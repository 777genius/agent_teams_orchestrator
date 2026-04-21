# Best Practices To Steal

## Top practices

### 1. Runtime adapter seam

`🎯 10   🛡️ 9   🧠 6`

Steal this almost directly:
- one interface
- per-runtime adapters
- spawn / readiness / transcripts / env / config deployment
- optional headless / RPC extensions

This is one of the best abstraction choices in the repo.

### 2. Worktree-first worker isolation

`🎯 9   🛡️ 9   🧠 5`

Workers should not share a mutable canonical workspace by default.

### 3. Explicit local coordination stores

`🎯 9   🛡️ 8   🧠 4`

`mail.db`, `merge-queue.db`, `sessions.db`, `events.db` is a good pattern for a local orchestrator.

### 4. Observable-state-first health logic

`🎯 9   🛡️ 9   🧠 4`

The ZFC principle is worth keeping:
- observed process state beats stale recorded state

### 5. Layered watchdogs

`🎯 8   🛡️ 8   🧠 6`

Mechanical check + AI triage + higher-order monitor is a strong pattern if each layer is honest about what it knows.

### 6. Headless future path, not just tmux forever

`🎯 9   🛡️ 8   🧠 6`

Sapling shows the right direction:
- direct spawn
- stdout event parsing
- optional RPC connection

### 7. Self-critique as architecture artifact

`🎯 8   🛡️ 8   🧠 2`

`STEELMAN.md` is exactly the kind of document worth copying.

### 8. Isolated tmux socket

`🎯 8   🛡️ 8   🧠 2`

If tmux is used at all, isolating project sessions from personal tmux is the right call.

### 9. Headless file redirect to avoid pipe backpressure

`🎯 8   🛡️ 8   🧠 3`

This is a subtle but good engineering detail.

### 10. Prompt inheritance instead of prompt sprawl

`🎯 8   🛡️ 7   🧠 4`

`canopy` is a strong pattern as long as prompt hierarchy does not become the primary safety mechanism.
