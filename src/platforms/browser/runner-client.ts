import { z } from 'zod'

const actionSchema = z.object({
  id: z.uuid(), actionId: z.string(), kind: z.string(), accountId: z.uuid(),
  state: z.enum(['queued', 'running', 'needs_human', 'succeeded', 'failed', 'uncertain', 'cancelled']),
  visible: z.boolean(),
  receipt: z.object({ externalId: z.string().max(200), url: z.string().max(2_000).optional() }).optional(),
  error: z.object({ code: z.string().max(100), detail: z.string().max(1_000) }).optional(),
  takeover: z.object({ reason: z.string().max(500), since: z.string() }).optional(),
})
export type RunnerAction = z.infer<typeof actionSchema>

/** `unreachable`: nothing was delivered. `lost`: the runner may have accepted the request. */
export class RunnerError extends Error {
  constructor(readonly kind: 'unreachable' | 'lost' | 'rejected', message: string) {
    super(message)
    this.name = 'RunnerError'
  }
}

const unreachableCodes = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])

export interface RunnerOptions {
  url: string
  token: string
  fetch?: typeof fetch
}

/** The browser runner's API, reached over a private network. */
export class RunnerClient {
  private readonly fetcher: typeof fetch

  constructor(private readonly options: RunnerOptions) {
    this.fetcher = options.fetch ?? fetch
  }

  submit(body: unknown) {
    return this.call('POST', '/v1/actions', body)
  }

  get(id: string) {
    return this.call('GET', `/v1/actions/${encodeURIComponent(id)}`)
  }

  /** The action the runner holds for an engine attempt, or null when it never arrived. */
  async find(actionId: string) {
    try {
      return await this.call('GET', `/v1/actions?actionId=${encodeURIComponent(actionId)}`)
    } catch (error) {
      if (error instanceof RunnerError && error.kind === 'rejected' && error.message.includes('404')) return null
      throw error
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RunnerAction> {
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.options.url), {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      throw new RunnerError(unreachableCodes.has(causeCode(error) ?? '') ? 'unreachable' : 'lost', `Runner ${method} ${path.split('?')[0]} failed`)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new RunnerError('lost', `Runner ${method} returned an unreadable response`)
    }
    if (!response.ok) throw new RunnerError(response.status >= 500 ? 'lost' : 'rejected', `Runner ${method} returned ${response.status}`)
    return actionSchema.parse(payload)
  }
}

function causeCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}
