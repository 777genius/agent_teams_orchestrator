# Overstory Architect Playbook

## Core verdict

`overstory` should be studied as:
- a strong reference for runtime abstraction
- a strong reference for local coding-swarm substrate
- a warning about expensive interactive substrate assumptions

## What to steal

### Runtime seam

`🎯 10   🛡️ 9   🧠 5`

Steal:
- one adapter interface
- per-runtime config deployment
- readiness/transcript/env boundaries in one seam

### Worktree-first worker isolation

`🎯 9   🛡️ 8   🧠 4`

Steal:
- isolated implementation cells as a first-class orchestration primitive

### Observable-truth watchdog logic

`🎯 10   🛡️ 9   🧠 4`

Steal:
- observed state outranks recorded state
- persistent roles and workers have different health assumptions

### Honest local durable coordination

`🎯 9   🛡️ 8   🧠 4`

Steal:
- SQLite mail / sessions / merge queue / events as explicit local subsystems

### Headless destination clarity

`🎯 9   🛡️ 8   🧠 4`

Steal:
- explicit migration target
- one strong reference implementation of the cleaner future

## What to ban

### Substrate-heavy correctness

`🎯 10   🛡️ 9   🧠 5`

Ban:
- correctness that depends on tmux, shell quirks, startup timing, and pane heuristics more than it should

### Soft role closure

`🎯 10   🛡️ 9   🧠 5`

Ban:
- relying on elegant prompts and role docs to imply stronger review / coordination contracts than the runtime actually enforces

### Repo-local truth pretending to be federation

`🎯 10   🛡️ 9   🧠 5`

Ban:
- stretching local coordination planes across repo boundaries without a first-class federation contract

### Runtime parity illusion

`🎯 9   🛡️ 8   🧠 4`

Ban:
- assuming one adapter interface means all runtimes are equally mature

### Runtime artifact pollution

`🎯 9   🛡️ 8   🧠 5`

Ban:
- letting orchestration state files live so close to repo truth that merge and cleanup layers must special-case them everywhere

## Architect one-liner

**Study `overstory` as a reference for runtime abstraction and observable-truth local swarms. Do not copy its interactive substrate tax, soft role closure, or local truth stretched past the point of federation honesty.**
