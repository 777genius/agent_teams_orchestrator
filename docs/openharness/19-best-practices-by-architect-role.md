# OpenHarness Best Practices By Architect Role

## Domain architect

Steal:

- explicit persistent team metadata
- explicit message shapes for mailbox traffic
- explicit compaction artifacts

Avoid:

- letting multiple truth models coexist for the same domain too long

## Runtime architect

Steal:

- headless worker execution path
- worktree isolation
- `contextvars` for in-process isolation
- practical restart semantics for one-shot workers

Avoid:

- making file protocols the accidental durable substrate
- letting env flags and prompt wording carry too much runtime meaning

## Contract architect

Steal:

- explicit provider registry
- explicit permission decision object
- allowlisted persisted tool metadata

Avoid:

- sentinel strings like `"inherit"` as a long-lived contract
- soft execution modes without structural enforcement

## Security architect

Steal:

- built-in sensitive path deny patterns
- guarded remote admin surfaces
- capability narrowing by platform

Avoid:

- policy surfaces that over-promise runtime enforcement
- local personalization that can persist or replay secrets

## Frontend and product architect

Steal:

- honest separation between UI mode and worker mode
- channel/gateway progress updates
- session continuity as a product feature

Avoid:

- product surfaces growing faster than the underlying runtime contract

## Operations architect

Steal:

- atomic write plus lock discipline
- crash-safe boring persistence work
- issue-driven hardening of real operational seams

Avoid:

- file and runtime fallbacks that quietly become production semantics

## Chief architect

Steal:

- the strong local primitives
- the boring persistence fixes
- the long-session continuity mindset

Avoid:

- mistaking a powerful harness for a fully closed orchestration engine
