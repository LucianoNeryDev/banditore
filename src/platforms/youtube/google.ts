import { redactText } from '../../crypto/redact.js'

/**
 * `unreachable`: the request never left this host, so nothing was created.
 * `lost`: the request may have been delivered.
 */
export type GoogleFailure =
  | { kind: 'unreachable' }
  | { kind: 'lost' }
  | { kind: 'http', status: number, reason?: string, message: string }

export class GoogleError extends Error {
  constructor(readonly failure: GoogleFailure, message: string) {
    super(message)
    this.name = 'GoogleError'
  }
}

export interface GoogleRequest {
  token?: string
  query?: Record<string, string>
  json?: unknown
  form?: Record<string, string>
  bytes?: { data: Buffer, type: string }
  headers?: Record<string, string>
  timeoutMs?: number
  /** Statuses other than 2xx that are an answer, not an error (308 for an unfinished upload). */
  accept?: number[]
}

export interface GoogleResponse {
  status: number
  headers: Headers
  payload: unknown
}

const maxResponseBytes = 2_000_000
const unreachableCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const allowedHosts = new Set(['oauth2.googleapis.com', 'www.googleapis.com', 'youtube.googleapis.com'])

/** JSON over HTTPS to Google's OAuth and YouTube Data APIs only. */
export class GoogleClient {
  private readonly fetcher: typeof fetch

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.fetcher = options.fetch ?? fetch
  }

  async request(method: 'GET' | 'POST' | 'PUT', target: string, call: GoogleRequest = {}): Promise<GoogleResponse> {
    const url = new URL(target)
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) throw new Error('Invalid Google URL')
    for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value)
    const headers: Record<string, string> = { Accept: 'application/json', ...call.headers }
    const secrets: string[] = []
    if (call.token) {
      headers.Authorization = `Bearer ${call.token}`
      secrets.push(call.token)
    }
    let body: string | URLSearchParams | Uint8Array | undefined
    if (call.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8'
      body = JSON.stringify(call.json)
    } else if (call.form) {
      body = new URLSearchParams(call.form)
      for (const [key, value] of Object.entries(call.form)) if (/secret|token|code/i.test(key)) secrets.push(value)
    } else if (call.bytes) {
      headers['Content-Type'] = call.bytes.type
      body = new Uint8Array(call.bytes.data)
    }

    let response: Response
    try {
      response = await this.fetcher(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(call.timeoutMs ?? 20_000) })
    } catch (error) {
      const code = errorCode(error)
      throw new GoogleError(code && unreachableCodes.has(code) ? { kind: 'unreachable' } : { kind: 'lost' }, `Google ${method} ${url.pathname} failed: ${code ?? 'network'}`)
    }
    let payload: unknown
    try {
      payload = await readJson(response)
    } catch {
      throw new GoogleError({ kind: 'lost' }, `Google ${method} ${url.pathname} returned an unreadable response`)
    }
    if (!response.ok && !call.accept?.includes(response.status)) {
      const error = errorBody(payload)
      throw new GoogleError({ kind: 'http', status: response.status, reason: error.reason,
        message: redactText(error.message ?? `HTTP ${response.status}`, secrets).slice(0, 500) },
      `Google ${method} ${url.pathname} returned ${response.status}${error.reason ? ` (${error.reason})` : ''}`)
    }
    return { status: response.status, headers: response.headers, payload }
  }
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxResponseBytes) {
      await reader.cancel()
      throw new Error('Response too large')
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Upload sessions answer some statuses with an empty or plain body.
    if (!response.ok) return null
    throw new Error('Unreadable JSON')
  }
}

/** The reason from a YouTube error (`{error: {errors: [{reason}]}}`) or an OAuth one (`{error: "invalid_grant"}`). */
function errorBody(payload: unknown): { reason?: string, message?: string } {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return {}
  const error = payload.error
  if (typeof error === 'string') {
    const description = 'error_description' in payload && typeof payload.error_description === 'string' ? payload.error_description : undefined
    return { reason: error, message: description ?? error }
  }
  if (!error || typeof error !== 'object') return {}
  const record = error as Record<string, unknown>
  const first = Array.isArray(record.errors) ? record.errors[0] as Record<string, unknown> | undefined : undefined
  return {
    reason: typeof first?.reason === 'string' ? first.reason : typeof record.status === 'string' ? record.status : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
  }
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code
    if ('name' in current && (current.name === 'TimeoutError' || current.name === 'AbortError')) return 'TIMEOUT'
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}
