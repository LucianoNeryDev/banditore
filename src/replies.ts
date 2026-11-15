import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { CallBudget } from './budget.js'
import { channelTarget, lockControls, readPublishing } from './channels.js'
import { adapterFor, clock, recordEvent, type EngineContext } from './context.js'
import { TransientCredentialError } from './credentials.js'
import type { Executor } from './db/client.js'
import { channels, jobs, postResponses, replies, replyCancellations, responseChecks, type ReplyState } from './db/schema.js'
import { conflict, EngineError, invalid, notFound } from './errors.js'
import { advisoryLock, dashboardIdentifier, hex64, isUniqueViolation, sendRetryDelayMs, sha256Json } from './exactly-once.js'
import { channelDriver } from './jobs/driver.js'
import { errorFields, log } from './log.js'
import { normalizeReplyText } from './platforms/reply-match.js'
import { RateLimited, type FindReplyOutcome, type ReplyOutcome } from './platforms/types.js'
import { permissionName, replyAvailability } from './reply-availability.js'
import { changeChannelStatus, emitReplyOutcome } from './webhooks.js'
import { approvalFields, approvalRefinement, approvalRefinementMessage, checkAutomation } from './answering/drafts.js'
import { queueControlEvent } from './control-events.js'
import type { ApprovedVia } from './db/schema.js'

type Reply = typeof replies.$inferSelect

const minuteMs = 60_000
const hourMs = 60 * minuteMs

/** A queued reply more than this past its `sendAt` is not sent any more. */
export const maxReplyLatenessMs = hourMs
/**
 * A submission that arrives more than this after its `sendAt` is refused
 * (`too_late`): it would leave at once, with no time left to cancel it. The
 * dashboard asks for a new approval instead.
 */
export const maxSubmissionLatenessMs = 5 * minuteMs
/** Looks without a match before a person may say an uncertain reply did not go out: the 1, 5 and 15 minute ones. */
export const missesBeforeNotSent = 3
/** Steps up the stored responses to a thread's top-level comment. */
const maxThreadDepth = 10
/** A claimed reply still `sending` after this long is treated as abandoned. */
export const replyLeaseMs = 5 * minuteMs
/** Tries for a reply whose request never left, or that the platform rate-limited. */
export const maxReplyAttempts = 3
/** Looks at the platform for an uncertain reply, after its attempt: about a day in all. */
export const replyReconcileDelaysMs = [1, 5, 15, 60, 180, 360, 720, 1_440].map(minutes => minutes * minuteMs)
/** Clock skew allowed when matching a reply's creation time with the attempt. */
export const replyReconcileSkewMs = 5 * minuteMs
export const repliesPerChannelHour = 30
export const repliesPerChannelDay = 200
/** `comments.insert` costs 50 of the Google project's 10,000 daily units, which uploads and reads share. */
export const youtubeRepliesPerDay = 20
export const replyCancellationRetentionMs = 30 * 86_400_000
/** How often the worker sends due replies and looks for uncertain ones. */
export const repliesIntervalMs = 5_000
const repliesPerPass = 10
const reconcilesPerPass = 5

export const replyRetryDelayMs = sendRetryDelayMs

/** What a reply binds: the post (job), the comment answered and the exact text. The dashboard computes the same value. */
export function replyDigest(input: { jobId: string, parentExternalId: string, text: string }) {
  return sha256Json(['social-reply-v1', input.jobId, input.parentExternalId, input.text])
}

/** One key per (organization, dashboard reply, revision, digest): a second submission of it is the same reply. */
export function replyRequestKey(organizationId: string, replyId: string, revision: number, digest: string) {
  return sha256Json(['social-reply-send-v1', organizationId, replyId, revision, digest])
}

const identifier = dashboardIdentifier
export const externalId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
export const replySubmissionSchema = z.strictObject({
  requestKey: hex64,
  replyId: identifier,
  revision: z.number().int().positive(),
  digest: hex64,
  jobId: z.uuid(),
  parentExternalId: externalId,
  // Already trimmed by the dashboard: the digest covers the exact text.
  text: z.string().min(1).max(20_000).refine(value => value.trim() === value, 'must be trimmed'),
  approvedByUserId: identifier,
  approvedAt: z.iso.datetime({ offset: true }),
  sendAt: z.iso.datetime({ offset: true }),
  ...approvalFields,
}).refine(approvalRefinement, approvalRefinementMessage)
export type ReplySubmission = z.infer<typeof replySubmissionSchema>

/** Submission and cancellation of one request key serialize on it, so a cancel that finds nothing leaves a tombstone a late submission sees. */
const lockRequestKey = (executor: Executor, organizationId: string, requestKey: string) => advisoryLock(executor, `reply-key:${organizationId}:${requestKey}`)

/** A reply as the dashboard reads it. A request key cancelled before it arrived has no reply behind it: its reply fields are null. */
export interface ReplyView {
  id: string | null
  requestKey: string
  replyId: string | null
  revision: number | null
  digest: string | null
  jobId: string | null
  channelId: string | null
  parentExternalId: string | null
  targetExternalId: string | null
  /** `person`, or `automation` with the engine draft it sends. */
  approvedVia: ApprovedVia | null
  draftId: string | null
  state: ReplyState
  errorCode: string | null
  /** The permission a `missing_permission` failure names. */
  permission: string | null
  platformReplyId: string | null
  url: string | null
  attemptCount: number
  /** Uncertain, and still being looked for on the platform. */
  reconciling: boolean
  sendAt: string | null
  attemptedAt: string | null
  settledAt: string | null
  settledBy: string | null
  /** The collected response the sent reply became. */
  responseId: string | null
  /** What a person said about it while uncertain; `not_sent` on a `sent` reply is a confirmation that overrode them. */
  resolution: 'sent' | 'not_sent' | null
  /** An uncertain reply a person may now resolve as `not_sent`: the 15-minute look found nothing, or the looks stopped. */
  notSentAllowed: boolean
  updatedAt: string
}

/** Whether a person may say an uncertain reply did not go out: only once the first looks found nothing, or the looks stopped. */
export function notSentAllowed(reply: Pick<Reply, 'state' | 'reconciling' | 'reconcileMisses'>) {
  return reply.state === 'uncertain' && (!reply.reconciling || reply.reconcileMisses >= missesBeforeNotSent)
}

export function replyView(reply: Reply, responseId: string | null = null): ReplyView {
  return {
    id: reply.id, requestKey: reply.requestKey, replyId: reply.replyId, revision: reply.revision, digest: reply.digest, jobId: reply.jobId,
    channelId: reply.channelId, parentExternalId: reply.parentExternalId, targetExternalId: reply.targetExternalId, approvedVia: reply.approvedVia,
    draftId: reply.draftId, state: reply.state,
    errorCode: reply.errorCode, permission: reply.permission ? permissionName(reply.permission) : null, platformReplyId: reply.platformReplyId,
    url: reply.url, attemptCount: reply.attemptCount, reconciling: reply.reconciling, sendAt: reply.sendAt.toISOString(),
    attemptedAt: reply.attemptedAt?.toISOString() ?? null, settledAt: reply.settledAt?.toISOString() ?? null, settledBy: reply.settledBy ?? null,
    responseId, resolution: reply.resolution ?? null, notSentAllowed: notSentAllowed(reply), updatedAt: reply.updatedAt.toISOString(),
  }
}

/** A request key cancelled before the engine stored a reply for it; a refused submission fills in what it named. */
function tombstoneView(row: typeof replyCancellations.$inferSelect, input?: ReplySubmission): ReplyView {
  const at = row.createdAt.toISOString()
  return {
    id: null, requestKey: row.requestKey, replyId: input?.replyId ?? null, revision: input?.revision ?? null, digest: input?.digest ?? null,
    jobId: input?.jobId ?? null, channelId: null, parentExternalId: input?.parentExternalId ?? null, targetExternalId: null,
    approvedVia: input ? input.approvedVia ?? 'person' : null, draftId: input?.draftId ?? null, state: 'cancelled',
    errorCode: 'cancelled_before_submit', permission: null, platformReplyId: null, url: null, attemptCount: 0, reconciling: false,
    sendAt: input ? new Date(input.sendAt).toISOString() : null, attemptedAt: null, settledAt: at, settledBy: null, responseId: null, resolution: null,
    notSentAllowed: false, updatedAt: at,
  }
}

/** The collected response a sent reply became, by the platform's reply ID. */
async function responseIdOf(executor: Executor, reply: Reply) {
  if (!reply.platformReplyId) return null
  const [row] = await executor.select({ id: postResponses.id }).from(postResponses)
    .where(and(eq(postResponses.channelId, reply.channelId), eq(postResponses.externalId, reply.platformReplyId))).limit(1)
  return row?.id ?? null
}

/**
 * The comment a reply is posted under: the top of the answered comment's
 * thread, from the stored responses. Null when the answered comment is not
 * one of this post's stored responses. `resolved` is false when the chain
 * leaves the stored responses (older than the newest few hundred) where
 * replies nest deeper than one level: the top is then read on the platform
 * before sending. Where they nest one level, a reply's parent is the top.
 */
async function threadTop(executor: Executor, channelId: string, jobId: string, parentExternalId: string, deepThreads: boolean) {
  let current = parentExternalId
  for (let depth = 0; depth < maxThreadDepth; depth++) {
    const [row] = await executor.select({ jobId: postResponses.jobId, parent: postResponses.parentExternalId }).from(postResponses)
      .where(and(eq(postResponses.channelId, channelId), eq(postResponses.externalId, current))).limit(1)
    if (!row) return depth === 0 ? null : { target: current, resolved: !deepThreads }
    if (row.jobId !== jobId) return null
    if (!row.parent) return { target: current, resolved: true }
    current = row.parent
  }
  return { target: current, resolved: !deepThreads }
}

/** Replies that were or will be sent count toward the limits: not cancelled ones, nor those that failed before any attempt. */
const counted = and(ne(replies.state, 'cancelled'), or(ne(replies.state, 'failed'), gt(replies.attemptCount, 0)))

/**
 * `comments.insert` requests a Google project made or will make on the
 * Pacific day of `sendAt`: every attempt may reach Google, and a reply not
 * tried yet counts once. Taken under the provider app's lock.
 */
async function youtubeInserts(executor: Executor, providerAppId: string, sendAt: Date) {
  const pacificDay = (value: unknown) => sql`(${value} at time zone 'America/Los_Angeles')::date`
  const [app] = await executor.select({ count: sql<number>`coalesce(sum(greatest(${replies.attemptCount}, 1)), 0)::int` }).from(replies)
    .innerJoin(channels, eq(channels.id, replies.channelId))
    .where(and(eq(channels.providerAppId, providerAppId), sql`${pacificDay(replies.sendAt)} = ${pacificDay(sql`${sendAt.toISOString()}::timestamptz`)}`, counted))
  return app!.count
}

/**
 * Settles a reply as sent with a platform ID, in a savepoint: false when
 * another reply holds that ID (one reply per platform ID and channel), so
 * the caller can record the conflict in the same transaction.
 */
async function settleSent(executor: Executor, id: string, values: Partial<typeof replies.$inferInsert>) {
  try {
    await executor.transaction(async (savepoint) => {
      await savepoint.update(replies).set(values).where(eq(replies.id, id))
    })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) return false
    throw error
  }
}

/**
 * Accepts an approved reply revision, once. Recomputes the digest and the
 * request key, then checks under the tenant's controls lock what the engine
 * can: the post is published, the answered comment is one of its stored
 * responses, the channel can reply and is neither paused nor missing the
 * permission, the text fits, and the channel (and, on YouTube, the provider
 * app) is within its limits. Repeating a submission returns the stored reply.
 */
export async function submitReply(context: EngineContext, organizationId: string, input: ReplySubmission) {
  const digest = replyDigest(input)
  if (digest !== input.digest) throw invalid('digest_mismatch', 'The text does not match the approved digest')
  if (replyRequestKey(organizationId, input.replyId, input.revision, digest) !== input.requestKey) throw invalid('request_key_mismatch', 'Unexpected request key')
  const sendAt = new Date(input.sendAt)
  if (sendAt.getTime() < Date.parse(input.approvedAt)) throw invalid('invalid_send_at', 'sendAt must not be before approvedAt')
  const approvedVia: ApprovedVia = input.approvedVia ?? 'person'
  return context.db.transaction(async (transaction) => {
    const now = clock(context)
    await lockRequestKey(transaction, organizationId, input.requestKey)
    const [existing] = await transaction.select().from(replies).where(eq(replies.requestKey, input.requestKey)).limit(1)
    if (existing) {
      const same = existing.organizationId === organizationId && existing.replyId === input.replyId && existing.revision === input.revision
        && existing.jobId === input.jobId && existing.parentExternalId === input.parentExternalId && existing.text === input.text
        && existing.approvedByUserId === input.approvedByUserId && existing.approvedAt.getTime() === Date.parse(input.approvedAt)
        && existing.sendAt.getTime() === sendAt.getTime() && existing.approvedVia === approvedVia && existing.draftId === (input.draftId ?? null)
      if (!same) throw conflict('revision_conflict', 'This request key was already submitted with other values')
      return { reply: replyView(existing, await responseIdOf(transaction, existing)), created: false }
    }
    // Cancelled while this submission was on its way: nothing is stored or sent.
    const [tombstone] = await transaction.select().from(replyCancellations)
      .where(and(eq(replyCancellations.organizationId, organizationId), eq(replyCancellations.requestKey, input.requestKey))).limit(1)
    if (tombstone) return { reply: tombstoneView(tombstone, input), created: false }
    const [other] = await transaction.select({ id: replies.id }).from(replies)
      .where(and(eq(replies.organizationId, organizationId), eq(replies.replyId, input.replyId), eq(replies.revision, input.revision))).limit(1)
    if (other) throw conflict('revision_conflict', 'This reply revision was already submitted under another key')
    // Late: it would leave at once, with no time left to cancel it.
    if (now.getTime() - sendAt.getTime() > maxSubmissionLatenessMs) {
      throw conflict('too_late', 'The reply arrived more than five minutes after its send time; approve it again', { maxLatenessMs: maxSubmissionLatenessMs })
    }
    // An automatic send of an engine draft: the engine's own records must allow it (ADR 0004).
    if (approvedVia === 'automation') {
      await checkAutomation(transaction, organizationId, { kind: 'comment', jobId: input.jobId, parentExternalId: input.parentExternalId,
        draftId: input.draftId!, revision: input.revision, digest, sendAt })
    }

    const [job] = await transaction.select().from(jobs).where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, input.jobId))).limit(1)
    const [channel] = job ? await transaction.select().from(channels).where(eq(channels.id, job.channelId)).limit(1) : []
    if (!job || !channel) throw notFound('Job')
    const availability = replyAvailability(context, channel)
    if (!availability.available) {
      if (availability.reason === 'missing_permission') {
        throw conflict('missing_permission', `Replying needs the ${availability.permission} permission; connect the channel again`, { permission: availability.permission })
      }
      if (availability.reason === 'channel_inactive') throw conflict('channel_inactive', 'The channel needs to be reconnected')
      throw conflict('not_supported', 'Replies are not available on this channel')
    }
    const rules = adapterFor(context, channel.platform).replyRules!(channel.kind)!
    if (Array.from(input.text).length > rules.maxLength) {
      throw new EngineError(400, 'text_too_long', `Replies on this channel are at most ${rules.maxLength} characters`, { maxLength: rules.maxLength })
    }
    await lockControls(transaction, organizationId)
    const controls = await readPublishing(transaction, organizationId)
    if (controls.paused || controls.pausedChannelIds.includes(channel.id)) throw conflict('paused', 'Publishing is paused')
    if (job.state !== 'published' || !job.receipt) throw conflict('comment_gone', 'The post is not published on this channel')
    const thread = await threadTop(transaction, channel.id, job.id, input.parentExternalId, rules.deepThreads ?? false)
    if (!thread) throw conflict('comment_gone', 'The comment is not among the post\'s responses')

    // Counted under a lock per channel, and per provider app on YouTube, so concurrent submissions cannot both pass.
    await advisoryLock(transaction, `reply-channel:${channel.id}`)
    const [recent] = await transaction.select({
      hour: sql<number>`count(*) filter (where ${replies.sendAt} > ${new Date(sendAt.getTime() - hourMs)})::int`, day: sql<number>`count(*)::int`,
    }).from(replies).where(and(eq(replies.channelId, channel.id), gt(replies.sendAt, new Date(sendAt.getTime() - 24 * hourMs)), counted))
    if (recent!.hour >= repliesPerChannelHour) throw conflict('rate_limited', `At most ${repliesPerChannelHour} replies an hour on a channel`, { limit: repliesPerChannelHour })
    if (recent!.day >= repliesPerChannelDay) throw conflict('daily_limit', `At most ${repliesPerChannelDay} replies a day on a channel`, { limit: repliesPerChannelDay })
    if (channel.platform === 'youtube' && channel.providerAppId) {
      await advisoryLock(transaction, `reply-app:${channel.providerAppId}`)
      if (await youtubeInserts(transaction, channel.providerAppId, sendAt) >= youtubeRepliesPerDay) {
        throw conflict('daily_limit', `At most ${youtubeRepliesPerDay} YouTube replies a day for this Google project`, { limit: youtubeRepliesPerDay })
      }
    }

    const [created] = await transaction.insert(replies).values({
      organizationId, channelId: channel.id, jobId: job.id, requestKey: input.requestKey, replyId: input.replyId, revision: input.revision, digest,
      parentExternalId: input.parentExternalId, targetExternalId: thread.target, targetResolved: thread.resolved, text: input.text, approvedByUserId: input.approvedByUserId,
      approvedAt: new Date(input.approvedAt), approvedVia, draftId: input.draftId ?? null, sendAt, notBefore: new Date(Math.max(now.getTime(), sendAt.getTime())), createdAt: now, updatedAt: now,
    }).returning()
    await recordEvent(transaction, { organizationId, kind: 'reply.queued', jobId: job.id, channelId: channel.id,
      detail: { replyId: input.replyId, revision: input.revision, approvedByUserId: input.approvedByUserId, approvedVia,
        ...(input.draftId ? { draftId: input.draftId } : {}) } })
    return { reply: replyView(created!), created: true }
  })
}

/**
 * Withdraws a reply the worker has not claimed. The claim and the cancel
 * lock the same row, so exactly one wins. A key the engine has not stored
 * yet is recorded as cancelled, so its submission is refused if it arrives.
 */
export async function cancelReply(context: EngineContext, organizationId: string, requestKey: string) {
  return context.db.transaction(async (transaction) => {
    const now = clock(context)
    await lockRequestKey(transaction, organizationId, requestKey)
    const [found] = await transaction.select().from(replies).where(eq(replies.requestKey, requestKey)).for('update').limit(1)
    if (found && found.organizationId !== organizationId) throw notFound('Reply')
    if (!found) {
      await transaction.insert(replyCancellations).values({ requestKey, organizationId, createdAt: now }).onConflictDoNothing()
      const [tombstone] = await transaction.select().from(replyCancellations)
        .where(and(eq(replyCancellations.requestKey, requestKey), eq(replyCancellations.organizationId, organizationId))).limit(1)
      // The key's tombstone belongs to another tenant: answer as for an unknown reply.
      if (!tombstone) throw notFound('Reply')
      await recordEvent(transaction, { organizationId, kind: 'reply.cancelled_before_submit' })
      return { reply: tombstoneView(tombstone) }
    }
    if (found.state === 'cancelled') return { reply: replyView(found) }
    if (found.state !== 'queued') throw conflict('too_late', 'The reply is already being sent or settled', { state: found.state })
    const [cancelled] = await transaction.update(replies).set({ state: 'cancelled', errorCode: 'cancelled', settledAt: now, updatedAt: now })
      .where(eq(replies.id, found.id)).returning()
    await recordEvent(transaction, { organizationId, kind: 'reply.cancelled', jobId: found.jobId, channelId: found.channelId, detail: { replyId: found.replyId } })
    return { reply: replyView(cancelled!) }
  })
}

/**
 * A person checked the platform for an uncertain reply and says whether it
 * went out. This settles the record; nothing is sent. `not_sent` waits for
 * the 15-minute look: a lost answer usually means the reply exists, and
 * reading it again too soon invites a second one. After `not_sent` the looks
 * go on until the last, and a reply found then overrides the person (the
 * resolution stays, as the record of the conflict).
 */
export async function resolveReply(context: EngineContext, organizationId: string, requestKey: string, outcome: 'sent' | 'not_sent') {
  return context.db.transaction(async (transaction) => {
    const now = clock(context)
    const [found] = await transaction.select().from(replies).where(and(eq(replies.organizationId, organizationId), eq(replies.requestKey, requestKey)))
      .for('update').limit(1)
    if (!found) throw notFound('Reply')
    if (found.state !== 'uncertain') throw conflict('not_uncertain', 'Only an uncertain reply can be resolved', { state: found.state })
    if (outcome === 'not_sent' && !notSentAllowed(found)) {
      throw conflict('still_checking', 'The reply is still being looked for under the comment; it can be marked as not sent after the 15-minute look',
        { state: found.state, misses: found.reconcileMisses })
    }
    const [settled] = await transaction.update(replies).set(outcome === 'sent'
      ? { state: 'sent', errorCode: null, reconciling: false, resolution: 'sent', settledBy: 'operator', settledAt: now, updatedAt: now }
      : { state: 'failed', errorCode: 'resolved_not_sent', resolution: 'not_sent', settledBy: 'operator', settledAt: now, updatedAt: now })
      .where(eq(replies.id, found.id)).returning()
    await recordEvent(transaction, { organizationId, kind: 'reply.resolved', jobId: found.jobId, channelId: found.channelId,
      detail: { outcome, stillLooking: settled!.reconciling } })
    await emitReplyOutcome(transaction, found.id, now)
    return { reply: replyView(settled!, await responseIdOf(transaction, settled!)) }
  })
}

/** The tenant's replies with these request keys; keys cancelled before they arrived come back as cancelled. */
export async function listReplies(context: EngineContext, organizationId: string, requestKeys: string[]) {
  if (!requestKeys.length) return []
  const rows = await context.db.select({ reply: replies, responseId: postResponses.id }).from(replies)
    .leftJoin(postResponses, and(eq(postResponses.channelId, replies.channelId), eq(postResponses.externalId, replies.platformReplyId)))
    .where(and(eq(replies.organizationId, organizationId), inArray(replies.requestKey, requestKeys)))
  const known = new Set(rows.map(row => row.reply.requestKey))
  const missing = requestKeys.filter(key => !known.has(key))
  const tombstones = missing.length ? await context.db.select().from(replyCancellations)
    .where(and(eq(replyCancellations.organizationId, organizationId), inArray(replyCancellations.requestKey, missing))) : []
  return [...rows.map(row => replyView(row.reply, row.responseId)), ...tombstones.map(row => tombstoneView(row))]
}

export interface ClaimedReply {
  id: string
  organizationId: string
  attemptedAt: Date
}

/**
 * Claims one due reply. Pause and channel state are re-checked under the
 * lock that pause updates take, and `sending` with its lease commits before
 * the platform is called: a crash leaves a lease for the sweeper.
 */
export async function claimNextReply(context: EngineContext): Promise<ClaimedReply | null> {
  for (let skipped = 0; skipped < 50; skipped++) {
    const result = await context.db.transaction(async (transaction) => {
      const now = clock(context)
      const [reply] = await transaction.select().from(replies).where(and(eq(replies.state, 'queued'), lte(replies.notBefore, now)))
        .orderBy(asc(replies.notBefore)).limit(1).for('update', { skipLocked: true })
      if (!reply) return null
      await lockControls(transaction, reply.organizationId)
      const controls = await readPublishing(transaction, reply.organizationId)
      const [channel] = await transaction.select({ status: channels.status, platform: channels.platform, providerAppId: channels.providerAppId })
        .from(channels).where(eq(channels.id, reply.channelId)).limit(1)
      let refusal = controls.paused || controls.pausedChannelIds.includes(reply.channelId) ? 'paused'
        : channel?.status !== 'active' ? 'channel_inactive'
          : now.getTime() - reply.sendAt.getTime() > maxReplyLatenessMs ? 'too_late' : null
      // Submission counted one insert; each try after it may reach Google too, so it needs room in the day's inserts.
      if (!refusal && reply.attemptCount > 0 && channel?.platform === 'youtube' && channel.providerAppId) {
        await advisoryLock(transaction, `reply-app:${channel.providerAppId}`)
        if (await youtubeInserts(transaction, channel.providerAppId, reply.sendAt) >= youtubeRepliesPerDay) refusal = 'daily_limit'
      }
      if (refusal) {
        const state: ReplyState = refusal === 'paused' ? 'cancelled' : 'failed'
        await transaction.update(replies).set({ state, errorCode: refusal, settledAt: now, updatedAt: now }).where(eq(replies.id, reply.id))
        await recordEvent(transaction, { organizationId: reply.organizationId, kind: `reply.${state}`, jobId: reply.jobId, channelId: reply.channelId, detail: { reason: refusal } })
        await emitReplyOutcome(transaction, reply.id, now)
        return 'skipped' as const
      }
      await transaction.update(replies).set({ state: 'sending', attemptCount: reply.attemptCount + 1, attemptedAt: now,
        leaseUntil: new Date(now.getTime() + replyLeaseMs), updatedAt: now }).where(eq(replies.id, reply.id))
      await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.sending', jobId: reply.jobId, channelId: reply.channelId,
        detail: { attempt: reply.attemptCount + 1 } })
      return { id: reply.id, organizationId: reply.organizationId, attemptedAt: now }
    })
    if (result !== 'skipped') return result
  }
  return null
}

/**
 * Makes the one platform request of a claimed reply and records its
 * outcome. A worker whose claim ran out before the request (the sweeper
 * already made the reply uncertain) sends nothing and records nothing.
 */
export async function executeReply(context: EngineContext, claimed: ClaimedReply): Promise<ReplyOutcome> {
  let outcome: ReplyOutcome | null
  try {
    outcome = await sendClaimed(context, claimed)
  } catch (error) {
    // Unexpected failure inside the adapter: the reply may exist.
    log('error', 'reply send threw', { replyId: claimed.id, ...errorFields(error) })
    outcome = { kind: 'uncertain', code: 'internal', detail: 'Unexpected error during the reply' }
  }
  if (!outcome) {
    log('warn', 'reply claim lost before the platform request; nothing sent', { replyId: claimed.id })
    await recordEvent(context.db, { organizationId: claimed.organizationId, kind: 'reply.claim_lost', detail: { replyId: claimed.id } })
    return { kind: 'failed', retryable: false, code: 'claim_lost', detail: 'The claim ran out before the platform request' }
  }
  await settleReply(context, claimed, outcome)
  return outcome
}

/** The platform request of a claimed reply; null when the claim no longer holds just before it, so nothing was sent. */
async function sendClaimed(context: EngineContext, claimed: ClaimedReply): Promise<ReplyOutcome | null> {
  const [reply] = await context.db.select().from(replies).where(eq(replies.id, claimed.id)).limit(1)
  const [channel] = reply ? await context.db.select().from(channels).where(eq(channels.id, reply.channelId)).limit(1) : []
  const [job] = reply ? await context.db.select({ receipt: jobs.receipt }).from(jobs).where(eq(jobs.id, reply.jobId)).limit(1) : []
  if (!reply || !channel || !job?.receipt) return { kind: 'failed', retryable: false, code: 'comment_gone', detail: 'Reply, channel or post missing' }
  const adapter = adapterFor(context, channel.platform)
  if (!adapter.reply) return { kind: 'failed', retryable: false, code: 'not_supported', detail: channel.platform }
  // Nothing has been sent yet: a token renewal that failed in transit can be tried again.
  let driver
  try {
    driver = await channelDriver(context, context.db, channel)
  } catch (error) {
    if (error instanceof TransientCredentialError) return { kind: 'failed', retryable: true, code: 'token_refresh_failed', detail: error.message }
    return { kind: 'failed', retryable: false, code: 'channel_inactive', detail: error instanceof Error ? error.message : 'Channel unavailable' }
  }
  let target = reply.targetExternalId
  if (!reply.targetResolved) {
    // A Facebook thread older than the stored responses: read its top-level comment first. Reads send nothing.
    if (!adapter.replyTarget) return { kind: 'failed', retryable: false, code: 'comment_gone', detail: 'The thread cannot be read on this channel' }
    const top = await adapter.replyTarget(driver.app, { channel: channelTarget(channel), token: driver.token, commentExternalId: target })
    if (top.kind !== 'top') return top
    target = top.externalId
  }
  // The claim must still hold just before the request: a worker that stalled
  // past its lease must not send what the sweeper already made uncertain. A
  // fresh lease covers the request itself.
  const now = clock(context)
  const [held] = await context.db.update(replies).set({ leaseUntil: new Date(now.getTime() + replyLeaseMs), targetExternalId: target, targetResolved: true, updatedAt: now })
    .where(and(eq(replies.id, claimed.id), eq(replies.state, 'sending'), eq(replies.attemptedAt, claimed.attemptedAt), gt(replies.leaseUntil, now)))
    .returning({ id: replies.id })
  if (!held) return null
  return adapter.reply(driver.app, { channel: channelTarget(channel), token: driver.token, postExternalId: job.receipt.externalId,
    targetExternalId: target, text: reply.text })
}

/** A confirmed reply settles the record even when it arrives late: after the sweeper made it uncertain, after a person said it did not go out (the conflict is kept), or after a person said it did (its platform ID is recorded). */
function settlesLate(reply: Reply, outcome: ReplyOutcome) {
  return outcome.kind === 'sent' && (reply.state === 'uncertain' || (reply.state === 'failed' && reply.errorCode === 'resolved_not_sent')
    || (reply.state === 'sent' && !reply.platformReplyId))
}

/**
 * Records a send's outcome. A confirmed reply settles it even after the
 * sweeper made it uncertain or a person resolved it (`settlesLate`);
 * anything else that arrives late is left to reconciliation.
 */
export async function settleReply(context: EngineContext, claimed: ClaimedReply, outcome: ReplyOutcome) {
  await context.db.transaction(async (transaction) => {
    const now = clock(context)
    const [reply] = await transaction.select().from(replies).where(eq(replies.id, claimed.id)).for('update').limit(1)
    if (!reply || reply.attemptedAt?.getTime() !== claimed.attemptedAt.getTime()) return
    if (reply.state !== 'sending' && !settlesLate(reply, outcome)) {
      await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.late_outcome', jobId: reply.jobId, channelId: reply.channelId,
        detail: { outcome: outcome.kind } })
      return
    }
    let values: Partial<typeof replies.$inferInsert>
    if (outcome.kind === 'sent') {
      values = { state: 'sent', platformReplyId: outcome.externalId, url: outcome.url ?? null, errorCode: null, reconciling: false, settledBy: 'worker', settledAt: now }
      if (!await settleSent(transaction, reply.id, { ...values, leaseUntil: null, updatedAt: now })) {
        // Another reply holds this platform ID, which cannot be both replies': a person decides.
        if (reply.state === 'sending') {
          await transaction.update(replies).set({ state: 'uncertain', errorCode: 'platform_id_conflict', reconciling: false, leaseUntil: null, updatedAt: now })
            .where(eq(replies.id, reply.id))
        }
        await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.platform_id_conflict', jobId: reply.jobId, channelId: reply.channelId,
          detail: { platformReplyId: outcome.externalId } })
        return
      }
      if (reply.resolution === 'not_sent') {
        await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.resolution_overridden', jobId: reply.jobId, channelId: reply.channelId,
          detail: { resolution: 'not_sent', settledBy: 'worker' } })
      }
    } else if (outcome.kind === 'uncertain') {
      values = { state: 'uncertain', errorCode: outcome.code, reconciling: true, reconcileCount: 0, reconcileMisses: 0,
        notBefore: new Date(Math.max(now.getTime(), claimed.attemptedAt.getTime() + replyReconcileDelaysMs[0]!)) }
    } else if (outcome.retryable && reply.attemptCount < maxReplyAttempts && now.getTime() - reply.sendAt.getTime() < maxReplyLatenessMs) {
      values = { state: 'queued', errorCode: outcome.code, notBefore: new Date(now.getTime() + replyRetryDelayMs(reply.attemptCount)) }
    } else {
      values = { state: 'failed', errorCode: outcome.code, permission: outcome.permission ?? null, settledAt: now }
    }
    if (outcome.kind !== 'sent') await transaction.update(replies).set({ ...values, leaseUntil: null, updatedAt: now }).where(eq(replies.id, reply.id))
    if (outcome.kind === 'failed' && outcome.permission) {
      // Replies stay unavailable on the channel until it connects again.
      await transaction.update(channels).set({ refusedScopes: sql`array(select distinct unnest(${channels.refusedScopes} || array[${outcome.permission}]::text[]))`,
        updatedAt: now }).where(eq(channels.id, reply.channelId))
    }
    if (outcome.kind === 'failed' && outcome.reauth) {
      await changeChannelStatus(transaction, reply.channelId, 'needs_reauth', 'reply_refused', now)
      await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'channel.needs_reauth', channelId: reply.channelId, detail: { reason: 'reply_refused' } })
    }
    if (outcome.kind === 'sent') {
      // Read the post's responses within 30 s, so the reply shows up and links back.
      await transaction.update(responseChecks).set({ nextCheckAt: sql`least(${responseChecks.nextCheckAt}, ${new Date(now.getTime() + 30_000)}::timestamptz)`, updatedAt: now })
        .where(and(eq(responseChecks.jobId, reply.jobId), inArray(responseChecks.state, ['ok', 'pending'])))
    }
    await recordEvent(transaction, { organizationId: reply.organizationId, kind: `reply.${values.state}`, jobId: reply.jobId, channelId: reply.channelId,
      detail: outcome.kind === 'sent' ? { platformReplyId: outcome.externalId } : { code: outcome.code } })
    // A reply a person already said was sent is not announced twice.
    if ((values.state === 'sent' || values.state === 'failed') && reply.state !== values.state) await emitReplyOutcome(transaction, reply.id, now)
    else if (values.state === 'uncertain') await queueControlEvent(transaction, 'replies.changed', reply.organizationId, now)
  })
}

/** Replies whose worker vanished after the claim: the request may have been made, so they become uncertain. */
export async function sweepReplies(context: EngineContext) {
  const now = clock(context)
  return context.db.transaction(async (transaction) => {
    const open = await transaction.select().from(replies).where(and(eq(replies.state, 'sending'), lt(replies.leaseUntil, now)))
      .limit(100).for('update', { skipLocked: true })
    for (const reply of open) {
      const first = (reply.attemptedAt ?? now).getTime() + replyReconcileDelaysMs[0]!
      await transaction.update(replies).set({ state: 'uncertain', errorCode: 'abandoned', reconciling: true, reconcileCount: 0, reconcileMisses: 0, leaseUntil: null,
        notBefore: new Date(Math.max(now.getTime(), first)), updatedAt: now }).where(eq(replies.id, reply.id))
      await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.uncertain', jobId: reply.jobId, channelId: reply.channelId,
        detail: { reason: 'abandoned' } })
      await queueControlEvent(transaction, 'replies.changed', reply.organizationId, now)
    }
    return open.map(reply => reply.id)
  })
}

/** A reply still being looked for: uncertain, or said not sent by a person before the last look. */
const lookingFor = and(eq(replies.reconciling, true), inArray(replies.state, ['uncertain', 'failed']))

/**
 * Another reply that may own a match found for `reply`: under the same
 * comment, with the same normalised text, attempted late enough for its
 * reply to fall in the same window, and either still unsettled (in flight,
 * uncertain, or said not sent while still looked for) or settled as sent
 * without a platform ID. With one, the match proves nothing about `reply`.
 */
async function rivalFor(executor: Executor, reply: Reply) {
  const attempted = (reply.attemptedAt ?? reply.updatedAt).getTime()
  const others = await executor.select({ id: replies.id, text: replies.text }).from(replies).where(and(
    eq(replies.channelId, reply.channelId), eq(replies.targetExternalId, reply.targetExternalId), ne(replies.id, reply.id),
    gte(replies.attemptedAt, new Date(attempted - 2 * replyReconcileSkewMs)),
    or(inArray(replies.state, ['sending', 'uncertain']), and(eq(replies.state, 'failed'), eq(replies.reconciling, true)),
      and(eq(replies.state, 'sent'), isNull(replies.platformReplyId)))))
  const text = normalizeReplyText(reply.text)
  return others.find(other => normalizeReplyText(other.text) === text) ?? null
}

/**
 * Looks on the platform for replies whose next check is due: uncertain
 * ones, and those a person said did not go out, until the last look. One
 * reply by the channel's own account under the same comment, with the same
 * text, since the attempt, and no other reply that may own it, settles it
 * as sent (overriding a person's "not sent", which stays recorded). Several,
 * or a rival reply, stop the checks (`ambiguous`); after the last check it
 * waits for a person. Never sends. Each page read is charged to the budget;
 * a platform out of its daily share is left out without holding up others.
 */
export async function reconcileDueReplies(context: EngineContext, budget?: CallBudget, limit = reconcilesPerPass) {
  const now = clock(context)
  const blocked = budget ? [...context.adapters.keys()].filter(platform => !budget.allows(platform)) : []
  const due = await context.db.select({ reply: replies, channel: channels, receipt: jobs.receipt }).from(replies)
    .innerJoin(channels, eq(channels.id, replies.channelId)).innerJoin(jobs, eq(jobs.id, replies.jobId))
    .where(and(lookingFor, lte(replies.notBefore, now), blocked.length ? notInArray(channels.platform, blocked) : undefined))
    .orderBy(asc(replies.notBefore)).limit(limit)
  let found = 0
  for (const { reply, channel, receipt } of due) {
    // The minute bucket is shared by every platform: when it is empty, the rest wait for the next pass.
    if (budget && !budget.take(channel.platform)) break
    const check = reply.reconcileCount + 1
    const attempted = (reply.attemptedAt ?? reply.updatedAt).getTime()
    const nextDelay = replyReconcileDelaysMs[check]
    // Claims this check first, so a crash does not repeat it at once.
    const [claimed] = await context.db.update(replies).set({ reconcileCount: check, updatedAt: clock(context),
      notBefore: new Date(nextDelay === undefined ? now.getTime() + hourMs : Math.max(now.getTime(), attempted + nextDelay)) })
      .where(and(eq(replies.id, reply.id), lookingFor, eq(replies.reconcileCount, reply.reconcileCount))).returning({ id: replies.id })
    if (!claimed) continue
    const stopLooking = (transaction: Executor, values: Partial<typeof replies.$inferInsert> = {}) => transaction.update(replies)
      .set({ reconciling: false, updatedAt: clock(context), ...values }).where(and(eq(replies.id, reply.id), lookingFor))
    try {
      const adapter = adapterFor(context, channel.platform)
      if (!adapter.findReply || !receipt) throw new Error('Replies cannot be looked up on this channel')
      const driver = await channelDriver(context, context.db, channel)
      const others = await context.db.select({ id: replies.platformReplyId }).from(replies)
        .where(and(eq(replies.channelId, channel.id), ne(replies.id, reply.id), isNotNull(replies.platformReplyId)))
      const result = await adapter.findReply(driver.app, { channel: channelTarget(channel), token: driver.token, postExternalId: receipt.externalId,
        targetExternalId: reply.targetExternalId, text: reply.text, since: new Date(attempted - replyReconcileSkewMs),
        excludeExternalIds: others.flatMap(row => row.id ? [row.id] : []), ...(budget ? { spendCall: () => budget.spend(channel.platform) } : {}) })
      if (await recordLook(context, reply, result, nextDelay === undefined)) found++
    } catch (error) {
      if (error instanceof RateLimited) {
        // A rate limit is not a check: look again in an hour.
        await context.db.update(replies).set({ reconcileCount: reply.reconcileCount, notBefore: new Date(clock(context).getTime() + hourMs), updatedAt: clock(context) })
          .where(and(eq(replies.id, reply.id), lookingFor))
      } else if (nextDelay === undefined) {
        await stopLooking(context.db)
      }
      log('warn', 'reply reconcile failed', { replyId: reply.id, check, ...errorFields(error) })
    }
  }
  return { checked: due.length, found }
}

/**
 * Records one look under the reply's comment, checking under the reply's
 * row lock what the platform read cannot know: whether the match was taken
 * by another reply meanwhile, or another reply may own it. True when the
 * look settled the reply as sent.
 */
async function recordLook(context: EngineContext, looked: Reply, result: FindReplyOutcome, last: boolean) {
  return context.db.transaction(async (transaction) => {
    const at = clock(context)
    const [reply] = await transaction.select().from(replies).where(and(eq(replies.id, looked.id), lookingFor)).for('update').limit(1)
    if (!reply) return false
    let outcome = result
    if (outcome.kind === 'found') {
      const rival = await rivalFor(transaction, reply)
      if (rival) {
        outcome = { kind: 'ambiguous', detail: 'Another reply with the same text under this comment may own the match' }
        await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.reconciled.rival', jobId: reply.jobId, channelId: reply.channelId,
          detail: { rivalReplyId: rival.id } })
      }
    }
    // The person's answer stays on a reply they said did not go out; only an uncertain one is marked ambiguous.
    const ambiguousCode = reply.state === 'uncertain' ? { errorCode: 'ambiguous' } : {}
    // A match another reply took meanwhile is not this reply's: the look counts as a miss.
    if (outcome.kind === 'found' && await settleSent(transaction, reply.id, { state: 'sent', platformReplyId: outcome.externalId, url: outcome.url ?? reply.url,
      errorCode: null, reconciling: false, settledBy: 'reconcile', settledAt: at, updatedAt: at })) {
      await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.reconciled.sent', jobId: reply.jobId, channelId: reply.channelId,
        detail: { platformReplyId: outcome.externalId, ...(reply.resolution === 'not_sent' ? { overrides: 'resolved_not_sent' } : {}) } })
      if (reply.state !== 'sent') await emitReplyOutcome(transaction, reply.id, at)
      return true
    }
    if (outcome.kind === 'ambiguous') {
      await transaction.update(replies).set({ reconciling: false, ...ambiguousCode, updatedAt: at }).where(eq(replies.id, reply.id))
      await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.reconciled.ambiguous', jobId: reply.jobId, channelId: reply.channelId })
      return false
    }
    // Nothing found: one more miss, and after the last look a person decides.
    await transaction.update(replies).set({ reconcileMisses: reply.reconcileMisses + 1, ...(last ? { reconciling: false } : {}), updatedAt: at })
      .where(eq(replies.id, reply.id))
    if (last) await recordEvent(transaction, { organizationId: reply.organizationId, kind: 'reply.reconciled.not_found', jobId: reply.jobId, channelId: reply.channelId })
    return false
  })
}

/** One pass of the worker: sends due replies one after another, then looks for uncertain ones. */
export async function runReplies(context: EngineContext, budget?: CallBudget) {
  let sent = 0
  for (let index = 0; index < repliesPerPass; index++) {
    const claimed = await claimNextReply(context)
    if (!claimed) break
    const outcome = await executeReply(context, claimed)
    log('info', 'reply attempt finished', { replyId: claimed.id, outcome: outcome.kind, ...(outcome.kind === 'sent' ? {} : { code: outcome.code }) })
    sent++
  }
  const reconciled = await reconcileDueReplies(context, budget)
  return { sent, reconciled }
}
