/**
 * YouTube's 10,000 daily units belong to the Google project and are shared
 * with uploads (1,600 units each), so the collectors' reads keep to this
 * share. Every read they make costs 1 unit.
 */
export const youtubeDailyReadUnits = 2_500

const pacificDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })

/**
 * A token bucket for platform reads made by the collectors: about
 * `perMinute` calls a minute, with a short burst. Platforms with a daily
 * quota also get a daily share, counted per Pacific day (when Google resets
 * it). One per worker process; the daily count starts over on restart.
 */
export class CallBudget {
  private tokens: number
  private last: number
  private day = ''
  private readonly spent = new Map<string, number>()

  constructor(private readonly perMinute = 60, private readonly burst = 10, private readonly now: () => number = Date.now,
    private readonly dailyCaps: Readonly<Record<string, number>> = { youtube: youtubeDailyReadUnits }) {
    this.tokens = burst
    this.last = now()
  }

  /** False once the platform's daily share is used up: skip its channels until tomorrow. */
  allows(platform: string) {
    const cap = this.dailyCaps[platform]
    return cap === undefined || this.spentToday(platform) < cap
  }

  /** Spends one call if one is left, from the minute bucket and the platform's daily share. */
  take(platform?: string) {
    if (platform && !this.allows(platform)) return false
    this.refill()
    if (this.tokens < 1) return false
    this.charge(platform)
    return true
  }

  /**
   * Spends one call for a request that is made anyway: a metrics read that
   * needs several requests finishes once started. The bucket may go into
   * debt, so the next `take` waits; the platform's daily share counts it too.
   */
  spend(platform?: string) {
    this.refill()
    this.charge(platform)
  }

  private refill() {
    const now = this.now()
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.perMinute / 60_000)
    this.last = now
  }

  private charge(platform?: string) {
    this.tokens -= 1
    if (platform && this.dailyCaps[platform] !== undefined) this.spent.set(platform, this.spentToday(platform) + 1)
  }

  private spentToday(platform: string) {
    const day = pacificDate.format(this.now())
    if (day !== this.day) {
      this.day = day
      this.spent.clear()
    }
    return this.spent.get(platform) ?? 0
  }
}
