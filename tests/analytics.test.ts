import { describe, expect, it } from 'vitest'
import { CallBudget } from '../src/budget.js'
import { newestThreads } from '../src/platforms/meta/responses.js'
import type { PlatformResponse } from '../src/platforms/types.js'
import { nextPacificMidnight } from '../src/platforms/youtube/adapter.js'
import { decodeCursor, encodeCursor, nextResponseCheck, pickDueChecks, responseCheckInterval, responseRetryDelayMs } from '../src/responses.js'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const published = new Date('2030-01-01T00:00:00Z')
const at = (ms: number) => new Date(published.getTime() + ms)

describe('response check cadence', () => {
  it('slows down as the post ages and stops after 90 days', () => {
    expect(responseCheckInterval('meta', published, at(0))).toBe(2 * minute)
    expect(responseCheckInterval('meta', published, at(day - 1))).toBe(2 * minute)
    expect(responseCheckInterval('meta', published, at(day))).toBe(10 * minute)
    expect(responseCheckInterval('meta', published, at(7 * day - 1))).toBe(10 * minute)
    expect(responseCheckInterval('meta', published, at(7 * day))).toBe(hour)
    expect(responseCheckInterval('meta', published, at(30 * day))).toBe(6 * hour)
    expect(responseCheckInterval('meta', published, at(90 * day - 1))).toBe(6 * hour)
    expect(responseCheckInterval('meta', published, at(90 * day))).toBeNull()
  })

  it('checks about every 30 seconds while watched, never slower than the cadence', () => {
    const now = at(10 * day)
    expect(nextResponseCheck('meta', published, now, null)).toEqual(new Date(now.getTime() + hour))
    expect(nextResponseCheck('meta', published, now, new Date(now.getTime() + minute))).toEqual(new Date(now.getTime() + 30_000))
    // An expired watch no longer counts.
    expect(nextResponseCheck('meta', published, now, now)).toEqual(new Date(now.getTime() + hour))
    expect(nextResponseCheck('meta', published, at(91 * day), new Date(at(91 * day).getTime() + minute))).toBeNull()
  })

  it('reads YouTube more slowly, watched or not, to spare the project quota', () => {
    expect(responseCheckInterval('youtube', published, at(0))).toBe(10 * minute)
    expect(responseCheckInterval('youtube', published, at(day))).toBe(30 * minute)
    expect(responseCheckInterval('youtube', published, at(7 * day))).toBe(3 * hour)
    expect(responseCheckInterval('youtube', published, at(30 * day))).toBe(12 * hour)
    expect(responseCheckInterval('youtube', published, at(90 * day))).toBeNull()
    const now = at(hour)
    expect(nextResponseCheck('youtube', published, now, new Date(now.getTime() + minute))).toEqual(new Date(now.getTime() + 2 * minute))
  })

  it('picks watched posts first, up to three per channel, and one per channel otherwise', () => {
    const rows = [
      { id: 1, channelId: 'a', watched: true }, { id: 2, channelId: 'a', watched: true }, { id: 3, channelId: 'a', watched: true },
      { id: 4, channelId: 'a', watched: true }, { id: 5, channelId: 'b', watched: false }, { id: 6, channelId: 'b', watched: false },
      { id: 7, channelId: 'c', watched: false },
    ]
    expect(pickDueChecks(rows, 8).map(row => row.id)).toEqual([1, 2, 3, 5, 7])
    expect(pickDueChecks(rows, 2).map(row => row.id)).toEqual([1, 2])
  })

  it('backs off failures from 2 minutes to at most 6 hours', () => {
    expect([1, 2, 3, 4].map(responseRetryDelayMs)).toEqual([2 * minute, 4 * minute, 8 * minute, 16 * minute])
    expect(responseRetryDelayMs(20)).toBe(6 * hour)
  })
})

describe('call budget', () => {
  it('allows a burst, then about one call a second', () => {
    let now = 0
    const budget = new CallBudget(60, 10, () => now)
    expect(Array.from({ length: 12 }, () => budget.take()).filter(Boolean)).toHaveLength(10)
    now += 1_000
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(false)
    now += 60_000
    expect(Array.from({ length: 20 }, () => budget.take()).filter(Boolean)).toHaveLength(10)
  })

  it('spends the further requests of a read even past zero, so the next read waits', () => {
    let now = 0
    const budget = new CallBudget(60, 10, () => now)
    expect(budget.take('meta')).toBe(true)
    // A five-request read: the first was taken, four more are spent.
    for (let call = 0; call < 4; call++) budget.spend('meta')
    expect(Array.from({ length: 10 }, () => budget.take()).filter(Boolean)).toHaveLength(5)
    for (let call = 0; call < 3; call++) budget.spend('meta')
    // Three calls of debt: about four seconds before the next call.
    now += 3_500
    expect(budget.take()).toBe(false)
    now += 600
    expect(budget.take()).toBe(true)
  })
})

describe('YouTube daily share', () => {
  it('stops YouTube reads at the daily cap and starts again the next Pacific day', () => {
    let now = Date.parse('2030-01-01T12:00:00Z')
    const budget = new CallBudget(1_000_000, 1_000_000, () => now, { youtube: 3 })
    expect([1, 2, 3, 4].map(() => budget.take('youtube'))).toEqual([true, true, true, false])
    expect(budget.allows('youtube')).toBe(false)
    // Other platforms are not held back by YouTube's share.
    expect(budget.allows('meta')).toBe(true)
    expect(budget.take('meta')).toBe(true)
    // 08:00 UTC on 2 January is midnight in Los Angeles (PST, UTC-8).
    now = Date.parse('2030-01-02T07:59:00Z')
    expect(budget.allows('youtube')).toBe(false)
    now = Date.parse('2030-01-02T08:00:00Z')
    expect(budget.take('youtube')).toBe(true)
  })

  it('counts spent requests toward the daily share as well', () => {
    const budget = new CallBudget(1_000_000, 1_000_000, () => Date.parse('2030-01-01T12:00:00Z'), { youtube: 3 })
    expect(budget.take('youtube')).toBe(true)
    budget.spend('youtube')
    expect(budget.allows('youtube')).toBe(true)
    budget.spend('youtube')
    expect(budget.allows('youtube')).toBe(false)
    expect(budget.take('youtube')).toBe(false)
  })

  it('resumes after a quota error at the next midnight Pacific time', () => {
    expect(nextPacificMidnight(new Date('2030-01-01T12:00:00Z'))).toEqual(new Date('2030-01-02T08:00:00Z'))
    // Daylight saving time: midnight PDT is 07:00 UTC.
    expect(nextPacificMidnight(new Date('2030-07-01T12:00:00.500Z'))).toEqual(new Date('2030-07-02T07:00:00Z'))
  })
})

describe('Instagram thread cut', () => {
  const at = (minutes: number) => new Date(Date.parse('2030-01-01T00:00:00Z') + minutes * 60_000)
  const entry = (externalId: string, minutes: number, parentExternalId: string | null = null): PlatformResponse => ({ externalId, parentExternalId,
    authorName: null, authorHandle: 'anna', text: externalId, likeCount: null, replyCount: null, publishedAt: at(minutes), url: null })
  const ids = (responses: PlatformResponse[]) => responses.map(response => response.externalId)

  it('keeps an old comment with its new reply, and drops the oldest threads instead', () => {
    const read = [entry('a', 0), entry('a1', 10, 'a'), entry('b', 5), entry('c', 6), entry('d', 7)]
    // Cutting by time alone would keep a1 without a.
    expect(ids(newestThreads(read, 3))).toEqual(['a1', 'd', 'a'])
  })

  it('keeps the comment and the newest replies of the thread that does not fit', () => {
    const read = [entry('x', 1), entry('x1', 2, 'x'), entry('x2', 3, 'x'), entry('x3', 4, 'x'), entry('y', 0)]
    expect(ids(newestThreads(read, 2))).toEqual(['x3', 'x'])
    expect(ids(newestThreads(read, 1))).toEqual(['x'])
    expect(ids(newestThreads(read, 10))).toEqual(['x3', 'x2', 'x1', 'x', 'y'])
  })

  it('ranks replies whose comment is missing from the read as one thread', () => {
    expect(ids(newestThreads([entry('r1', 3, 'gone'), entry('r2', 4, 'gone'), entry('z', 5)], 2))).toEqual(['z', 'r2'])
  })
})

describe('responses cursor', () => {
  it('round-trips and refuses anything else', () => {
    const id = '0b0d5f3e-9c1a-4f6e-8a2b-1c2d3e4f5a6b'
    const cursor = encodeCursor(new Date('2030-01-01T10:00:00.123Z'), id)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(cursor)).toEqual({ firstSeenAt: new Date('2030-01-01T10:00:00.123Z'), id })
    for (const bad of ['nope', Buffer.from('{"t":"x","id":"y"}').toString('base64url')]) expect(() => decodeCursor(bad)).toThrow('The cursor is not valid')
  })
})
