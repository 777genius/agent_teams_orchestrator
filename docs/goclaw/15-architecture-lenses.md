# GoClaw Architecture Lenses

This file reviews GoClaw from multiple architect perspectives.

## 1. Domain modeling lens

Strong:

- task lifecycle is explicit
- statuses are meaningful
- review and blocker concepts are first-class

Weak:

- some surrounding behavior still bypasses the strongest explicit APIs

Verdict:

- domain core is good

## 2. Execution-contract lens

Strong:

- the system clearly wants explicit run types and orchestration modes

Weak:

- the run contract is not packaged into one enforceable object
- semantics are reconstructed from flags and wrappers

Verdict:

- weak

## 3. Identity lens

Strong:

- they understand actor vs scope vs sender

Weak:

- those lanes are not transported through one canonical typed envelope

Verdict:

- conceptually mature, operationally fragile

## 4. Authorization lens

Strong:

- real roles
- real team/user access concepts
- sender-aware permission thinking

Weak:

- enforcement spread across layers
- permissive defaults survive in important seams

Verdict:

- powerful but uneven

## 5. Eventing lens

Strong:

- lots of eventing infrastructure
- typed event surfaces exist

Weak:

- no single canonical outbox/replay truth
- middle layers decay more than boundaries

Verdict:

- architecturally mixed

## 6. UI contract lens

Strong:

- rich UI surface
- lots of live product features

Weak:

- multiple local truth models
- convergence is not unified

Verdict:

- backend stronger than frontend truth discipline

## 7. Reliability lens

Strong:

- recovery mindset is real
- stale handling exists
- compensating logic exists

Weak:

- admission and delivery guarantees are not as strong as lifecycle guarantees

Verdict:

- resilient core, less resilient shell

## 8. Testing lens

Strong:

- many targeted tests around important incidents
- decent core coverage in several subsystems

Weak:

- hottest seam contracts are not always tested as one contract

Verdict:

- good local testing, weaker seam-level contract testing

## 9. Evolution lens

Strong:

- team clearly learns from production
- hardening commits are real

Weak:

- some seams keep needing new propagation patches

Verdict:

- strong maintainers, structurally expensive seams

## 10. Product architecture lens

Strong:

- ambitious platform surface
- real orchestration product, not just a toy CLI wrapper

Weak:

- breadth amplifies every unresolved seam

Verdict:

- strong product momentum, but breadth arrived before all contracts were equally mature

## 11. Documentation lens

Strong:

- unusually rich docs for a project at this stage
- explicit dangerous-seam notes
- useful changelog memory

Weak:

- docs can be ahead of implementation
- some product surfaces are described more cleanly than they are enforced

Verdict:

- high documentation maturity, lower contract maturity

## 12. Maintenance-cost lens

Strong:

- maintainers appear responsive to production pain
- hard seams are visible in issue and commit history

Weak:

- some hotspots remain chronically expensive
- patch-train hardening suggests distributed correctness

Verdict:

- strong team, expensive shell

## Final lens summary

If you review GoClaw as a top architect, the key insight is:

- the center is stronger than the shell

That single sentence explains most of the system.
