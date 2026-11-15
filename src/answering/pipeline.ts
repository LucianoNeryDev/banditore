import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import { clock, recordEvent, type EngineContext } from '../context.js'
import type { Executor } from '../db/client.js'
import {
  answeringSettings, channels, conversations, directMessages, inboundDrafts, jobs, outgoingMessages, postResponses,
  type AnsweringContextEntry, type AnsweringSettings, type DraftKind, type Platform,
} from '../db/schema.js'
import { queueControlEvent } from '../control-events.js'
import { errorFields, log } from '../log.js'
import { messageDigest } from '../messages.js'
import { replyDigest } from '../replies.js'
import { decide, type Decision, type DecisionItem } from './decision.js'
import { DraftError, draftFits, draftLimits, type DraftInput, type DraftOutput, type HistoryMessage, type ThreadItem } from './drafting.js'

// The answering step: decide, then draft, for inbound DMs and comments the
// readers stored. It runs in its own worker pass, after the readers committed,
// and never inside them: the readers hold no drafting code, and this step
// holds no sending code. All it writes is a decision and a draft (ADR 0004).

const hourMs = 60 * 60_000
const dayMs = 24 * hourMs
/** How often the worker looks for new inbound items, and how many it handles per pass. */
export const answeringIntervalMs = 15_000
const itemsPerPass = 10
/** Only comments under posts published this recently are answered. */
export const commentPostAgeMs = 7 * dayMs
/** A DM older than this cannot be answered any more (the answering window). */
const messageWindowMs = dayMs
/** At most this many ancestors of a comment are read. */
const maxThreadDepth = 10

type Tenant = typeof answeringSettings.$inferSelect & { draftsEnabledAt: Date }

interface MessageCandidate {
  kind: 'message'
  tenant: Tenant
  channel: typeof channels.$inferSelect
  conversation: typeof conversations.$inferSelect
  message: typeof directMessages.$inferSelect
}
interface CommentCandidate {
  kind: 'comment'
  tenant: Tenant
  channel: typeof channels.$inferSelect
  response: typeof postResponses.$inferSelect
  job: typeof jobs.$inferSelect
}
type Candidate = MessageCandidate | CommentCandidate

function platformsWith(context: EngineContext, capability: 'sendMessage' | 'reply') {
  return [...context.adapters].filter(([, adapter]) => adapter[capability]).map(([platform]) => platform) as Platform[]
}

/**
 * New direct messages to answer: per conversation, the person's newest
 * message, first seen after `drafts` was switched on and sent within the
 * answering window, that has no decision yet and that the brand has not
 * answered since. Several new messages in one conversation make one item:
 * the newest (coalescing).
 */
export async function messageCandidates(context: EngineContext, tenant: Tenant, now: Date, limit: number): Promise<MessageCandidate[]> {
  const platforms = platformsWith(context, 'sendMessage')
  if (!platforms.length) return []
  const newest = context.db.selectDistinctOn([directMessages.conversationId], { id: directMessages.id, conversationId: directMessages.conversationId,
    externalId: directMessages.externalId, sentAt: directMessages.sentAt, firstSeenAt: directMessages.firstSeenAt })
    .from(directMessages)
    .where(and(eq(directMessages.organizationId, tenant.organizationId), eq(directMessages.direction, 'in'),
      gte(directMessages.firstSeenAt, tenant.draftsEnabledAt), gt(directMessages.sentAt, new Date(now.getTime() - messageWindowMs))))
    .orderBy(directMessages.conversationId, desc(directMessages.sentAt), desc(directMessages.id)).as('newest')
  const rows = await context.db.select({ id: newest.id }).from(newest)
    .where(and(
      sql`not exists (select 1 from ${inboundDrafts} where ${inboundDrafts.conversationId} = ${newest.conversationId}
        and ${inboundDrafts.inboundExternalId} = ${newest.externalId} and ${inboundDrafts.kind} = 'message')`,
      sql`not exists (select 1 from ${directMessages} answered where answered.conversation_id = ${newest.conversationId}
        and answered.direction = 'out' and answered.sent_at > ${newest.sentAt})`))
    .orderBy(asc(newest.firstSeenAt)).limit(limit)
  if (!rows.length) return []
  const found = await context.db.select({ message: directMessages, conversation: conversations, channel: channels }).from(directMessages)
    .innerJoin(conversations, eq(conversations.id, directMessages.conversationId)).innerJoin(channels, eq(channels.id, directMessages.channelId))
    .where(and(inArray(directMessages.id, rows.map(row => row.id)), eq(channels.status, 'active'), inArray(channels.platform, platforms)))
    .orderBy(asc(directMessages.firstSeenAt))
  return found.map(row => ({ kind: 'message', tenant, ...row }))
}

/**
 * New comments to answer: written by someone other than the channel,
 * first seen after `drafts` was switched on, under a post published at most
 * seven days ago, without a decision yet.
 */
export async function commentCandidates(context: EngineContext, tenant: Tenant, now: Date, limit: number): Promise<CommentCandidate[]> {
  const platforms = platformsWith(context, 'reply')
  if (!platforms.length) return []
  const rows = await context.db.select({ response: postResponses, job: jobs, channel: channels }).from(postResponses)
    .innerJoin(jobs, eq(jobs.id, postResponses.jobId)).innerJoin(channels, eq(channels.id, postResponses.channelId))
    .where(and(eq(postResponses.organizationId, tenant.organizationId), eq(postResponses.fromChannel, false),
      gte(postResponses.firstSeenAt, tenant.draftsEnabledAt), gte(jobs.publishAt, new Date(now.getTime() - commentPostAgeMs)),
      eq(jobs.state, 'published'), eq(channels.status, 'active'), inArray(channels.platform, platforms),
      sql`not exists (select 1 from ${inboundDrafts} where ${inboundDrafts.responseId} = ${postResponses.id} and ${inboundDrafts.kind} = 'comment')`))
    .orderBy(asc(postResponses.firstSeenAt), asc(postResponses.id)).limit(limit)
  return rows.map(row => ({ kind: 'comment', tenant, ...row }))
}

/** The conversation's newest messages up to and including the one answered, oldest first. */
export async function conversationHistory(executor: Executor, conversationId: string, upTo?: Date): Promise<HistoryMessage[]> {
  const rows = await executor.select({ direction: directMessages.direction, text: directMessages.text, attachments: directMessages.attachments,
    sentAt: directMessages.sentAt }).from(directMessages)
    .where(and(eq(directMessages.conversationId, conversationId), upTo ? sql`${directMessages.sentAt} <= ${upTo}` : undefined))
    .orderBy(desc(directMessages.sentAt), desc(directMessages.id)).limit(draftLimits.historyMessages)
  return rows.reverse().map(row => ({ direction: row.direction, text: row.text, attachments: row.attachments.map(item => item.type), sentAt: row.sentAt }))
}

/**
 * The comments above one, from the stored responses (oldest first), and the
 * channel's own replies in that chain written before it.
 */
export async function commentThread(executor: Executor, response: typeof postResponses.$inferSelect): Promise<ThreadItem[]> {
  const chain: Array<typeof postResponses.$inferSelect> = []
  let parent = response.parentExternalId
  for (let depth = 0; parent && depth < maxThreadDepth; depth++) {
    const [row] = await executor.select().from(postResponses)
      .where(and(eq(postResponses.channelId, response.channelId), eq(postResponses.externalId, parent))).limit(1)
    if (!row) break
    chain.push(row)
    parent = row.parentExternalId
  }
  const ids = [...chain.map(row => row.externalId)]
  const brand = ids.length ? await executor.select().from(postResponses)
    .where(and(eq(postResponses.channelId, response.channelId), inArray(postResponses.parentExternalId, ids), eq(postResponses.fromChannel, true),
      lt(postResponses.publishedAt, response.publishedAt), ne(postResponses.id, response.id)))
    .orderBy(desc(postResponses.publishedAt)).limit(draftLimits.threadItems) : []
  return [...chain, ...brand].filter((row, index, all) => all.findIndex(other => other.id === row.id) === index)
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime()).slice(-draftLimits.threadItems)
    .map(row => ({ fromChannel: row.fromChannel === true, author: row.authorHandle ?? row.authorName, text: row.text, publishedAt: row.publishedAt }))
}

/** The longest text the channel takes for this kind, or null when the adapter says nothing. */
export function channelMaxLength(context: EngineContext, channel: Pick<typeof channels.$inferSelect, 'platform' | 'kind'>, kind: DraftKind): DraftInput['maxLength'] {
  const adapter = context.adapters.get(channel.platform)
  if (kind === 'message') {
    const rules = adapter?.messageRules?.(channel.kind)
    return rules ? { value: rules.maxLength, unit: rules.unit } : null
  }
  const rules = adapter?.replyRules?.(channel.kind)
  return rules ? { value: rules.maxLength, unit: 'characters' } : null
}

/** The drafting input for an item; the same context serves a revision. */
export async function draftInputFor(context: EngineContext, item: { kind: 'message', channel: typeof channels.$inferSelect, conversationId: string, upTo?: Date }
  | { kind: 'comment', channel: typeof channels.$inferSelect, response: typeof postResponses.$inferSelect, job: typeof jobs.$inferSelect },
settings: Pick<AnsweringSettings, 'voice' | 'replyContext'> | null, entries: AnsweringContextEntry[], requireDraft: boolean): Promise<DraftInput> {
  const base = { kind: item.kind, channel: { name: item.channel.name, platform: item.channel.platform }, voice: settings?.voice ?? '',
    replyContext: settings?.replyContext ?? '', context: entries, maxLength: channelMaxLength(context, item.channel, item.kind), requireDraft }
  if (item.kind === 'message') return { ...base, history: await conversationHistory(context.db, item.conversationId, item.upTo) }
  return { ...base, post: item.job.payload.content, thread: await commentThread(context.db, item.response),
    comment: { author: item.response.authorHandle ?? item.response.authorName, text: item.response.text, publishedAt: item.response.publishedAt } }
}

interface Drafted {
  decision: Decision
  draft: { text: string, model: string, output: DraftOutput } | null
  draftErrorCode: string | null
}

/**
 * Decides an item, then drafts it unless the decision is `none`. Without a
 * drafting model there is no draft. A cleared (`auto`) item without a usable
 * draft goes to a person (`no_draft`, `draft_too_long`).
 */
async function decideAndDraft(context: EngineContext, candidate: Candidate): Promise<Drafted> {
  const { settings, context: entries } = candidate.tenant
  const item: DecisionItem = candidate.kind === 'message'
    ? { kind: 'message', channel: { id: candidate.channel.id, name: candidate.channel.name, platform: candidate.channel.platform },
      author: { name: candidate.conversation.participantName, handle: candidate.conversation.participantUsername }, text: candidate.message.text,
      attachments: candidate.message.attachments.map(value => value.type) }
    : { kind: 'comment', channel: { id: candidate.channel.id, name: candidate.channel.name, platform: candidate.channel.platform },
      author: { name: candidate.response.authorName, handle: candidate.response.authorHandle }, text: candidate.response.text, attachments: [],
      post: candidate.job.payload.content }
  let decision = await decide({ settings, context: entries, item, flagged: item.attachments.length > 0, model: context.decisionModel })
  if (decision.outcome === 'none') return { decision, draft: null, draftErrorCode: null }
  if (!context.draftModel) {
    return { decision: decision.outcome === 'auto' ? { ...decision, outcome: 'review', reason: 'no_draft' } : decision, draft: null, draftErrorCode: null }
  }
  const input = await draftInputFor(context, candidate.kind === 'message'
    ? { kind: 'message', channel: candidate.channel, conversationId: candidate.conversation.id, upTo: candidate.message.sentAt }
    : { kind: 'comment', channel: candidate.channel, response: candidate.response, job: candidate.job }, settings, entries, decision.outcome === 'auto')
  try {
    const result = await context.draftModel.draft(input, settings.replyModel)
    const text = result.output.reply
    if (decision.outcome === 'auto' && !text) decision = { ...decision, outcome: 'review', reason: 'no_draft' }
    else if (decision.outcome === 'auto' && text && !draftFits(input.maxLength, text)) decision = { ...decision, outcome: 'review', reason: 'draft_too_long' }
    return { decision, draft: text ? { text, model: result.model, output: result.output } : null, draftErrorCode: null }
  } catch (error) {
    log('warn', 'drafting failed', { kind: candidate.kind, channelId: candidate.channel.id, ...errorFields(error) })
    if (decision.outcome === 'auto') decision = { ...decision, outcome: 'review', reason: 'no_draft' }
    return { decision, draft: null, draftErrorCode: error instanceof DraftError ? error.code : 'error' }
  }
}

/**
 * Stores one decision and draft, once (a second worker's insert does
 * nothing). A new DM draft supersedes the conversation's older ones that no
 * automatic send has taken: they come back in the outbox with `superseded`.
 * The control plane is told after the commit.
 */
async function storeDraft(context: EngineContext, candidate: Candidate, drafted: Drafted) {
  return context.db.transaction(async transaction => {
    const now = clock(context)
    const { decision, draft } = drafted
    const digest = !draft ? null : candidate.kind === 'message'
      ? messageDigest({ conversationId: candidate.conversation.id, text: draft.text })
      : replyDigest({ jobId: candidate.job.id, parentExternalId: candidate.response.externalId, text: draft.text })
    const target = candidate.kind === 'message'
      ? { conversationId: candidate.conversation.id, inboundExternalId: candidate.message.externalId }
      : { responseId: candidate.response.id, inboundExternalId: candidate.response.externalId }
    const [created] = await transaction.insert(inboundDrafts).values({
      organizationId: candidate.tenant.organizationId, channelId: candidate.channel.id, kind: candidate.kind, ...target,
      outcome: decision.outcome, reason: decision.reason, decisionModel: decision.model, probabilities: decision.probabilities,
      confidence: decision.confidence, caseId: decision.caseId, decisionThreshold: decision.decisionThreshold, noneThreshold: decision.noneThreshold,
      cost: decision.cost, errorCode: decision.errorCode, draftText: draft?.text ?? null, draftDigest: digest, draftModel: draft?.model ?? null,
      draftLanguage: draft?.output.language.slice(0, 16) ?? null, draftFlags: draft?.output.flags ?? [], draftErrorCode: drafted.draftErrorCode,
      settingsVersion: candidate.tenant.version, outboxPending: true, outboxAt: now, createdAt: now,
    }).onConflictDoNothing().returning({ id: inboundDrafts.id })
    if (!created) return null
    if (candidate.kind === 'message') {
      const taken = sql`exists (select 1 from ${outgoingMessages} where ${outgoingMessages.draftId} = ${inboundDrafts.id})`
      await transaction.update(inboundDrafts).set({ supersededBy: created.id, supersededAt: now, outboxPending: true, outboxAt: now })
        .where(and(eq(inboundDrafts.conversationId, candidate.conversation.id), eq(inboundDrafts.kind, 'message'), ne(inboundDrafts.id, created.id),
          isNull(inboundDrafts.supersededBy), sql`not ${taken}`))
    }
    await recordEvent(transaction, { organizationId: candidate.tenant.organizationId, kind: 'draft.created', channelId: candidate.channel.id,
      detail: { draftId: created.id, kind: candidate.kind, outcome: decision.outcome, reason: decision.reason, model: decision.model,
        probabilities: decision.probabilities, confidence: decision.confidence, caseId: decision.caseId, cost: decision.cost,
        errorCode: decision.errorCode, drafted: Boolean(draft), draftModel: draft?.model ?? null, draftErrorCode: drafted.draftErrorCode,
        flags: draft?.output.flags ?? [], settingsVersion: candidate.tenant.version } })
    await queueControlEvent(transaction, 'drafts.available', candidate.tenant.organizationId, now)
    return created.id
  })
}

/** Tenants whose settings have `drafts` on. */
async function activeTenants(context: EngineContext): Promise<Tenant[]> {
  const rows = await context.db.select().from(answeringSettings).where(isNotNull(answeringSettings.draftsEnabledAt))
  return rows.filter((row): row is Tenant => row.draftsEnabledAt !== null && row.settings.drafts)
}

/** One pass: decide and draft up to `limit` new inbound items, oldest first, across tenants. */
export async function runAnswering(context: EngineContext, limit = itemsPerPass) {
  const now = clock(context)
  let drafted = 0
  let failed = 0
  for (const tenant of await activeTenants(context)) {
    if (drafted + failed >= limit) break
    const left = limit - drafted - failed
    const candidates: Candidate[] = [
      ...tenant.settings.kinds.messages ? await messageCandidates(context, tenant, now, left) : [],
      ...tenant.settings.kinds.comments ? await commentCandidates(context, tenant, now, left) : [],
    ].slice(0, left)
    for (const candidate of candidates) {
      try {
        const result = await decideAndDraft(context, candidate)
        if (await storeDraft(context, candidate, result)) drafted++
      } catch (error) {
        failed++
        log('error', 'answering item failed', { kind: candidate.kind, channelId: candidate.channel.id, ...errorFields(error) })
      }
    }
  }
  return { drafted, failed }
}
