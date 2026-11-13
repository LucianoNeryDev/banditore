import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Executor } from './db/client.js'
import { channelMetrics, channels } from './db/schema.js'
import type { RateLimited } from './platforms/types.js'

/** A rate-limited channel is left alone this long, by every collector. */
export const rateLimitPauseMs = 60 * 60_000

/**
 * Holds back every read on a channel until `until`; never shortens a longer
 * pause. The pause lives on the channel's `channel_metrics` row.
 */
export async function pauseChannel(executor: Executor, channel: { id: string, organizationId: string }, until: Date, now = new Date()) {
  await executor.insert(channelMetrics).values({ channelId: channel.id, organizationId: channel.organizationId, nextCollectAt: until, pausedUntil: until, updatedAt: now })
    .onConflictDoUpdate({ target: channelMetrics.channelId, set: {
      pausedUntil: sql`greatest(coalesce(${channelMetrics.pausedUntil}, ${until}), ${until})`,
      nextCollectAt: sql`greatest(${channelMetrics.nextCollectAt}, ${until})`, updatedAt: now,
    } })
}

/**
 * Applies a rate limit: the channel alone, or, when the limit belongs to the
 * provider app (Meta's app limit, YouTube's project quota), every active
 * channel on that app, across tenants. Returns the end of the pause.
 */
export async function pauseForRateLimit(executor: Executor, channel: { id: string, organizationId: string, providerAppId: string | null },
  error: RateLimited, now: Date) {
  const until = error.until && error.until.getTime() > now.getTime() ? error.until : new Date(now.getTime() + rateLimitPauseMs)
  const targets = error.scope === 'app' && channel.providerAppId
    ? await executor.select({ id: channels.id, organizationId: channels.organizationId }).from(channels)
      .where(and(eq(channels.providerAppId, channel.providerAppId), eq(channels.status, 'active')))
    : []
  if (!targets.some(target => target.id === channel.id)) targets.push({ id: channel.id, organizationId: channel.organizationId })
  for (const target of targets) await pauseChannel(executor, target, until, now)
  return until
}

/** SQL condition: the channel is not paused at `now`. Needs `channel_metrics` left-joined. */
export const notPaused = (now: Date) => or(isNull(channelMetrics.pausedUntil), lte(channelMetrics.pausedUntil, now))
