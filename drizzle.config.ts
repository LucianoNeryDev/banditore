import { defineConfig } from 'drizzle-kit'

// Generation only. Migrations are applied by src/cli/migrate.ts with the
// migrator role, never by the running service.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
})
