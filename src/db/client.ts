import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  return { pool, db: drizzle(pool, { schema }) }
}

export type Database = ReturnType<typeof createDatabase>['db']
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type Executor = Database | Transaction
