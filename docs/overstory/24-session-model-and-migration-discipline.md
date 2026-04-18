# Session Model And Migration Discipline

## What is strong

### 1. Sessions moved from flat file to SQLite with a real bridge

`🎯 9   🛡️ 9   🧠 4`

`src/sessions/compat.ts` is a good migration story:
- `sessions.db` becomes authoritative
- `sessions.json` is imported if needed
- empty DB vs existing DB is handled explicitly

This is much cleaner than abandoning old state abruptly.

### 2. Schema migrations are boring and explicit

`🎯 9   🛡️ 8   🧠 3`

The session store handles additive migration steps like:
- `bead_id` -> `task_id`
- `transcript_path`
- `prompt_version`
- `coordinator_name`

This is strong quiet engineering.

### 3. Run model exists, not just sessions

`🎯 8   🛡️ 8   🧠 4`

The presence of `RunStore` and run-scoped logic is important.

It means the system is not only tracking individual agent sessions, but also trying to model a higher-level swarm run.

## What is weak

### 1. Session truth is still local and partially reconstructed

`🎯 9   🛡️ 8   🧠 4`

The session model is good for one repo, but dashboard and status still need to:
- reconcile process liveness
- patch state from observed health
- combine run view with null-run sessions

That means session truth is durable, but not self-sufficient.

### 2. Health-corrected state is useful but soft

`🎯 8   🛡️ 8   🧠 4`

Both status and dashboard update session state based on observed health.

That is a practical design.

But it also means the persisted session row is not the only authority; process observation is co-authoring truth.

### 3. Compatibility bridges can linger

`🎯 8   🛡️ 8   🧠 3`

The current bridge is well done, but every bridge carries a long-tail cost if it never truly dies.

That is a general lesson more than a specific flaw.

## Best practice to steal

`🎯 9   🛡️ 9   🧠 4`

Steal:
- explicit migration bridge
- additive schema evolution
- run model separate from session rows

## Anti-pattern to ban

`🎯 8   🛡️ 8   🧠 3`

Ban:
- pretending migration is done while operational code still relies on fallback semantics everywhere

## Architect takeaway

**`overstory` shows good migration discipline around session truth. The subtle lesson is that persistence, observation, and UI still need a clear hierarchy of authority.**
