# GoClaw Architect Playbook

## Why this file exists

This file is the shortest high-signal architect playbook extracted from the whole GoClaw study.

Use it when making actual design decisions, not when exploring.

It answers four questions:

1. What are GoClaw's strongest architectural laws?
2. What are its most dangerous anti-laws?
3. Which patterns should be copied directly?
4. Which patterns should be banned at review time?

## 1. The strongest architectural laws in GoClaw

### Law A. Durable state beats conversational hope

When GoClaw is strongest, it does not trust prompt-only behavior.
It prefers:

- persisted task rows
- explicit lifecycle methods
- recovery workers
- post-turn reconciliation

This is the best law in the codebase.

### Law B. Recovery is part of normal runtime

GoClaw assumes:

- agents hang
- tasks get stuck
- review states rot
- dependent work can become orphaned

And it designs repair into the system itself.

This is a mature worldview.

### Law C. Coordination deserves a first-class plane

The team task board is not just UI.
It is a coordination surface backed by durable state.

This is better than trying to orchestrate everything through ephemeral chat turns.

### Law D. Mature extension surfaces need real contracts

Hooks prove this:

- explicit events
- explicit scopes
- security posture
- audit trail
- dry-run
- docs and tests

When GoClaw chooses to make an extension surface first-class, the result is good.

### Law E. Schema evolution is architecture

Their migration layer shows a strong instinct:

- required schema version
- dirty-state detection
- tracked data hooks

This is boring, serious engineering, and worth copying.

## 2. The most dangerous anti-laws in GoClaw

### Anti-law A. If the contract is unclear, bridge it with metadata

This is probably the single most dangerous pattern in the system.

Examples:

- `origin_sender_id`
- `origin_role`
- `local_key`
- `peer_kind`
- trace ancestry
- synthetic sender markers

This keeps features moving.
It also creates distributed correctness.

### Anti-law B. A name can sound stronger than the runtime really is

Examples:

- `RunKind`
- `UserID`
- viewer/admin/operator boundaries in some paths

The label sounds crisp.
The real behavior is softer.

That is a contract-honesty problem.

### Anti-law C. Breadth is allowed to outrun seam maturity

GoClaw keeps expanding:

- hooks
- channels
- providers
- runtime/packages
- teams
- dashboard
- multi-tenant surfaces

Even while some seams remain hot.

That creates long-term maintenance tax.

### Anti-law D. Compatibility shims stay in hot paths too long

Backward compatibility is treated almost like product policy.

That helps adoption.
But it also means:

- more fallbacks
- more bypasses
- more legacy formats
- more semantic exceptions

in live runtime seams.

### Anti-law E. Truth can be "mostly the same" in several places

This shows up across:

- task row
- audit row
- bus event
- websocket payload
- UI projection

The backend may be right while the product still looks broken.

## 3. Patterns to copy directly

### Copy 1. Store-backed lifecycle state machine

Copy directly:

- explicit task states
- explicit lifecycle transitions
- recovery-aware design

Do not simplify this away.

### Copy 2. Post-turn reconciliation

This is one of their smartest ideas.

Do not assume an agent will always close the state machine correctly.
Have a repair phase after the turn.

### Copy 3. Hooks as a model extensibility subsystem

Copy the style, not necessarily the exact feature set:

- typed config
- explicit events
- security model
- auditability
- dry-run
- fail-closed blocking behavior

### Copy 4. Version-busted caches

This is safer than TTL-only convergence for important behavior.

### Copy 5. Tracked migration hooks

If data needs transformation, make it:

- explicit
- versioned
- idempotent
- remembered

## 4. Patterns to copy only with caution

### Caution 1. Multi-tenant architecture

This is strong in GoClaw.
It is also expensive.

Copy only if multi-tenant is truly part of the product thesis.

### Caution 2. Broad provider layer

Provider breadth is valuable.
But only if every provider feeds one honest run-outcome contract.

### Caution 3. Broad ingress model

One engine with many ingress paths is powerful.
But only if all ingress flows into one canonical execution envelope.

## 5. Patterns to ban at review time

### Ban 1. Wrapper-based semantic transport

If a feature needs several wrapper layers to remember:

- actor
- sender
- scope
- role
- local routing key
- run mode

then the contract is not strong enough.

### Ban 2. Generic patch helpers for important domain state

Critical state must mutate through named domain methods, not generic maps.

### Ban 3. Soft modes pretending to be contracts

If a mode exists, it must define:

- identity envelope
- available tools
- side-effect rules
- tracing semantics
- post-turn behavior

Otherwise it is only a label.

### Ban 4. Auth smeared across layers

Do not let:

- router
- handler
- store

each partially decide access.

One mandatory boundary must own human authorization.

### Ban 5. UI-specific truths

No screen should own its own interpretation of core domain truth.

The UI can project.
It must not redefine.

### Ban 6. Fake-success provider adapters

The engine must have one authoritative failure channel.
No provider adapter may weaken that.

## 6. Decision rules for your future orchestrator

### If a subsystem is core orchestration:

- prefer explicit domain state
- prefer explicit transitions
- prefer repair loops
- prefer stored truth over prompt truth

### If a subsystem crosses boundaries:

- prefer one canonical envelope
- prefer typed contracts
- prefer fail-closed authorization
- prefer explicit routing identity

### If a subsystem is product-facing:

- separate truth from projection
- document limitations
- do not advertise a surface before it is first-class end-to-end

### If a subsystem is operational:

- make migrations explicit
- make dirty state explicit
- make recovery tools explicit

## 7. The top-architect summary

If you only remember one thing from GoClaw, remember this:

- its strongest architecture lives where the system is explicit
- its weakest architecture lives where the system has to remember meaning indirectly

That is the most important lesson.

## Final distilled rule

Copy from GoClaw when you see:

- explicit state
- explicit transitions
- explicit recovery
- explicit auditability
- explicit contracts

Reject from GoClaw when you see:

- metadata as semantic glue
- labels stronger than behavior
- truth split across several layers
- compatibility exceptions in hot paths
- wrapper chains carrying correctness
