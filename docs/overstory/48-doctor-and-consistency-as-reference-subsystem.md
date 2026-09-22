# Doctor And Consistency As Reference Subsystem

## What is strong

### 1. `ov doctor` is a real subsystem, not cosmetic diagnostics

`🎯 10   🛡️ 9   🧠 4`

`src/commands/doctor.ts` and `src/doctor/*` are serious:
- category-based checks
- fixable findings
- rerun after fix
- human and JSON output

That is very good control-plane engineering.

### 2. Consistency checks span multiple truth sources

`🎯 10   🛡️ 9   🧠 5`

`src/doctor/consistency.ts` is especially strong because it cross-checks:
- SessionStore
- git worktrees
- tmux sessions
- PIDs

This is one of the clearest examples of operational honesty in the repo.

### 3. Hygiene is treated as part of the product

`🎯 9   🛡️ 8   🧠 4`

The existence of doctor categories for:
- dependencies
- config
- structure
- databases
- consistency
- merge
- logs
- ecosystem
- providers
- watchdog

shows that the maintainers think of operability as first-class.

## What is weak

### 1. Strong doctor tooling can hide expensive underlying seams

`🎯 9   🛡️ 8   🧠 4`

When a system has strong hygiene tooling, it becomes easier to live with costly substrate and lifecycle seams longer than you otherwise would.

### 2. Diagnostics are stronger than full self-healing

`🎯 8   🛡️ 8   🧠 4`

Doctor is excellent at surfacing inconsistency.
That does not mean the orchestration model itself is fully self-stabilizing.

### 3. Cross-checking many stores confirms distributed truth pressure

`🎯 9   🛡️ 8   🧠 4`

The very strength of `doctor/consistency` also reveals the architecture:
- truth is distributed enough that consistency repair must be an explicit subsystem

## Best practice to steal

`🎯 10   🛡️ 9   🧠 4`

Steal:
- a serious doctor/consistency subsystem that spans real control-plane truths

## Anti-pattern to ban

`🎯 8   🛡️ 8   🧠 4`

Ban:
- using strong diagnostics as an excuse not to simplify the underlying lifecycle and authority model

## Architect takeaway

**`overstory`'s doctor and consistency layer is one of its best operational subsystems. It is worth copying, but it also reveals how much explicit hygiene the architecture still requires.**
