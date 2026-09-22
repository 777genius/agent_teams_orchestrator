# Mail Protocol And Coordination Truth

## What is strong

### 1. Mail is a real subsystem, not stringly chaos

`🎯 9   🛡️ 8   🧠 4`

`src/mail/store.ts` and `src/mail/client.ts` show a cleaner model than many competitors:
- SQLite-backed persistence
- WAL mode
- explicit message types
- structured protocol payloads
- thread support
- injection formatting for agent hooks

That is meaningfully stronger than "agents talk through prompt prose".

### 2. Protocol messages are acknowledged as special

`🎯 8   🛡️ 8   🧠 3`

The client distinguishes protocol-style coordination messages like:
- `worker_done`
- `merge_ready`
- `merged`
- `merge_failed`
- `dispatch`
- `assign`

That is important because it shows the team understands that not all messages are equal.

### 3. Repo-local mail is a good local-first truth

`🎯 8   🛡️ 8   🧠 3`

Within one repo, `mail.db` is a reasonable coordination plane:
- fast
- local
- durable enough
- easy to inspect

## What is weak

### 1. Repo-local mail becomes a boundary fast

`🎯 10   🛡️ 9   🧠 5`

Issue `#105` proves the main limit:
- mail is clean for one repo
- mail becomes ambiguous for cross-repo orchestration

That is why the best proposed direction is federation through orchestrator/coordinator, not one magically shared mail layer.

### 2. Read-on-check is simple but opinionated

`🎯 8   🛡️ 7   🧠 3`

`check()` and `checkInject()` eagerly mark unread mail as read.

That is fine for a pragmatic local workflow, but it means:
- "read" is closer to "delivered to consumer" than "actually acted on"
- replay / audit semantics are softer than in a true event-sourcing model

### 3. Coordination truth still depends on role discipline

`🎯 9   🛡️ 8   🧠 4`

Even with typed messages, the system still depends on agents to:
- send the right message
- send it at the right moment
- interpret result mail correctly

So the mail layer is stronger than pure chat, but weaker than a fully enforced task engine.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- typed local message bus over SQLite
- explicit protocol payloads
- thread support

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- assuming a local mail plane automatically scales to multi-repo orchestration without federation semantics

## Architect takeaway

**`overstory`'s mail layer is a good local coordination primitive, but it is not by itself a full orchestration truth model.**
