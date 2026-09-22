# GoClaw Compensating Architecture Signals

## Why this file exists

Many large systems do not break because the core model is weak.
They break because too much surrounding code is forced to compensate for missing contracts.

GoClaw is a good example of this pattern.

## Healthy compensation vs unhealthy compensation

Compensation is not always bad.

Healthy compensation:

- repairs durable state after crashes or partial turns
- makes failure visible
- converges toward one canonical truth

Unhealthy compensation:

- reconstructs meaning that should have been carried explicitly
- relies on wrapper-specific metadata propagation
- makes different paths semantically unequal
- hides failure behind fallback behavior

## Healthy compensation GoClaw gets right

### 1. Post-turn reconciliation

This is one of the strongest parts of the system.

The runtime does not trust the agent turn to fully finalize orchestration state.
It reconciles after the turn:

- auto-complete
- auto-fail
- redispatch
- stale repair
- blocked-task unblocking

This is good compensation because it repairs one durable state machine.

### 2. Stale recovery ticker

The ticker exists because real orchestration is messy:

- tasks can get stuck
- sessions can die
- locks can outlive their owners

GoClaw handles this explicitly.

This is healthy because the compensation is domain-aware and state-aware.

### 3. Publish-time validation observers

The `eventbus/validate_agent_id.go` observer is a good pattern.
It does not silently reinterpret meaning.
It detects drift and surfaces it.

That is a good use of a safety net.

## Unhealthy compensation signals in GoClaw

### 1. Identity re-propagation patches

The system repeatedly needs to restore:

- `origin_sender_id`
- `origin_role`
- `local_key`
- `peer_kind`
- session metadata

This is not normal recovery.
It is a sign that the execution envelope is not canonical.

### 2. Path-specific announce wrapping

Two runs can both look like `RunKind = "announce"` and still carry different:

- identity subsets
- side-effect semantics
- post-turn behavior

That means wrappers are compensating for a missing mode contract.

### 3. UI fetch-one / refetch convergence

The UI often repairs itself by:

- local optimistic patch
- fetch-one on a specific event
- per-screen refetch logic

That is compensation for split truth, not a coherent projection model.

### 4. Generic patch helpers around strong lifecycle APIs

Once a system already has named lifecycle methods, generic patch paths used as safety nets are a smell.

They usually indicate:

- the runtime wants a shortcut
- the store contract is weaker than the domain contract
- mocks and production can drift apart

### 5. Fail-open and backward-compat shims in sensitive seams

Examples in GoClaw include:

- no gateway token -> full-access backward-compat mode
- pairing check failure -> assume paired in some channel paths
- no permission store -> allow all in heartbeat flow
- context file permission check failures with fail-open comments

These are not just implementation details.
They are architecture signals that availability often wins over contract sharpness.

## What these signals mean architecturally

GoClaw's center is stronger than its shell.

The durable task engine is first-class.
The surrounding execution contract is partly reconstructed by compensation.

This creates two kinds of strength:

- strong state repair inside the core
- weaker semantic stability at subsystem boundaries

## How to read compensation as an architect

When you see compensation, ask:

1. Is this repairing state, or reconstructing meaning?
2. Is it converging toward one truth, or hiding split truth?
3. Is it local and explicit, or spread through many wrappers?
4. Would one typed contract remove the need for this logic?

If the answer to question 4 is "yes", the compensation is probably a smell.

## What to steal

- post-turn reconciliation
- stale recovery tied to explicit task state
- validation observers that detect drift without reinterpreting it

## What to avoid

- compensating for missing identity contracts by adding more metadata hops
- compensating for weak UI truth with screen-specific refetch rituals
- compensating for soft modes with path-specific wrappers
- compensating for weak auth with local handler checks

## The distilled lesson

Use compensation to repair durable state.

Do not use compensation to carry the meaning of the system.
