# Headless Future Vs Tmux Present

## The strongest positive signal

### 1. The headless path is real, not vapor

`🎯 10   🛡️ 9   🧠 5`

`src/commands/sling.ts` already has a real headless branch.

It does:
- direct spawn
- log-directory creation
- stdout/stderr redirection to files
- headless session recording with no `tmux` session

`src/worktree/process.ts` is also a real subsystem, not a placeholder.

### 2. Sapling is a concrete reference runtime

`🎯 10   🛡️ 9   🧠 5`

`SaplingRuntime` is the cleanest proof that `overstory` understands the next architectural step:
- `headless = true`
- `buildDirectSpawn()`
- `parseEvents()`
- `connect()`

This is one of the strongest things in the whole competitor.

## What is still true today

### 1. The product is still mostly `tmux`-present

`🎯 10   🛡️ 9   🧠 4`

For most runtimes, the practical story is still:
- interactive spawn
- `tmux` pane lifecycle
- readiness heuristics
- `send-keys` / capture-pane style mechanics

The repo has a strong future direction, but the present substrate is still very `tmux`-heavy.

### 2. Isolated `tmux` is hardening, not the end state

`🎯 9   🛡️ 9   🧠 3`

Issue `#85` comments say this clearly:
- isolated `tmux` helps determinism now
- headless workers are still the cleaner long-term path

That is the right framing.

### 3. Adapter parity is not there yet

`🎯 9   🛡️ 8   🧠 5`

The existence of `buildPrintCommand()` is not the same thing as true headless lifecycle support.

Right now:
- `SaplingRuntime` is the real reference
- most other runtimes still do not expose the same direct-spawn / event / connection closure

## Best practice to steal

`🎯 10   🛡️ 9   🧠 5`

Steal this:
- design the future path before you fully migrate to it
- create one reference runtime that proves the model
- let infrastructure land before adapter parity lands

## Anti-pattern to ban

`🎯 9   🛡️ 9   🧠 4`

Ban this:
- claiming the migration is done when only one runtime truly embodies the new contract

## Architect takeaway

**`overstory` is strongest when read as a transition architecture: it knows where it wants to go, but it has not yet escaped the cost of where it came from.**
