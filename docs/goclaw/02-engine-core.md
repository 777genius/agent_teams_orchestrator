# GoClaw Engine Core

## Core claim

The team task engine is the strongest part of GoClaw.

It is strong because truth mostly lives in:

- explicit task rows
- explicit lifecycle methods
- explicit runtime repair loops

not in UI inference or prompt-only convention.

## What is good

### 1. Explicit task lifecycle

The status model is richer than most competitors:

- `pending`
- `in_progress`
- `completed`
- `blocked`
- `failed`
- `in_review`
- `cancelled`
- `stale`

This is a serious advantage.

### 2. Recovery is in the runtime

Recovery is not left to operators or UI users.

The runtime actively repairs:

- expired locks
- stale pending work
- stale in-review work
- orphaned blocked tasks
- followup scheduling

### 3. Scheduler is its own subsystem

The scheduler is not just "some queue in the gateway".

It has:

- lanes
- per-session queues
- queue/followup/interrupt behaviors
- bounded queues
- adaptive throttling

### 4. Post-turn compensation is smart

One of their strongest ideas is post-turn reconciliation.

The system does not trust the agent turn to always leave task state perfect.
After the turn, runtime logic can still:

- complete tasks
- fail tasks
- redispatch
- repair state

That is mature engineering.

### 5. Pipeline is staged

The agent loop is not one giant monolith.
There is real stage separation between:

- context injection
- message/history prep
- tool filtering
- LLM call
- tool execution
- finalization

## Where core gets weaker

### 1. Dispatch edge is less durable than lifecycle core

Inside lifecycle methods, the system is strong.
At dispatch edges, it becomes weaker:

- assign first
- publish later
- retry often becomes stale-recovery later

### 2. Subagents are less durable than team tasks

Subagents look feature-rich, but they are not as runtime-durable as the task engine.

The task engine is closer to first-class durable truth.
Subagents are closer to:

- active memory state
- audit/store support
- less complete restore semantics

### 3. Some side-channel patches bypass the strong lifecycle API

The strongest part of the system is explicit lifecycle methods.
The weakest part is when runtime starts leaning on generic patch helpers instead.

## Practical takeaway

Steal from GoClaw when it stays inside:

- explicit task lifecycle
- explicit recovery
- explicit scheduler machinery

Do not assume that strength extends equally to:

- dispatch guarantees
- subagent durability
- event/UI projection
