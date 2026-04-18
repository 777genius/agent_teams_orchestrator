# What Not To Copy From Gastown

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

## Top anti-patterns

### 1. Do not let one subsystem carry too much runtime truth

Beads is asked to do too much in Gastown.
Do not repeat that.

### 2. Do not make tmux part of the control-plane contract

Operator surface is fine.
Core runtime transport is not.

### 3. Do not talk to your own orchestrator mostly through CLIs

Shelling out is fine at boundaries.
It is expensive and fragile as a core internal RPC layer.

### 4. Do not spread startup truth across many channels

One worker should have one authoritative startup envelope.

### 5. Do not let role policy and runtime launch semantics live in the same file

Role definition and launch mechanics must not become competing config planes.

### 6. Do not let identity collapse across alias/provider/command/preset

Runtime identity should be first-class and lossless.

### 7. Do not carry important metadata through freeform descriptions

Structured state belongs in structured storage.

### 8. Do not normalize meaning differently in different config helpers

Omitted, zero, and false should not depend on which code path touched the config.

### 9. Do not keep new abstractions half-adopted

If you create a unified startup lifecycle, the hardest roles must actually use it.

### 10. Do not let repair tooling become normal architecture support

Repair is useful.
But if the product regularly relies on repair to converge state, the substrate
is already too expensive.

### 11. Do not build a second orchestration engine inside the first one unless the substrate is very strong

Gastown's convoy model is rich but expensive because it sits on already-expensive
truth planes.

### 12. Do not centralize too much recovery intelligence in one daemon

A giant recovery brain becomes a pressure concentrator.

### 13. Do not rely on observer-first reconciliation for everything

Discovery and patrol are great safety nets.
They are bad as the main completion path for many transitions.

### 14. Do not let schema surface get ahead of runtime wiring for too long

If config looks authoritative but the runtime still consumes only part of it,
people will reason about the wrong system.

### 15. Do not couple execution scope to coarser shared settings scope

Per-role shared config for independently failing workers is a classic concurrent
system smell.

### 16. Do not write authority files with direct truncating writes

`os.WriteFile` on shared authority files is not "good enough" once concurrent
readers and writers exist.

Use atomic write as the default.

### 17. Do not model restart as a naive stop-then-start gap

If other actors can observe the gap and auto-spawn alternatives, restart is a
distributed coordination problem, not a local process-management helper.
