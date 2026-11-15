# ADR 0001: Own engine replaces Postiz as the publishing layer

- Status: Accepted
- Date: 2026-10-18

## Context

The dashboard already owns social drafts, revisions, approval, pause
and audit. Self-hosted Postiz v2.25.0 was adopted only as the execution layer:
it holds channel connections and fires scheduled posts.

In practice that layer is the problem:

- Provider credentials are instance-wide environment variables
  (`FACEBOOK_APP_*`, `X_API_*`, ...). A client cannot bring its own app, and
  one restricted app takes every client down.
- It publishes only through official APIs. Actions those APIs refuse to
  unaudited apps (public TikTok posts, for example) have no path.
- Its public API is limited to 30 requests per hour and has no idempotency
  keys. Workspaces have no creation API and were inserted with SQL.
- It needs Temporal and Redis in addition to PostgreSQL.

No client post has been published through it yet, so replacing it now costs
little: re-connecting a few channels and swapping the dashboard's Postiz client.

## Decision

Build a separate service, the social engine, that executes approved actions.

- The dashboard remains the only control plane. It sends the engine an
  approved revision; the engine executes and reports receipts.
- Provider apps are data, not environment: each channel references the provider
  app it was authorized through, and an app is owned by one tenant or shared
  by the agency ([ADR 0002](0002-per-tenant-provider-apps.md)).
- The job queue runs on PostgreSQL , in the engine's own database on
  the existing PostgreSQL 17 Nomad job.
- Every action goes through a platform adapter with a declared driver. The
  first phase implements only the `api` driver; a `browser` driver is a later,
  separate decision.
- The dashboard selects the executor per organization, so tenants move from
  Postiz to the engine one at a time. Postiz is retired after the engine has
  published for real.

## Consequences

- We own token refresh, rate limits, retries and media upload for every
  platform we support, instead of inheriting Postiz's integrations.
- One more Nomad service and database to back up and monitor.
- Platform support grows one adapter at a time; nothing is available until its
  adapter has been tested end to end.
- The dashboard's Postiz-specific code becomes one implementation of a
  publisher interface and is deleted once no tenant uses it.
