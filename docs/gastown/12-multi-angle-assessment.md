# Gastown Multi-Angle Architectural Assessment

Date: 2026-04-16  
Studied revision: `bdbe8c4b` on `main`

This file evaluates Gastown from several architect-level angles instead of only
from a single "good or bad architecture" lens.

## Summary

Gastown is strongest when the question is:

- how should coding agents coordinate?
- how should work be isolated?
- how should failures be treated as normal?

Gastown is weakest when the question is:

- what is the cleanest substrate?
- what scales operationally with the least tax?
- what ports cleanly to new runtimes and platforms?

## 1. Orchestration model

### What is strong

- explicit mail and handoff model
- role model with real operational semantics
- staged and dependency-aware workflow thinking
- serious treatment of continuation, resume, and worker reuse

Architect rating: `🎯 9.6   🛡️ 8.8   🧠 4`

### What is risky

- role and workflow vocabulary is rich enough to create concept tax
- convoy, wisps, molecules, gates, patrols, dogs, deacon loops add a second and
  sometimes third layer of orchestration on top of the base system

Architect rating: `🎯 9.4   🛡️ 8.2   🧠 7`

### Verdict

Gastown is one of the best projects to study for orchestration primitives.

It is not one of the best projects to copy literally as an orchestration engine
shape.

## 2. Runtime substrate

### What is strong

- the team clearly understands that coding-agent orchestration is a stateful
  system, not a chat toy
- there is persistent work tracking, recovery logic, and lifecycle reasoning

### What is weak

Runtime truth is split across too many planes:

- Beads and Dolt
- tmux sessions and pane state
- freeform description metadata
- env variables
- JSON shadow-state files
- patrol discovery

Architect rating: `🎯 9.9   🛡️ 9.6   🧠 8`

### Verdict

This is Gastown's biggest architectural weakness.

## 3. Startup and lifecycle contract

### What is strong

- the project has clearly invested in startup, priming, role-specific
  lifecycle, and readiness logic
- there are newer abstractions trying to improve this, such as unified session
  lifecycle helpers and role-definition work

### What is weak

Startup truth is fragmented across:

- role TOML `start_command`
- runtime config resolution
- env assembly
- hooks and priming
- tmux environment propagation
- role-specific managers

Evidence:

- `#3218`
- `#3248`
- `#1289`
- `#1666`
- `#3652`

Architect rating: `🎯 9.8   🛡️ 9.4   🧠 7`

### Verdict

Gastown's startup contract is one of the clearest examples of "many almost-good
abstractions, but no single authoritative one".

## 4. Performance and scaling behavior

### What is strong

- the team and community clearly recognize polling tax as a real problem
- there are explicit pushes toward event-driven wake and reduced polling
- there is visible awareness that current behavior is too expensive

### What is weak

Current architecture still pays for:

- CLI/subprocess tax
- polling tax
- repeated Dolt access
- background scans and patrol loops

Evidence:

- `#1760` - dashboard spawns 55+ `bd` processes
- `#2067` - proposal to move deacon to event-driven wake
- `#3597` - blocked convoys causing repeated `bd` subprocess churn

Architect rating: `🎯 9.7   🛡️ 9.3   🧠 6`

### Verdict

The performance problem is not just optimization debt.

It is architectural, because current runtime coordination relies too much on
shell-out polling and observer loops.

## 5. Portability and platform independence

### What is strong

- Beads alone is more portable than the full Gastown stack
- there is at least some awareness that the current session layer is too
  platform-shaped

### What is weak

Full Gastown is deeply Unix and tmux shaped.

Evidence:

- `#3538` - Windows is effectively non-viable
- attach and session behavior continues to depend on TTY and tmux details
- many lifecycle and liveness semantics assume Unix process/session behavior

Architect rating: `🎯 9.8   🛡️ 9.5   🧠 5`

### Verdict

Gastown is not a good portability reference.

## 6. Security and sandboxing fit

### What is strong

- the community clearly understands the value of hard runtime restrictions for
  review agents and safety-sensitive tasks
- there is good instinct toward read-only and sandboxed workers

### What is weak

The engine shape is still interactive-session-first.

Evidence:

- `#1382` - request for headless/sandboxed polecats without tmux
- current lifecycle assumes persistent session + `gt hook` ceremony

Architect rating: `🎯 9.5   🛡️ 8.9   🧠 6`

### Verdict

Gastown has the right instinct here, but the current engine shape fights the
next step.

## 7. Extensibility and multi-runtime story

### What is strong

- ambition is real
- role agents, presets, ACP, and worker-API work all point in the right
  direction

### What is weak

The system is still partly Claude-shaped and interactive-session-shaped.

Problems:

- role TOML can still compete with runtime resolution
- capabilities are partly inferred, not declared
- richer preset capabilities are not fully user-configurable
- identity is not one stable first-class object

Architect rating: `🎯 9.6   🛡️ 8.8   🧠 7`

### Verdict

Gastown's direction is good.

Its current extensibility substrate is still too implicit and too legacy-loaded
to be considered clean.

## 8. Configuration and convergence

### What is strong

- there is serious intent to give users structured control over runtime and role
  behavior
- the project is willing to build doctor/sync/validation paths

### What is weak

Configuration authority is split.

Problems:

- different helpers normalize config differently
- generated settings do not always have one convergence owner
- runtime consumes only part of the richer schema
- shared role-level settings can affect independently failing workers

Evidence:

- `#3648`
- `#3000`
- `#3500`

Architect rating: `🎯 9.7   🛡️ 9.1   🧠 7`

### Verdict

Gastown's config system is ambitious but not yet architecturally quiet.

## 9. Recovery and operability

### What is strong

- one of Gastown's biggest strengths is that it takes recovery seriously
- patrol loops, watchdogs, zombie handling, stale cleanup, convoy feeding, and
  repair flows all come from a healthy operational instinct

Architect rating: `🎯 9.4   🛡️ 8.7   🧠 6`

### What is weak

- recovery often compensates for substrate fragmentation rather than building on
  top of a quiet substrate
- repair logic is at risk of becoming part of the normal architecture rather
  than an exceptional tool

Architect rating: `🎯 9.8   🛡️ 9.3   🧠 7`

### Verdict

Gastown has one of the best recovery mindsets in the space, but not one of the
best recovery foundations.

## 10. Team quality and project trajectory

### What is strong

- active release cadence
- `v1.0.0` release in April 2026
- repeated focused fixes in startup, witness, daemon, tmux, and config seams
- good willingness to rethink old assumptions
- active work on ACP, wrappers, and runtime parity for non-Claude agents

Architect rating: `🎯 9.1   🛡️ 8.8   🧠 3`

### What is weak

- persistent churn in the same runtime seams is itself a signal
- fixes often stabilize the same architectural hotspots rather than deleting the
  root seam
- many fixes in 2026 still land in startup, tmux/env, role resolution, convoy
  polling, and platform compatibility, which means those seams are still live

Architect rating: `🎯 9.5   🛡️ 9.0   🧠 4`

### Verdict

The team is serious.

The architecture is still paying interest on old decisions.

## Top lessons by angle

### Best lessons to take

- Mail and handoff should be explicit
- Coding workers need true workspace isolation
- Recovery must be designed in, not bolted on
- Roles should represent operational responsibility, not just persona
- The system should distinguish durable truth from cheap realtime signaling

### Most dangerous lessons to ignore

- Avoid multi-plane truth at all costs
- Do not make tmux or any terminal mux part of the core contract
- Do not make your own CLI the internal RPC layer
- Do not ship split startup and identity contracts
- Do not make headless and sandboxed workers second-class

## Final architect verdict

Gastown is excellent to study if you want:

- better orchestration vocabulary
- better worker isolation instincts
- better recovery instincts
- better modeling of agent collaboration as a real system

Gastown is dangerous to copy if you want:

- a quiet substrate
- clean portability
- low-maintenance runtime contracts
- a small number of authoritative state and startup planes
