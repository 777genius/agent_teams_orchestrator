# Cleanup, Recovery, And Lifecycle Repair

## What is strong

### 1. Cleanup improved from bug pain into a first-class surface

`🎯 9   🛡️ 8   🧠 4`

Issue history here is actually encouraging:
- `#90` led to `ov clean --agent <name>`
- `ov stop --clean-worktree` now works even for completed agents

That shows the maintainers are willing to turn operator pain into explicit lifecycle tools.

### 2. Clean does more than delete files

`🎯 9   🛡️ 8   🧠 4`

`src/commands/clean.ts` is not naive.
It handles:
- process kill
- tmux cleanup
- worktree cleanup
- branch cleanup
- state/db cleanup
- synthetic session-end event logging

That is real lifecycle repair thinking.

### 3. Stop distinguishes headless and tmux agents correctly

`🎯 9   🛡️ 8   🧠 4`

`src/commands/stop.ts` correctly handles:
- tmux sessions
- headless process trees
- already-completed agents
- optional branch/worktree cleanup

That is good practical engineering.

## What is weak

### 1. Repair is stronger mechanically than semantically

`🎯 10   🛡️ 8   🧠 5`

The system is getting better at:
- killing
- cleaning
- removing
- marking sessions ended

But it is still weaker at:
- resuming orchestration intent
- replaying ownership cleanly
- restarting a dead control-plane role with one canonical contract

### 2. Recovery is local-first, not fully orchestration-durable

`🎯 9   🛡️ 8   🧠 4`

Coordinator death is survivable because work is decoupled.
But that is not the same as having a strong durable engine that can continue the same orchestration graph automatically.

### 3. Synthetic events are honest, but still compensating behavior

`🎯 8   🛡️ 8   🧠 3`

Synthetic `session_end` events during cleanup are a good observability practice.
They also show that some lifecycle truth still has to be repaired after the fact.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- explicit cleanup and lifecycle repair commands
- separate handling for headless and tmux execution models

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- confusing strong mechanical cleanup with strong orchestration durability

## Architect takeaway

**`overstory` is getting good at lifecycle repair. The deeper lesson is that cleanup tooling and durable orchestration continuity are related but not the same thing.**
