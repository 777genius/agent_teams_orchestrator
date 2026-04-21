# Dashboard, Events, And Freshness

## What is strong

### 1. The dashboard is refresh-honest

`🎯 9   🛡️ 8   🧠 4`

`src/commands/dashboard.ts` is not pretending to be instant, push-based truth.

It is explicitly:
- polling
- cached
- run-scoped by `current-run.txt`
- tolerant of transient DB failures

That honesty is good.

### 2. Event buffering is pragmatic

`🎯 8   🛡️ 8   🧠 3`

`EventBuffer` does incremental dedup with `lastSeenId` and keeps a rolling window.

That is a good local dashboard pattern.

### 3. Headless agents get a real event ingestion path

`🎯 9   🛡️ 8   🧠 4`

`src/events/tailer.ts` is important.

It bridges:
- headless `stdout.log`
- NDJSON event parsing
- `events.db`

That is how the project keeps headless runtime progress visible without lying that `tmux` is the only source of truth.

## What is weak

### 1. Freshness is a mixed model

`🎯 10   🛡️ 8   🧠 5`

The dashboard truth is a composition of:
- polling
- TTL caches for tracker and subprocess data
- `EventBuffer`
- stale-on-error session fallback
- tailer-fed `events.db`

This is pragmatic, but it is not one clean freshness model.

### 2. "Best effort" is everywhere

`🎯 9   🛡️ 8   🧠 4`

A lot of dashboard loading paths degrade silently:
- tracker unavailable -> cached tasks or empty
- DB errors -> cached sessions
- event failures -> empty feed

That is fine for operator UX, but it means observability coherence is softer than the UI may imply.

### 3. Current-run scoping is useful but partial

`🎯 8   🛡️ 8   🧠 3`

Run scoping by `current-run.txt` is a nice operator concept.

But it coexists with:
- null `runId` sessions
- repo-local state
- stale session caches

So it is a helpful lens, not one complete execution boundary.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- polling honesty
- rolling event buffer
- explicit tailer from headless logs to structured events

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- letting a mixed freshness model masquerade as one clean real-time truth

## Architect takeaway

**`overstory`'s dashboard is more honest than many real-time UIs, but it still sits on a layered freshness model rather than one canonical live truth stream.**
