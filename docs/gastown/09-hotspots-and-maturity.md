# Gastown Hotspots and Maturity Signals

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file exists to keep the analysis fair.

Gastown has major architectural debt, but it is not sloppy code written by a
careless team.

## Why the codebase still deserves respect

- strong design docs
- many explicit comments tied to prior bugs
- real fallback logic in hot paths
- very large targeted test surface in the dangerous subsystems
- clear attempts to evolve away from painful old assumptions

## Hot runtime seams

The areas that kept looking structurally hot were:

- Beads/Dolt/routing identity
- tmux transport
- witness/daemon lifecycle glue
- polecat startup and liveness
- hook-state migration
- convoy/gates/parked work
- role config and startup resolution

## Compensation signals that matter

The hot files repeatedly contain patterns like:

- fallback
- stale
- zombie
- dedup
- repair
- rollback
- guard
- safety net
- backward compat

That does not mean the code is bad.
It means the system is spending a lot of code volume stabilizing expensive seams.

## Strong maturity signals

Very rough test-function counts noted during review:

- `internal/daemon` about `289`
- `internal/doltserver` about `204`
- `internal/witness` about `157`
- `internal/tmux` about `137`
- `internal/polecat` about `118`
- `internal/mail` about `116`
- `internal/acp` about `41`

Additional high-level signals gathered later:

- around `489` `*_test.go` files under `internal/`
- around `32` design-doc files under `docs/design/`
- active April 2026 open PR stream still landing on startup, tmux, beads,
  routing, convoy, and plugin seams

This is one reason the right conclusion is:

- "overburdened architecture"

not:

- "amateur project"

## The real maturity lesson

Gastown is useful precisely because it shows both:

- how a smart team invents good orchestration ideas
- how even a smart team can get trapped by a substrate that is too implicit,
  too tool-coupled, and too multi-planar

## Retrieval hint

Open this file when the question is:

- "is Gastown just sloppy?"
- "does the team know what it is doing?"
- "why is the project still worth studying despite the debt?"
