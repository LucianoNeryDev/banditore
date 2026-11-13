import { redact } from './crypto/redact.js'

let secrets: readonly string[] = []

/** Every known secret value is removed from log output. */
export function registerLogSecrets(values: readonly string[]) {
  secrets = values.filter(value => value.length >= 8)
}

export function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...(redact(fields, secrets) as Record<string, unknown>) })
  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export function errorFields(error: unknown) {
  return error instanceof Error ? { error: error.name, detail: error.message } : { error: String(error) }
}
