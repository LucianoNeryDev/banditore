import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { recordEvent, type EngineContext } from '../context.js'
import { channels, conversations, jobs, postResponses } from '../db/schema.js'
import { conflict, EngineError, notFound } from '../errors.js'
import { errorFields, log } from '../log.js'
import { DraftError, draftFits, tooLongFlag } from './drafting.js'
import { draftInputFor } from './pipeline.js'
import { readAnswering } from './settings.js'

export const reviseSchema = z.strictObject({
  kind: z.enum(['message', 'comment']),
  conversationId: z.uuid().optional(),
  responseId: z.uuid().optional(),
  // The person's current text; null: a first draft on request.
  current: z.string().max(10_000).nullable(),
  instruction: z.string().min(1).max(2_000).refine(value => value.trim().length > 0, 'must not be blank'),
}).refine(value => value.kind === 'message' ? value.conversationId !== undefined && value.responseId === undefined
  : value.responseId !== undefined && value.conversationId === undefined, { message: 'a message names conversationId, a comment responseId', path: ['kind'] })
export type ReviseInput = z.infer<typeof reviseSchema>

/**
 * A person asks for a new version of a draft, or for a first one. Same
 * context as the engine's own drafts; the instruction is the only trusted
 * instruction, the current text is the person's, the inbound text stays
 * data. Synchronous; nothing is stored but an audit event without text.
 * Refused for a tenant without answering settings, and a text longer than
 * the channel takes is refused rather than returned.
 */
export async function reviseDraft(context: EngineContext, organizationId: string, input: ReviseInput) {
  if (!context.draftModel) throw new EngineError(503, 'drafting_unavailable', 'No drafting model is configured')
  // A tenant without answering settings never reaches a model provider (ADR 0004).
  const answering = await readAnswering(context.db, organizationId)
  if (!answering) throw conflict('answering_not_configured', 'This tenant has no answering settings')
  let draftInput
  let channelId: string
  if (input.kind === 'message') {
    const [row] = await context.db.select({ conversation: conversations, channel: channels }).from(conversations)
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, input.conversationId!))).limit(1)
    if (!row) throw notFound('Conversation')
    channelId = row.channel.id
    draftInput = await draftInputFor(context, { kind: 'message', channel: row.channel, conversationId: row.conversation.id },
      answering.settings, answering.context, true)
  } else {
    const [row] = await context.db.select({ response: postResponses, job: jobs, channel: channels }).from(postResponses)
      .innerJoin(jobs, eq(jobs.id, postResponses.jobId)).innerJoin(channels, eq(channels.id, postResponses.channelId))
      .where(and(eq(postResponses.organizationId, organizationId), eq(postResponses.id, input.responseId!))).limit(1)
    if (!row) throw notFound('Response')
    channelId = row.channel.id
    draftInput = await draftInputFor(context, { kind: 'comment', channel: row.channel, response: row.response, job: row.job },
      answering.settings, answering.context, true)
  }
  let result
  try {
    result = await context.draftModel.draft({ ...draftInput, revise: { current: input.current, instruction: input.instruction } },
      answering.settings.replyModel)
  } catch (error) {
    log('warn', 'revision failed', { kind: input.kind, channelId, ...errorFields(error) })
    throw new EngineError(502, 'drafting_failed', 'The drafting model did not answer', { code: error instanceof DraftError ? error.code : 'error' })
  }
  await recordEvent(context.db, { organizationId, kind: 'draft.revised', channelId, detail: { kind: input.kind,
    ...(input.kind === 'message' ? { conversationId: input.conversationId } : { responseId: input.responseId }),
    fromScratch: input.current === null, model: result.model, flags: result.output.flags, drafted: Boolean(result.output.reply) } })
  if (!result.output.reply) {
    throw new EngineError(422, 'no_draft', 'The drafting model could not write this reply', { flags: result.output.flags, model: result.model })
  }
  // A text the channel cannot take is not handed back as a revision a person could approve.
  if (!draftFits(draftInput.maxLength, result.output.reply)) {
    throw new EngineError(422, 'draft_too_long', 'The revised reply is longer than the channel takes', { flags: [...result.output.flags, tooLongFlag],
      model: result.model, maxLength: draftInput.maxLength?.value ?? null, unit: draftInput.maxLength?.unit ?? null })
  }
  return { text: result.output.reply, model: result.model, flags: result.output.flags }
}
