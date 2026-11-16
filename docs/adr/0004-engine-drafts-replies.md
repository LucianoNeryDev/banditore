# ADR 0004: The engine decides and drafts answers, and still sends only what was approved

- Status: Accepted
- Date: 2026-11-15

## Context

Direct messages and comments wait for a person to read them and write an
answer in the control plane. Many need none (a thanks, an emoji), and many
ask what the brand has already written down (opening hours, shipping). The
control plane wants every inbound item sorted and, where it needs an answer,
a draft ready to approve; for some, an answer that goes out within minutes
without a person.

The engine already holds the inbound text and the channel context, and the
control plane already owns approval. Until now the engine held no model and
the boundary was simple: the code that reads comments and messages holds no
sending code, and nothing is sent that the control plane did not submit.

## Decision

The engine decides and drafts; it still sends only what the control plane
approved.

- **Settings.** The control plane pushes each tenant's resolved answering
  settings and preprogrammed context (`PUT /v1/tenants/:org/answering`,
  versioned). No settings, or `drafts` off: nothing happens, and a revision
  is refused. Items first seen before their kind was switched on are never
  processed.
- **A separate step.** The readers (conversation sync, comment reader) are
  unchanged: they store what they read and nothing else. A worker step that
  runs on its own schedule, after their commits, picks up new inbound rows
  that have no decision. It holds the models but no sending code; all it
  writes is one row per item (`inbound_drafts`) and an event for the control
  plane.
- **Decision.** One Choice question to Liquid AI's System One (`full`,
  `draft`, `none`), after `never` and `always` cases checked in code. The
  policy is the instruction; the item is state labelled as untrusted. A
  flagged item (a direct message with attachments) is asked but never
  `auto`. No key or a failed call is `skipped`: a person decides.
- **Draft.** Claude (Haiku 5.5 by default) with no tools and a structured
  JSON answer. Untrusted text is wrapped as escaped data; the brand's voice
  and context come from the control plane. `none` items get no draft. A
  cleared item whose draft is empty, unneeded or flagged by the drafting
  model goes to a person.
- **Approval stays in the control plane.** The control plane pulls the
  drafts (`/v1/drafts/outbox`), shows them, and approves them through a person
  or its own automatic approval. An automatic approval is submitted through
  the existing reply and message routes with `approvedVia: "automation"` and
  the draft's ID, and the engine re-checks its own records (`guard_*`): the
  decision was `auto`, the settings still allow it, the text is the unedited
  draft, the draft is current and unused, and the delay has passed. The
  control plane's word alone is never enough.
- **Revisions.** A person may ask for a new version with an instruction
  (`drafts/revise`); the engine answers synchronously and stores only an
  audit event.

## Consequences

- The text of DMs and comments of tenants with answering on reaches two
  processors, Liquid AI (decision) and Anthropic (draft). Tenants without
  settings are never sent to either.
- Drafts are model output about third-party content: kept like the inbound
  rows (180 days, removed when the channel is disabled).
- A hostile message can at most move the decision's numbers or the draft's
  text; it cannot send anything. The guards and the unedited-digest rule
  mean only a draft the engine itself cleared can go out unseen.
- Both keys are optional. The engine works as before without them.

## Alternatives considered

- **Draft in the control plane.** It never holds message bodies at the
  volume the engine reads them, and the engine's guard would then trust its
  word about what was decided.
- **Draft inside the readers.** Simplest, but the code that reads untrusted
  content would hold model calls and be one step from sending; a crash or a
  slow model would also hold up reading.
