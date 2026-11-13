import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

// Migrations run with the migrator role, outside the service job.
const migrationUrl = process.env.DATABASE_MIGRATION_URL
if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required')
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).username === new URL(migrationUrl).username) {
  throw new Error('Runtime and migration roles must differ')
}
const pool = new Pool({ connectionString: migrationUrl, max: 1 })
try {
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })
  process.stdout.write('migrations applied\n')
} finally {
  await pool.end()
}
