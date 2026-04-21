# Recovery And Reconciliation

## One of the best Cortex instincts

Cortex clearly understands that coordinators die and teams may keep working after the coordinator dies.

That is good orchestrator thinking.

## Key pieces

- `Runner.Reconciler`
- `LogParser`
- `WorkspaceSync`
- `WorkspaceLock`

## What is good

### Resume and reconcile are explicit features

They are not hidden.

Cortex has separate paths for:

- resuming dead teams
- reconciling already-finished sessions back into truth

That is much better than many early projects.

### LogParser is serious

`LogParser` parses NDJSON session logs into:

- timeline entries
- token usage
- result presence
- diagnosis
- restart context

This is stronger than simple grep-based recovery.

### WorkspaceSync is practical

There is a periodic sync of workspace state into output storage.

That helps operators and UI consumers, even if the core model is not fully unified.

## The core weakness

Recovery is heavily dependent on:

- logs
- workspace files
- inferred outcomes

That means reconciliation is not restoring one authoritative durable transaction log.

It is reconstructing truth from artifacts.

That is clever, but also a sign that the center of truth is not strong enough yet.

## WorkspaceLock lesson

`WorkspaceLock` is a useful band-aid:

- it serializes read-modify-write file operations

But it also reveals a deeper truth:

- concurrent updates are happening against shared files
- the lock is process-local
- fallback path runs unserialized if the lock process is unavailable

That is acceptable for an early local system.
It is not a platform-grade answer.

## Bottom line

Cortex has a better recovery mindset than most early competitors.

But its recovery model is still artifact-driven rather than engine-driven.

That is a good idea wrapped around a weaker truth model.
