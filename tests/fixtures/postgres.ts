import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from '../../src/db/schema.js'

const command = promisify(execFile)
// Same pinned PostgreSQL 17 image as the dashboard's database tests.
const image = 'postgres:17@sha256:aa90e97ee862e558111d34cfb8b2c4bec768c2b039fb791341686928560263b3'
const label = 'banditore-test=postgres'

/** A disposable PostgreSQL 17 container with migrator and runtime roles. */
export async function postgresFixture() {
  const password = randomBytes(24).toString('hex')
  const pools: pg.Pool[] = []
  let id: string | undefined
  let port = 0
  const pool = (user: string, database: string) => {
    const created = new pg.Pool({ host: '127.0.0.1', port, user, password, database, connectionTimeoutMillis: 2_000, max: 10 })
    pools.push(created)
    return created
  }
  async function cleanup() {
    await Promise.all(pools.map(value => value.end().catch(() => undefined)))
    if (!id) return
    const inspection = JSON.parse((await command('docker', ['inspect', id])).stdout)[0]
    if (inspection.Config.Labels['banditore-test'] !== 'postgres') throw new Error('Fixture ownership mismatch')
    await command('docker', ['rm', '-fv', id])
  }
  try {
    id = (await command('docker', ['run', '-d', '--label', label, '-e', 'POSTGRES_USER=bootstrap', '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', 'POSTGRES_DB=postgres', '-p', '127.0.0.1::5432', image])).stdout.trim()
    port = Number((await command('docker', ['port', id, '5432'])).stdout.trim().split('\n')[0]!.split(':').at(-1))
    const admin = pool('bootstrap', 'postgres')
    let ready = false
    // Up to 90 s: a loaded machine can take longer than half a minute to start the container.
    for (let retry = 0; retry < 450 && !ready; retry++) {
      try { await admin.query('select 1'); ready = true } catch { await new Promise(resolve => setTimeout(resolve, 200)) }
    }
    if (!ready) throw new Error('Fixture not ready')
    for (const role of ['social_engine_migrator', 'social_engine_runtime']) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
    }
    await admin.query('CREATE DATABASE leonessa_social_engine OWNER social_engine_migrator')
    await admin.query('REVOKE ALL ON DATABASE leonessa_social_engine FROM PUBLIC')
    await admin.query('GRANT CONNECT ON DATABASE leonessa_social_engine TO social_engine_migrator, social_engine_runtime')
    const migrator = pool('social_engine_migrator', 'leonessa_social_engine')
    await migrate(drizzle(migrator), { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })
    const runtime = pool('social_engine_runtime', 'leonessa_social_engine')
    return { cleanup, migrator, runtime, db: drizzle(runtime, { schema }), pool }
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}
