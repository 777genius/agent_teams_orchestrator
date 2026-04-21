# PR History And Strategic Direction

## What merged PRs reveal

Recent merged PRs are unusually informative:
- `#126` - add orchestrator command surface
- `#127` - compress coordinator/lead/worker roles for low agent budgets
- `#101` - support Claude bypass dialog and Codex shared state
- `#77` - Copilot runtime fixes
- `#60` - configurable shell init delay
- `#49` - Codex runtime adapter
- `#61` - Gemini runtime adapter

This is enough to infer real strategic direction.

## Strategic direction signals

### 1. The product is widening upward, not just outward

`🎯 9   🛡️ 8   🧠 4`

PR `#126` matters because it adds a first-class orchestrator surface.

That says the project is moving toward:
- explicit hierarchy
- ecosystem-level coordination
- more than one repo or one coordinator story

### 2. Budget-aware orchestration is becoming product policy

`🎯 9   🛡️ 8   🧠 4`

PR `#127` is especially revealing.

It does not merely tweak config.

It changes role behavior under tight budgets:
- coordinator can compress into coordinator/lead
- lead can compress into lead/worker

That is a real architectural adaptation to resource constraints.

### 3. Shared state across worktree boundaries is acknowledged as first-class

`🎯 9   🛡️ 8   🧠 4`

PR `#101` is a very important signal:
- Codex in worktrees needed access to canonical `.overstory`
- leads also needed canonical `.git` visibility for nested worktree creation

This is not a minor adapter quirk.

It shows that the system's execution substrate already assumes some shared canonical state even when workers live in isolated worktrees.

### 4. Runtime support is being grown opportunistically but coherently

`🎯 8   🛡️ 8   🧠 3`

Codex, Gemini, Cursor, Copilot all show a clear direction:
- widen runtime support
- fix substrate pain as it appears
- keep the adapter seam as the organizing principle

That is disciplined enough to respect, even if maturity is still uneven.

## What this means architecturally

`overstory` is not drifting randomly.

It is moving toward:
- broader runtime coverage
- stronger hierarchy
- lower-budget survivability
- less `tmux` dependence over time

But it is doing so while still carrying:
- repo-local truth
- soft role contracts
- substrate dependence

That means the project is evolving intelligently, but under real architectural debt pressure.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- use PR history as an architectural sensor, not just a merge log

## Anti-pattern to ban

`🎯 8   🛡️ 8   🧠 3`

Ban:
- adding hierarchy, runtimes, and budget modes faster than the underlying contracts are closed

## Architect takeaway

**The PR history shows a project that is strategically coherent, not chaotic. The risk is not lack of direction. The risk is that the widening surface may outpace the hardening of the underlying contracts.**
