import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runnerKeyPair, sealSecret } from '../src/crypto/sealed.js'
import { ActionStore, actionView, type ActionRequest } from '../src/runner/actions.js'
import { Executor, ScriptError, type Script } from '../src/runner/executor.js'
import { totp } from '../src/runner/totp.js'

const runner = runnerKeyPair()
const accountId = '6b1f4c0e-8a52-4d3c-9b7e-2f1a3c4d5e6f'
const sealed = sealSecret(runner.publicKey, accountId, JSON.stringify({ username: 'leonessa.digital', password: 'pw' }))
const request = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  actionId: 'attempt-1', kind: 'publish_post', content: 'Ciao Brescia', media: [], settings: {},
  account: { id: accountId, platform: 'tiktok', handle: 'leonessa.digital', sealed: {
    ephemeralPublicKey: sealed.ephemeralPublicKey.toString('base64'), nonce: sealed.nonce.toString('base64'), ciphertext: sealed.ciphertext.toString('base64') } },
  ...overrides,
})
const file = () => join(mkdtempSync(join(tmpdir(), 'runner-')), 'actions.json')

function executor(store: ActionStore, script: Script, download?: () => Promise<{ files: string[], cleanup: () => Promise<void> }>) {
  const notify = vi.fn().mockResolvedValue(undefined)
  const cleanup = vi.fn().mockResolvedValue(undefined)
  const instance = new Executor({ store, runnerPrivateKey: runner.privateKey, scripts: { tiktok: { publish_post: script } },
    download: download ?? (async () => ({ files: ['/tmp/a.mp4'], cleanup })), notify, takeoverMs: 50, pollMs: 5 })
  return { instance, notify, cleanup }
}

describe('runner actions', () => {
  it('deduplicates by engine attempt and never exposes the sealed secret', () => {
    const store = new ActionStore(file())
    const first = store.submit(request())
    expect(store.submit(request({ content: 'other' })).id).toBe(first.id)
    expect(JSON.stringify(actionView(first))).not.toContain(sealed.ciphertext.toString('base64'))
  })

  it('runs a script with the opened secret and records the receipt', async () => {
    const store = new ActionStore(file())
    const action = store.submit(request())
    const { instance, cleanup } = executor(store, async (context) => {
      expect(context.secret).toEqual({ username: 'leonessa.digital', password: 'pw' })
      expect(context.files).toEqual(['/tmp/a.mp4'])
      context.visible()
      return { externalId: '7400000000000000000', url: 'https://www.tiktok.com/@leonessa.digital/video/7400000000000000000' }
    })
    await instance.tick()
    expect(store.get(action.id)).toMatchObject({ state: 'succeeded', receipt: { externalId: '7400000000000000000' } })
    expect(cleanup).toHaveBeenCalled()
  })

  it('fails a media download it could not finish as media_download_failed, without running the script', async () => {
    const store = new ActionStore(file())
    const action = store.submit(request())
    const script = vi.fn()
    await executor(store, script, async () => { throw new TypeError('fetch failed') }).instance.tick()
    expect(store.get(action.id)).toMatchObject({ state: 'failed', error: { code: 'media_download_failed', detail: 'fetch failed' } })
    expect(script).not.toHaveBeenCalled()
  })

  it('fails before the visible step and is uncertain after it', async () => {
    const before = new ActionStore(file())
    const one = before.submit(request())
    await executor(before, async () => { throw new ScriptError('upload_failed', 'no') }).instance.tick()
    expect(before.get(one.id)).toMatchObject({ state: 'failed', error: { code: 'upload_failed' } })

    const after = new ActionStore(file())
    const two = after.submit(request())
    await executor(after, async (context) => { context.visible(); throw new Error('lost') }).instance.tick()
    expect(after.get(two.id)).toMatchObject({ state: 'uncertain', error: { code: 'script_error' } })
  })

  it('waits for a person and gives up after the takeover window', async () => {
    const store = new ActionStore(file())
    const resolved = store.submit(request())
    let ready = false
    const { instance, notify } = executor(store, async (context) => {
      setTimeout(() => { ready = true }, 10)
      await context.needHuman('captcha', async () => ready)
    })
    await instance.tick()
    expect(store.get(resolved.id)!.state).toBe('succeeded')
    expect(notify.mock.calls[0]![0]).toContain('captcha')

    const stuck = store.submit(request({ actionId: 'attempt-2' }))
    await executor(store, async (context) => { await context.needHuman('login checkpoint', async () => false) }).instance.tick()
    expect(store.get(stuck.id)).toMatchObject({ state: 'failed', error: { code: 'takeover_timeout' } })
  })

  it('survives a restart: unstarted work stays queued, interrupted work settles', () => {
    const path = file()
    const store = new ActionStore(path)
    const queued = store.submit(request({ actionId: 'a' }))
    const early = store.submit(request({ actionId: 'b' }))
    const late = store.submit(request({ actionId: 'c' }))
    store.update(early.id, { state: 'running' })
    store.update(late.id, { state: 'needs_human', visibleAt: new Date().toISOString(), takeover: { reason: 'x', since: '' } })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(3)
    const reopened = new ActionStore(path)
    expect(reopened.get(queued.id)!.state).toBe('queued')
    expect(reopened.get(early.id)).toMatchObject({ state: 'failed', error: { code: 'runner_restarted' } })
    expect(reopened.get(late.id)).toMatchObject({ state: 'uncertain' })
    expect(reopened.get(late.id)!.takeover).toBeUndefined()
  })

  it('cancels only queued actions', () => {
    const store = new ActionStore(file())
    const queued = store.submit(request({ actionId: 'a' }))
    const running = store.submit(request({ actionId: 'b' }))
    store.update(running.id, { state: 'running' })
    expect(store.cancel(queued.id)!.state).toBe('cancelled')
    expect(store.cancel(running.id)!.state).toBe('running')
  })
})

describe('totp', () => {
  // RFC 6238 test vector: seed "12345678901234567890", SHA-1, T = 59 s.
  it('matches the RFC 6238 vector', () => {
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1_111_111_109_000)).toBe('081804')
  })
})

describe('runner API', () => {
  const token = 'r'.repeat(40)
  async function serve() {
    const { createServer } = await import('node:http')
    const { toNodeListener } = await import('h3')
    const { createRunnerApp } = await import('../src/runner/http.js')
    const store = new ActionStore(file())
    const wake = vi.fn()
    const server = createServer(toNodeListener(createRunnerApp(store, token, wake)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    return { base, wake, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
  }

  it('needs the token, accepts actions once and never returns the secret', async () => {
    const { base, wake, close } = await serve()
    try {
      const post = (headers: Record<string, string>, body: unknown) => fetch(`${base}/v1/actions`, { method: 'POST', headers, body: JSON.stringify(body) })
      expect((await post({}, request())).status).toBe(401)
      const accepted = await post({ authorization: `Bearer ${token}` }, request())
      expect(accepted.status).toBe(202)
      const view = await accepted.json() as { id: string, state: string }
      expect(view.state).toBe('queued')
      expect(wake).toHaveBeenCalled()
      const again = await (await post({ authorization: `Bearer ${token}` }, request())).json() as { id: string }
      expect(again.id).toBe(view.id)
      const read = await fetch(`${base}/v1/actions/${view.id}`, { headers: { authorization: `Bearer ${token}` } })
      expect(await read.text()).not.toContain(sealed.ciphertext.toString('base64'))
      expect((await post({ authorization: `Bearer ${token}` }, { ...request(), extra: true })).status).toBe(400)
      expect((await fetch(`${base}/v1/actions/${view.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    } finally {
      await close()
    }
  })
})
