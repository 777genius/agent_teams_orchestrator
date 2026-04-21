# Gastown Doctrines and Overextensions

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file focuses on Gastown's architectural doctrines:

- which ones are genuinely strong
- which ones are good in moderation but overextended in practice

## Why this matters

Projects like Gastown are not just codebases.

They are also systems of architectural beliefs.

To learn well from them, you have to separate:

- the healthy principle
- the expensive ideological overreach

## 1. ZFC has a strong core

The strongest reading of ZFC is:

- transport facts, do not invent them from brittle heuristics
- let the right layer make judgments
- prefer explicit observation over regex-driven guesswork

That core is good.

Architect rating: `🎯 9.2   🛡️ 8.8   🧠 5`

## 2. ZFC becomes dangerous when it weakens engine invariants

The weak reading of ZFC is:

- do not encode enough invariants in the engine
- push too much judgment into agents and prompts
- excuse runtime ambiguity with "the agent decides"

That version is dangerous in orchestrators.

Why:

- some things should not be agent judgment calls
- liveness, ownership, authorization, and state transition validity need hard
  contracts

Architect warning: `🎯 9.7   🛡️ 9.3   🧠 6`

## 3. "Events are truth, labels are cache" is a strong principle

From `property-layers.md`, this is one of the best crisp architectural rules in
the repo:

- immutable events as truth
- mutable labels as convenience/cache

This is excellent.

Architect rating: `🎯 9.4   🛡️ 9.2   🧠 4`

## 4. But Gastown does not always live up to that rule

One of the key lessons is that a project can know the right rule and still fail
to implement it consistently.

That is exactly what happens here:

- some areas move toward clean event or typed truth
- other areas still depend on tmux state, descriptions, or shadow files

So the right takeaway is:

- copy the rule
- do not copy the inconsistency

## 5. Persistent worker identity is a strong doctrine

Gastown's HOP and polecat lifecycle thinking repeatedly reinforce a healthy
principle:

- the worker is not the process
- the worker is not the transient session

That doctrine is one of the best in the codebase.

Architect rating: `🎯 9.6   🛡️ 8.9   🧠 5`

## 6. Self-recycling is a strong doctrine

The self-managed completion docs and persistent polecat docs point in a very
healthy direction:

- worker finishes work
- worker self-reports completion
- worker returns to reusable idle state
- watchdogs verify by exception

This is exactly the right shape for high-throughput coding workers.

Architect rating: `🎯 9.3   🛡️ 8.8   🧠 6`

## 7. Observer as safety net is good, observer as main path is expensive

Gastown's docs often contain the right intended rule:

- observer and patrol loops should be safety nets

That is good.

What became expensive in practice:

- observer-first completion handling
- patrol-based convergence for too many transitions
- scan loops compensating for weak ownership paths

Architect warning: `🎯 9.5   🛡️ 9.1   🧠 6`

## 8. Source-of-truth language is a strong doctrine

Gastown often names what should be authoritative:

- queue, not branch grep
- config, not scattered metadata
- catalog, not source of truth
- events, not labels

That discipline of naming authority is excellent and worth copying.

Architect rating: `🎯 9.1   🛡️ 8.8   🧠 3`

## 9. Too many local "single sources of truth" can still create global confusion

One subtle Gastown lesson:

- saying "X is the source of truth" in one subsystem is not enough
- if many subsystems each declare different local truths, the system still feels
  fragmented overall

This is one of the deepest lessons from the repo.

Bad pattern:

- tmux is truth for liveness
- beads is truth for work
- route files are truth for prefixes
- config is truth for env
- events are truth for some states
- labels are cache here, but not there

Each statement may be locally reasonable.
Together they can still create state sprawl.

Architect warning: `🎯 9.8   🛡️ 9.4   🧠 7`

## 10. Graceful degradation is good, but too much fallback becomes contract blur

Gastown values graceful degradation:

- no hooks -> startup fallback
- no prompt mode -> nudge path
- no resume -> fresh session + handoff
- no process API -> tmux fallback

This is a healthy instinct up to a point.

The danger:

- too many fallback paths blur what the real contract is
- systems become "works in many ways, reliably in none"

Architect warning: `🎯 9.4   🛡️ 8.9   🧠 6`

## 11. Directives and overlays show good precedence thinking

The config philosophy in `property-layers.md` is unusually thoughtful:

- town vs rig precedence
- concatenate where additive makes sense
- replace where merge semantics would be unsafe

That is a genuinely strong configuration design instinct.

Architect rating: `🎯 8.9   🛡️ 8.7   🧠 5`

## 12. But the config philosophy is stronger than the current runtime wiring

This is another important Gastown lesson:

- config doctrine can be more mature than execution doctrine

You can see thoughtful precedence rules in docs, while runtime still pays for:

- split convergence
- partial adoption
- competing config planes

That mismatch is itself a lesson to avoid.

## 13. "Mechanical where possible, intelligent where necessary" is a very strong doctrine

The watchdog chain and dog execution docs reveal a strong principle:

- not every control problem should be solved by asking an LLM
- some parts should remain deterministic machinery
- some parts need reasoning

This is one of Gastown's best doctrines.

Architect rating: `🎯 9.3   🛡️ 8.8   🧠 5`

## 14. But layered control becomes dangerous when every new concern gets a new role

The downside of that doctrine is obvious in practice:

- Boot
- Deacon
- dogs
- witnesses
- refineries

can become an expensive hierarchy if identity, routing, and lifecycle are not
already quiet.

That is where strong layered control turns into over-architecture.

Architect warning: `🎯 9.5   🛡️ 9.0   🧠 7`

## 15. "Critical jobs stay imperative" is a doctrine worth keeping

`dog-execution-model.md` gets something exactly right:

- reliability-critical background jobs should not depend on agent availability
- flexible plugin/agent execution belongs on less critical paths

This is a rare and very good doctrine in agent systems.

Architect rating: `🎯 9.5   🛡️ 9.1   🧠 4`

## 16. Strategic vision is strong, but vision ahead of substrate is still overextension

Gastown thinks in terms of:

- federation
- protocol surfaces
- attributed work ledger
- plugins
- ecosystem participation

All of that is strategically impressive.

But when the local engine still has loud seams, the vision begins to outrun the
quietness of the runtime.

That is architectural overreach even when the vision itself is good.

Architect warning: `🎯 9.4   🛡️ 8.9   🧠 7`

## Best doctrines to keep

- worker identity separate from session
- persistent sandbox separate from process lifetime
- events as truth, labels as cache
- self-recycling over needless destruction
- observer as safety net
- catalog is not truth
- fail-closed safety
- explicit precedence rules for config layers
- mechanical control separated from reasoning control
- imperative execution for reliability-critical background paths

## Doctrines to use carefully, not literally

- ZFC
- graceful degradation
- agent decides, Go transports
- observer-first thinking
- rich multi-role control hierarchies
- ambitious ecosystem surface before substrate maturity

These are valuable only if hard engine invariants still exist.

## Final takeaway

Gastown's philosophy is stronger than its current runtime implementation in
several places.

That is useful.

It means you can learn from its doctrines without copying its current costs.
