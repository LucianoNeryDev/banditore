import { createHash, timingSafeEqual } from 'node:crypto'
import { createApp, createRouter, defineEventHandler, getQuery, getRequestHeader, getRouterParam, readRawBody, setResponseStatus, type H3Event } from 'h3'
import { z, ZodError } from 'zod'
import { errorFields, log } from '../log.js'
import { actionRequestSchema, actionView, type ActionStore } from './actions.js'

/** The runner's API. Only the engine calls it, over a private network, with its own bearer token. */
export function createRunnerApp(store: ActionStore, token: string, wake: () => void) {
  const expected = digest(token)
  const router = createRouter()
  router.get('/healthz', defineEventHandler(() => ({ ok: true })))
  router.post('/v1/actions', authed(async (event) => {
    const raw = await readRawBody(event, false)
    if (!raw || raw.length > 256_000) throw new HttpError(400, 'invalid_request')
    const action = store.submit(actionRequestSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8'))))
    setResponseStatus(event, 202)
    wake()
    return actionView(action)
  }))
  // The engine looks an action up by its own attempt ID when reconciling.
  router.get('/v1/actions', authed(async (event) => {
    const action = store.findByRequest(actionRequestSchema.shape.actionId.parse(getQuery(event).actionId))
    if (!action) throw new HttpError(404, 'not_found')
    return actionView(action)
  }))
  router.get('/v1/actions/:id', authed(async (event) => {
    const action = store.get(z.uuid().parse(getRouterParam(event, 'id')))
    if (!action) throw new HttpError(404, 'not_found')
    return actionView(action)
  }))
  router.post('/v1/actions/:id/cancel', authed(async (event) => {
    const action = store.cancel(z.uuid().parse(getRouterParam(event, 'id')))
    if (!action) throw new HttpError(404, 'not_found')
    return actionView(action)
  }))
  const app = createApp()
  app.use(router)
  app.use(defineEventHandler((event) => {
    setResponseStatus(event, 404)
    return { error: 'not_found' }
  }))
  return app

  function authed(handler: (event: H3Event) => Promise<unknown>) {
    return defineEventHandler(async (event) => {
      try {
        const header = getRequestHeader(event, 'authorization') ?? ''
        if (!timingSafeEqual(digest(header.startsWith('Bearer ') ? header.slice(7) : ''), expected)) throw new HttpError(401, 'unauthorized')
        return await handler(event)
      } catch (error) {
        if (error instanceof HttpError) {
          setResponseStatus(event, error.status)
          return { error: error.code }
        }
        if (error instanceof ZodError || error instanceof SyntaxError) {
          setResponseStatus(event, 400)
          return { error: 'invalid_request' }
        }
        log('error', 'runner request failed', { path: event.path.split('?')[0], ...errorFields(error) })
        setResponseStatus(event, 500)
        return { error: 'internal' }
      }
    })
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}
