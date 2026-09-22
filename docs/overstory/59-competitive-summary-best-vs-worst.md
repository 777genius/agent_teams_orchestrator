# Competitive Summary - Best vs Worst

If `overstory` is reduced to one compact architect summary:

## Best things in `overstory`

### Runtime seam

`🎯 10   🛡️ 9   🧠 5`

One of the best runtime abstraction layers among swarm competitors.

### Worktree-first worker model

`🎯 9   🛡️ 8   🧠 4`

Strong default for local coding work with isolated mutable cells.

### Watchdog and consistency tooling

`🎯 10   🛡️ 9   🧠 4`

Reference-grade operator-facing truth surfaces.

### Thin dependency surface

`🎯 9   🛡️ 8   🧠 3`

Important behavior is first-party and inspectable.

### Bounded reviewability taste

`🎯 9   🛡️ 8   🧠 3`

The project shows real willingness to reject strategically right but operationally unreviewable change sets.

## Worst things in `overstory`

### Interactive substrate tax

`🎯 10   🛡️ 9   🧠 5`

`tmux`, shell startup, pane heuristics, path quirks, container variance.

### Soft role closure

`🎯 10   🛡️ 9   🧠 5`

Reviewer / lead / coordinator correctness is still softer than the prompt architecture makes it feel.

### Runtime parity illusion

`🎯 9   🛡️ 8   🧠 4`

Strong interface, uneven maturity across adapters.

### Repo-local truth stretched too far

`🎯 10   🛡️ 9   🧠 5`

Local durable coordination is strong.
Federation closure is not equally strong.

### Cleanup and artifact burden

`🎯 8   🛡️ 8   🧠 4`

Good cleanup tooling exists because the system still produces meaningful orchestration debris.

## One-line verdict

**Study `overstory` as a runtime-architecture reference and a local swarm substrate reference. Do not copy its expensive interactive substrate assumptions or its softer role / parity / federation seams.**
