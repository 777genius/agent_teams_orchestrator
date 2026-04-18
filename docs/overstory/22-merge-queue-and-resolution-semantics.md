# Merge Queue And Resolution Semantics

## What is strong

### 1. The merge queue is explicit and local

`🎯 9   🛡️ 8   🧠 3`

`src/merge/queue.ts` gives the system a real FIFO merge surface:
- SQLite-backed
- WAL mode
- ordered by autoincrement
- explicit status transitions

That is much better than "whoever merges first wins".

### 2. Tiered resolution is thoughtfully structured

`🎯 9   🛡️ 8   🧠 4`

`src/merge/resolver.ts` is one of the most sophisticated parts of the repo:
- clean merge
- auto-resolve
- AI resolve
- re-imagine

This is a serious attempt to operationalize merge conflict handling instead of punting everything to humans immediately.

### 3. Historical conflict context via `mulch` is a real idea

`🎯 8   🛡️ 7   🧠 5`

Using past merge knowledge to improve current resolution is genuinely interesting.

This is one of the more original ideas in `overstory`.

## What is weak

### 1. The resolver becomes an operational janitor

`🎯 10   🛡️ 9   🧠 5`

The biggest smell is still here:
- auto-committing os-eco state files
- stashing / popping
- conflict heuristics
- cleanup semantics

Once the merge layer starts absorbing all that extra work, it becomes harder to explain what "merge truth" really is.

### 2. Auto-resolve semantics can still surprise operators

`🎯 9   🛡️ 8   🧠 4`

The project has tried to harden this, but the risk remains:
- keep-incoming auto-resolve
- union merge logic
- history-enriched AI resolve

These are powerful, but they also increase the semantic distance between "git merge" and "what the system actually did".

### 3. Re-imagine is powerful and dangerous

`🎯 8   🛡️ 7   🧠 5`

Tier 4 is architecturally fascinating because it admits:
- sometimes the branch is not worth preserving literally
- reimplementation against current truth can be better

That is useful, but it is also a very high-trust move.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- explicit FIFO merge queue
- structured merge escalation tiers

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban:
- letting merge resolution silently become the janitor for unrelated operational state

## Architect takeaway

**`overstory` has one of the more interesting merge subsystems in the space, but it also shows how quickly a merge layer can become an overloaded semantics sink.**
