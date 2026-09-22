# GoClaw Migrations and Backward-Compat Pressure

## Core observation

GoClaw takes evolution seriously.
That is good.

But it also pays a high price for backward compatibility and environment breadth.

This file is about that tradeoff.

## 1. What they do well

### Explicit schema discipline

Their upgrade layer has real structure:

- required schema version is explicit
- dirty migration detection exists
- error messages point to recovery commands

This is much better than silent boot drift.

Architect lesson:

- schema version should be treated as a runtime contract, not just a deploy detail

### Data hooks after SQL migrations

They support Go data hooks after SQL migration versions.

Good signals:

- hooks are version-bound
- hooks are tracked in `data_migrations`
- hooks are designed to be idempotent

This is strong engineering.

Architect lesson:

- if schema change needs data transformation, encode it as a tracked subsystem, not an ad hoc admin note

### PG + SQLite parity for stronger subsystems

Hooks are a good example:

- PostgreSQL schema
- SQLite schema
- tests around both

This is the right way to support edition split.

Architect lesson:

- edition split is only healthy when the contract is intentionally mirrored

## 2. Where the pressure starts to hurt

### Onboarding friction is an architectural signal

Issue `#312` is not just an installation complaint.
It reveals architecture cost:

- Go installation path confusion
- missing migrations on binary path
- PostgreSQL requirement
- `pgcrypto` and `vector` requirements
- dirty migration recovery
- docs/command mismatch

This means setup complexity is part of the architecture now.

Architect lesson:

- if "first 30 minutes" are rough, the architecture is already demanding too much operational context

### Docker update path confusion

Issue `#934` shows another class of pain:

- pulled image exists
- `make up` rebuilds from local source with cached layers
- operator expects update but gets old local build path instead

This is product/ops drift created by mixed build-vs-run concerns.

Architect lesson:

- developer build paths and operator deployment paths should be visibly separate

### Backward compatibility leaks into hot paths

GoClaw keeps many compatibility shims alive:

- no gateway token → permissive dev/full-access paths
- legacy session formats
- old ownership fallbacks
- old reasoning config shims
- many `legacy`, `deprecated`, `backward compat`, `bypass` notes in live code

This keeps installs working, but it also pollutes runtime contracts.

Architect lesson:

- backward compatibility should expire
- if it lives too long in hot paths, it becomes part of the architecture

## 3. Strong migration mindset vs weak contract closure

This is the central tension:

- migration discipline is relatively strong
- runtime contract closure is weaker

So the system can evolve schema safely while still carrying semantic drift in:

- auth
- identity
- execution modes
- event/UI sync

Architect lesson:

- good migration machinery does not automatically mean good contract hygiene

## 4. Best practices to steal

- explicit required schema version
- dirty-state detection
- tracked data hooks
- idempotent migration memory
- PG/SQLite parity only for truly first-class subsystems
- changelog entries that explain architectural migration rationale

## 5. Bad practices to avoid

- making operators discover migration prerequisites by failure
- coupling normal onboarding to heavyweight DB extensions without a smoother path
- leaving compatibility bridges active inside hot runtime seams for too long
- mixing developer build flows and consumer update flows
- assuming docs are enough compensation for operational complexity

## 6. The top-architect view

The best version of GoClaw here is:

- serious about schema evolution
- serious about data migration discipline

The dangerous version is:

- too willing to keep compatibility dialects alive in core-adjacent behavior

That distinction matters.

## The distilled lesson

Steal their migration discipline.
Do not inherit their habit of letting backward compatibility become permanent runtime texture.
