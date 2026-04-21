# GoClaw UI and Realtime Truth

## Core claim

GoClaw's backend task truth is much stronger than its frontend realtime truth reconstruction.

## Main problem

The web client does not seem to use one unified team-state model.
Instead, different screens reconstruct truth differently.

## What this means

There are several competing truth layers:

- durable backend task rows
- audit/event rows
- websocket payloads
- local React state in different screens
- debug event capture

## Consequences

### 1. Board, chat panel, and task detail do not converge the same way

Different UI surfaces subscribe to different events and refresh differently.

That means one screen can be current while another is stale.

### 2. Payload shape drift matters too much

If one routing field or payload field is missing, user-visible truth can break even when backend truth is correct.

Issue `#877` is a clear example:

- task completion event lost `local_key`
- backend task was correct
- routing and user-facing topic placement were wrong

### 3. Query invalidation is not the universal fallback

The app does not appear to use one strong convergence mechanism for team state.

### 4. WS edge is not the worst part

The surprising thing is that websocket edge filtering is relatively disciplined.
The weaker part is the middle:

- event payload shape
- projection code
- UI-local reconstruction

## Best one-line summary

Backend truth is stronger than the live product truth around it.

## Practical lesson

For a new orchestrator UI, pick one:

- canonical event log
- canonical query invalidation path
- canonical shared projection layer

Do not let each screen invent its own convergence strategy.
