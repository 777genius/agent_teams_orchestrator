# GoClaw Consistency and Events

## Core claim

GoClaw has a strong durable task core, but consistency around that core is much weaker.

## The main problem

There is no single end-to-end truth pipeline.

Instead, truth is split across:

- task rows
- audit/event rows
- message bus events
- websocket payloads
- denormalized counters
- UI-local projections

## Why this matters

A system can have a correct backend task state and still present wrong live behavior because:

- event delivery is best-effort
- audit is subscriber-derived
- UI is reconstructing from partial payloads

## Important weaknesses

### 1. No real outbox pattern

Task state changes, broadcast events, and audit rows are not one atomic commit flow.

That means:

- task row can be right
- audit can lag
- UI can miss or misread the transition

### 2. Broadcast is synchronous fan-out

`MessageBus.Broadcast(...)` is not a durable queue.
It is synchronous fan-out.

That couples:

- latency
- side effects
- subscriber behavior

more tightly than it should.

### 3. Audit is not first-class truth

`team_task_events` is more of a derived trail than a canonical event log.

That is useful for history, but weaker for:

- replay
- convergence
- exact reconstruction

### 4. Generic patch helpers are blind

Some generic update helpers do not strongly assert that a real row update actually happened.

That makes side-channel patches riskier than explicit lifecycle methods.

### 5. Counters are maintained out-of-band

Some denormalized counts are updated in separate steps.
That is operationally understandable, but it increases drift potential.

## Best one-line summary

The inner truth is strong.
The surrounding truth synchronization is not equally strong.

## Practical lesson

If a new orchestrator wants strong consistency, it should prefer:

- one canonical event/outbox path
- one clear replay source
- fewer derived truth layers

not:

- task row here
- audit subscriber there
- UI local patch elsewhere
