# GoClaw Top Architect Takeaways

## If you only remember ten things

### 1. The task engine is the part to respect

This is the strongest subsystem in the codebase.
It is explicit, stateful, store-backed, and recovery-aware.

### 2. The shell around the task engine is the part to distrust

Identity, mode semantics, admission, eventing, UI convergence, and provider outcomes are much less uniform.

### 3. Recovery is one of their best instincts

GoClaw assumes that real systems:

- get stuck
- partially fail
- leave stale state behind

That mindset is worth stealing.

### 4. Compensation is good only when it repairs state

Post-turn repair and stale recovery are good.
Identity re-propagation and wrapper-specific mode semantics are not.

### 5. One mode name is not enough

If `announce`, `delegate`, or `notification` do not force:

- one identity envelope
- one tool envelope
- one persistence rule
- one side-effect rule

then they are labels, not contracts.

### 6. One field name is not enough

`UserID` became semantically overloaded in GoClaw.
That is a warning sign.
Names must match meaning, especially across async boundaries.

### 7. One auth layer is better than three partial ones

Router + handler + store sharing authorization responsibility is expensive and dangerous.

### 8. One projection model is better than four local truths

Durable backend truth is not enough if board, task detail, chat panel, and debug event stores all rebuild reality differently.

### 9. One provider failure channel is mandatory

Provider adapters should not be allowed to convert real failure into strange success.
The orchestrator above them becomes blind.

### 10. One strong contract beats many strong patches

GoClaw often hardens the same seam repeatedly.
That means the team is good, but the seam itself is still too distributed.

## The five strongest practices worth copying first

1. Store-backed lifecycle state machine
2. Recovery ticker and stale repair
3. Post-turn reconciliation
4. Shared task board as first-class coordination plane
5. Explicit dangerous-seam documentation

## The five most dangerous mistakes to never copy

1. Distributed correctness through propagation chains
2. Modes as labels instead of runtime contracts
3. Split truth across backend, bus, and UI
4. Authorization spread across multiple partial boundaries
5. Provider adapters that soften failure before the engine sees it

## Final architect verdict

GoClaw is impressive because its orchestration core is real.

GoClaw is dangerous as a template because too much important meaning is still carried by:

- context
- metadata
- wrapper chains
- fallback paths
- local projections

Take their boring core.
Do not take their distributed correctness model.
