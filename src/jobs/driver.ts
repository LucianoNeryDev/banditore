import { eq } from 'drizzle-orm'
import { resolveProviderApp, type EngineContext } from '../context.js'
import type { Executor } from '../db/client.js'
import { browserAccounts, type channels } from '../db/schema.js'
import { EngineError } from '../errors.js'
import type { BrowserAccountTarget, ResolvedProviderApp } from '../platforms/types.js'
import { channelAccessToken } from '../credentials.js'

/** How a channel is driven: an OAuth token from its provider app, or a vault login for the browser runner. */
export async function channelDriver(context: EngineContext, executor: Executor, channel: typeof channels.$inferSelect):
Promise<{ app: ResolvedProviderApp | null, token: string, browserAccount?: BrowserAccountTarget }> {
  if (channel.browserAccountId) {
    const [account] = await executor.select().from(browserAccounts).where(eq(browserAccounts.id, channel.browserAccountId)).limit(1)
    if (!account || account.status !== 'active') throw new EngineError(409, 'channel_inactive', 'The browser account needs a login')
    return { app: null, token: '', browserAccount: { id: account.id, handle: account.handle,
      sealed: { ephemeralPublicKey: account.ephemeralPublicKey, nonce: account.nonce, ciphertext: account.ciphertext } } }
  }
  if (!channel.providerAppId) throw new EngineError(409, 'channel_inactive', 'Channel has no provider app')
  const app = await resolveProviderApp(context, executor, channel.providerAppId)
  return { app, token: await channelAccessToken(context, channel, app) }
}
