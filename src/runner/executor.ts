import { openSecret } from '../crypto/sealed.js'
import { errorFields, log } from '../log.js'
import { accountSecretSchema, type AccountSecret } from '../vault.js'
import type { Action, ActionStore } from './actions.js'

/** A failure a script reports on purpose. Before the visible step it is always `failed`. */
export class ScriptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

export interface ScriptContext {
  action: Action
  secret: AccountSecret
  /** Downloaded media, in request order. */
  files: string[]
  /**
   * Marks the step that makes something public. Call it immediately before
   * that click; from then on a failure is `uncertain`, never retried.
   */
  visible(): void
  /**
   * Stops for a person on noVNC. Resolves once `done` returns true, or throws
   * after the takeover window.
   */
  needHuman(reason: string, done: () => Promise<boolean>): Promise<void>
}

export type Script = (context: ScriptContext) => Promise<{ externalId: string, url?: string } | void>

export interface ExecutorOptions {
  store: ActionStore
  runnerPrivateKey: string
  scripts: Record<string, Partial<Record<Action['kind'], Script>>>
  download(action: Action): Promise<{ files: string[], cleanup(): Promise<void> }>
  notify(message: string): Promise<void>
  takeoverMs?: number
  pollMs?: number
}

/** Runs queued actions one at a time: one display, one person at the keyboard. */
export class Executor {
  private busy = false

  constructor(private readonly options: ExecutorOptions) {}

  async tick() {
    if (this.busy) return
    const action = this.options.store.next()
    if (!action) return
    this.busy = true
    try {
      await this.run(action)
    } finally {
      this.busy = false
    }
  }

  private async run(action: Action) {
    const { store } = this.options
    const script = this.options.scripts[action.account.platform]?.[action.kind]
    if (!script) {
      store.update(action.id, { state: 'failed', error: { code: 'unsupported', detail: `No ${action.kind} script for ${action.account.platform}` } })
      return
    }
    store.update(action.id, { state: 'running' })
    let downloaded: Awaited<ReturnType<ExecutorOptions['download']>> | undefined
    try {
      const sealed = { ephemeralPublicKey: Buffer.from(action.account.sealed.ephemeralPublicKey, 'base64'),
        nonce: Buffer.from(action.account.sealed.nonce, 'base64'), ciphertext: Buffer.from(action.account.sealed.ciphertext, 'base64') }
      const secret = accountSecretSchema.parse(JSON.parse(openSecret(this.options.runnerPrivateKey, action.account.id, sealed)))
      try {
        downloaded = await this.options.download(action)
      } catch (error) {
        // Nothing was opened on the platform yet: the engine may try the action again later.
        throw new ScriptError('media_download_failed', error instanceof Error ? error.message : 'Media download failed')
      }
      const receipt = await script({
        action, secret, files: downloaded.files,
        visible: () => { store.update(action.id, { visibleAt: new Date().toISOString() }) },
        needHuman: (reason, done) => this.waitForHuman(action, reason, done),
      })
      store.update(action.id, { state: 'succeeded', ...(receipt ? { receipt } : {}) })
    } catch (error) {
      const current = store.get(action.id)!
      const code = error instanceof ScriptError ? error.code : 'script_error'
      const detail = (error instanceof Error ? error.message : 'Script failed').slice(0, 500)
      log('warn', 'runner action failed', { actionId: action.id, code, visible: Boolean(current.visibleAt), ...errorFields(error) })
      store.update(action.id, { state: current.visibleAt ? 'uncertain' : 'failed', error: { code, detail } })
    } finally {
      await downloaded?.cleanup().catch(() => undefined)
    }
  }

  private async waitForHuman(action: Action, reason: string, done: () => Promise<boolean>) {
    const { store } = this.options
    const deadline = Date.now() + (this.options.takeoverMs ?? 30 * 60_000)
    store.update(action.id, { state: 'needs_human', takeover: { reason, since: new Date().toISOString() } })
    await this.options.notify(`Browser runner: ${action.account.platform} @${action.account.handle} needs a person (${reason}). Open noVNC on the runner host.`)
      .catch(error => log('warn', 'runner notify failed', errorFields(error)))
    while (Date.now() < deadline) {
      if (await done().catch(() => false)) {
        store.update(action.id, { state: 'running' })
        return
      }
      await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 5_000))
    }
    throw new ScriptError('takeover_timeout', `Nobody resolved: ${reason}`)
  }
}
