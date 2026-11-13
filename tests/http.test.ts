import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EngineContext } from '../src/context.js'
import { createEngineApp } from '../src/http/app.js'

const token = 't'.repeat(48)
let server: Server
let base: string

// No database: every request here must be refused before it reaches one.
const context = { db: new Proxy({}, { get() { throw new Error('database touched') } }) } as unknown as EngineContext

beforeAll(async () => {
  server = createServer(toNodeListener(createEngineApp(context, token)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
})

describe('engine API', () => {
  it('answers liveness without a token', async () => {
    const response = await fetch(`${base}/healthz`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('refuses requests without the service token', async () => {
    for (const authorization of [undefined, 'Bearer wrong', `Basic ${token}`, `Bearer ${token}x`]) {
      const response = await fetch(`${base}/v1/tenants/org/channels`, { headers: authorization ? { authorization } : {} })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized', message: 'Invalid service token' })
    }
  })

  it('validates submissions before touching the database', async () => {
    const response = await post('/v1/jobs', { organizationId: 'org', postId: 'p', revision: 0, channels: [] })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string, issues: Array<{ path: string }> }
    expect(body.error).toBe('invalid_request')
    expect(body.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['revision', 'channels', 'content', 'publishAt']))
  })

  it('rejects unknown fields, bad JSON, wrong content types and large bodies', async () => {
    expect((await post('/v1/jobs/cancel', { organizationId: 'org', postId: 'p', revision: 1, extra: true })).status).toBe(400)
    expect((await post('/v1/jobs/cancel', '{nope')).status).toBe(400)
    expect((await post('/v1/jobs/cancel', 'x', { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post('/v1/jobs/cancel', 'x'.repeat(1_000_001))).status).toBe(413)
  })

  it('rejects organization IDs with unexpected characters', async () => {
    const response = await fetch(`${base}/v1/tenants/${encodeURIComponent('org/../x')}/channels`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(400)
  })

  it('validates metrics queries before touching the database', async () => {
    const get = (query: string) => fetch(`${base}/v1/tenants/org/metrics${query}`, { headers: { authorization: `Bearer ${token}` } })
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID()).join(',')
    for (const query of ['', '?jobIds=', '?jobIds=not-a-uuid', `?jobIds=${ids}`]) expect((await get(query)).status).toBe(400)
  })

  it('validates analytics and responses queries before touching the database', async () => {
    const get = (path: string) => fetch(`${base}/v1/tenants/org${path}`, { headers: { authorization: `Bearer ${token}` } })
    const ids = (count: number) => Array.from({ length: count }, () => crypto.randomUUID()).join(',')
    for (const path of ['/metrics/history', '/metrics/history?jobIds=', `/metrics/history?jobIds=${ids(21)}`, '/metrics/history?jobIds=x',
      '/channel-metrics?channelIds=nope', '/channel-metrics?days=0', '/channel-metrics?days=401', '/channel-metrics?days=1.5',
      `/responses?jobIds=${ids(51)}`, '/responses?limit=0', '/responses?limit=201', '/responses?after=not%20base64', '/responses?after=bm9wZQ']) {
      expect((await get(path)).status, path).toBe(400)
    }
    await expect((await get('/responses?after=bm9wZQ')).json()).resolves.toMatchObject({ error: 'invalid_cursor' })
    for (const body of [{}, { jobIds: [] }, { jobIds: ['x'] }, { jobIds: ids(21).split(',') }, { jobIds: ids(1).split(','), extra: 1 }]) {
      expect((await post('/v1/tenants/org/responses/watch', body)).status).toBe(400)
    }
  })

  it('returns JSON 404 for unknown routes', async () => {
    const response = await fetch(`${base}/nothing`)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'not_found' })
  })

  it('hides internal errors', async () => {
    const response = await fetch(`${base}/readyz`)
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('database touched')
  })
})
