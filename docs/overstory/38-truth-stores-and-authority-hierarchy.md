# Truth Stores And Authority Hierarchy

## What is strong

### 1. Local durable stores are explicit

`🎯 10   🛡️ 9   🧠 4`

Within one repo the project has a clear set of local stores:
- `mail.db`
- `sessions.db`
- `events.db`
- `merge-queue.db`
- `metrics.db`

That is much stronger than prompt-only orchestration.

### 2. Each store has a visible job

`🎯 9   🛡️ 8   🧠 4`

This is good architectural separation:
- mail for coordination messages
- sessions/runs for lifecycle
- events for timelines
- merge queue for integration order
- metrics for cost/accounting

### 3. Stores are typed and queryable

`🎯 9   🛡️ 8   🧠 4`

The stores are not blobs.
They have interfaces, migrations, and query methods.

## What is weak

### 1. Authority is distributed, not singular

`🎯 10   🛡️ 9   🧠 5`

This is the subtle but important caveat.

Visible truth is still co-authored by:
- durable rows
- process observation
- tmux state
- event tailers
- dashboard cache layers

So local durability is real, but one singular authority hierarchy is softer than it first appears.

### 2. Mail/events are coordination truth, not full domain truth

`🎯 9   🛡️ 8   🧠 4`

The stores are useful and strong.
But they do not automatically equal a durable task graph the way `goclaw`'s task engine tries to.

### 3. Repo-local truth does not automatically compose upward

`🎯 10   🛡️ 9   🧠 5`

Issue `#105` is the clearest signal here.

Local truth is good.
Local truth stretched into cross-repo federation without a higher-order contract is not.

## Best practice to steal

`🎯 10   🛡️ 9   🧠 4`

Steal:
- explicit local durable stores with clear jobs

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban:
- confusing "we have several good local stores" with "we have one canonical durable orchestration truth"

## Architect takeaway

**`overstory` teaches that explicit local stores are powerful. It also teaches that authority hierarchy must be stated clearly, or durability and observation will start co-authoring truth in expensive ways.**
