# Isolation Vs Shared State Tension

## What is strong

### 1. Worktree isolation is real, not decorative

`🎯 9   🛡️ 8   🧠 4`

Builders and most workers operate in isolated worktrees.
That is a strong containment unit.

### 2. Canonical shared state needs are acknowledged, not hidden

`🎯 9   🛡️ 8   🧠 4`

PR `#101` is a very important signal:
- Codex in worktrees needed access to canonical `.overstory`
- leads also needed canonical `.git` visibility for nested worktree creation

That means the team has already hit the true shape of the problem.

## What is weak

### 1. Isolation is not the whole truth

`🎯 10   🛡️ 9   🧠 5`

The system sells isolated workers, but some important state is intentionally canonical and shared:
- `.overstory`
- `.git`
- tracker / mulch / ecosystem state

That is not wrong.
It just means the architecture has a real duality:
- isolated implementation cells
- canonical coordination substrate

### 2. Shared canonical state can quietly become a hidden dependency

`🎯 9   🛡️ 8   🧠 4`

When worktrees still need canonical state for correct operation, adapter and runtime behavior starts depending on assumptions that are not visible in the simple "each agent has its own worktree" story.

### 3. Cross-repo scaling makes this tension sharper

`🎯 9   🛡️ 8   🧠 5`

Issue `#105` shows that once orchestration crosses repo boundaries, local shared state stops being a simple convenience and becomes a federation problem.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- explicit recognition that isolated workers still need carefully chosen canonical shared state

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 5`

Ban:
- pretending isolation is total when real correctness still depends on invisible canonical state

## Architect takeaway

**`overstory` is valuable because it does not fully deny the shared-state problem. The deeper lesson is to model isolated execution cells and canonical coordination state as separate first-class concepts, not as an accidental mix.**
