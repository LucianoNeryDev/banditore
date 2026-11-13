import type { EngineContext } from './context.js'
import type { channels } from './db/schema.js'

type Channel = typeof channels.$inferSelect
type AvailabilityChannel = Pick<Channel, 'platform' | 'kind' | 'status' | 'providerAppId' | 'grantedScopes' | 'refusedScopes'>

/** Google scopes are URLs; people know them by their last part. */
export const permissionName = (scope: string) => scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')

export type ReplyAvailability =
  /** `maxLength`: the longest reply text the platform takes, in characters. */
  | { available: true, maxLength: number }
  | { available: false, reason: 'not_supported' | 'channel_inactive' | 'missing_permission', permission?: string }

/** Whether people can send direct messages on a channel; Instagram's `maxLength` counts UTF-8 bytes. */
export type MessageAvailability = ReplyAvailability

/**
 * Shared by replies and messages: the channel is active, no send was refused
 * for a permission the grant lacks, and the permission is not missing from
 * the granted scopes (unknown scopes count as granted until a send says
 * otherwise). A refusal of the other feature's own permission does not count.
 */
function availability(channel: AvailabilityChannel, rules: { permission: string, maxLength: number } | null, otherPermission: string | undefined): ReplyAvailability {
  if (!rules) return { available: false, reason: 'not_supported' }
  if (channel.status !== 'active') return { available: false, reason: 'channel_inactive' }
  // A refusal names the permission it missed, which may be another than the rule's (Meta asks for pages_read_engagement too).
  const refused = channel.refusedScopes.includes(rules.permission) ? rules.permission : channel.refusedScopes.find(scope => scope !== otherPermission)
  const missing = refused ?? (channel.grantedScopes && !channel.grantedScopes.includes(rules.permission) ? rules.permission : undefined)
  if (missing) return { available: false, reason: 'missing_permission', permission: permissionName(missing) }
  return { available: true, maxLength: rules.maxLength }
}

/** Whether people can reply to comments on a channel. */
export function replyAvailability(context: EngineContext, channel: AvailabilityChannel): ReplyAvailability {
  const adapter = context.adapters.get(channel.platform)
  const rules = channel.providerAppId && adapter?.reply ? adapter.replyRules?.(channel.kind) ?? null : null
  return availability(channel, rules, adapter?.messageRules?.(channel.kind)?.permission)
}

/** Whether direct messages can be sent on a channel. */
export function messageAvailability(context: EngineContext, channel: AvailabilityChannel): MessageAvailability {
  const adapter = context.adapters.get(channel.platform)
  const rules = channel.providerAppId && adapter?.sendMessage ? adapter.messageRules?.(channel.kind) ?? null : null
  return availability(channel, rules, adapter?.replyRules?.(channel.kind)?.permission)
}
