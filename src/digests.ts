import { sha256Json } from './exactly-once.js'

// What a reply or a direct message binds, as the dashboard computes it too.
// Shared by the send side and the answering step, which drafts the text a
// submission will carry, so neither has to import the other.

/** A reply binds the post (job), the comment answered and the exact text. */
export function replyDigest(input: { jobId: string, parentExternalId: string, text: string }) {
  return sha256Json(['social-reply-v1', input.jobId, input.parentExternalId, input.text])
}

/** A message binds the conversation and the exact text. */
export function messageDigest(input: { conversationId: string, text: string }) {
  return sha256Json(['social-message-v1', input.conversationId, input.text])
}
