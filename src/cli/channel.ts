import { parseArgs } from 'node:util'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { importChannel } from '../channels.js'
import { loadConfig } from '../config.js'
import type { EngineContext } from '../context.js'
import { createDatabase } from '../db/client.js'
import { channelKinds, channels } from '../db/schema.js'

// Operator command for moving channels from another publisher. The grant is
// read from stdin and stored encrypted; nothing here prints it.
//   channel import --org … --provider-app … --kind … --external-id … --name …  < {"accessToken", "refreshToken"?, "expiresAt"?}
//   channel list --org …
const [command, ...rest] = process.argv.slice(2)
const { values } = parseArgs({ args: rest, options: {
  org: { type: 'string' }, 'provider-app': { type: 'string' }, kind: { type: 'string' }, 'external-id': { type: 'string' }, name: { type: 'string' },
} })
const organizationId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/)
const credentialSchema = z.strictObject({
  accessToken: z.string().min(1).max(4_000),
  refreshToken: z.string().min(1).max(4_000).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
})

if (command !== 'import' && command !== 'list') {
  console.error('usage: channel import --org … --provider-app … --kind … --external-id … --name … < credential.json | channel list --org …')
  process.exit(2)
}
const config = loadConfig()
const { db, pool } = createDatabase(config.databaseUrl)
// Neither command calls a platform, so no adapters are needed.
const context: EngineContext = { db, keyring: config.keyring, providerSecrets: config.providerSecrets, adapters: new Map() }
try {
  if (command === 'list') {
    const rows = await db.select().from(channels).where(eq(channels.organizationId, organizationId.parse(values.org))).orderBy(channels.name)
    for (const row of rows) console.log(`${row.id}  ${row.platform}  ${row.kind}  ${row.externalId}  ${row.name}  ${row.status}`)
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    const parsed = credentialSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (!parsed.success) throw new Error(`Invalid credential: ${parsed.error.issues.map(issue => issue.path.join('.') || 'credential').join(', ')}`)
    const result = await importChannel(context, {
      organizationId: organizationId.parse(values.org),
      providerAppId: z.string().regex(/^[a-z0-9-]{3,64}$/).parse(values['provider-app']),
      kind: z.enum(channelKinds).parse(values.kind),
      externalId: z.string().min(1).max(200).regex(/^[\w.-]+$/).parse(values['external-id']),
      name: z.string().min(1).max(200).parse(values.name),
      credential: { accessToken: parsed.data.accessToken, ...(parsed.data.refreshToken ? { refreshToken: parsed.data.refreshToken } : {}),
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null },
    })
    console.log(`imported channel ${result.channelId}`)
  }
} finally {
  await pool.end()
}
