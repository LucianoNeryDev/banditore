import type { FindReplyInput, FindReplyOutcome } from './types.js'

/** Unicode NFC, whitespace runs as one space, trimmed: how a reply's text is compared with what the platform shows. */
export function normalizeReplyText(value: string) {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/** A reply read back from the platform while an uncertain send is reconciled. */
export interface ReplyCandidate {
  id: string
  text: string
  /** Milliseconds; null when the platform gave no readable time. */
  createdAt: number | null
  /** Written by the channel's own account. */
  own: boolean
  url?: string
}

/** The one reply the account wrote with this text since the attempt, among IDs no other reply holds. */
export function pickOwnReply(candidates: ReplyCandidate[], input: Pick<FindReplyInput, 'text' | 'since' | 'excludeExternalIds'>): FindReplyOutcome {
  const text = normalizeReplyText(input.text)
  const matches = candidates.filter(candidate => candidate.own && normalizeReplyText(candidate.text) === text && !input.excludeExternalIds.includes(candidate.id)
    && (candidate.createdAt === null || candidate.createdAt >= input.since.getTime()))
  if (matches.length === 1) return { kind: 'found', externalId: matches[0]!.id, ...(matches[0]!.url ? { url: matches[0]!.url } : {}) }
  if (!matches.length) return { kind: 'not_found' }
  return { kind: 'ambiguous', detail: `${matches.length} replies of the account match the text` }
}
