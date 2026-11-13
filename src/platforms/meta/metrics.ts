import { z } from 'zod'
import type { ChannelMetricName, ChannelMetricValues, MetricValues } from '../../db/schema.js'
import type { AccountMetricsResult, MetricsResult } from '../types.js'
import { GraphError, type GraphCall, type GraphClient } from './graph.js'

const count = z.number().int().nonnegative()
const insightsSchema = z.object({
  data: z.array(z.object({
    name: z.string(),
    values: z.array(z.object({ value: z.unknown(), end_time: z.string().optional() })).max(100).optional(),
    total_value: z.object({ value: z.unknown() }).optional(),
  })).max(50),
})
const facebookPostSchema = z.object({
  reactions: z.object({ summary: z.object({ total_count: count }) }).optional(),
  comments: z.object({ summary: z.object({ total_count: count }) }).optional(),
  // Absent until the post is shared once.
  shares: z.object({ count }).optional(),
})
const instagramMediaSchema = z.object({ like_count: count.optional(), comments_count: count.optional() })
const facebookPageSchema = z.object({ followers_count: count.optional(), fan_count: count.optional() })
const instagramUserSchema = z.object({ followers_count: count.optional(), follows_count: count.optional(), media_count: count.optional() })

type InsightEntry = z.infer<typeof insightsSchema>['data'][number]
interface InsightsOptions {
  query?: Record<string, string>
  /** Which value of a metric to keep; by default its total, or its first value. */
  pick?: (entry: InsightEntry) => unknown
}
const dayMs = 86_400_000

/** Permission refused (10, 200-299) or a metric this post does not support (100). */
function refused(error: unknown) {
  if (!(error instanceof GraphError) || error.failure.kind !== 'http') return false
  const code = error.failure.code ?? 0
  return code === 10 || code === 100 || (code >= 200 && code <= 299)
}

function readInsights<N extends string>(payload: unknown, names: Record<string, N>, pick?: InsightsOptions['pick']) {
  const values: Partial<Record<N, number>> = {}
  for (const entry of insightsSchema.parse(payload).data) {
    const name = names[entry.name]
    const value = count.safeParse(pick ? pick(entry) : entry.total_value?.value ?? entry.values?.[0]?.value)
    if (name && value.success) values[name] = value.data
  }
  return values
}

/**
 * Asks for every metric at once; when Meta refuses the set, asks for each
 * one alone, so a single unsupported metric does not hide the others.
 */
async function insights<N extends string>(graph: GraphClient, call: GraphCall, id: string, names: Record<string, N>, options: InsightsOptions = {}) {
  const request = (metrics: string[]) => graph.request('GET', `/${id}/insights`, { ...call, query: { ...options.query, metric: metrics.join(',') } })
  // Without the insights permission, Pages answer 200 with no data rather than an error.
  const missing = (values: Partial<Record<N, number>>) => Object.values(names).filter(name => values[name] === undefined)
  try {
    const values = readInsights(await request(Object.keys(names)), names, options.pick)
    return { values, unavailable: missing(values) }
  } catch (error) {
    if (!refused(error)) throw error
  }
  const values: Partial<Record<N, number>> = {}
  const unavailable: N[] = []
  for (const [metric, name] of Object.entries(names)) {
    try {
      Object.assign(values, readInsights(await request([metric]), names, options.pick))
    } catch (error) {
      if (!refused(error)) throw error
    }
    if (values[name] === undefined) unavailable.push(name)
  }
  return { values, unavailable }
}

/** Reactions, comments and shares need `pages_read_engagement`; views and reach need `read_insights`. */
export async function facebookPostMetrics(graph: GraphClient, call: GraphCall, postId: string): Promise<MetricsResult> {
  const post = facebookPostSchema.parse(await graph.request('GET', `/${postId}`, { ...call, query: {
    fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares',
  } }))
  const viewed = await insights(graph, call, postId, { post_media_view: 'views', post_total_media_view_unique: 'reach' })
  return {
    values: { likes: post.reactions?.summary.total_count ?? 0, comments: post.comments?.summary.total_count ?? 0, shares: post.shares?.count ?? 0, ...viewed.values },
    unavailable: viewed.unavailable,
  }
}

/**
 * Like and comment counts come with basic access; views, reach, shares and
 * saves need the insights permission (`instagram_manage_insights`, or
 * `instagram_business_manage_insights` with Instagram's own login).
 */
export async function instagramMediaMetrics(graph: GraphClient, call: GraphCall, mediaId: string): Promise<MetricsResult> {
  const media = instagramMediaSchema.parse(await graph.request('GET', `/${mediaId}`, { ...call, query: { fields: 'like_count,comments_count' } }))
  const measured = await insights(graph, call, mediaId, { views: 'views', reach: 'reach', shares: 'shares', saved: 'saves' })
  const values: MetricValues = { ...measured.values }
  // Owners can hide like counts; Meta then omits the field.
  if (media.like_count !== undefined) values.likes = media.like_count
  if (media.comments_count !== undefined) values.comments = media.comments_count
  const unavailable = [...measured.unavailable, ...(media.like_count === undefined ? ['likes' as const] : [])]
  return { values, unavailable }
}

/** The value of the latest day that ended by `now`. Page insights answer `period=day` with the last few days. */
function lastFullDay(now: Date) {
  return (entry: InsightEntry) => entry.values
    ?.filter(value => value.end_time !== undefined && Date.parse(value.end_time) <= now.getTime())
    .sort((a, b) => Date.parse(b.end_time!) - Date.parse(a.end_time!))[0]?.value
}

/**
 * Followers come with `pages_read_engagement` (`fan_count`, Page likes, when
 * Meta omits `followers_count`). Views, reach and Page views of the last full
 * day need `read_insights`; Meta retires Page metrics often, so a refused or
 * empty metric is reported unavailable rather than failing the read.
 */
export async function facebookPageMetrics(graph: GraphClient, call: GraphCall, pageId: string, now: Date): Promise<AccountMetricsResult> {
  const page = facebookPageSchema.parse(await graph.request('GET', `/${pageId}`, { ...call, query: { fields: 'followers_count,fan_count' } }))
  const day = await insights(graph, call, pageId, { page_media_view: 'views', page_total_media_view_unique: 'reach', page_views_total: 'profileViews' },
    { query: { period: 'day' }, pick: lastFullDay(now) })
  const values: ChannelMetricValues = { ...day.values }
  const followers = page.followers_count ?? page.fan_count
  if (followers !== undefined) values.followers = followers
  return { values, unavailable: [...(followers === undefined ? ['followers' as const] : []), ...day.unavailable] }
}

/**
 * Follower, following and media counts come with basic access. Reach, views
 * and profile views of the last full UTC day need the insights permission
 * (`instagram_manage_insights`, or `instagram_business_manage_insights` with
 * Instagram's own login).
 */
export async function instagramAccountMetrics(graph: GraphClient, call: GraphCall, userId: string, now: Date): Promise<AccountMetricsResult> {
  const user = instagramUserSchema.parse(await graph.request('GET', `/${userId}`, { ...call, query: { fields: 'followers_count,follows_count,media_count' } }))
  const until = Math.floor(now.getTime() / dayMs) * dayMs
  const day = await insights(graph, call, userId, { reach: 'reach', views: 'views', profile_views: 'profileViews' }, { query: {
    period: 'day', metric_type: 'total_value', since: String((until - dayMs) / 1000), until: String(until / 1000),
  } })
  const values: ChannelMetricValues = { ...day.values }
  const unavailable: ChannelMetricName[] = [...day.unavailable]
  for (const [name, value] of [['followers', user.followers_count], ['following', user.follows_count], ['posts', user.media_count]] as const) {
    if (value === undefined) unavailable.push(name)
    else values[name] = value
  }
  return { values, unavailable }
}
