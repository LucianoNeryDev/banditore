import { eq } from 'drizzle-orm'
import type { Keyring } from './crypto/envelope.js'
import type { Database, Executor } from './db/client.js'
import { events, providerApps, type Platform } from './db/schema.js'
import { EngineError } from './errors.js'
import type { PublicMedia } from './media.js'
import type { RunnerClient } from './platforms/browser/runner-client.js'
import type { PlatformAdapter, ResolvedProviderApp } from './platforms/types.js'
import type { WebhookSender } from './webhook-sender.js'
import type { DecisionModel } from './answering/decision.js'
import type { DraftModel } from './answering/drafting.js'

export interface EngineContext {
  db: Database
  keyring: Keyring
  adapters: Map<Platform, PlatformAdapter>
  providerSecrets: Map<string, string>
  /** Absent when the dashboard does not serve media publicly; URL-based platforms then cannot publish images. */
  publicMedia?: PublicMedia
  /** The browser runner, when configured. */
  runner?: RunnerClient
  /** Sends webhook requests; the public-HTTPS-only sender when absent. */
  webhookSender?: WebhookSender
  /** The decision model (Liquid AI); without it every decision is `skipped`. */
  decisionModel?: DecisionModel
  /** The drafting model (Anthropic); without it nothing is drafted. Neither model has tools. */
  draftModel?: DraftModel
  now?: () => Date
}

export const clock = (context: EngineContext) => context.now?.() ?? new Date()

export function adapterFor(context: EngineContext, platform: Platform) {
  const adapter = context.adapters.get(platform)
  if (!adapter) throw new EngineError(503, 'platform_unavailable', `Platform ${platform} is not configured`)
  return adapter
}

export async function resolveProviderApp(context: EngineContext, executor: Executor, id: string): Promise<ResolvedProviderApp & { ownerKind: 'agency' | 'tenant', ownerOrganizationId: string | null }> {
  const [app] = await executor.select().from(providerApps).where(eq(providerApps.id, id)).limit(1)
  if (!app) throw new EngineError(404, 'not_found', 'Provider app not found')
  const secret = context.providerSecrets.get(app.secretRef)
  if (!secret) throw new EngineError(503, 'provider_secret_missing', `Secret for provider app ${app.id} is not configured`)
  return { id: app.id, platform: app.platform, externalAppId: app.externalAppId, secret, settings: app.settings,
    ownerKind: app.ownerKind, ownerOrganizationId: app.ownerOrganizationId }
}

export async function recordEvent(executor: Executor, value: { organizationId: string, kind: string, jobId?: string, channelId?: string, detail?: Record<string, unknown> }) {
  await executor.insert(events).values({ organizationId: value.organizationId, kind: value.kind, jobId: value.jobId, channelId: value.channelId, detail: value.detail ?? {} })
}
