import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Executor } from './db/client.js'

// What comment replies and direct messages share to send each submission at most once.

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/)
/** A dashboard identifier: a reply, message or user ID. */
export const dashboardIdentifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)

/** The hex SHA-256 of the JSON array: how digests and request keys are computed on both sides. */
export function sha256Json(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export async function advisoryLock(executor: Executor, name: string) {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`)
}

export function isUniqueViolation(error: unknown) {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}

/** 1, 2, then 4 minutes after a request that never left. */
export function sendRetryDelayMs(attemptCount: number) {
  return 60_000 * 2 ** Math.max(0, attemptCount - 1)
}
