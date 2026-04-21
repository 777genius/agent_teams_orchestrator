# Gastown Workflow and Recovery Engine

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file covers:

- workflow mode explosion
- prompt/template dependence
- string metadata
- sagas
- observer-first behavior
- convoy
- wisps
- witness
- daemon

## Main conclusion

Gastown's richest workflow features are powerful, but they are where the
architecture becomes most expensive.

The problem is not ambition.
The problem is that advanced orchestration sits on too many seams at once.

## 1. Workflow integrity still depends too much on prompt/template discipline

Some workflow correctness still depends on:

- patrol prompts
- formula semantics
- textual instructions
- background task discipline

This creates a soft enforcement boundary where structural behavior can drift
without one hard engine invariant failing.

## 2. The workflow engine has mode explosion

Gastown workflows branch across several semantics:

- root-only vs poured
- formula vs molecule
- `gt sling` vs `gt formula run`
- convoy vs non-convoy
- attachment and rollback variants

That makes lifecycle reasoning expensive.

## 3. Too much runtime metadata is tunneled through strings

Important semantics flow through:

- description fields
- stringly metadata
- key-value lines inside text blobs
- even freeform phrases in some cases

That makes the control plane more fragile and race-prone.

## 4. Lifecycle operations are sagas

Critical flows like:

- sling
- spawn
- reuse
- rollback
- recovery

span too many planes and often require compensating cleanup afterward.

That is classic saga tax.

## 5. Completion is overloaded

`gt done` is not a narrow transition.
It acts like a policy-heavy macro involving:

- completion
- merge behavior
- source issue handling
- hook cleanup
- checkpoints
- exit semantics

That concentrates too much policy in one lifecycle command.

## 6. The engine is still observer-first

Many transitions are not cleanly completed by one owner.
Instead other components later discover and reconcile them.

That is smart as a safety net, but expensive when state truth is already
fragmented.

## 7. Convoy is a second orchestration engine

Convoy is conceptually strong.
But operationally it adds another orchestration layer with:

- its own graph semantics
- cross-store resolution
- staged/open lifecycle
- gate logic
- wake logic
- cooldown memory

That is a lot of extra engine inside the engine.

## 8. Wisps are powerful but costly

Wisps are a genuinely useful idea.
But they also create lifecycle tax around:

- creation
- cleanup
- rollback
- reaping
- promotion
- deduplication

They became another pressure surface in the runtime.

## 9. Witness is smart, but it is also a compensation engine

Witness carries a lot of responsibility:

- startup handling
- liveness interpretation
- nudge behavior
- merge notifications
- zombie classification
- patrol side effects

It is powerful, but very compensatory.

## 10. The daemon is a centralized recovery brain

The daemon knows too much:

- lifecycle
- restart
- sync
- convoy
- recovery
- deacon supervision
- pressure checks
- cleanup
- boot coordination

That gives it power, but also makes it a major complexity concentrator.

## Key issues to remember

- `#2386` - fake patrol cycles
- `#3322` - custom formulas visible in one path, missing in another
- `#3350` - failed sling rollback left orphaned wisp state
- `#2416` - worker can see no hook even when work is logically attached
- `#3587` - gate close and wake are separate non-atomic steps
- `#3597` - blocked convoys keep generating useless polling work
- `#2067` - enormous idle polling/token tax
- `#2641` and `#2384` - hook state persistence/cleanup asymmetry
- `#3055` - ghost idle after `gt done`
- `#3342` - idle reaper killed actively working polecat

## Retrieval hint

Open this file when the question is:

- "where does their workflow engine get expensive?"
- "why do convoys and wisps feel powerful but dangerous?"
- "why do recovery and patrol bugs keep recurring?"
