import { parseArgs } from 'node:util'
import { z } from 'zod'
import { createDatabase } from '../db/client.js'
import { platforms, providerApps } from '../db/schema.js'
import { pinProviderScopes, providerScopes, scopesToPin } from '../provider-scopes.js'

// Operator command: register or update a provider app. The secret itself is
// configured in the service environment under --secret-ref.
//   provider-app --id … --platform … --external-app-id … --secret-ref … [--scopes a,b]
// `scopes` shows or changes only the scopes a provider app asks for:
//   provider-app scopes --id …                    what it asks for now
//   provider-app scopes --id … --without-replies  pin the defaults without the reply-only scopes
//   provider-app scopes --id … --set a,b          pin these (Google ones by last part: youtube.upload)
//   provider-app scopes --id … --default          unpin: the engine's defaults again
const appId = z.string().regex(/^[a-z0-9-]{3,64}$/)
const [command, ...rest] = process.argv.slice(2)

const { db, pool } = createDatabase(z.string().min(1).parse(process.env.DATABASE_URL))
try {
  if (command === 'scopes') await scopes(rest)
  else await register(process.argv.slice(2))
} finally {
  await pool.end()
}

async function scopes(args: string[]) {
  const { values } = parseArgs({ args, options: { id: { type: 'string' }, 'without-replies': { type: 'boolean' }, set: { type: 'string' },
    default: { type: 'boolean' } } })
  const id = appId.parse(values.id)
  const choices = [values['without-replies'], values.set !== undefined, values.default].filter(Boolean).length
  if (choices > 1) throw new Error('Give at most one of --without-replies, --set and --default')
  let result
  if (!choices) result = await providerScopes(db, id)
  else if (values.default) result = await pinProviderScopes(db, id, null)
  else {
    const { platform } = await providerScopes(db, id)
    result = await pinProviderScopes(db, id, scopesToPin(platform, values.set !== undefined ? { scopes: values.set.split(',') } : { withoutReplies: true }))
  }
  process.stdout.write(`provider app ${id} (${result.platform}) asks for ${result.pinned ? 'pinned' : 'default'} scopes:\n${result.scopes.map(scope => `  ${scope}\n`).join('')}`)
}

async function register(args: string[]) {
  const { values } = parseArgs({ args, options: {
    id: { type: 'string' }, platform: { type: 'string' }, 'external-app-id': { type: 'string' },
    owner: { type: 'string', default: 'agency' }, 'owner-organization': { type: 'string' },
    'secret-ref': { type: 'string' }, mode: { type: 'string', default: 'development' },
    'config-id': { type: 'string' }, scopes: { type: 'string' },
  } })
  const input = z.object({
    id: appId,
    platform: z.enum(platforms),
    // Numeric for Meta and Instagram, a client ID for Google.
    'external-app-id': z.string().regex(/^(\d+|[\w-]+\.apps\.googleusercontent\.com)$/),
    owner: z.enum(['agency', 'tenant']),
    'owner-organization': z.string().min(1).max(200).optional(),
    'secret-ref': z.string().regex(/^[a-z0-9-]{3,64}$/),
    mode: z.enum(['development', 'live']),
    'config-id': z.string().regex(/^\d+$/).optional(),
    scopes: z.string().optional(),
  }).parse(values)
  if ((input.owner === 'tenant') !== Boolean(input['owner-organization'])) throw new Error('--owner-organization is required exactly for tenant apps')
  const row = {
    platform: input.platform, externalAppId: input['external-app-id'], ownerKind: input.owner,
    ownerOrganizationId: input['owner-organization'] ?? null, secretRef: input['secret-ref'], mode: input.mode,
    settings: { configId: input['config-id'], scopes: input.scopes?.split(',').map(scope => scope.trim()).filter(Boolean) },
  }
  await db.insert(providerApps).values({ id: input.id, ...row })
    .onConflictDoUpdate({ target: providerApps.id, set: { ...row, updatedAt: new Date() } })
  process.stdout.write(`provider app ${input.id} saved\n`)
}
