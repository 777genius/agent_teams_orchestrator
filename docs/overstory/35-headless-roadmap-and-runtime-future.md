# Headless Roadmap And Runtime Future

## What is strong

### 1. The project clearly knows the destination

`🎯 10   🛡️ 9   🧠 4`

This is one of the best things about `overstory`.
The maintainers are not confused about the direction:
- headless is cleaner
- interactive tmux is transitional
- Sapling is the strongest proof point so far

Issue `#85` makes this explicit.

### 2. Sapling is a real future signal

`🎯 9   🛡️ 8   🧠 4`

`src/runtimes/sapling.ts` shows what a cleaner future can look like:
- headless subprocess
- NDJSON events
- direct connection / RPC-like flow
- explicit guards config

This is one of the strongest future-facing artifacts in the repo.

### 3. Headless is not just theory anymore

`🎯 9   🛡️ 8   🧠 4`

`src/worktree/process.ts` and headless branches in `sling.ts` mean the migration has already started in code, not just in docs.

## What is weak

### 1. The future is unevenly distributed

`🎯 10   🛡️ 9   🧠 5`

This is the main caveat.

The repo knows where it wants to go, but not all runtimes are there:
- Sapling is much closer
- Claude is still heavily interactive
- OpenCode is still clearly incomplete
- parity is not uniform

### 2. Transition architecture can linger

`🎯 9   🛡️ 8   🧠 4`

Projects often know the right destination but keep paying the transitional substrate tax for a long time.

### 3. Mixed runtime semantics are still expensive

`🎯 9   🛡️ 8   🧠 5`

As long as some agents are headless and some are interactive, lifecycle, health, observability, and cleanup semantics stay more complex.

## Best practice to steal

`🎯 10   🛡️ 9   🧠 4`

Steal:
- being explicit about the migration destination and building a real reference runtime that proves it

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- calling the migration "done" while semantics are still heavily split between interactive and headless paths

## Architect takeaway

**`overstory` is valuable because its future direction is unusually clear. The lesson is to build the cleaner runtime path early, then prevent the transitional substrate from living forever as the real baseline.**
