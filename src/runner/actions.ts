import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { browserPlatforms, channelKinds } from '../db/schema.js'

export const actionStates = ['queued', 'running', 'needs_human', 'succeeded', 'failed', 'uncertain', 'cancelled'] as const
export type ActionState = typeof actionStates[number]

export const actionRequestSchema = z.strictObject({
  // The engine's attempt ID: the same request twice returns the same action.
  actionId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  kind: z.enum(['login', 'publish_post']),
  account: z.strictObject({
    id: z.uuid(),
    platform: z.enum(browserPlatforms),
    handle: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
    sealed: z.strictObject({ ephemeralPublicKey: z.base64(), nonce: z.base64(), ciphertext: z.base64() }),
  }),
  // Where to post: the channel's kind and external ID (a LinkedIn Page's company ID, or the handle).
  target: z.strictObject({ kind: z.enum(channelKinds), externalId: z.string().min(1).max(200) }).optional(),
  // Checked by the engine for the platform: Pinterest's board, Reddit's subreddit and title.
  settings: z.record(z.string().max(100), z.union([z.string().max(2_000), z.number(), z.boolean()])).default({}),
  content: z.string().max(50_000).default(''),
  media: z.array(z.strictObject({ url: z.url({ protocol: /^https$/ }), mimeType: z.enum(['video/mp4', 'image/jpeg', 'image/png']) })).max(20).default([]),
})
export type ActionRequest = z.infer<typeof actionRequestSchema>

export interface Action extends ActionRequest {
  id: string
  state: ActionState
  /** Set just before the step that makes something public; after it, failures are uncertain. */
  visibleAt?: string
  receipt?: { externalId: string, url?: string }
  error?: { code: string, detail: string }
  takeover?: { reason: string, since: string }
  createdAt: string
  updatedAt: string
}

const finalStates: ActionState[] = ['succeeded', 'failed', 'uncertain', 'cancelled']
/** Finished actions are kept this long so the engine can read their result. */
const retentionMs = 7 * 86_400_000

/**
 * Actions, persisted as one JSON file on the runner's volume. The file is
 * small (one account acts at a time) and rewritten atomically on each change.
 */
export class ActionStore {
  private readonly actions = new Map<string, Action>()

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {
    let saved: Action[] = []
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as Action[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const action of saved) {
      // A restart interrupted these. Before the visible step nothing happened;
      // after it, only a person or a reconcile can tell.
      if (action.state === 'running' || action.state === 'needs_human') {
        Object.assign(action, action.visibleAt
          ? { state: 'uncertain', error: { code: 'runner_restarted', detail: 'The runner restarted after the visible step' } }
          : { state: 'failed', error: { code: 'runner_restarted', detail: 'The runner restarted before the visible step' } })
        delete action.takeover
      }
      this.actions.set(action.id, action)
    }
    this.save()
  }

  submit(request: ActionRequest): Action {
    const existing = [...this.actions.values()].find(action => action.actionId === request.actionId)
    if (existing) return existing
    const at = this.now().toISOString()
    const action: Action = { ...request, id: randomUUID(), state: 'queued', createdAt: at, updatedAt: at }
    this.actions.set(action.id, action)
    this.save()
    return action
  }

  get(id: string) {
    return this.actions.get(id)
  }

  findByRequest(actionId: string) {
    return [...this.actions.values()].find(action => action.actionId === actionId)
  }

  next() {
    return [...this.actions.values()].filter(action => action.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  }

  update(id: string, values: Partial<Pick<Action, 'state' | 'visibleAt' | 'receipt' | 'error' | 'takeover'>>) {
    const action = this.actions.get(id)
    if (!action) throw new Error(`Unknown action ${id}`)
    if (finalStates.includes(action.state)) throw new Error(`Action ${id} is already ${action.state}`)
    Object.assign(action, values, { updatedAt: this.now().toISOString() })
    if (values.state && values.state !== 'needs_human') delete action.takeover
    this.save()
    return action
  }

  /** Cancels a queued action; anything already started runs to its end. */
  cancel(id: string) {
    const action = this.actions.get(id)
    if (!action) return null
    if (action.state === 'queued') return this.update(id, { state: 'cancelled' })
    return action
  }

  private save() {
    const cutoff = this.now().getTime() - retentionMs
    for (const [id, action] of this.actions) {
      if (finalStates.includes(action.state) && Date.parse(action.updatedAt) < cutoff) this.actions.delete(id)
    }
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify([...this.actions.values()]), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}

/** The view returned to the engine: never the sealed secret. */
export function actionView(action: Action) {
  return { id: action.id, actionId: action.actionId, kind: action.kind, accountId: action.account.id, state: action.state,
    visible: Boolean(action.visibleAt), receipt: action.receipt, error: action.error, takeover: action.takeover, updatedAt: action.updatedAt }
}
