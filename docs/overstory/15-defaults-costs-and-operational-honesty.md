# Defaults, Costs, And Operational Honesty

## The defaults tell a story

Current defaults in `src/config.ts` include:
- `agents.maxConcurrent: 25`
- `runtime.shellInitDelayMs: 0`
- `agents.maxAgentsPerLead: 5`
- `agents.maxSessionsPerRun: 0`

These are not neutral defaults.

They encode a philosophy:
- aggressive parallelism
- low startup friction
- experienced operator assumption

## Why this is risky

### 1. The out-of-box cost profile is high

`🎯 10   🛡️ 9   🧠 3`

Issue `#67` and user feedback in that thread are brutally clear:
- default concurrency can burn through subscription windows quickly
- low-budget runs can deadlock or starve
- the system can feel fast and broken at the same time

### 2. Spawn pressure and shell pressure interact

`🎯 9   🛡️ 8   🧠 3`

Issue `#95` shows the important interaction:
- too many concurrent spawns
- zero shell breathing room
- fragile startup on slower machines

This is not one bad knob. It is the composition of defaults.

### 3. Low-budget mode needed architectural help

`🎯 9   🛡️ 8   🧠 4`

The follow-up direction discussed around issue `#95` is revealing:
- role compression
- direct scout/builder dispatch for narrow streams
- better behavior when agent budget is intentionally small

That is not a UI tweak. It is orchestration policy adapting to operating budget.

## What is good here

### 1. The maintainers are honest about the pain

`🎯 9   🛡️ 8   🧠 2`

The issue threads do not pretend the defaults are universally safe.

They explicitly discuss:
- lower concurrency
- same-runtime fallback first
- role compression under low budgets
- graceful degradation

That is a healthy engineering signal.

### 2. Triage-based degradation is the right direction

`🎯 8   🛡️ 8   🧠 5`

The discussion around issue `#67` is architecturally good:
- do not parse every runtime's `tmux` output for failures
- let a triage layer classify failure / degrade / retry

That is a better systems move than bolting brittle heuristics into every adapter.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 3`

Steal this:
- treat defaults as part of architecture, not cosmetic config
- have an explicit low-budget operating mode

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 3`

Ban this:
- defaults that only make sense for power users with large budgets, while the product presentation implies normal users should start there

## Architect takeaway

**`overstory` is honest enough to expose the pain, but the repo still proves that defaults are one of the most expensive architectural decisions in an agent system.**
