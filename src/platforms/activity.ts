/** Newest posts read per check: enough that a busy hour between reads is not missed. */
export const activityPostsPerRead = 25
const maxText = 500

/** A caption or title as webhooks carry it: at most 500 characters. */
export const clipText = (value: string | null | undefined) => value ? Array.from(value).slice(0, maxText).join('') : null
