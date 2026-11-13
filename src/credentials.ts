import { and, eq, isNotNull, lt } from 'drizzle-orm'
import { z } from 'zod'
import { adapterFor, clock, recordEvent, resolveProviderApp, type EngineContext } from './context.js'
import { channelTokenContext, openToken, sealToken } from './crypto/envelope.js'
import type { Executor } from './db/client.js'
import { channelCredentials, channels } from './db/schema.js'
import { EngineError } from './errors.js'
import { errorFields, log } from './log.js'
import { ReauthRequired, type ChannelCredential, type ResolvedProviderApp } from './platforms/types.js'
import { changeChannelStatus } from './webhooks.js'

/** Default refresh margin when an adapter names none. */
const defaultRefreshBeforeMs = 5 * 60_000
const envelopeSchema = z.object({ v: z.literal(1), accessToken: z.string().min(1), refreshToken: z.string().min(1).optional() })

/**
 * Plaintext stored for a grant. A bare access token (every channel stored
 * before refresh tokens existed) still reads back as one.
 */
export function encodeCredential(credential: Pick<ChannelCredential, 'accessToken' | 'refreshToken'>) {
  if (!credential.refreshToken) return credential.accessToken
  return JSON.stringify({ v: 1, accessToken: credential.accessToken, refreshToken: credential.refreshToken })
}

export function decodeCredential(plaintext: string, expiresAt: Date | null): ChannelCredential {
  if (plaintext.startsWith('{"v":1')) {
    const value = envelopeSchema.parse(JSON.parse(plaintext))
    return { accessToken: value.accessToken, ...(value.refreshToken ? { refreshToken: value.refreshToken } : {}), expiresAt }
  }
  return { accessToken: plaintext, expiresAt }
}

/** Seals and stores a channel's grant, replacing any previous one. */
export async function storeCredential(context: EngineContext, executor: Executor, channelId: string, credential: ChannelCredential) {
  const sealed = sealToken(context.keyring, encodeCredential(credential), channelTokenContext(channelId))
  const values = { keyId: sealed.keyId, nonce: sealed.nonce, ciphertext: sealed.ciphertext, expiresAt: credential.expiresAt, refreshedAt: clock(context) }
  await executor.insert(channelCredentials).values({ channelId, ...values })
    .onConflictDoUpdate({ target: channelCredentials.channelId, set: values })
}

export async function readCredential(context: EngineContext, executor: Executor, channelId: string, lock = false): Promise<ChannelCredential> {
  const query = executor.select().from(channelCredentials).where(eq(channelCredentials.channelId, channelId)).limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw new EngineError(409, 'channel_inactive', 'Channel has no credential')
  return decodeCredential(openToken(context.keyring, row, channelTokenContext(channelId)), row.expiresAt)
}

/** A refresh failed for a reason that may pass; the job can be tried again. */
export class TransientCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientCredentialError'
  }
}

/**
 * The channel's access token, renewed first when it is about to expire. The
 * credential row stays locked during the renewal, so two workers never
 * refresh the same grant at once.
 */
export async function channelAccessToken(context: EngineContext, channel: typeof channels.$inferSelect, app: ResolvedProviderApp) {
  const adapter = adapterFor(context, channel.platform)
  const current = await readCredential(context, context.db, channel.id)
  if (!adapter.refreshCredential || !needsRefresh(current, adapter.refreshBeforeMs ?? defaultRefreshBeforeMs, clock(context))) return current.accessToken
  return (await refreshChannel(context, channel, app, adapter.refreshBeforeMs ?? defaultRefreshBeforeMs)).accessToken
}

function needsRefresh(credential: ChannelCredential, beforeMs: number, now: Date) {
  return credential.expiresAt !== null && credential.expiresAt.getTime() - now.getTime() < beforeMs
}

async function refreshChannel(context: EngineContext, channel: typeof channels.$inferSelect, app: ResolvedProviderApp, beforeMs: number) {
  const adapter = adapterFor(context, channel.platform)
  try {
    return await context.db.transaction(async transaction => {
      const current = await readCredential(context, transaction, channel.id, true)
      // Another worker may have renewed it while this one waited for the lock.
      if (!needsRefresh(current, beforeMs, clock(context))) return current
      const renewed = await adapter.refreshCredential!(app, current)
      const next = { ...renewed, refreshToken: renewed.refreshToken ?? current.refreshToken }
      await storeCredential(context, transaction, channel.id, next)
      // A renewal that names the granted scopes (Google's) keeps the channel's list current.
      if (renewed.grantedScopes) {
        await transaction.update(channels).set({ grantedScopes: renewed.grantedScopes, updatedAt: clock(context) }).where(eq(channels.id, channel.id))
      }
      await recordEvent(transaction, { organizationId: channel.organizationId, kind: 'channel.token_refreshed', channelId: channel.id,
        detail: { expiresAt: next.expiresAt?.toISOString() ?? null } })
      return next
    })
  } catch (error) {
    if (!(error instanceof ReauthRequired)) {
      throw new TransientCredentialError(error instanceof Error ? error.message : 'Token refresh failed')
    }
    await context.db.transaction(async transaction => {
      await changeChannelStatus(transaction, channel.id, 'needs_reauth', 'refresh_refused', clock(context))
      await recordEvent(transaction, { organizationId: channel.organizationId, kind: 'channel.needs_reauth', channelId: channel.id, detail: { reason: 'refresh_refused' } })
    })
    throw new EngineError(409, 'channel_inactive', 'The channel needs to be reconnected')
  }
}

/**
 * Renews keep-alive grants that will lapse within their adapter's margin,
 * whether or not anything is due on the channel.
 */
export async function refreshIdleCredentials(context: EngineContext) {
  const now = clock(context)
  let renewed = 0
  for (const [platform, adapter] of context.adapters) {
    if (!adapter.keepAlive || !adapter.refreshCredential) continue
    const beforeMs = adapter.refreshBeforeMs ?? defaultRefreshBeforeMs
    const due = await context.db.select({ channel: channels }).from(channels)
      .innerJoin(channelCredentials, eq(channelCredentials.channelId, channels.id))
      .where(and(eq(channels.platform, platform), eq(channels.status, 'active'), isNotNull(channels.providerAppId),
        lt(channelCredentials.expiresAt, new Date(now.getTime() + beforeMs))))
      .limit(50)
    for (const { channel } of due) {
      try {
        await refreshChannel(context, channel, await resolveProviderApp(context, context.db, channel.providerAppId!), beforeMs)
        renewed++
      } catch (error) {
        log('warn', 'idle token refresh failed', { channelId: channel.id, ...errorFields(error) })
      }
    }
  }
  return renewed
}
