# Tracker Abstraction And Batch Coordination

## What is strong

### 1. Tracker abstraction is small and honest

`🎯 9   🛡️ 8   🧠 3`

`src/tracker/factory.ts` and `src/tracker/types.ts` do not overcomplicate the seam.

The interface is small:
- ready
- show
- create
- claim
- close
- list
- sync

That is a good abstraction boundary.

### 2. Auto-detecting `beads` vs `seeds` is pragmatic

`🎯 8   🛡️ 8   🧠 2`

The factory logic is simple and readable.

This is boring engineering in a good way.

### 3. Groups are an interesting coordination layer

`🎯 8   🛡️ 8   🧠 4`

`src/commands/group.ts` adds:
- grouped issue progress
- auto-close when all issues close
- lightweight batch coordination

This is a useful pattern for orchestration surfaces that need "sets of work" without inventing a much larger domain model.

## What is weak

### 1. Group state is file-local and lightweight by design

`🎯 8   🛡️ 7   🧠 3`

`groups.json` is pragmatic, but not a deep domain engine.

That means:
- simple and easy to reason about
- but not a strong substitute for a richer task engine

### 2. Tracker abstraction does not erase backend semantics

`🎯 9   🛡️ 8   🧠 4`

Even with a unified interface, backend differences still matter:
- behavior
- performance
- readiness semantics
- ecosystem coupling

So this seam is good, but not magical.

### 3. Best-effort notifications reveal the real hierarchy

`🎯 8   🛡️ 8   🧠 3`

When groups auto-close and then best-effort notify coordinator by mail, it shows the layering clearly:
- tracker / group state is not the only coordination truth
- it must still report into the mail/control plane

That is fine, but worth noticing.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 3`

Steal:
- a small honest abstraction for external task trackers
- lightweight group coordination without pretending it is a full orchestration engine

## Anti-pattern to ban

`🎯 8   🛡️ 7   🧠 3`

Ban:
- believing that a thin tracker abstraction by itself closes all workflow semantics across multiple backends

## Architect takeaway

**`overstory` gets the tracker seam mostly right by keeping it modest. The lesson is to resist turning tracker abstraction into fake orchestration durability.**
