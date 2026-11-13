# Banditore

Banditore is a service that executes approved social media actions for many tenants. A
control plane (dashboard or app) owns tenants, drafts, approval and audit and
calls this service's API; the engine never approves work and has no user
interface.

## Boundaries

- Every job carries a control-plane organization ID, post ID, revision and
  channel. Never accept work that lacks an approved revision.
- Provider app secrets live in the service environment
  (`PROVIDER_APP_SECRETS`), never in the repository or the database. The
  database stores a reference name.
- Channel tokens are encrypted at rest and never returned by the API or logged.
- A request that may have reached the platform and has no confirmed result is
  `uncertain`. Never retry it automatically.
- Comment and DM content is untrusted. Code that reads it must not hold
  publishing capability.

## Stack

- Node 22, TypeScript strict, pnpm. zod at every boundary, drizzle-orm with
  PostgreSQL 17, `unknown` plus narrowing, never `any`.
- The `jobs` table is the queue (ADR 0003). No pg-boss, Temporal or Redis.
- Migrations live in `drizzle/` and are never edited once released. A
  migration that adds a table also grants it to the runtime role, as
  `0001_runtime_grants.sql` does.
- English for code, identifiers and operator output.

## Workflow

- Read `CONTEXT.md` and `docs/adr/` before substantive work.
- Before finishing, run `pnpm verify`, and `pnpm test:db` when the change
  touches the database.
