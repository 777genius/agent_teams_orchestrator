# Watchdog And Observable Truth

## What is strong

### 1. Observable state is explicitly ranked above recorded state

`🎯 10   🛡️ 9   🧠 4`

`src/watchdog/health.ts` is one of the strongest files in the repo.

The ZFC principle is architecturally important:
- observable state beats recorded state
- tmux / pid liveness outranks stale session rows
- headless and interactive agents are treated differently on purpose

That is real systems thinking.

### 2. Persistent roles are treated differently from workers

`🎯 9   🛡️ 8   🧠 4`

Coordinator / orchestrator / monitor are exempted from naive stale logic.

This is good because the team understands that:
- idle is normal for persistent control-plane roles
- idle is suspicious for short-lived workers

### 3. Health is not just UI decoration

`🎯 9   🛡️ 8   🧠 4`

The watchdog model is tied to:
- escalation
- termination
- recovery classification

That makes health a real subsystem, not cosmetic status coloring.

## What is weak

### 1. Observable truth still rides on a heavy substrate

`🎯 9   🛡️ 8   🧠 5`

The health model is strong, but the main signals still come from:
- tmux liveness
- PID liveness
- shell / pane assumptions

So even though the logic is good, it is still paying substrate tax.

### 2. Good health logic cannot compensate for weak spawn substrate forever

`🎯 9   🛡️ 8   🧠 4`

Issue threads like `#84`, `#85`, `#87`, `#93`, `#142` show the pattern:
- watchdog can classify failures well
- but it cannot erase startup brittleness caused by tmux and interactive readiness heuristics

### 3. Recovery is strong locally, weaker across orchestration hierarchy

`🎯 8   🛡️ 7   🧠 4`

Coordinator death is survivable because state is local and decoupled.
But restart / continuation semantics are still softer than the local health logic itself.

## Best practice to steal

`🎯 10   🛡️ 9   🧠 4`

Steal:
- explicit priority ordering between observed and recorded state
- different health logic for persistent vs worker roles

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- assuming strong watchdog logic makes a brittle spawn substrate acceptable

## Architect takeaway

**`overstory` has one of the better observable-truth watchdog models in this space. The lesson is to pair that mindset with a lighter substrate, not to rely on watchdog logic to save an expensive substrate forever.**
