# GoClaw First-Class vs Soft Subsystems

## Why this matters

Large products often look architecturally uniform from the outside.

They are not.

Some subsystems are truly first-class:

- typed
- store-backed
- enforced
- tested
- visible in product flows

Other subsystems are softer:

- partially enforced
- path-dependent
- wrapper-dependent
- narrative-strong but contract-weaker

GoClaw is a good case study in this difference.

## First-class subsystems in GoClaw

### 1. Team task engine

This is the clearest first-class subsystem.

Why:

- explicit statuses
- explicit lifecycle methods
- real recovery
- store-backed truth
- visible product usage
- broad test coverage

This subsystem deserves trust.

### 2. Scheduler core

The inner scheduler also feels first-class.

Why:

- dedicated package
- explicit queue semantics
- real tests
- real concurrency model

Important nuance:

- the scheduler core is first-class
- the admission shell around it is not equally strong

### 3. Hooks

Hooks are now first-class enough to count.

Why:

- explicit store contract
- PG + SQLite implementations
- docs
- RPC surface
- audit log
- security model
- tests

### 4. Skills

Skills are reasonably first-class:

- seeding
- hashing
- dependency scanning
- lifecycle state

The system clearly treats them as managed assets.

## Soft subsystems in GoClaw

### 1. Execution modes

`announce`, `delegate`, `notification` look important, but they are softer than they appear.

Why:

- meaning depends on wrappers and side flags
- tool visibility and tracing visibility are split
- same mode label can arrive with different identity and side-effect envelopes

This is not first-class contract design.

### 2. Identity propagation

Conceptually mature.
Operationally soft.

Why:

- actor/scope/sender are understood
- but not carried by one canonical typed envelope

This creates constant seam pressure.

### 3. UI truth model

The UI is product-rich, but the truth model is soft.

Why:

- multiple local projections
- different event coverage per screen
- convergence by refetch habits instead of one projection law

### 4. Provider outcome normalization

Providers are strategically important, but the run-truth contract is softer than it should be.

Why:

- some adapters return hard errors cleanly
- some can soften failure into weak success semantics

That makes the subsystem less first-class than the task engine.

### 5. Authorization boundary

The project has roles, API keys, sender-aware checks, and tenant scope.
That sounds first-class.

But enforcement is still softer than the vocabulary:

- router
- handler
- store

all participate.

This is not one hard boundary.

## Mixed subsystems

### Domain eventing

There are good ingredients:

- typed domain events
- worker pool
- dedup
- retry

But the total event story is mixed because:

- domain events are not the only event system
- message bus and UI eventing form a separate reality

### Tracing

Tracing is strong in product value and instrumentation effort.
It is also honest enough to show a key lesson:

- some stale recovery is intentionally disabled to avoid false kills

That is good operational judgment.
But it also shows the runtime contract is still bounded by caution and compromise.

## The architect rule

When copying from GoClaw, do not copy by feature label.

Copy by subsystem maturity.

Good questions:

1. Is this backed by one explicit store contract?
2. Is it implemented in both storage modes?
3. Is it enforced the same way across paths?
4. Does one screen/path tell the same truth as another?
5. Are tests proving one contract, or only local incidents?

## What to steal

- first-class task engine discipline
- first-class hook subsystem discipline
- skills as managed assets

## What to avoid

- treating soft subsystems like they are already fully contractual
- building product workflows on top of semantics that still depend on wrapper choice

## The distilled lesson

GoClaw teaches that architecture quality must be judged per subsystem, not per repository.

Some parts are genuinely mature.
Some parts are still socially mature but technically soft.
