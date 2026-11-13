import { z } from 'zod'
import type { PlatformResponse, ResponsesInput, ResponsesResult } from '../types.js'
import { GraphError, type GraphCall, type GraphClient } from './graph.js'
import { instagramOwnComment, instagramUserSchema } from './replies.js'

const count = z.number().int().nonnegative()
const paging = z.object({ cursors: z.object({ after: z.string().max(1_000).optional() }).optional(), next: z.string().optional() }).optional()
const facebookCommentsSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(200),
    message: z.string().optional(),
    created_time: z.string().max(40),
    like_count: count.optional(),
    comment_count: count.optional(),
    parent: z.object({ id: z.string().max(200) }).optional(),
    // The ID only tells the Page's own comments apart; it is never stored.
    from: z.object({ id: z.string().max(200).optional(), name: z.string().optional() }).optional(),
    permalink_url: z.string().optional(),
  })).max(100),
  paging,
})
const instagramCommentSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().optional(),
  username: z.string().optional(),
  timestamp: z.string().max(40),
  like_count: count.optional(),
  user: instagramUserSchema,
})
const instagramCommentsSchema = z.object({
  data: z.array(instagramCommentSchema.extend({
    replies: z.object({ data: z.array(instagramCommentSchema).max(100), paging }).optional(),
  })).max(100),
  paging,
})

/** About 300 comments per read: three pages on Facebook, up to six on Instagram (50 per page, with their replies). */
export const maxResponsesPerRead = 300
const facebookPages = 3
const instagramPages = 6

function date(value: string) {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed)
}

/** Why Meta refused: a permission (10, 200-299), or a post that no longer exists (100/33). */
function refusal(error: unknown, permission: string): string | null {
  if (!(error instanceof GraphError) || error.failure.kind !== 'http') return null
  const code = error.failure.code ?? 0
  if (code === 10 || (code >= 200 && code <= 299)) return `Reading comments needs the ${permission} permission; connect the channel again to grant it.`
  if (code === 100 && error.failure.subcode === 33) return 'The post was deleted or the app can no longer see it.'
  return null
}

/**
 * Comments and replies on a Page post, newest first. Commenter names need
 * `pages_read_user_content`; without it Meta may refuse the edge or leave the
 * author out. `from.id` only marks the Page's own comments.
 */
export async function facebookResponses(graph: GraphClient, call: GraphCall, input: ResponsesInput): Promise<ResponsesResult> {
  const responses: PlatformResponse[] = []
  let after: string | undefined
  for (let page = 0; page < facebookPages; page++) {
    let result: z.infer<typeof facebookCommentsSchema>
    try {
      result = facebookCommentsSchema.parse(await graph.request('GET', `/${input.externalId}/comments`, { ...call, query: {
        filter: 'stream', order: 'reverse_chronological', limit: '100',
        fields: 'id,message,created_time,like_count,comment_count,parent{id},from{id,name},permalink_url', ...(after ? { after } : {}),
      } }))
    } catch (error) {
      const reason = refusal(error, 'pages_read_user_content')
      if (reason && page === 0) return { kind: 'unavailable', reason }
      throw error
    }
    for (const comment of result.data) {
      const publishedAt = date(comment.created_time)
      if (!publishedAt) continue
      responses.push({ externalId: comment.id, parentExternalId: comment.parent?.id ?? null, authorName: comment.from?.name ?? null, authorHandle: null,
        text: comment.message ?? '', likeCount: comment.like_count ?? null, replyCount: comment.comment_count ?? null, publishedAt,
        url: comment.permalink_url?.startsWith('https://') && comment.permalink_url.length <= 2_000 ? comment.permalink_url : null,
        fromChannel: comment.from?.id === input.channel.externalId })
    }
    after = result.paging?.next ? result.paging.cursors?.after : undefined
    if (!after || responses.length >= maxResponsesPerRead || !(input.morePages?.() ?? true)) break
  }
  return { kind: 'ok', responses }
}

/**
 * Comments and their replies on Instagram media, newest first. The edge and
 * commenter usernames need `instagram_manage_comments`, or
 * `instagram_business_manage_comments` with Instagram's own login.
 */
export async function instagramResponses(graph: GraphClient, call: GraphCall, input: ResponsesInput, permission: string): Promise<ResponsesResult> {
  const responses: PlatformResponse[] = []
  let after: string | undefined
  // `user` comes back only on the account's own comments.
  const fields = 'id,text,username,timestamp,like_count,user'
  for (let page = 0; page < instagramPages; page++) {
    let result: z.infer<typeof instagramCommentsSchema>
    try {
      result = instagramCommentsSchema.parse(await graph.request('GET', `/${input.externalId}/comments`, { ...call, query: {
        fields: `${fields},replies{${fields}}`, limit: '50', ...(after ? { after } : {}),
      } }))
    } catch (error) {
      const reason = refusal(error, permission)
      if (reason && page === 0) return { kind: 'unavailable', reason }
      throw error
    }
    for (const comment of result.data) {
      const replies = comment.replies?.data ?? []
      // A reply count is only known when every reply came in one page.
      const replyCount = comment.replies?.paging?.next ? null : replies.length
      for (const [value, parent] of [[comment, null], ...replies.map(reply => [reply, comment.id] as const)] as const) {
        const publishedAt = date(value.timestamp)
        if (!publishedAt) continue
        responses.push({ externalId: value.id, parentExternalId: parent, authorName: null, authorHandle: value.username ?? null, text: value.text ?? '',
          likeCount: value.like_count ?? null, replyCount: parent ? null : replyCount, publishedAt, url: null, fromChannel: instagramOwnComment(value, input.channel) })
      }
    }
    after = result.paging?.next ? result.paging.cursors?.after : undefined
    if (!after || responses.length >= maxResponsesPerRead || !(input.morePages?.() ?? true)) break
  }
  return { kind: 'ok', responses: newestThreads(responses, maxResponsesPerRead) }
}

/**
 * At most `max` responses, newest first, cut by whole threads (a comment
 * and its replies) so a kept reply never loses its parent. Threads rank by
 * their newest comment or reply; the first thread that does not fit keeps
 * its comment and its newest replies. Instagram does not document the order
 * of the edge, so the ranking does not rely on it.
 */
export function newestThreads(responses: PlatformResponse[], max: number) {
  const time = (response: PlatformResponse) => response.publishedAt.getTime()
  const byNewest = (a: PlatformResponse, b: PlatformResponse) => time(b) - time(a)
  const threads = new Map<string, PlatformResponse[]>()
  for (const response of responses) {
    const key = response.parentExternalId ?? response.externalId
    const thread = threads.get(key)
    if (thread) thread.push(response)
    else threads.set(key, [response])
  }
  const ranked = [...threads].map(([key, entries]) => ({ key, entries: entries.sort(byNewest) }))
    .sort((a, b) => time(b.entries[0]!) - time(a.entries[0]!))
  const kept: PlatformResponse[] = []
  for (const { key, entries } of ranked) {
    const room = max - kept.length
    if (room <= 0) break
    if (entries.length <= room) {
      kept.push(...entries)
      continue
    }
    const parent = entries.find(entry => entry.externalId === key)
    kept.push(...(parent ? [parent] : []), ...entries.filter(entry => entry !== parent).slice(0, parent ? room - 1 : room))
  }
  return kept.sort(byNewest)
}
