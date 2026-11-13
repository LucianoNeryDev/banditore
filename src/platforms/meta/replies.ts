import { z } from 'zod'
import { pickOwnReply, type ReplyCandidate } from '../reply-match.js'
import type { FindReplyInput, FindReplyOutcome, ReplyInput, ReplyOutcome, ReplyTargetInput, ReplyTargetOutcome } from '../types.js'
import { rateLimited } from './classify.js'
import { GraphError, type GraphCall, type GraphClient } from './graph.js'

const createdSchema = z.object({ id: z.string().min(1).max(200) })
const paging = z.object({ cursors: z.object({ after: z.string().max(1_000).optional() }).optional(), next: z.string().optional() }).optional()
const facebookRepliesSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(200),
    message: z.string().optional(),
    created_time: z.string().max(40).optional(),
    // Only compared with the Page's ID; never stored.
    from: z.object({ id: z.string().max(200).optional() }).optional(),
    permalink_url: z.string().optional(),
  })).max(100),
  paging,
})
/** `user` comes back only on comments the app user (the account itself) wrote. */
export const instagramUserSchema = z.union([z.object({ id: z.string().max(200) }), z.string().max(200)]).optional()
const instagramRepliesSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(200),
    text: z.string().optional(),
    timestamp: z.string().max(40).optional(),
    username: z.string().max(200).optional(),
    user: instagramUserSchema,
  })).max(100),
  paging,
})

const parentSchema = z.object({ id: z.string().min(1).max(200), parent: z.object({ id: z.string().min(1).max(200) }).optional() })

/** Pages of replies read when looking for an uncertain reply. */
const findPages = 5
/** Instagram's page size for a comment's replies; Meta documents no maximum for this edge. */
const instagramPageSize = 50
/** Steps read up a Facebook thread to its top-level comment. */
const maxThreadSteps = 10

/** A Meta permission named in an error message ("(#200) Requires pages_manage_engagement permission"), if any. */
export function namedPermission(message: string, expected: string) {
  if (message.includes(expected)) return expected
  return /\b(?:pages|instagram|ads|business|read)_[a-z_]+\b/.exec(message)?.[0]
}

/** Whether an Instagram comment is the account's own: `user` names it, or the username is the account's. */
export function instagramOwnComment(comment: { user?: { id: string } | string, username?: string }, account: { externalId: string, handle?: string | undefined }) {
  const user = typeof comment.user === 'string' ? comment.user : comment.user?.id
  if (user !== undefined && user === account.externalId) return true
  return Boolean(account.handle && comment.username && comment.username.toLowerCase() === account.handle.toLowerCase())
}

/**
 * Classifies a failed reply request. Only a request that may have reached
 * Meta without a readable answer is uncertain; a refusal is definite.
 */
export function classifyReply(error: unknown, permission: string): ReplyOutcome {
  if (!(error instanceof GraphError)) return { kind: 'uncertain', code: 'unexpected_response', detail: 'Unreadable success response' }
  const failure = error.failure
  if (failure.kind === 'unreachable') return { kind: 'failed', retryable: true, code: 'unreachable', detail: error.message }
  if (failure.kind === 'lost') return { kind: 'uncertain', code: 'response_lost', detail: error.message }
  const code = failure.code ?? 0
  const detail = `HTTP ${failure.status} code ${code}${failure.subcode ? `/${failure.subcode}` : ''}: ${failure.message}`
  if (code === 190 || code === 102) return { kind: 'failed', retryable: false, code: 'channel_inactive', detail, reauth: true }
  if (code === 10 || (code >= 200 && code <= 299)) {
    // Only a refusal that names the permission says the grant lacks it; any
    // other permission error is about this comment (a hidden commenter, a
    // restricted thread) and fails just this reply.
    const named = namedPermission(failure.message, permission)
    return named ? { kind: 'failed', retryable: false, code: 'missing_permission', detail, permission: named }
      : { kind: 'failed', retryable: false, code: 'reply_not_allowed', detail }
  }
  if (rateLimited(error)) return { kind: 'failed', retryable: true, code: 'rate_limited', detail }
  if (code === 100 && failure.subcode === 33) return { kind: 'failed', retryable: false, code: 'comment_gone', detail }
  if (failure.transient || failure.status >= 500) return { kind: 'uncertain', code: 'platform_error', detail }
  return { kind: 'failed', retryable: false, code: 'rejected', detail }
}

/** A reply under a Facebook comment, as the Page: `POST /{comment-id}/comments`. Needs `pages_manage_engagement`. */
export async function facebookReply(graph: GraphClient, call: GraphCall, input: ReplyInput): Promise<ReplyOutcome> {
  let created: z.infer<typeof createdSchema>
  try {
    created = createdSchema.parse(await graph.request('POST', `/${input.targetExternalId}/comments`, { ...call, form: { message: input.text } }))
  } catch (error) {
    return classifyReply(error, 'pages_manage_engagement')
  }
  return { kind: 'sent', externalId: created.id }
}

/** A reply under an Instagram comment: `POST /{ig-comment-id}/replies`. Needs `instagram_manage_comments`, or `instagram_business_manage_comments` with Instagram's own login. */
export async function instagramReply(graph: GraphClient, call: GraphCall, input: ReplyInput, permission: string): Promise<ReplyOutcome> {
  let created: z.infer<typeof createdSchema>
  try {
    created = createdSchema.parse(await graph.request('POST', `/${input.targetExternalId}/replies`, { ...call, form: { message: input.text } }))
  } catch (error) {
    return classifyReply(error, permission)
  }
  return { kind: 'sent', externalId: created.id }
}

const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? null : parsed
}
const httpsUrl = (value: string | undefined) => value?.startsWith('https://') && value.length <= 2_000 ? value : undefined

/** The Page's replies under a Facebook comment, newest first, a few pages deep. */
export async function facebookFindReply(graph: GraphClient, call: GraphCall, input: FindReplyInput): Promise<FindReplyOutcome> {
  const candidates: ReplyCandidate[] = []
  let after: string | undefined
  for (let page = 0; page < findPages; page++) {
    if (page > 0) input.spendCall?.()
    const result = facebookRepliesSchema.parse(await graph.request('GET', `/${input.targetExternalId}/comments`, { ...call, query: {
      filter: 'stream', order: 'reverse_chronological', limit: '100', fields: 'id,message,created_time,from{id},permalink_url', ...(after ? { after } : {}),
    } }))
    for (const reply of result.data) {
      const url = httpsUrl(reply.permalink_url)
      candidates.push({ id: reply.id, text: reply.message ?? '', createdAt: time(reply.created_time), own: reply.from?.id === input.channel.externalId,
        ...(url ? { url } : {}) })
    }
    after = result.paging?.next ? result.paging.cursors?.after : undefined
    if (!after) break
  }
  return pickOwnReply(candidates, input)
}

/** The account's replies under an Instagram comment, a few pages deep. */
export async function instagramFindReply(graph: GraphClient, call: GraphCall, input: FindReplyInput): Promise<FindReplyOutcome> {
  const candidates: ReplyCandidate[] = []
  let after: string | undefined
  for (let page = 0; page < findPages; page++) {
    if (page > 0) input.spendCall?.()
    const result = instagramRepliesSchema.parse(await graph.request('GET', `/${input.targetExternalId}/replies`, { ...call, query: {
      fields: 'id,text,timestamp,username,user', limit: String(instagramPageSize), ...(after ? { after } : {}),
    } }))
    for (const reply of result.data) {
      candidates.push({ id: reply.id, text: reply.text ?? '', createdAt: time(reply.timestamp),
        own: instagramOwnComment(reply, input.channel) })
    }
    after = result.paging?.next ? result.paging.cursors?.after : undefined
    if (!after) break
  }
  return pickOwnReply(candidates, input)
}

/**
 * The top-level comment of a Facebook thread whose start is older than the
 * stored responses: reads each comment's `parent` up from the oldest known
 * one. A read sends nothing, so every failure can be tried again or is
 * definite.
 */
export async function facebookThreadTop(graph: GraphClient, call: GraphCall, input: ReplyTargetInput): Promise<ReplyTargetOutcome> {
  let current = input.commentExternalId
  try {
    for (let step = 0; step < maxThreadSteps; step++) {
      const comment = parentSchema.parse(await graph.request('GET', `/${current}`, { ...call, query: { fields: 'id,parent{id}' } }))
      if (!comment.parent) return { kind: 'top', externalId: current }
      current = comment.parent.id
    }
  } catch (error) {
    const outcome = classifyReply(error, 'pages_read_engagement')
    return outcome.kind === 'uncertain' ? { kind: 'failed', retryable: true, code: 'unreachable', detail: outcome.detail } : outcome.kind === 'failed' ? outcome
      : { kind: 'failed', retryable: false, code: 'rejected', detail: 'Unexpected answer' }
  }
  return { kind: 'failed', retryable: false, code: 'comment_gone', detail: `The thread is deeper than ${maxThreadSteps} comments` }
}
