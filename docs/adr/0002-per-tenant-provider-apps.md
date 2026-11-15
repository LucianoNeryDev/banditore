# ADR 0002: Provider apps per tenant

- Status: Accepted
- Date: 2026-10-18

## Context

A platform developer app (Meta app, X project, TikTok app) is what a channel
owner authorizes through OAuth. Its permissions, review status and rate limits
apply to every channel connected through it.

One reviewed Meta app can technically serve many businesses. Separate apps are
still useful when a client must own the app in their own Business Manager, or
to contain the damage when a platform restricts one app.

## Decision

Store provider apps as records, each with:

- the platform and the platform's app identifier,
- an owner: one tenant, or `agency` for a shared app,
- a secret reference (a Nomad variable key), never the secret itself,
- its mode (development or live) and the permissions granted to it.

Every channel references the provider app it was authorized through. Token
refresh and API calls for that channel use that app's credentials. A
tenant-owned app may only connect that tenant's channels; an agency app may
connect any tenant's channels.

The operator's own channels use an operator-owned app. Clients default to the
agency app and may move to their own app later.

## Consequences

- Moving a channel to a different app requires the owner to authorize again.
- App review applies per app: a tenant-owned app needs its own review before it
  can serve users who have no role on it.
- The OAuth callback URL is on the dashboard API, so it must stay stable;
  changing it means updating every registered app.
