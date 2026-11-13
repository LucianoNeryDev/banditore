# ADR 0003: The jobs table is the queue

- Status: Accepted
- Date: 2026-10-18

## Context

The first design used pg-boss for scheduling and a separate `jobs` table for
the publishing state machine. That keeps two records of the same job, and the
rules that matter most (re-check pause in the claiming transaction, commit the
attempt before calling the platform, never retry an uncertain attempt) would
live in our code either way.

## Decision

The `jobs` table is the queue. A worker claims the earliest due job with
`SELECT … FOR UPDATE SKIP LOCKED`, re-checks pause and channel status under a
per-tenant advisory lock that pause updates also take, writes the attempt and
sets `running`, and commits before calling the platform. Retries set
`not_before`. A sweeper turns attempts left open for ten minutes into
`uncertain`.

## Consequences

- One source of truth for job state; no extra dependency.
- Polling adds up to one poll interval (five seconds by default) of delay.
- Throughput is bounded by one worker process's concurrency. That is far
  above the expected volume; several processes can share the table safely if
  needed.
