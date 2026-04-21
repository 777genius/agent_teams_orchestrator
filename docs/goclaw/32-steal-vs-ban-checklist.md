# GoClaw Steal vs Ban Checklist

## Why this file exists

This is the most actionable companion file in the folder.

It compresses the study into one architect checklist:

- what to steal
- what to ban

Use it when making design decisions for a new orchestrator.

## 1. Task engine

### Steal

- store-backed task lifecycle
- explicit task states
- explicit lifecycle methods instead of ad hoc status patches
- stale recovery as part of runtime
- post-turn reconciliation

### Ban

- generic patch side channels for important task state
- hidden status mutation paths outside the lifecycle API
- assuming bus delivery equals task truth

## 2. Scheduler and admission

### Steal

- scheduler as a real subsystem
- explicit queue semantics
- fairness and backpressure as explicit design topics

### Ban

- helper-chosen delivery guarantees
- multiple queue semantics hidden across call sites
- debouncing in a coarser key-space than routing truth

## 3. Identity and auth

### Steal

- recognizing that `actor`, `scope`, and `sender` are not the same thing
- documenting dangerous identity seams

### Ban

- semantic overload of one field like `UserID`
- correctness that depends on manually re-propagating identity through wrappers
- auth checks split across router, handler, and store
- permissive default role mapping in main request paths

## 4. Execution modes

### Steal

- the idea that system-driven runs should be distinguished from normal user turns

### Ban

- mode names as soft labels
- mode semantics split between context, request, trace metadata, and local flags
- tools, tracing, and UI each learning mode from different channels

## 5. Events, caches, and UI freshness

### Steal

- version-busted caches
- negative cache caps
- explicit invalidation tests

### Ban

- split truth between task row, audit row, event payload, and UI projections
- pubsub invalidation as a replacement for one authoritative domain contract
- every screen inventing its own refresh strategy

## 6. Providers and runtime outcomes

### Steal

- provider abstraction
- failover as a first-class concern

### Ban

- adapter layers that can convert real failure into fake success
- treating `finish_reason = error` as weaker than a real engine error
- letting engine truth depend on provider-specific ambiguity

## 7. Extensibility

### Steal

- hooks as a first-class subsystem
- explicit extension events
- dry-run support
- audit trail
- security posture built into the extension system

### Ban

- marketing extension surfaces that are not wired end-to-end
- "just callbacks" without typed contracts, budgets, or auditability

## 8. Migrations and compatibility

### Steal

- explicit schema version requirements
- dirty migration detection
- tracked data hooks
- edition parity only for truly first-class surfaces

### Ban

- letting backward compatibility live forever in hot paths
- making users discover migration prerequisites only by breaking startup
- mixing developer build flows with operator deployment flows

## 9. Multi-tenant design

### Steal

- tenant as a first-class domain concept
- tenant-bound API keys
- fail-closed tenant resolution where possible

### Ban

- tenant fallbacks that silently widen scope
- owner/admin bypass paths that require every downstream handler to remember extra guards

## 10. Documentation culture

### Steal

- dangerous-seam docs
- changelog as architectural memory
- limitations and troubleshooting sections

### Ban

- docs that keep promising surfaces after runtime has drifted
- assuming docs can compensate for weak contracts

## The distilled architect rule

Steal from GoClaw when it uses:

- explicit domain state
- explicit lifecycle methods
- explicit recovery
- explicit auditability

Ban from your design anything that depends on:

- wrapper propagation
- semantic overload
- split truth
- compatibility glue in hot paths
- soft labels pretending to be contracts
