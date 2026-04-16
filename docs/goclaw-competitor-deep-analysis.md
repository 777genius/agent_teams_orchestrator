# GoClaw Deep Competitor Analysis

Date: 2026-04-16
Studied revision: `f5917b0e` on `origin/dev`
Previous local detached head before refresh: `2cbf8381`

## Goal

This document is not about designing our Rust orchestrator.

The goal is narrower:

- understand what `goclaw` does architecturally well
- understand what it does badly
- understand what recurring user pain in issues reveals about the real weak seams
- separate strong orchestration core from weak surrounding seams

## How I studied it

I used three sources in parallel:

1. Fresh code on `origin/dev`
2. GitHub issues, especially recurring bugs and most-discussed reports
3. Commit history around fixes, to see whether fixes are local patches or symptoms of a deeper model problem

Important caveat:

- for most of the repo I used direct code reading, issue review, grep-based hotspot analysis, and selective tests
- I was able to run targeted tests around identity / store / tools / cmd
- I was **not** able to run the full provider-package test suite locally because the installed `go` tool here rejects `go 1.26.0` in `goclaw`'s `go.mod`
- so provider-layer conclusions below are based on static code reading, issue evidence, and existing test files, not a full local provider test run

Main code areas reviewed:

- `internal/scheduler/*`
- `internal/tasks/task_ticker.go`
- `internal/tools/team_*`
- `internal/store/team_store.go`
- `internal/store/pg/teams_tasks_*`
- `internal/agent/*`
- `internal/pipeline/*`
- `internal/agent/loop_pipeline_adapter.go`
- `internal/agent/loop_pipeline_callbacks.go`
- `internal/workspace/*`
- `internal/tools/policy.go`
- `internal/tools/context_keys.go`
- `internal/store/context.go`
- `internal/store/run_context.go`
- `internal/gateway/router.go`
- `internal/gateway/event_filter.go`
- `internal/gateway/methods/heartbeat.go`
- `internal/gateway/methods/chat.go`
- `internal/gateway/methods/access.go`
- `internal/gateway/methods/channel_instances.go`
- `internal/gateway/methods/teams_tasks.go`
- `internal/gateway/methods/teams_tasks_mutations.go`
- `internal/gateway/server.go`
- `internal/permissions/policy.go`
- `internal/http/auth.go`
- `internal/http/channel_instances.go`
- `cmd/gateway_consumer_post_turn.go`
- `internal/bus/*`
- `internal/eventbus/*`
- `internal/tracing/collector.go`
- `internal/tools/shell.go`
- `internal/tools/subagent_*`
- `internal/store/subagent_store.go`
- `internal/store/pg/subagent_tasks.go`
- `migrations/000034_subagent_tasks.up.sql`
- `ui/web/src/api/ws-client.ts`
- `ui/web/src/hooks/use-ws-event.ts`
- `ui/web/src/pages/teams/*`
- `ui/web/src/pages/teams/board/use-board-tasks.ts`
- `ui/web/src/pages/teams/task-sections/task-detail-dialog.tsx`
- `ui/web/src/pages/chat/hooks/use-chat-team-tasks.ts`
- `internal/agent/resolver_helpers.go`
- `internal/agent/systemprompt.go`
- `internal/agent/systemprompt_team_test.go`
- `docs/00-architecture-overview.md`
- `docs/01-agent-loop.md`
- `docs/11-agent-teams.md`
- `docs/17-changelog.md`
- `docs/agent-identity-conventions.md`

Issue sample used:

- 200 issues from `gh issue list --state all`
- plus targeted reading of issues `#261`, `#266`, `#306`, `#320`, `#431`, `#437`, `#498`, `#504`, `#543`, `#555`, `#565`, `#616`, `#628`, `#645`, `#675`, `#677`, `#789`, `#836`, `#838`, `#862`, `#866`, `#870`, `#915`
- plus targeted reading of issues `#495`, `#506`, `#555`, `#557`, `#560`, `#734`, `#877`, `#884`, `#888`

## Short verdict

⚠️ The most accurate one-line summary is this:

`goclaw` has a strong orchestration engine and weak seams around that engine.

More concretely:

- the **task engine, scheduler, recovery loop, and staged agent pipeline** are genuinely strong
- the **context propagation, policy layering, workspace edge handling, realtime/UI synchronization, and product surface coherence** are noticeably weaker

So the problem in `goclaw` is not "bad architecture".

The real problem is:

- very broad scope
- too many cross-cutting concerns
- too much implicit state flowing through context, metadata, and buses
- part of the codebase is in a transition state: cleaner new surfaces exist, but some still bridge to older semantics underneath

## Deep scorecard

| Subsystem | Score / 10 | Verdict |
|---|---:|---|
| Team task lifecycle engine | 9.4 | Very strong |
| Recovery and stale handling | 9.3 | Very strong |
| Scheduler and queue semantics | 9.1 | Strong |
| Pipeline decomposition | 8.7 | Strong |
| Team-task persistence model | 9.0 | Strong |
| Post-turn compensating runtime | 8.8 | Strong |
| Subagent runtime model | 7.2 | Feature-rich but materially less durable |
| Workspace model concept | 8.0 | Good concept |
| Workspace implementation on edge cases | 6.2 | Fragile |
| Policy and permissions power | 8.4 | Powerful |
| Policy clarity and explainability | 5.9 | Weak |
| Gateway auth / RBAC posture | 6.2 | Improved, but still permissive in key defaults |
| Context propagation model | 5.6 | Weak |
| Prompt/runtime contract discipline | 7.4 | Thoughtful, but partly prompt-mediated |
| Event topology / WS delivery model | 5.8 | Split and bridge-heavy |
| Realtime/UI event dataflow | 6.1 | Weak |
| Package coupling / bounded contexts | 6.4 | Mixed |
| Provider stream error surfacing | 5.7 | Fragile adapters |
| Product consistency and docs coherence | 6.0 | Mixed to weak |
| Core test confidence | 8.3 | Strong in core, uneven overall |

## Evolutionary hotspots and test blind spots

This layer matters because architecture quality is not only "how the code looks today".
It is also:

- where the team keeps changing the design
- where fixes keep landing
- where churn is or is not defended by tests

### 1. The hottest files are not the task state machine

Using `git log --name-only --since=2025-01-01`, the most frequently changed files were:

- `cmd/gateway.go`: `159`
- `internal/agent/loop.go`: `136`
- `cmd/gateway_managed.go`: `75`
- `internal/agent/resolver.go`: `72`
- `internal/agent/loop_history.go`: `67`
- `internal/agent/loop_types.go`: `65`
- `internal/agent/systemprompt.go`: `64`
- `cmd/gateway_consumer.go`: `51`
- `internal/config/config_channels.go`: `49`
- `internal/gateway/server.go`: `46`

That is a very strong signal.

It says the most active design pressure is concentrated in:

- gateway entry and runtime boot flow
- agent loop internals
- resolver and prompt wiring
- config and server boundaries

not in the task engine itself.

That supports the central thesis of this document:

- the durable orchestration core is one of GoClaw's stronger parts
- the real architectural stress is around the seams: gateway, loop, prompt, config, routing, identity

### 2. Churn is especially high in context and routing seams

Targeted change counts since `2025-01-01` for some critical files:

| File | Change count |
|---|---:|
| `internal/agent/loop.go` | 133 |
| `internal/agent/systemprompt.go` | 61 |
| `internal/gateway/server.go` | 44 |
| `internal/tools/context_keys.go` | 31 |
| `internal/store/context.go` | 22 |
| `internal/gateway/router.go` | 21 |
| `internal/tools/team_tool_dispatch.go` | 21 |
| `internal/gateway/methods/chat.go` | 22 |
| `internal/http/auth.go` | 18 |
| `internal/tools/team_tasks_lifecycle.go` | 11 |
| `internal/tasks/task_ticker.go` | 11 |
| `internal/permissions/policy.go` | 9 |
| `internal/gateway/methods/heartbeat.go` | 6 |
| `internal/tools/subagent_spawn.go` | 3 |
| `internal/tools/subagent_control.go` | 3 |
| `internal/tools/subagent_persist.go` | 1 |

This is revealing in two ways:

- `team_tasks_lifecycle` and `task_ticker` are active, but not chaotic
- context, routing, prompt, gateway, and loop files are much hotter

So the most unstable conceptual seam is not "how task states work".
It is "how identity, context, prompt, routing, and gateway behavior are glued together".

### 3. Package-level test confidence is uneven in exactly the places you would expect

Rough package-level line ratios:

| Package | Go lines | Test lines | Test ratio |
|---|---:|---:|---:|
| `internal/providers` | 22,109 | 12,296 | 55.6% |
| `internal/scheduler` | 1,748 | 842 | 48.2% |
| `internal/workspace` | 606 | 291 | 48.0% |
| `internal/agent` | 21,192 | 8,959 | 42.3% |
| `internal/tools` | 36,245 | 11,481 | 31.7% |
| `internal/http` | 30,797 | 7,025 | 22.8% |
| `internal/gateway` | 13,384 | 2,673 | 20.0% |
| `internal/store` | 51,525 | 5,180 | 10.1% |

This does not mean those numbers are exact coverage.
But they are still useful.

The pattern is:

- scheduler is relatively well-defended
- workspace has good density for its size
- providers are tested heavily because the adapter surface is large
- store and gateway are much thinner in test density relative to their semantic importance

That is one more reason I treat `store/context/gateway` as the real architectural risk zone.

### 4. Several hot files are hot and still lack direct same-file tests

Among top-churn Go files since `2025-01-01`:

- `cmd/gateway.go` - no direct same-file test
- `internal/agent/loop.go` - no direct same-file test
- `cmd/gateway_managed.go` - no direct same-file test
- `internal/agent/resolver.go` - no direct same-file test
- `internal/agent/systemprompt.go` - no direct same-file test
- `cmd/gateway_consumer.go` - no direct same-file test
- `internal/config/config_channels.go` - no direct same-file test
- `internal/http/agents.go` - no direct same-file test
- `internal/store/team_store.go` - no direct same-file test
- `internal/tools/team_tasks_tool.go` - no direct same-file test
- `internal/tools/delegate.go` - no direct same-file test

This matters because it highlights where they rely on:

- higher-level integration behavior
- neighboring package tests
- or simply maintainer confidence

rather than direct tight unit tests around the hottest files.

That is not automatically wrong.
But in a codebase with lots of implicit context, it increases regression risk.

### 5. The tested parts and the truly hardened parts are not identical

One subtle competitor lesson is this:

- `scheduler` is well-tested and genuinely feels hard
- `team task lifecycle` is well-tested and genuinely feels durable
- `policy` is tested, but the tests currently lock in some permissive defaults
- `subagents` are feature-rich, but direct runtime test confidence is still weak

This is important.

Testing can validate the wrong default just as effectively as the right one.

Example:

- `permissions/policy_test.go` gives confidence
- but part of that confidence is confidence in `unknown RPC -> viewer`

So when reading a competitor's tests, the real question is not only:

- "is it tested?"

It is also:

- "what worldview are the tests freezing into place?"

### 6. Transition markers are concentrated in hot seams

Searching hot paths for markers like `TODO`, `deferred`, `deprecated`, `backward compat`, and `fail-open` produced a telling pattern.

Examples:

- `internal/gateway/server.go` - `backward compat`
- `internal/agent/resolver.go` - `deferred`
- `internal/agent/loop_types.go` - `deprecated`, `backward compat`
- `internal/channels/telegram/handlers.go` - `fail-open`, `deferred`
- `internal/http/agents.go` - `deprecated`
- `internal/store/agent_store.go` - `backward compat`
- `internal/store/team_store.go` - `backward compat`
- `internal/tools/policy.go` - `deferred`
- `cmd/gateway_consumer_handlers.go` - `backward compat`

This is useful because it moves the conversation from vague intuition to evidence:

- the repo is not just large
- the repo is still actively carrying migration-state semantics in many hot files

That does not make it bad.
But it does mean the architecture is still evolving in exactly the most sensitive zones:

- gateway boundaries
- resolver and prompt plumbing
- channel policy
- store semantics
- runtime handlers

## Deeper runtime findings: where the strong core becomes heuristic again

This pass went deeper into:

- `internal/store/pg/teams_tasks_lifecycle.go`
- `internal/store/pg/teams_tasks_progress.go`
- `internal/tasks/task_ticker.go`
- `cmd/gateway_consumer_post_turn.go`
- `internal/tools/team_tool_dispatch.go`
- `internal/tools/team_tool_validation.go`
- `internal/tools/team_tasks_followup.go`
- `internal/gateway/methods/teams_tasks_mutations.go`

The key insight is:

- the task lifecycle core is genuinely transactional
- but the dispatch and repair edges around that core are more heuristic than they first appear

### 1. The lifecycle core is strongest exactly where it stays inside explicit store methods

The good part is very real:

- `ClaimTask`, `AssignTask`, `CompleteTask`, `FailTask`, `CancelTask`, `ApproveTask`, `RejectTask`, `ResetTaskStatus`, `FailPendingTask`
- explicit status guards in SQL
- transactional unblocking via `unblockDependentTasks(...)`
- lock heartbeat via `RenewTaskLock(...)`
- repair queries in `task_ticker`

This is where GoClaw is closest to a real orchestration engine and farthest from "workflow sugar".

### 2. But dispatch is not fully durable - it is `assign first, publish later`

The dispatch flow in both:

- `internal/tools/team_tool_dispatch.go`
- `internal/gateway/methods/teams_tasks_mutations.go`

does this shape:

1. move task `pending -> in_progress`
2. broadcast event that the task is dispatched
3. `TryPublishInbound(...)` to actually queue the member-agent work

That means the persistent state transition happens before the runtime delivery succeeds.

If `TryPublishInbound(...)` drops because the bus is full:

- the task is already `in_progress`
- the UI may already have seen a dispatched/in-progress event
- the actual agent may never receive the work

The code comment says "ticker will retry", but that is more optimistic than precise.
What really happens is:

- PG lock duration is `60m`
- SQLite lock duration is `30m`
- recovery depends on stale lock expiry, not an immediate durable retry queue

So this is not a normal retry channel.
It is delayed recovery by stale-task repair.

That is an important competitor lesson:

- their durable state machine is stronger than their durable delivery model

### 3. There is a real contract mismatch between `UpdateTask(...)` and some dispatch safety nets

This is one of the strongest new findings.

`UpdateTask(...)` in both PG and SQLite explicitly whitelists only:

- `subject`
- `description`
- `priority`
- `assignee_user_id`
- `metadata`
- `blocked_by`
- `updated_at`

But current live code calls it with `status` and `result` in at least these places:

- `internal/tools/team_tool_dispatch.go:59`
- `internal/tools/team_tool_dispatch.go:75`
- `internal/tools/team_tool_dispatch.go:358`
- `internal/gateway/methods/teams_tasks_mutations.go:343`

Those paths are used for safety nets like:

- auto-fail lead-owned tasks
- auto-fail after max dispatch attempts

The problem:

- production store rejects those columns
- those errors are ignored with `_ = m.teamStore.UpdateTask(...)`

So those safety nets look stronger in code than they actually are in the real store contract.

This is not just a style issue.
It is a real architectural mismatch between:

- generic patch API
- lifecycle API
- runtime assumptions

### 3.1. The same weak assumption is duplicated in both tool-dispatch and gateway-dispatch paths

This makes the issue worse.

The exact same "generic update can fail a task" assumption appears in two different dispatch stacks:

- tool/runtime dispatch
  - `internal/tools/team_tool_dispatch.go`
- dashboard/gateway dispatch
  - `internal/gateway/methods/teams_tasks_mutations.go`

Both contain safety nets like:

- "do not dispatch to lead agent"
- "auto-fail after too many dispatch attempts"

And both try to realize those safety nets through `UpdateTask(status/result)`.

So this is not one accidental bad callsite.
It is a repeated architectural assumption.

That matters because duplicated wrong assumptions are exactly the kind of thing that survives code review and ships for a long time.

### 3.2. The production helper under that path is itself a weak contract

Under the hood, both PG and SQLite `UpdateTask(...)` implementations call generic helpers:

- `internal/store/pg/helpers.go`
- `internal/store/sqlitestore/helpers.go`

Those helpers:

- build a dynamic `UPDATE`
- execute it
- return `nil` if SQL did not error
- do **not** check `RowsAffected()`

So even ignoring the `status/result` whitelist problem, the generic patch path is already weaker than explicit lifecycle methods.

In other words:

- explicit lifecycle methods like `AssignTask`, `FailTask`, `ApproveTask` validate state transitions and row effects
- generic `UpdateTask(...)` is a blind patch side channel

This is a bigger competitor lesson than the specific whitelist bug:

- when a strong state machine also exposes a weak generic patch backdoor, runtime code will eventually start leaning on the weak path

And that is exactly what happened here.

### 4. Mock tests appear to hide that mismatch instead of exposing it

In `internal/tools/team_mock_backend_test.go`, the mock `UpdateTask(...)` accepts and applies fields like:

- `status`
- `result`
- `owner_agent_id`
- `lock_expires_at`
- `progress_percent`

But the real PG/SQLite `UpdateTask(...)` does not.

That means test ergonomics and production semantics diverge.

This is a high-value competitor lesson:

- if your mocks are more permissive than your real store contracts, you can accidentally test a stronger system than the one you actually run

And that seems to be exactly what happened here.

### 4.1. The mock contract is not just broader - it is materially more powerful

The mock `UpdateTask(...)` in `team_mock_backend_test.go` accepts and mutates:

- `status`
- `result`
- `owner_agent_id`
- `locked_at`
- `lock_expires_at`
- `progress_percent`
- `progress_step`
- `followup_at`
- `followup_count`
- `followup_max`
- `followup_message`
- `followup_channel`
- `followup_chat_id`

That is dramatically wider than the real store whitelist.

So the tests are not merely "loosely mocking persistence".
They are modeling a fundamentally different patch API.

That is one of the clearest architectural self-deception patterns in the repo:

- production store says "generic patch is narrow"
- mock store says "generic patch is broad and stateful"
- runtime code starts to rely on the broad version

Once that happens, test success becomes less trustworthy.

### 5. Some important dispatch behavior has little or no direct test pressure

I ran targeted checks and found:

- no direct same-file tests for `internal/tools/team_tool_dispatch.go`
- no direct store tests exercising this `UpdateTask(status/result)` mismatch in PG
- `go test ./internal/store/pg -run 'Test.*UpdateTask|Test.*Task.*Lifecycle'` returned `no tests to run`
- targeted `go test ./internal/tools -run 'Test.*(Dispatch|Retry|Reject|Review|Followup|Lead)'` passed, but that does not prove the dispatch safety-net contract against the real PG/SQLite store

This does not mean the team tools are untested.
It means this specific seam is much weaker than the task lifecycle core.

### 5.1. This is a good example of why "the tests pass" can still be misleading

The current state is roughly:

- targeted tool tests pass
- runtime code looks like it has safety nets
- the production store contract is narrower than the mock contract
- generic update helpers do not assert row impact

So a maintainer can easily read the codebase and conclude:

- "we already guard this"

when the more honest statement is:

- "we guard this in mock-backed tests and in intended control flow, but not robustly in the real persistence contract"

That is an important competitor lesson because it is subtle.
It is not a loud failure mode like a panic or a missing import.
It is the quiet kind of mismatch that survives for months.

### 6. Repair logic is strong, but it also compensates for weak delivery guarantees

The impressive part of GoClaw is still true:

- `task_ticker`
- `gateway_consumer_post_turn.go`
- `FailPendingTask(...)`
- orphaned-blocked repair
- stale lock recovery

But the deeper read is now sharper:

- some of that repair logic is not only "good resilience"
- some of it is also compensating for delivery and state-sync gaps around dispatch/runtime edges

That is not a criticism by itself.
It is a maturity signal.

Strong orchestrators often need repair logic.
But the question is:

- "does repair complement a strong delivery model?"
- or
- "does repair quietly paper over a weak delivery model?"

In GoClaw, the answer is mixed.

### 7. Backend semantics differ by storage backend in at least one meaningful orchestration parameter

Task lock duration differs by backend:

- PostgreSQL: `60m`
- SQLite: `30m`

That means recovery timing and the cost of dropped dispatches are not identical across backends.

This is a subtle but important lesson:

- if orchestrator behavior changes materially by backend, operators can experience different failure and retry timing even when the product surface looks the same

## Deeper consistency findings: how many truths the system really has

This pass focused on:

- `internal/store/pg/helpers.go`
- `internal/store/sqlitestore/helpers.go`
- `internal/store/pg/teams_tasks_activity.go`
- `internal/store/sqlitestore/teams_tasks_activity.go`
- `internal/bus/bus.go`
- `internal/bus/broadcast_helpers.go`
- `cmd/gateway_events.go`

The main conclusion is:

- GoClaw has a strong task row as durable truth
- but comments, audit events, realtime bus events, denormalized counters, and UI projections are not glued together transactionally

That is not unusual.
But it is one of the main reasons their outer seams feel weaker than their task core.

### 1. There is no real outbox pattern around team-task events

The lifecycle state changes happen in store methods first.
Then realtime events are broadcast on the in-process bus.
Then task audit rows are persisted by a bus subscriber in `cmd/gateway_events.go`.

So the flow is roughly:

1. mutate task row
2. commit
3. broadcast event
4. audit subscriber writes `team_task_events`
5. UI subscribers react or refetch

That means:

- audit events are not written in the same transaction as lifecycle changes
- realtime delivery and audit persistence can diverge
- there is no durable outbox bridging the DB and the event stream

This is a very important competitor lesson.
The task table is durable.
The surrounding event/audit system is eventually-consistent best effort.

### 2. `MessageBus.Broadcast(...)` is synchronous fan-out, not isolated delivery

This is subtle and important.

`MessageBus.Broadcast(...)` loops through all subscribers synchronously.
It catches panics, but it does not isolate latency.

That means:

- a slow subscriber slows the caller
- audit persistence work can sit on the same broadcast path
- progress-notification logic sits on the same fan-out path

So their bus is not:

- durable
- queued per subscriber
- outbox-backed

It is an in-process synchronous fan-out hub.

That is fast and simple.
But it also means side effects attached to events are more tightly coupled than they first appear.

### 3. Team audit is not a first-class source of truth - it is a subscriber side effect

This is one of the clearest deeper findings.

`RecordTaskEvent(...)` exists in the stores, but in practice task audit rows are mainly written by the gateway event subscriber:

- `cmd/gateway_events.go`

That subscriber:

- listens to bus events
- maps event names to audit event types
- writes `team_task_events`

So task audit is not the primary state machine.
It is a derived trail.

That matters because:

- if audit write fails, lifecycle still succeeded
- if broadcast path is skipped, audit can be missing
- audit history is informative, but not authoritative

This is another split-truth seam.

### 4. Generic map-update helpers are blind patches

The generic helpers:

- `execMapUpdate(...)`
- `execMapUpdateWhereTenant(...)`

do not check `RowsAffected()`.

So a patch can:

- target the wrong tenant
- target a missing row
- match zero rows

and still return `nil` as long as SQL execution itself did not error.

That is a big architectural nuance.

Combined with ignored errors and permissive mocks, it means some runtime code can believe it changed task state when in fact nothing changed.

This is especially relevant because the task system also has strong explicit lifecycle methods that *do* validate transitions.
So the dangerous edge is not the explicit state machine.
It is the generic patch side channel around it.

### 5. Some denormalized counters are maintained out-of-band

`AddTaskComment(...)`:

- inserts the comment
- then separately increments `comment_count`
- and ignores increment failure

`AttachFileToTask(...)`:

- inserts attachment
- then separately increments `attachment_count`
- and ignores increment failure

This is not catastrophic.
But it is another sign that some UI-facing truth is best effort rather than transactionally coupled.

So even inside the durable task subsystem, not all derived fields are equally strong.

### 6. Audit/UI/event data can diverge independently from task state

Taken together, the system has at least these team-task truths:

- task row state in `team_tasks`
- comment rows
- attachment rows
- audit rows in `team_task_events`
- denormalized counters on the task row
- realtime bus events
- frontend local projections and refetch caches

The strongest of these is the task row.
The rest are weaker and not atomically bound to it.

This explains why issues like:

- `#503`
- `#515`
- `#555`
- `#877`

feel so representative.

The problem is not that the task state machine is poor.
The problem is that the surrounding observation surfaces are derived through several non-atomic layers.

## Deeper scheduler findings: strong queue core, weaker end-to-end admission model

This pass went deeper into:

- `internal/scheduler/scheduler.go`
- `internal/scheduler/queue.go`
- `internal/scheduler/lanes.go`
- `internal/scheduler/scheduler_queue_test.go`
- `cmd/gateway_consumer.go`
- `cmd/gateway_consumer_normal.go`
- `cmd/gateway_consumer_handlers.go`
- `internal/agent/loop_team_reminders.go`
- issue `#266`
- issue `#677`
- commit `014f74ec`

The key conclusion is:

- the scheduler itself is reasonably solid
- but end-to-end message admission still spans too many queues, drops, and session-shaping layers

### 1. The scheduler core is legitimately better than average

Real strengths:

- named lanes with separate concurrency pools
- per-session queueing
- queue modes: `queue`, `followup`, `interrupt`
- drop policy: `old` vs `new`
- debounce
- generation-based stale completion filtering after `Reset()`
- adaptive throttle near 60% context-window usage
- FIFO cancellation with `activeOrder`

So this is not a toy scheduler.
It is one of their better subsystems.

### 2. But the scheduler is only one of several admission layers

End-to-end, a user message does not go straight into "the scheduler".

It moves through:

- channel/webhook ingress
- `MessageBus` inbound buffer
- dedupe cache
- inbound debouncer
- session-key shaping
- scheduler session queue
- lane semaphore

That matters because queue quality at the scheduler layer does not automatically mean queue quality at the product level.

The most important example is `TryPublishInbound(...)`:

- it is non-blocking
- it drops when the global inbound buffer is full
- it has no durable retry queue behind it

So some important messages can be lost *before* the scheduler ever sees them.

This is one of the clearest reasons the outer runtime feels weaker than the inner scheduler.

### 3. There are effectively two queue models, not one

The system has both:

- a global inbound bus buffer
- a per-session scheduler queue

And they have very different semantics:

- bus-level drop on `TryPublishInbound(...)`
- session-level `DropOld` / `DropNew`
- debounce-based collapsing
- cancel/drain semantics

This makes admission harder to reason about.

A user-facing orchestrator is much easier to trust when there is one primary queueing truth.
GoClaw has multiple queueing truths.

### 4. Group responsiveness still depends heavily on session-key and internal-message shaping

Issue `#266` is especially revealing here.

It was not just "one bug".
It showed a structural risk:

- lead agent group sessions
- team reminders
- teammate dispatches
- notification messages
- user messages

all interact through the same broader ingress and session-shaping system.

The fix in commit `014f74ec` improved two real problems:

- removed the `[user]+[assistant]+[user]` reminder pattern that caused `NO_REPLY`
- propagated `PeerKind` correctly so notifications route to the right session

That was a good fix.
But the maintainers also explicitly said in the issue comments:

- queue architecture redesign is still needed
- team-task-aware capacity or a separate dispatch queue is the real fix

That is very strong competitor evidence.
It means even they do not consider the current end-to-end admission model fully solved.

### 5. Session fairness is still policy-driven more than causally guaranteed

GoClaw does have fairness ideas:

- one task per owner per round in team dispatch
- per-session concurrency limits
- stale message skipping after abort cutoff

But the deeper truth is:

- fairness depends on queue caps
- fairness depends on the debounce window
- fairness depends on session key construction
- fairness depends on internal traffic not crowding the wrong ingress path

So fairness is partly emergent policy, not purely guaranteed by one durable model.

### 6. Cancellation semantics are thoughtful, but lossy by design

`CancelAll()`:

- cancels all active runs
- drains queued requests
- marks an abort cutoff so older queued messages are treated as stale

This is coherent.
But it is also intentionally lossy.

That is fine for operator control.
It is less fine if your product language sounds like every user message is safely queued until processed.

Again, this is not "bad code".
It is a lesson in honesty of semantics:

- some messages are intentionally sacrificed to recover session control

### 7. Scheduler tests are decent, but even here there are signs of timing sensitivity

Issue `#677` is only a flaky test report, but it is still informative.

It shows:

- there are timing windows around `Stop()`
- scheduler tests did not always evolve with runtime changes
- race-sensitive behavior exists even in one of their better-tested subsystems

This does not reduce my rating of the scheduler core much.
But it does reinforce a broader theme:

- the strong parts of GoClaw are still evolving under real concurrency pressure

### 8. The inbound debouncer is a hidden routing seam, not just a UX nicety

This was one of the most important new findings from another pass through the ingress path.

`internal/bus/inbound_debounce.go` looks harmless at first:

- buffer quick consecutive messages
- merge them
- avoid unnecessary duplicate runs

But the actual key is:

- `channel:chatID:senderID`

And the merge strategy is:

- take the **last** message as the structural envelope
- concatenate text content from all messages
- keep the last message's metadata / route / target fields

That means the debouncer ignores several routing-significant fields:

- `agent_id`
- `tenant_id`
- `peer_kind`
- `local_key`
- thread/forum topic identity carried in metadata

This is not a theoretical concern.
`cmd/gateway_consumer_normal.go` later uses exactly those fields to decide:

- session key
- thread routing
- forum-topic routing
- agent target

So the current debouncer can, in principle, collapse messages that should remain separate.

Examples:

- same sender sends two quick messages into two different forum topics in the same Telegram group
- same sender sends two quick messages into two different DM threads
- same sender quickly targets different agents in the same chat

In all of those cases, the debouncer key can collide, and the last message's envelope wins.

I did not find a public issue explicitly naming this exact bug yet.
But the code path is real, and it is a strong architectural warning:

- the admission layer currently treats "same sender in same chat" as equivalent to "same route"

That assumption is weaker than the routing model used later in the consumer.

So this is a concrete place where ingress simplification is stricter than downstream routing semantics.

### 9. QoS is implicit, not explicit

Another important finding is that priority behavior is encoded indirectly through API choice, not through a first-class queueing model.

External inbound traffic often uses:

- `PublishInbound(...)`

which blocks when the global bus is full.

Internal system-originated traffic often uses:

- `TryPublishInbound(...)`

which drops immediately when the bus is full.

Examples include:

- team dispatch
- task ticker notifications
- blocker escalations
- some gateway-side internal events

This creates an implicit QoS model:

- real user ingress backpressures the source
- internal orchestration traffic is often best-effort

That may be a reasonable product decision.
But architecturally it is dangerous because:

- it is not centralized as a policy
- it is scattered across callsites
- different internal message classes get different reliability based on which publish helper the author happened to choose

That is a classic large-system smell:

- reliability semantics are encoded in helper selection, not in the queueing model itself

### 10. Adaptive throttle quietly overrides the visible concurrency story

At the product surface, group sessions are described as allowing more concurrency.

`cmd/gateway_consumer_normal.go` explicitly sets:

- group chats -> `maxConcurrent = 3`

But `internal/scheduler/queue.go` has adaptive throttle that reduces effective concurrency to `1` when the estimated token load reaches `>= 60%` of the context window.

And `cmd/gateway_heartbeat.go` wires that estimate from persisted session history.

So the true rule is not:

- group session = 3 concurrent runs

It is:

- group session = up to 3 concurrent runs until the adaptive throttle decides otherwise

This is thoughtful from a memory-pressure perspective.
But it also means the user-visible concurrency story is softer than it looks.

In practice, this can amplify exactly the kinds of responsiveness complaints seen in issues like `#266`:

- long-lived group sessions
- lots of history
- internal system side traffic
- visible concurrency setting says "3"
- actual effective concurrency silently collapses to "1"

I am intentionally calling this an amplification factor, not a proven root cause for every case.
But architecturally it matters:

- the scheduler has a hidden mode switch that changes fairness and responsiveness under history pressure

### 10.1. Issue `#266` is effectively a maintainer admission that the outer queue shell needs redesign

The current comments on `#266` are very revealing.

The maintainers explicitly describe the problem as:

- lead group session waits synchronously on team-task flow
- session queue pressure builds up while previous work is still cleaning up
- `TryPublishInbound()` silently drops when the buffer is full
- the fix is deferred because it needs a **queue architecture redesign**

That is important because it aligns almost perfectly with what the current code shows:

- strong inner scheduler primitives
- weak outer admission shell
- reliability semantics split across bus, debouncer, session queue, and lane submit

This is one of the clearest places where issue discussion and code structure tell the same architectural story.

### 10.2. Admission semantics depend on callsite, not on message importance

The deepest new lesson from this pass is that GoClaw does **not** have one unified QoS model for inbound work.

Instead, admission semantics are chosen ad hoc at the callsite:

- real channel ingress usually uses blocking `PublishInbound(...)`
- team dispatch often uses non-blocking `TryPublishInbound(...)`
- task ticker notifications use `TryPublishInbound(...)`
- team blocker wakeups use `TryPublishInbound(...)`
- subagent announce batches use blocking `PublishInbound(...)`
- dashboard task creation / assignment paths may use blocking `PublishInbound(...)`

That means message reliability is determined by origin path, not by semantic criticality.

Concrete example:

- a human-assigned team task from dashboard can take a blocking ingress path
- an automatically redispatched or stale-recovered team task often takes a best-effort path

So the system can treat "operator-created work" and "runtime-repair work" with different durability guarantees even when both are lifecycle-critical.

That is a strong competitor warning sign.

The architecture is telling you:

- QoS is encoded in helper choice
- not in one central admission policy

### 10.3. There are really several inbound classes, not one queue

In the live runtime, inbound work is not just:

- message bus
- scheduler

It is at least:

1. channel ingress or internal producer
2. optional dedupe
3. optional `InboundDebouncer`
4. `MessageBus` inbound channel
5. `processNormalMessage(...)` routing and session shaping
6. session queue
7. lane semaphore

And not all traffic goes through the same path.

Examples:

- ordinary user messages go through the debouncer
- teammate messages bypass debounce
- subagent announce messages bypass debounce
- blocker escalation bypasses debounce

So there is no single canonical admission path.
There are multiple ingress classes with different collapse, backpressure, and delivery semantics.

That is not automatically wrong.
But it raises the cost of reasoning about fairness:

- which flows can merge
- which flows can drop
- which flows can starve user input
- which flows can pile up behind old session state

### 10.4. The debouncer key is too coarse for the richness of their routing model

`internal/bus/inbound_debounce.go` keys buffers by:

- `channel:chatID:senderID`

It ignores:

- `tenant_id`
- `agent_id`
- `peer_kind`
- `local_key`
- thread/topic routing

Meanwhile `processNormalMessage(...)` later derives much richer routing:

- scoped session keys
- thread session keys
- forum-topic session keys
- DM-thread overrides
- group-specific user identity shaping

So the debouncer collapses messages **before** the richer routing model is applied.

That creates a structural risk:

- messages that are distinct in final routing space may already have been merged in coarse ingress space

I am not claiming every one of those dimensions is currently exploitable into a user-visible bug.
But architecturally it is the wrong layering direction:

- coarse merge first
- precise route later

### 10.5. The scheduler itself is better tested than the system that feeds it

I ran targeted scheduler tests:

- `go test ./internal/scheduler -run 'Test.*(AdaptiveThrottle|Drop|Cancel|Reset|Serialization|Parallel)'`

and they passed.

That matches the code quality signal:

- `internal/scheduler` is relatively disciplined
- queue primitives are directly tested
- cancellation, reset, drop policy, serialization, and adaptive throttle are all covered

But the outer shell around it is much less defended:

- I did not find direct tests for `InboundDebouncer` key correctness
- I did not find end-to-end tests for bus pressure + debounce + scheduler interaction
- I did not find tests proving that internal `TryPublishInbound(...)` traffic cannot starve or silently disappear in lifecycle-critical paths

So the test story here is asymmetric:

- inner scheduler confidence is real
- outer admission confidence is much weaker

### 10.6. The strongest precise conclusion from this layer

After this pass, the most accurate scheduler-related summary is:

- `scheduler core` is strong
- `admission shell` is fragmented
- `fairness story` is partly explicit, partly hidden
- `delivery guarantees` vary by origin path

That is why issues like `#266` are so important.

They are not just "queue bugs".
They are symptoms of a system where:

- queueing
- debounce
- ingress backpressure
- internal notifications
- session shaping
- adaptive throttle

are all individually reasonable, but not unified into one coherent admission model.

### 11. `parentCtx` reuse shows the session queue is not a pure envelope queue

`SessionQueue` stores `parentCtx` from the first `Enqueue(...)` call and later reuses it for future `scheduleNext(...)` executions.

In practice this is often harmless because many sessions share the same long-lived gateway context.
But it still reveals something important about the design:

- queued work is not driven purely by the queued request envelope
- part of execution context is session-owned state captured outside the pending request itself

That is a softer version of the same problem seen elsewhere in GoClaw:

- the system mixes durable/request truth with ambient runtime context

Again, this is not a smoking-gun production bug by itself.
It is a design smell that tells you the scheduler boundary is not fully self-contained.

## What is architecturally strong

### 1. The team task engine is the best part of the system

This is the clearest strength in the whole repo.

Why it is good:

- explicit lifecycle states: `pending`, `in_progress`, `completed`, `blocked`, `failed`, `in_review`, `cancelled`, `stale`
- transitions are mostly durable and DB-backed
- completion/fail/cancel paths unblock dependents transactionally
- review/approve/reject are first-class lifecycle steps
- blocker handling and followups are part of the model, not UI sugar

Key files:

- `internal/store/team_store.go`
- `internal/store/pg/teams_tasks_lifecycle.go`
- `internal/store/pg/teams_tasks_progress.go`
- `internal/tools/team_tasks_create.go`
- `internal/tools/team_tasks_lifecycle.go`
- `internal/tools/team_tasks_mutations.go`

This is not a toy board.
It is a real orchestration substrate.

### 2. Recovery is built into the runtime, not left to operators

`internal/tasks/task_ticker.go` is one of the strongest design decisions in the repo.

What it does well:

- recover stale `in_progress` tasks
- mark long-pending tasks stale
- mark long-`in_review` tasks stale
- fix orphaned blocked tasks
- send leader notifications
- batch work across teams

This matters because unattended systems fail in these exact ways.
Many orchestrators stop at "we have statuses".
`goclaw` actually does lifecycle maintenance.

### 3. Scheduler is its own subsystem

`internal/scheduler/*` is a real scheduler, not "a few mutexes inside the loop".

Good properties:

- per-session queue
- queue modes: `queue`, `followup`, `interrupt`
- drop policy
- debounce
- adaptive throttle near context pressure
- cancellation APIs

That is the right architectural direction.
Scheduling is treated as a bounded subsystem.

### 4. The team-task persistence model is deliberate, not accidental

This is easy to miss if you only read the tool layer.

The schema itself shows a mature orchestration mental model:

- lock timestamps and lock expiry
- `blocked_by`
- followup scheduling fields
- task numbering and identifiers
- scope fields (`channel`, `chat_id`, `user_id`)
- denormalized counts for UI performance
- indexes for owner/status, lock expiry, scope, followups, identifiers

The SQLite schema and PG migrations both show this clearly.

This matters because the strong behavior in `goclaw` is not only "smart Go code".
It is also backed by a data model designed around task orchestration as a first-class concern.

### 5. The agent loop is staged, not one giant function

The `internal/pipeline/*` layer is clean by comparison with most agent repos.

The main win:

- `ContextStage`
- `ThinkStage`
- `PruneStage`
- `ToolStage`
- `ObserveStage`
- `CheckpointStage`
- `FinalizeStage`

This makes it much easier to evolve behavior without turning the loop into spaghetti.

### 6. Post-turn compensation is one of the smartest parts of the runtime

`cmd/gateway_consumer_post_turn.go` is a very important file.

It shows that `goclaw` does not fully trust agent behavior to maintain the task system correctly.
Instead, it adds a compensating runtime layer after the run finishes.

That layer maps:

- run error -> fail task
- explicit complete/escalate -> skip
- reviewed -> renew lock
- loop detector kill -> fail task
- no terminal action -> auto-complete task

This is stronger than most competitors.

It means their system is designed around a realistic assumption:

- agents are helpful but unreliable actors
- the runtime must reconcile final state after the turn

This same idea explains why issues like `#504` and `#506` are fixable inside the system instead of being left as manual operator cleanup forever.

### 7. The maintainers are willing to document trap zones explicitly

This is a quiet positive signal.

`docs/agent-identity-conventions.md` is large and specific because the team has clearly learned where identity and scoping go wrong.

That does not mean the problem is solved.
It does mean the maintainers are not naive about the hard parts.

This matters because some codebases hide these problems until they explode.
`goclaw` at least surfaces them.

### 8. The repo often fixes bugs with real code and tests, not hand-waving

This is a positive signal.

Examples:

- `#431` workspace fallback fix in commit `bdfc0fad`
- `#836` Windows workspace isolation fix in `e715e43a`
- `#555` board update logic fixed in `5ed86b84`

That suggests the maintainers do understand the code, even when the system is too broad.

### 9. Orchestration modes are a neat capability pattern

`spawn`, `delegate`, and `team` mode are worth noting.

They do two useful things:

- make inter-agent capability intent explicit
- hide inappropriate tools from the agent based on current orchestration context

This is a good pattern.
It keeps the model understandable for the LLM and for the product.

But it is also important not to overread it:

- this is mostly a capability and prompt-shaping layer
- it is not a separate hard runtime isolation boundary

So it is a good idea to copy conceptually, but not sufficient by itself.

### 10. Prompt contracts are unusually deliberate and well-tested

This is a real strength, even though it also creates a later risk.

Evidence:

- `internal/agent/resolver_helpers.go` builds a dense `TEAM.md` with explicit anti-patterns, task-sizing rules, batching rules, `blocked_by` rules, and reviewer/member workflow
- `internal/agent/loop_history.go` filters injected context files by runtime mode, team context, bootstrap state, and tool visibility
- `internal/agent/systemprompt.go` logs prompt length and resolves prompt mode explicitly
- `internal/agent/systemprompt_team_test.go`, `systemprompt_mode_test.go`, and `prompt_builder_orchestration_test.go` verify that different orchestration modes actually produce different prompt surfaces

This is better than the common "huge prompt string with almost no tests" approach.

The maintainers clearly treat prompt construction as part of runtime behavior, not just prose.

### 11. WS event filtering is more disciplined than the average dashboard stack

`internal/gateway/event_filter.go` is worth calling out positively.

It does a few things right:

- tenant filtering is fail-closed for regular clients
- team events are checked against team access
- admin-only events are explicitly blocked from non-admin users
- trace status, tenant revocation, exec approvals, and other event families each have separate filtering logic

So even though the overall event topology is messy, the actual WS delivery boundary is not naive.

That matters because many systems with broad dashboards simply over-broadcast and hope the frontend hides things.
`goclaw` is better than that.

### 12. When they focus on a security seam, they often fix it properly

This is important because the repo is not "security sloppy everywhere".

Concrete positives:

- `chat.*` ownership issue from `#675` was corrected with a shared `requireSessionOwner()` helper instead of one-off local checks
- `/mcp/bridge` is now disabled with `403` when no gateway token is configured
- HTTP auth is stricter than the old WS/gateway habits in several places:
  - API keys carry scoped tenant context
  - browser pairing resolves to operator, not admin
  - dev-mode no-auth ignores spoofed `X-GoClaw-User-Id` and forces `system`
- several tenant hotfix tests show they now test cross-tenant role mistakes explicitly

So the right read is:

- they are capable of hardening a seam well
- the bigger problem is that the underlying default model is still not uniformly strict

## What is architecturally weak

### 1. Context and metadata sprawl is a real structural problem

This is one of the biggest weaknesses in the repo.

Evidence:

- `context.WithValue(...)` occurrences in `internal/*`: `73`
- `TenantIDFromContext(...)`: `420`
- `WithTenantID(...)`: `146`
- `WithAgentID(...)`: `76`

Key files:

- `internal/store/context.go`
- `internal/tools/context_keys.go`
- `internal/store/run_context.go`
- `internal/agent/loop_context.go`

The most revealing fact is that `internal/store/run_context.go` explicitly says it is trying to replace `27` separate `context.WithValue` calls with one typed struct.

That means the authors already know this is a problem.

And the problem is still visible in the newer path:

- `internal/store/context.go` alone still contains `18` `context.WithValue(...)` calls
- `internal/tools/context_keys.go` is another large context-helper hub
- `internal/agent/loop_context.go` still performs about `15` `store.With*` injections and `24` `tools.With*` injections inside one setup path

Why this is bad:

- too much correctness depends on "did the right context key get injected?"
- hidden coupling between layers
- hard to explain policy or routing decisions
- easy to miss one path when adding tenant or workspace scope

This is exactly the kind of architecture debt that shows up as weird production bugs.

The deeper issue is that identity itself is not simple in `goclaw`.

The code and docs now distinguish at least:

- actor identity
- scope identity
- sender identity
- user identity
- tenant identity
- agent UUID vs agent key

That is a real domain problem, not just naming sloppiness.
But it also means correctness lives in a lot of propagation paths.

Issue `#565` captures this well:

- multi-tenant foundation is considered solid
- human identity is still treated as fragmented enough to justify a new enterprise identity layer

### 1.1. Identity is better documented than it is encapsulated

This is one of the most important deeper findings.

`goclaw` is not identity-naive anymore.
In fact, it is unusually explicit about identity semantics:

- `docs/agent-identity-conventions.md` is large, concrete, and names the trap zones directly
- `internal/store/context.go` now has `ActorIDFromContext(ctx)` as an explicit repair layer
- `internal/store/context_actor_id_test.go` directly tests:
  - group -> sender wins
  - guild -> sender wins
  - DM -> merged tenant user wins
  - empty sender fallback behavior
- `tests/integration/telegram_group_write_file_permission_test.go` is a very concrete regression harness for `#915`

This is the good news.

The bad news is that correctness is still highly distributed.

By simple callsite count:

- `TenantIDFromContext(...)`: `426`
- `WithTenantID(...)`: `204`
- `UserIDFromContext(...)`: `123`
- `WithUserID(...)`: `57`
- `SenderIDFromContext(...)`: `20`
- `WithSenderID(...)`: `16`
- `ActorIDFromContext(...)`: `23`
- references to `#915` in code/comments/tests: `51`
- `peer_kind` references across runtime paths: `177`

That pattern tells you something important:

- they now understand the model
- but the model still has to be reassembled in many places

The strongest evidence is how many wrappers manually preserve origin metadata:

- `internal/tools/team_tasks_create.go` stores `origin_sender_id`, `origin_role`, `origin_session_key`, `peer_kind`, `local_key`
- `internal/gateway/methods/teams_tasks_mutations.go` restores `origin_sender_id` and `origin_role` on dashboard dispatch
- `internal/tools/team_tool_dispatch.go` carries sender, role, session key, peer kind, team workspace, trace context
- `internal/tools/delegate_tool.go` carries actor audit identity separately from scope identity
- `internal/tools/subagent_spawn.go` and `internal/tools/subagent_exec.go` preserve sender, role, session key, tenant, trace
- `internal/tools/sessions_send.go` manually propagates the acting sender to avoid synthetic-sender permission failure
- `cmd/gateway_consumer_handlers.go` manually rebuilds teammate and subagent announce runs with restored sender, role, session, local key, peer kind

This is not just "a lot of metadata".
This is an architectural smell:

- identity and routing truth are not packaged into one strongly typed envelope
- they are reconstructed across ingress, dispatch, announce, post-turn, and UI-facing paths

That is exactly why so many issues rhyme structurally:

- `#557` - custom skill upload missing tenant header
- `#560` - channel inbound message missing `TenantID`
- `#734` - HTTP inline-auth path authenticates but forgets tenant injection
- `#877` - completion event loses `local_key`, so routing falls back to the wrong Telegram topic
- `#915` - group file-write auth uses group scope instead of real sender

These look different at the surface.
Architecturally they are the same class of bug:

- one path forgot to carry one piece of identity or scope state

`ActorIDFromContext(ctx)` is therefore best understood as a repair abstraction, not a full solution.
It is smart and useful, but it also proves the deeper model is hard enough that many callsites cannot safely use raw `UserID` anymore.

Another revealing detail is that the repo now contains several comments marked `SCOPE-intentional` or similar.
Examples in `team_tasks_create.go` and `cron.go` explicitly say they are *not* switching some rows to `ActorIDFromContext` because doing so would break shared group visibility semantics.

That is a sophisticated tradeoff, but also a warning:

- scope identity and actor identity are both valid
- the system often needs both
- the choice is local and easy to get wrong

`internal/store/config_permission_store.go` makes this even sharper.
In group/guild context:

- sender is the real permission boundary
- synthetic sender must deny
- missing sender must deny
- DB errors still fail-open

So sender propagation is not optional decoration.
It is a security and correctness boundary.

The final read here is nuanced:

- architecturally, this is one of the most sophisticated parts of `goclaw`
- operationally, it is also one of the easiest places to regress

The maintainers are clearly hardening it.
I confirmed targeted tests still pass:

- `go test ./internal/store ./internal/tools ./cmd -run 'Test.*(Actor|Sender|FileWriter|Group|Skill|Cron|TeamTask).*'`

But the deeper lesson is still negative:

- if your orchestrator requires this many manual `tenant/user/sender/session/local_key/peer_kind` restorations, new features will keep breaking the boundary

So the right competitor lesson is not "their identity model is bad".
It is:

- their identity model is strong in awareness
- but weak in encapsulation
- and that weak encapsulation leaks directly into orchestration, permissions, routing, and audit behavior

### 1.2. The deeper problem is distributed identity propagation

Going one level deeper, the key architectural risk is not "bad identity modeling".
It is that identity correctness is spread across too many carriers at once:

- HTTP auth and custom headers
- websocket client auth state
- `internal/store/context.go`
- `internal/store/run_context.go`
- `internal/tools/context_keys.go`
- task metadata (`origin_sender_id`, `origin_role`, `origin_session_key`, `peer_kind`, `local_key`)
- bus and websocket payloads

`RunContext` is clearly a corrective move, but only a partial one.
It centralizes some important values:

- `TenantID`
- `UserID`
- `CredentialUserID`
- `SenderID`
- `AgentID`
- `AgentKey`

But the runtime still carries a second identity and routing layer in tool context.
By direct inspection of the current code:

- `internal/store/context.go` defines `18` store context keys
- `internal/tools/context_keys.go` defines `32` tool context keys
- `internal/agent/loop_context.go` still manually injects both store-level and tool-level identity/routing values inside one setup path

When you narrow the search to non-test runtime code only, the signal is still strong:

- `TenantIDFromContext(...)`: `422`
- `WithTenantID(...)`: `97`
- `UserIDFromContext(...)`: `115`
- `SenderIDFromContext(...)`: `17`
- `ActorIDFromContext(...)`: `12`
- `RoleFromContext(...)`: `12`
- `origin_sender_id`: `5`
- `origin_role`: `5`
- `origin_session_key`: `3`
- `peer_kind`: `42`

This is one of the clearest competitor lessons in the repo:

- tenant propagation is everywhere
- actor-aware accessors exist
- but raw `UserID` access is still far more common than actor-aware access
- origin metadata still has to be manually persisted on deferred paths

That is why the current issue cluster reads as one structural bug family rather than four isolated mistakes:

- `#557` - custom skill upload path forgot the tenant header and silently created data in the master tenant
- `#560` - channel inbound message missed `TenantID`, so the same agent resolved differently on Telegram vs dashboard
- `#734` - inline-auth HTTP handlers authenticated but forgot `store.WithTenantID(...)`
- `#915` - group write-file permission checked the group scope instead of the acting sender

All four are the same architectural shape:

- one ingress or wrapper path forgets one piece of identity or scope state
- the request does not hard-fail
- semantics silently shift

The code itself makes this especially clear.

`internal/agent/loop_context.go` still has to reconstruct run identity by hand:

- `WithTenantID`
- `WithUserID`
- `WithCredentialUserID`
- `WithSenderID`
- `WithRole`
- plus tool-layer routing context such as channel, chat, workspace, team task, delegation, and session values

`internal/tools/team_tasks_create.go` then shows the next layer of complexity:

- it persists `origin_sender_id` and `origin_role`
- but it intentionally stores `UserID` as the task visibility scope
- the comment explicitly says switching to `ActorIDFromContext(...)` would break shared group visibility

That is sophisticated domain thinking.
It is also fragile, because local callsites must choose correctly between:

- actor identity
- scope identity
- sender identity

`internal/store/config_permission_store.go` sharpens this further.
In group/guild contexts:

- `UserID` is the shared group scope
- `SenderID` is the acting human
- missing or synthetic sender must deny
- wrappers are explicitly required to preserve the real sender through subagent, delegate, and teammate paths

So sender propagation is not a minor detail.
It is a permission boundary.

This gives a more precise final read than the earlier "context sprawl" label:

- `goclaw` no longer has a naive identity model
- it has a fairly sophisticated identity model
- but that model is weakly encapsulated
- correctness still depends on many manual propagation seams

That is why the maintainers had to add repair abstractions like `ActorIDFromContext(...)`.
That helper is smart and necessary, but it also proves the underlying model is hard enough that many callsites cannot safely use raw `UserID` anymore.

The most important competitor lesson here is very specific:

- do not let actor identity, scope identity, tenant identity, and routing identity live in separate partial carriers unless one typed envelope owns them end to end
- otherwise every new ingress, wrapper, async path, or UI dispatch route becomes a fresh chance to break permissions, audit, routing, or orchestration truth

### 1.3. The system really has three identity lanes, not one

Following the actual Telegram group flow makes the architecture even clearer.

At ingress in `cmd/gateway_consumer_normal.go`:

- `UserID` becomes the shared scope principal
  - for Telegram groups: `group:telegram:<chatID>`
  - for Discord guilds: `guild:<guildID>:user:<senderID>`
- `SenderID` stays the acting human
- session keys are derived from channel/chat/topic scope, not actor identity

This means the runtime already starts with two valid but different notions of "who this run is about":

- scope principal
- acting principal

But one level deeper, there is effectively a third lane too:

- permission principal

Those three lanes show up in different subsystems:

**Scope lane**

- `gateway_consumer_normal.go` builds group-scoped `UserID`
- `internal/tools/session_scope.go` restricts cross-session access using `UserIDFromContext(...)`
- `internal/tools/team_tasks_create.go` intentionally persists `UserID` as task visibility scope
- `internal/tools/workspace_interceptor.go` falls back to `store.UserIDFromContext(ctx)` for workspace event routing and file attachment scope
- `internal/tools/team_event_helpers.go` packs `UserIDFromContext(...)` into task event payload context

**Audit lane**

- `internal/tools/delegate_tool.go` uses `ActorIDFromContext(...)` for audit trail events
- `internal/tools/team_tasks_blocker.go` writes `ActorIDFromContext(...)` into failure and escalation paths
- `ActorIDFromContext(...)` exists precisely because raw `UserID` is no longer safe as "the actor"

**Permission lane**

- `internal/store/config_permission_store.go` checks `SenderID` against group file-writer grants
- `cmd/gateway_consumer_normal.go` has to compute `effectiveSenderID` and `effectiveRole`
- `internal/tools/sessions_send.go` manually propagates `MetaOriginSenderID`
- delegation / subagent / teammate wrappers preserve sender and role so re-ingress turns can still pass permission checks

This is the deeper architectural truth:

- there is no single "current user" abstraction inside `goclaw`
- there are multiple identity lanes with different semantics
- several subsystems are intentionally reading different ones

That is more sophisticated than a normal web app identity model.
It is also much easier to regress.

The integration test `tests/integration/telegram_group_write_file_permission_test.go` makes this explicit in its own invariant:

- `UserID   = group:telegram:<chatID>`  - scope / memory namespace
- `SenderID = <numeric>`                - acting principal

The code then has to preserve that split through wrappers.
For example:

- `sessions_send` emits a synthetic sender on the wire but has to stash the real sender in metadata
- `gateway_consumer_normal.go` later restores `effectiveSenderID` from `MetaOriginSenderID`
- `CheckFileWriterPermission(...)` denies if the real sender is missing or synthetic

So the architecture is not just "context-heavy".
It is carrying a deliberate dual or triple-lane identity model through asynchronous wrappers.

That leads to a sharper competitor lesson than before:

- if your orchestrator needs shared group scope, per-actor audit, and per-actor permissions at the same time, you cannot pretend one `user_id` field will represent all of them
- but once you split them, you must package the split into one typed end-to-end contract
- otherwise every wrapper has to remember which lane to preserve, which lane to transform, and which lane to leave untouched

This is exactly why `#915` was not a one-line bug.
It exposed that `goclaw` depends on many wrappers preserving the same identity split correctly:

- ingress
- task creation
- delegation
- subagent announce
- session send
- escalation
- UI and task event projection

That is powerful architecture.
It is also high-maintenance architecture.

### 1.4. `UserID` is no longer a stable contract field

One more layer deeper, the most revealing smell is this:

- the field named `UserID` no longer has one stable meaning across the runtime

`internal/bus/types.go` still describes `InboundMessage.UserID` as:

- external user ID for per-user scoping

But the actual runtime now uses that field in several incompatible ways.

At normal group ingress:

- `gateway_consumer_normal.go` sets `UserID = group:<channel>:<chatID>`
- this is a scope principal, not an acting human

In team dispatch paths:

- `team_tool_dispatch.go` sets `MetaOriginUserID` from `store.UserIDFromContext(ctx)`
- if that is empty, it falls back to `originChatID`
- so the "origin user id" field can degrade into chat scope rather than user identity

In delegate paths:

- `delegate_tool.go` builds `DelegateRequest.UserID` from `ActorIDFromContext(ctx)`
- `announceToParent()` then publishes that actor-derived value back into `InboundMessage.UserID`

In subagent paths:

- `subagent_spawn.go` stores `OriginUserID = store.UserIDFromContext(ctx)`
- `subagent_exec.go` republishes it into `InboundMessage.UserID`
- `handleSubagentAnnounce()` then may normalize it back to a group scope principal with:
  - `announceUserID = group:<channel>:<chatID>`

In teammate announce paths:

- `gateway_consumer_handlers.go` forwards `OriginUserID` into `announceRouting`
- `processAnnounceLoop()` then feeds that directly into `RunRequest.UserID`

So the same conceptual slot can mean:

- a shared group scope principal
- an actor-derived human identity
- a chat-scope fallback
- an origin-carried value from an earlier phase

This is deeper than ordinary "context sprawl".
It means the semantic meaning of `UserID` itself is phase-dependent.

That is why some subsystems must keep compensating:

- `team_tasks_read.go` filters end-user task visibility by `store.UserIDFromContext(ctx)` - i.e. scope lane
- `delegate_tool.go` emits audit events with `ActorIDFromContext(ctx)` instead
- `config_permission_store.go` ignores `UserID` for group write permission and uses `SenderID`

So there is no single authoritative answer to:

- what does `UserID` mean here?

The answer is:

- it depends on which stage of the orchestration pipeline you are in

That is a major competitor lesson.
Once a field name keeps its shape but not its meaning, the system becomes harder to reason about than the type signatures suggest.

The async wrappers show this clearly:

- some preserve `UserID`
- some preserve `SenderID`
- some preserve both
- some later normalize `UserID` back to group scope
- some fall back to `chatID`

So the real contract is not encoded in one type.
It is encoded in path-specific conventions.

This is exactly the kind of architecture that can look correct in local code review while still producing cross-path bugs months later.

### 1.5. Async announce paths preserve different identity subsets

Going even deeper, the async re-ingress paths are not even fully consistent with each other.

The strongest example is the difference between:

- teammate announce
- subagent announce

Both are `RunKind = "announce"` runs.
Both feed new agent turns back into an existing parent conversation.
But they preserve identity differently.

**Subagent announce path**

- `subagent_spawn.go` stores:
  - `OriginUserID`
  - `OriginSenderID`
  - `OriginRole`
  - `OriginSessionKey`
  - tenant and trace context
- `subagent_exec.go` republishes all of them
- `gateway_consumer_handlers.go` restores:
  - group-scoped `announceUserID`
  - `originSenderID`
  - `originRole`
- `gateway_subagent_announce_queue.go` schedules the announce run with:
  - `UserID`
  - `SenderID`
  - `Role`

So subagent announce preserves both:

- scope lane
- permission lane

**Teammate announce path**

- teammate dispatch preserves `MetaOriginUserID`, `MetaOriginSenderID`, `MetaOriginRole`
- member run itself receives `UserID`, `SenderID`, `Role`
- but when the member finishes, `gateway_consumer_handlers.go` builds `announceRouting`
  with:
  - `OriginUserID`
  - no `OriginSenderID`
  - no `OriginRole`
- then `gateway_announce_queue.go` schedules the lead announce run with:
  - `UserID`
  - no `SenderID`
  - no `Role`

That means the teammate announce path drops the permission lane before the lead's announce run even starts.

This matters more than it first appears.

`RunKindNotification` has an explicit guard:

- `team_tasks_tool.go` blocks mutations during notification runs

But I did not find a comparable hard restriction for `RunKind = "announce"`.
So announce runs appear to remain normal agent turns with fewer persistence effects, not a fully restricted "output-only" mode.

That creates an architectural asymmetry:

- subagent announce run can still carry user-attributed permission context
- teammate announce run cannot

So if a lead announce run ever needs permission-sensitive behavior:

- file writes in group contexts
- admin-role bypass behavior
- any future sender-sensitive tool policy

then the behavior will depend on which async path produced the announce.

That is a deeper architectural smell than a single missing field:

- the same conceptual runtime mode (`announce`) is not backed by one consistent identity contract
- instead, each announce producer decides which subset of identity survives

This is exactly the kind of inconsistency that can stay latent for a long time:

- local path looks fine
- subagent path works
- teammate path mostly works for plain conversational relay
- only permission-sensitive or side-effectful announce behavior exposes the split

The competitor lesson here is very sharp:

- once you have asynchronous re-ingress, every re-ingress producer must target one canonical execution envelope
- otherwise "same run kind" stops meaning "same runtime semantics"

### 1.6. `RunKind` is mostly metadata, not a hardened execution boundary

The next layer down is even more important.

The problem is not only that different announce producers preserve different identity subsets.
It is also that `RunKind` itself does not look like a strong capability boundary.

In non-test runtime code:

- `RunKindFromCtx(...)` is used in only one real behavioral guard:
  - `team_tasks_tool.go` blocks task mutations during `notification` runs
- otherwise `RunKind` mostly flows into:
  - agent events
  - traces
  - UI badges
  - scheduler request metadata

That is a very different role.

It means `RunKind` is acting more like:

- observability metadata
- prompt/event annotation

than like:

- a hard execution contract
- a capability sandbox
- a guaranteed side-effect boundary

The teammate announce path shows why this matters.

`gateway_announce_queue.go` does not just schedule a read-only relay run.
It wraps the announce turn with a fresh `PendingTeamDispatch`, then after the run completes it drains that pending set through `postTurn.ProcessPendingTasks(...)`.

So teammate announce runs can:

- create new team tasks
- defer those creations into post-turn dispatch
- continue team orchestration after the announce turn finishes

That is not an "output only" envelope.
That is still a real orchestration turn.

The subagent announce path is different again.

`gateway_subagent_announce_queue.go` schedules the parent announce run directly.
It does not inject `PendingTeamDispatch`.
So the two announce paths already differ in side-effect envelope even before you consider identity preservation.

This gets sharper when you line it up with `team_tasks_create.go`.

That code explicitly says:

- if `PendingTeamDispatch` exists, pending tasks get added to the post-turn queue
- if it does not exist, creation falls back to immediate `AssignTask(...)` plus `DispatchTaskToAgent(...)`

So both announce flows can mutate orchestration state.
They just do it differently:

- teammate announce: batched post-turn continuation
- subagent announce: fallback-style immediate dispatch if task creation happens

This means that `RunKind = "announce"` does **not** imply one consistent behavioral envelope.

The same nominal run kind can vary by producer path in all of these dimensions:

- which identity fields survived re-ingress
- whether permission lane is preserved
- whether pending team dispatch exists
- whether post-turn orchestration continuation is available
- whether task creation is deferred or immediate

There is another subtle consequence.

Tool visibility is controlled primarily by orchestration mode and agent identity, not by run kind:

- `loop_tool_filter.go` hides `delegate` and `team_tasks` by `spawn/delegate/team`
- `orchestration_mode.go` derives that from team membership and delegate links
- I did not find an equivalent run-kind-specific capability filter for `announce`

So the practical power of an announce run is determined more by:

- which agent is running
- what orchestration mode that agent has
- which side-channel context was injected

than by the fact that the run is labeled `"announce"`.

That is one of the deepest architecture lessons in the whole codebase.

The smell is not merely:

- "one path forgot `SenderID`"

It is:

- runtime mode names do not map cleanly to hardened execution contracts

Once that happens, a system starts depending on convention-heavy composition:

- the router sets some fields
- the queue path sets some others
- the tool layer blocks one specific action for one specific run kind
- the rest is left to prompt guidance and path-specific behavior

That can still work.
But it is fragile in exactly the wrong way:

- it looks principled locally
- it behaves differently globally

The competitor lesson is extremely important:

- if runtime modes exist, they must mean something operationally exact
- the same mode must imply the same identity envelope, the same tool envelope, and the same side-effect model regardless of producer path
- otherwise mode names become a comforting illusion instead of a correctness boundary

### 1.7. There are really two `RunKind` channels, and they diverge

Going one step deeper, the `RunKind` story is even less unified than it first appears.

It is not just that `RunKind` is weakly enforced.
It is that GoClaw currently has two separate `RunKind` channels:

- a **tool-context channel**
- an **event/tracing request channel**

and they are not kept in sync.

The tool-context channel is driven by `tools.WithRunKind(...)`.

In non-test runtime code I found only one call site:

- `gateway_consumer_normal.go`

That path reads `msg.Metadata["run_kind"]` and injects it into the context before scheduling the run.
This is exactly why `team_tasks_tool.go` can block mutations during notification turns:

- the tool reads `RunKindFromCtx(ctx)`
- the inbound consumer injected that value manually

But the request-level channel is different.

`RunRequest.RunKind` is set directly on some scheduled runs:

- `gateway_announce_queue.go` sets `RunKind: "announce"`
- `gateway_subagent_announce_queue.go` sets `RunKind: "announce"`
- `gateway_managed.go` sets `RunKind: "delegate"`

That value then propagates into:

- pipeline input
- emitted agent events
- traces
- UI run-kind badges

The key problem is that these two channels do not converge automatically.

I did **not** find code that takes `req.RunKind` and injects it into tool context during loop setup.
`Loop.injectContext(...)` does not call `WithRunKind(...)`.
The scheduler does not appear to do it either.

So the result is asymmetrical:

**Notification runs**

- tools can see the run kind via context
- but the emitted agent events may not carry `RunKind`, because the `RunRequest`
  built in `gateway_consumer_normal.go` does not set `RunKind`

**Announce and delegate runs**

- events and traces can see the run kind via `req.RunKind`
- but tools cannot reliably see the run kind, because those direct scheduler paths
  do not inject `WithRunKind(...)`

That is a very deep architectural smell.

It means there is no single authoritative answer to:

- what mode is this run in?

The answer depends on which subsystem you ask:

- tools may see one truth
- events may see another
- UI may see another

In practice, this creates a matrix of mismatches:

- `notification`: behaviorally restricted, observability may under-label it
- `announce`: observability-labeled, behaviorally not mode-restricted
- `delegate`: observability-labeled, tools may still execute as if it were a normal run

That is worse than "run mode is soft".
It means the system can simultaneously have:

- one mode truth for enforcement
- another mode truth for telemetry

This is exactly the kind of design that causes teams to overestimate their guarantees.
An engineer sees `RunKind = "announce"` in traces or events and assumes tools can reason about it.
Another engineer sees `RunKindFromCtx(ctx)` and assumes all run kinds are enforced symmetrically.
Both assumptions are locally plausible.
Globally, neither is fully true.

The competitor lesson here is extremely sharp:

- mode must be carried through one canonical envelope
- that envelope must feed both enforcement and observability
- if tools, traces, and UI learn about mode through different channels, the system will eventually drift into self-deception

### 1.8. "Modes" are really path-specific bundles of flags, not first-class contracts

The deepest layer in this seam is that GoClaw does not really appear to have a single first-class execution-mode object.

Instead, what the code calls:

- announce
- delegate
- notification

is assembled out of several different knobs:

- `RunKind`
- `HideInput`
- `ParentTraceID`
- `ParentRootSpanID`
- `DelegateParentTraceID` in context
- `PendingTeamDispatch`
- `ContentSuffix`
- synthetic sender IDs
- origin metadata like sender/role/session/local key

and those knobs are combined differently depending on producer path.

The strongest example is the contrast between the three main system-driven run types.

**Notification**

- enters through normal inbound consumer
- gets `WithRunKind(ctx, "notification")`
- therefore tools can see the mode
- uses synthetic sender plus optional origin-sender recovery
- does **not** set `RunRequest.RunKind`

So notification is primarily a:

- tool-enforcement mode

not a request-level first-class run type.

**Announce**

- direct scheduler path sets `RunRequest.RunKind = "announce"`
- sets `HideInput = true`
- reuses parent trace via `ParentTraceID`
- may nest under parent root span via `ParentRootSpanID`
- may carry `ContentSuffix` for WS media
- may or may not inject `PendingTeamDispatch`
- does **not** reliably inject `WithRunKind(...)` for tools

So announce is really a bundle of:

- trace-linking behavior
- history-persistence behavior
- sometimes orchestration continuation behavior
- observability labeling

but not a consistently enforced runtime mode.

**Delegate**

- direct `loop.Run(...)` path sets `RunRequest.RunKind = "delegate"`
- does not use `HideInput`
- does not reuse parent trace through `ParentTraceID`
- instead uses `tracing.WithDelegateParentTraceID(ctx, ...)`
- again, does not appear to inject `WithRunKind(...)` for tools

So delegate is yet another different bundle:

- trace-link semantics via context
- request-level labeling via `RunKind`
- but not the same tool-visible mode contract as notification

This is important because it means even the tracing model is split by path.

For example:

- announce child runs reuse the parent trace and mark that trace back to `running`
- delegate runs create a new trace linked by parent pointer

Those are meaningful semantic differences.
But they are not expressed through one typed execution contract.
They are expressed through different combinations of request fields and context carriers.

This is the deepest version of the smell:

- the architecture names a few runtime modes
- but the real semantics live in path-specific bundles of flags

Once that happens, the mode name becomes less useful than it sounds.
The true behavior of a run is no longer determined by:

- `"announce"`

or:

- `"delegate"`

It is determined by the hidden combination of:

- request flags
- trace wiring
- context injection
- pending-dispatch wrapper
- sender/origin metadata

That makes the system harder to evolve safely.
Adding one new producer path or wrapper is no longer "support this mode".
It is:

- remember the right identity fields
- remember the right trace semantics
- remember the right history semantics
- remember the right post-turn semantics
- remember the right tool-context semantics

and it is very easy to forget one of those pieces.

That is why the issue pattern around identity, announce routing, permissions, and task behavior keeps recurring.
The system is not failing because the engineers do not understand the problem.
It is failing because the execution contract is not packaged into one enforceable thing.

This is one of the strongest lessons in the entire competitor codebase:

- do not let "modes" be reconstructed from a bag of flags
- if a mode exists, it must be a first-class contract that carries identity, trace semantics, tool semantics, history semantics, and side-effect policy together

### 1.9. History shows patch-train hardening, not a closed execution-contract fix

Looking at recent history around this seam makes the pattern even clearer.

The important point is not just that there were bugs.
It is *how* they were fixed.

For the same April 2026 identity / announce / permission seam, the codebase took at least this patch train:

- `9e5cec03` - preserve acting sender and migrate actor-sensitive call sites
- `1bd90123` - still had to fix synthetic sender override plus dashboard dispatch propagation
- `6a9b747b` - still had to add RBAC role propagation and a store-layer bypass for admin/operator/owner

That is not what a fully packaged execution contract looks like.
It is what a distributed correctness model looks like:

- fix one missing propagation edge
- discover another producer path
- fix role after sender
- fix dashboard after subagent
- fix deferred dispatch after live dispatch

The commit messages themselves say this very plainly.

`1bd90123` says:

- "Closes the two last unpropagated paths identified by the #915 e2e audit."

That is a very revealing sentence.
It means the system was audited path by path for propagation gaps.
That is already a sign that correctness is not guaranteed by one central contract.
It is recovered through an audit over wrapper chains.

`6a9b747b` is equally revealing.
After sender propagation was added, role propagation still had to be pushed through:

- context
- `RunRequest`
- `SubagentTask`
- `AnnounceMetadata`
- `InboundMessage.Metadata`
- re-ingress routing
- `RunRequest` again
- loop context

That is a long chain.
When a patch note has to spell out a pipeline like that, it is usually because the semantic boundary is not packaged tightly enough.

There is another strong signal in the issue state itself.

Issue `#915` is still open even though multiple hardening commits already landed against it.
That does not prove the fix is wrong.
But it strongly suggests the seam still does not feel fully "closed" even to the maintainers and users.

Issue `#877` fits the same pattern from a different angle.
Its root cause is:

- the runtime broadcast path reached into execution context for `local_key`
- but the correct source of truth was task metadata stored earlier in another phase

That is the same architectural class:

- meaning is distributed across phases
- one path reads the wrong carrier
- user-visible behavior breaks

The history of these files reinforces it:

- `gateway_consumer_normal.go` is one of the hottest files in the repo
- `context_keys.go` saw repeated changes across team/runtime waves
- `gateway_subagent_announce_queue.go` got dedicated sender/role propagation changes only very recently
- `loop_types.go` kept absorbing more fields into `RunRequest`

That is the codebase telling us:

- the seam is real
- the seam is active
- the seam is expensive

The testing pattern is also revealing.

There are good tests for:

- `notification` task-mutation blocking
- file-writer permission outcomes for synthetic vs propagated senders
- admin-role bypass behavior

But I did **not** find a comparable first-class test suite asserting a single canonical contract for:

- `announce`
- `delegate`
- the relationship between `RunRequest.RunKind`, tool-context `RunKind`, trace semantics, and post-turn semantics

That means tests are strongest at the symptom layer:

- does this path deny correctly?
- does this sender pass correctly?

and weaker at the contract layer:

- do all system-driven run modes obey one common execution model?

This is a very important competitor lesson.

The dangerous architecture is not only:

- "a system with bugs"

It is:

- a system where correctness is repaired by successive propagation patches because the underlying contract is not singular

That kind of system can become very capable and still remain structurally expensive to harden.

The lesson for us is sharp:

- if you find yourself fixing sender, then role, then session, then local key, then trace parenting, then deferred dispatch across different wrappers
- stop and package the execution contract
- otherwise you are not closing a seam, you are gardening it

### 2. `store` became a gravity well

By rough package-level analysis:

- `internal/store`: `244` Go files, about `51k` lines
- imported across internal packages about `536` times

Top-level internal package sizes:

- `store`: `51k` lines
- `channels`: `45k` lines
- `tools`: `36k` lines
- `http`: `30k` lines
- `agent`: `21k` lines

The issue is not just size.
The issue is that `store` carries too many roles:

- domain types
- status enums
- context helpers
- access helpers
- persistence interfaces
- tenant scoping conventions

This increases cross-package coupling.
It makes `store` both the data layer and a shared semantic layer.

### 3. Pipeline cleanup is real, but the v3 core is not as self-contained as it first appears

At README level, the v3 pipeline looks like a clean replacement of the old loop.

That is only partly true.

Good news:

- `internal/pipeline/*` is genuinely cleaner than a monolithic loop
- `internal/agent/loop_v3_force_test.go` explicitly guards that legacy `runLoop()` should stay deleted
- `docs/17-changelog.md` says v3 is forced for all agents

But the deeper code shows a softer reality:

- `internal/agent/loop_pipeline_adapter.go` still maps `Loop` internals into pipeline callbacks
- `internal/agent/loop_pipeline_callbacks.go` says: `NOTE: injectContext() and this callback must stay in sync when new context values are added`
- `internal/store/v3_flags.go` still parses deprecated `v3_pipeline_enabled` for backward compatibility

So the pipeline is cleaner as a surface, but some semantics still depend on legacy `Loop` helpers through a callback bridge.

That is not a fatal flaw.
But it does mean the architecture is more transitional than the public story suggests.

Even the docs are split:

- `docs/17-changelog.md` says v2 is deleted and v3 is forced
- `docs/01-agent-loop.md` and `docs/00-architecture-overview.md` still describe a dual-mode gate and `v3_pipeline_enabled`

That is architectural drift, not just stale prose.

### 4. Policy is powerful but too opaque

The policy model is not weak in capability.
It is weak in explainability.

Relevant files:

- `internal/tools/policy.go`
- `internal/agent/loop_tool_filter.go`
- `internal/tools/team_access_policy.go`
- `internal/store/config_permission_store.go`

There are several layers:

- global tool profiles
- provider overrides
- per-agent allow/deny
- group-level allow
- subagent deny lists
- orchestration-mode hiding
- team access checks
- config permission checks

That gives strong control, but behavior becomes hard to reason about.

Issue `#616` is the perfect symptom:

- user sees `tool not allowed by policy: team_tasks`
- helpers in comments explain multiple possible causes
- user still cannot tell where the effective denial came from

This is a design smell:

- powerful
- not locally explainable
- error surfaces too far from the root decision

There is also a deeper boundary issue here:

- `internal/permissions/policy.go` still treats unknown RPC methods as viewer-readable by default
- `internal/gateway/router.go` still has a fallback path that authenticates as `viewer` when token/pairing fail

That means some boundary layers still historically prefer permissive degradation over strict denial.

Open issue `#866` is severe, but it is not random FUD.
Current code still shows the exact architectural tendency that makes such reports plausible.

There is now even stronger evidence for this tendency:

- `permissions.MethodRole()` still defaults unknown methods to `viewer`
- `permissions/policy_test.go` explicitly tests and approves that unknown methods default to `viewer`

That is not an incidental bug.
It is an architectural default.

### 4.1. The RPC permission table covers only a small fraction of the public method surface

This gets worse after counting the actual method set.

Using `pkg/protocol/methods.go` on revision `f5917b0e`, I counted:

- `24` methods explicitly classified as admin
- `21` methods explicitly classified as write
- `81` methods that therefore fall through to default `viewer`

So most of the RPC surface is not positively classified.

That alone would not be catastrophic if:

- the default were strict
- scopes were enforced separately
- sensitive handlers performed strong local checks

But those conditions do not hold consistently.

The list of suspicious methods that currently fall through to `viewer` includes:

- `heartbeat.set`
- `heartbeat.toggle`
- `heartbeat.test`
- `heartbeat.checklist.set`
- `heartbeat.logs`
- `logs.tail`
- `channels.instances.list`
- `channels.instances.get`
- `channels.instances.create`
- `channels.instances.update`
- `channels.instances.delete`
- `teams.update`
- `teams.members.add`
- `teams.members.remove`
- `teams.tasks.delete`
- `teams.tasks.delete-bulk`
- `teams.workspace.list`
- `teams.workspace.read`
- `teams.workspace.delete`
- `config.permissions.list`
- `config.permissions.grant`
- `config.permissions.revoke`
- `agents.files.set`
- `chat.inject`
- `cron.run`
- `hooks.create`
- `hooks.update`
- `hooks.delete`
- `hooks.toggle`
- `hooks.test`

Some of these may be protected elsewhere.
But architecturally that is already too much reliance on "protected elsewhere".

### 4.2. API key scopes are modeled, but the WS router mostly enforces role only

This is another strong competitor lesson.

`internal/permissions/policy.go` defines:

- `MethodScopes(...)`
- `CanAccessWithScopes(...)`
- `RoleFromScopes(...)`

So on paper there is a scope-aware model.

But in the websocket path:

- `internal/gateway/router.go` checks `CanAccess(client.role, req.Method)`
- it does **not** call `CanAccessWithScopes(client.scopes, req.Method)`

I searched the repo and `CanAccessWithScopes(...)` is effectively only exercised in tests, not in the WS request router.

That means the fine-grained scope model is weaker than it appears:

- API key scopes collapse into a coarse role
- after that, the WS router mostly authorizes by role only

This is exactly the kind of architectural drift that produces a false sense of safety.

The codebase contains a more precise permission model than the hot path actually uses.

### 4.3. Many viewer-default handlers do not provide a strong second line of defense

This is the most uncomfortable part.

I re-read the handlers for several viewer-default methods.
Many of them do not have an extra role check at the handler boundary.

Examples:

- `internal/gateway/methods/heartbeat.go`
  - `handleSet`
  - `handleToggle`
  - `handleTest`
  - `handleChecklistSet`
  - no local admin/operator check
- `internal/gateway/methods/logs.go`
  - `handleTail`
  - no local admin/operator check
- `internal/gateway/methods/channel_instances.go`
  - list/get/create/update/delete
  - no local admin/operator check
- `internal/gateway/methods/teams_crud.go`
  - `handleUpdate`
  - no `HasTeamAccess(...)` check and no local role check
- `internal/gateway/methods/teams_members.go`
  - `handleAddMember`
  - `handleRemoveMember`
  - no local role check and no `HasTeamAccess(...)` gate
- `internal/gateway/methods/teams_workspace.go`
  - list/read/delete
  - no local role check and no `HasTeamAccess(...)` gate
- `internal/gateway/methods/teams_tasks.go`
  - `handleTaskGet`
  - `handleTaskGetLight`
  - no `HasTeamAccess(...)` gate
- `internal/gateway/methods/teams_tasks_mutations.go`
  - `handleTaskDelete`
  - `handleTaskDeleteBulk`
  - no local role check and no `HasTeamAccess(...)` gate

There are some places where non-admin access is checked correctly.
For example:

- `teams_crud.go` adds `HasTeamAccess(...)` checks for `handleGet` and `handleDelete`

But that is exactly the problem:

- some handlers are protected locally
- some handlers assume router policy is enough
- router policy itself is incomplete and permissive

So the system does not have one clean authorization boundary.
It has a patchwork of partial boundaries.

### 4.4. The store layer mostly enforces tenant scope, not human team access

This is the key confirmation step.

I re-read the PG store implementation to check whether missing handler guards were maybe compensated lower in the stack.
Mostly, they are not.

Relevant files:

- `internal/store/pg/teams.go`
- `internal/store/pg/teams_tasks.go`
- `internal/store/team_store.go`

The team access model itself is split into two separate concepts:

- `agent_team_members`
  - which agents belong to a team
- `team_user_grants`
  - which human users are allowed to see a team

That split is fine in principle.
But it becomes dangerous when request handlers apply it inconsistently.

Important observations:

- `ListUserTeams(...)` uses `team_user_grants`
- `HasTeamAccess(...)` uses `team_user_grants`
- many core CRUD/task/workspace store methods do **not** use `team_user_grants`
- they mostly filter by `tenant_id` only

Examples from the PG store:

- `GetTeam(...)`
  - checks `tenant_id`
  - does not check `team_user_grants`
- `UpdateTeam(...)`
  - delegates to generic update with tenant scoping
  - does not check `team_user_grants`
- `AddMember(...)`
  - inserts directly
  - no human access check
- `RemoveMember(...)`
  - deletes directly
  - no human access check
- `ListTaskScopes(...)`
  - filters by `team_id` and `tenant_id`
  - no human access check
- `GetTask(...)`
  - filters by `task_id` and `tenant_id`
  - no human access check
- `DeleteTask(...)`
  - filters by `task_id`, `team_id`, terminal status, and `tenant_id`
  - no human access check
- `DeleteTasks(...)`
  - same story
- `ListActiveTasksByChatID(...)`
  - filters by `chat_id` and `tenant_id`
  - no session owner check

So if a gateway handler forgets to call `HasTeamAccess(...)`, the store layer usually does not repair that omission.

That means the real effective security boundary is:

- tenant scope in the store
- plus whatever per-handler human access checks the handler author remembered to add

That is not a robust architecture.

### 4.5. Human team access is applied inconsistently across handlers

After checking the handlers again with the store behavior in mind, the inconsistency is now proven rather than suspected.

Examples of handlers that do apply human access checks:

- `teams_crud.go`
  - `handleGet(...)`
  - `handleDelete(...)`
  - non-admin callers must satisfy `HasTeamAccess(...)`

Examples of handlers that currently do not:

- `teams_crud.go`
  - `handleUpdate(...)`
  - `handleKnownUsers(...)`
  - `handleScopes(...)`
  - `handleEventsList(...)`
  - `handleTaskActiveBySession(...)`
- `teams_members.go`
  - `handleAddMember(...)`
  - `handleRemoveMember(...)`
- `teams_workspace.go`
  - `handleWorkspaceList(...)`
  - `handleWorkspaceRead(...)`
  - `handleWorkspaceDelete(...)`
- `teams_tasks.go`
  - `handleTaskGet(...)`
  - `handleTaskGetLight(...)`
- `teams_tasks_mutations.go`
  - `handleTaskDelete(...)`
  - `handleTaskDeleteBulk(...)`

This gives `goclaw` a structurally uneven authorization model:

- some routes are protected by human team grants
- some routes are protected only by coarse role classification
- some routes rely on store tenant scoping only

That is exactly the kind of architecture where one new route quietly reopens an old class of bugs.

### 4.6. Session ownership discipline is also uneven

There is another smaller but very telling example.

Chat methods already contain a stronger ownership helper:

- `internal/gateway/methods/access.go`
  - `requireSessionOwner(...)`
- `chat.go`
  - uses it for history reads and aborts

But `teams.tasks.active-by-session` does not use that helper.
It directly calls `ListActiveTasksByChatID(sessionKey)`.

Practical risk is lower than in the team-ID paths because:

- WS session keys include an opaque conversation identifier
- canonical format is `agent:{agentKey}:ws:direct:{conversationId}`

So random guessing is not trivial.

But the architectural lesson still matters:

- one subsystem explicitly knows session ownership must be checked
- a nearby subsystem reads session-scoped task state without using that check

That is another sign of boundary logic being distributed by convention instead of enforced centrally.

### 5. Fail-open behavior appears in too many sensitive seams

This is one of the biggest red flags.

Examples found:

- `internal/tools/team_access_policy.go`
  - malformed settings JSON -> allow
- `internal/tools/workspace_interceptor.go`
  - team resolution fails -> allow write
  - role resolution fails -> allow write
- `internal/store/config_permission_store.go`
  - DB errors often degrade open for file-writer and cron checks
- channel pairing checks in channel layer also have fail-open paths

This exact style already caused at least one security-related fix acknowledged in changelog:

- `docs/17-changelog.md` notes previous fail-open behavior around file writer / cron permission checks

Architecturally this means:

- availability was often chosen over strict correctness
- over time this creates silent security and isolation gaps

For a multi-agent orchestration system with shared workspaces, that is risky.

There is also a new, more security-specific version of this problem:

- `internal/gateway/router.go` still has `Path 4: Fallback -> viewer`
- so wrong token or unavailable pairing does not hard-fail the WS session; it degrades to authenticated `viewer`
- because the permission layer is default-permit for unknown read-ish RPC methods, this fallback is more dangerous than it would be in a strict-default-deny model

That exact interaction is the architectural core of issue `#866`.

### 6. Realtime and UI synchronization are weaker than the durable task core

This is another important seam.

The DB task lifecycle is stronger than the UI sync model.

Relevant files:

- `internal/bus/bus.go`
- `internal/eventbus/bus_impl.go`
- `internal/gateway/methods/teams_tasks.go`
- `internal/gateway/methods/teams_tasks_mutations.go`
- `internal/gateway/event_filter.go`
- `internal/tracing/collector.go`
- `ui/web/src/api/ws-client.ts`
- `ui/web/src/pages/teams/board/use-board-tasks.ts`
- `ui/web/src/pages/teams/task-sections/task-detail-dialog.tsx`
- `ui/web/src/pages/chat/hooks/use-chat-team-tasks.ts`

There are really two event systems:

- `internal/eventbus` for typed domain events with worker pool, dedup, retry
- `internal/bus` for message routing and websocket-style broadcasting

Then the UI often does patch-and-refetch behavior:

- subscribe to a set of websocket events
- fetch light task payload on certain events
- patch local state

Concrete examples:

- board view uses `useWsEvent(...)` and then does `getTaskLight(...)` on many state changes
- task detail re-loads full detail on comment events
- chat task panel maintains a separate local projection from `team.task.*` events
- traces page invalidates cached queries on `trace.status` instead of streaming full row truth

That is workable, but fragile.

Issue `#555` shows the kind of bug this produces:

- durable state had moved
- board still displayed stale status
- fix ended up in post-turn handler logic

This is a sign the presentation flow is less robust than the persistent model.

Issue `#877` reinforces the same point from another angle:

- completion events lost `local_key`
- backend state was fine
- realtime routing to the correct Telegram forum topic broke because event payload context did not survive the whole path

That is exactly the kind of bug split event topologies produce.

### 6.1. The web client actually has multiple competing truth models

After reading the concrete web hooks, the problem is even sharper than "stale UI sometimes happens".

There are at least four different truth surfaces in the web app:

- the durable `team_tasks` row in the backend
- the derived `team_task_events` audit stream
- websocket payloads captured in the global event store
- per-screen local React state that patches or refetches selectively

Those surfaces are not reconstructed the same way.

#### Board hook

`ui/web/src/pages/teams/board/use-board-tasks.ts`:

- subscribes to `created`, `claimed`, `completed`, `cancelled`, `reviewed`, `approved`, `rejected`, `assigned`, `dispatched`, `commented`, `progress`, `deleted`
- **does not subscribe to `TEAM_TASK_FAILED`**
- also does not have any dedicated `stale` or `blocked` refresh path
- patches `progress` locally without refetch
- refetches a single task on other events with a per-task debounce

This already explains why board truth can drift from backend truth even when the backend lifecycle is correct.

There is a second subtle mismatch:

- the board filter vocabulary is only `"all" | "pending" | "in_progress" | "completed"`
- backend task rows support `pending / in_progress / completed / blocked / failed / in_review / cancelled`

So the backend model is richer than the main board filter model.

Issue `#555` is important here.
The maintainer comment says commit `5ed86b84` fixed one concrete post-turn completion bug.
That may well be true.
But the current board hook still shows that the architectural weakness is broader than that one fix:

- terminal states are not subscribed symmetrically
- some state changes patch locally, others refetch one row, others are ignored

#### Chat task panel

`ui/web/src/pages/chat/hooks/use-chat-team-tasks.ts` uses a different model:

- it **does** subscribe to `TEAM_TASK_FAILED`
- it **does** subscribe to `TEAM_TASK_ATTACHMENT_ADDED`
- it mutates a local in-memory `teamTasks` list directly
- it increments `commentCount` and `attachmentCount` optimistically
- it also injects inline notification messages into chat

So the chat surface and the board surface do not consume the same event set and do not rebuild state the same way.

#### Task detail dialog

`ui/web/src/pages/teams/task-sections/task-detail-dialog.tsx` is different again:

- it loads full detail once with `getTaskDetail(...)`
- it only subscribes to `TEAM_TASK_COMMENTED`
- on comment it reloads detail
- it does **not** subscribe to `failed`, `approved`, `rejected`, `reviewed`, `attachment_added`, or generic lifecycle changes

So task detail can easily become stale even while the board or chat panel moves on.

#### Global event capture is also incomplete

This is the nastiest part.

`ui/web/src/components/providers/ws-provider.tsx` captures all team-related websocket events into a global Zustand store through `TEAM_RELATED_EVENTS`.

But `ui/web/src/api/protocol.ts` currently defines `TEAM_RELATED_EVENTS` without `TEAM_TASK_FAILED`, even though:

- `Events.TEAM_TASK_FAILED` exists
- chat hooks subscribe to it directly

That means even the global debug/event capture layer is missing at least one real task lifecycle event.

This is a strong competitor lesson:

- the problem is not just "a board forgot one subscription"
- the web client contains several partially overlapping event vocabularies
- some screens refetch rows
- some screens patch local state
- some screens rely on a global event capture set that is itself incomplete

That is exactly how a system ends up with "backend truth is correct, but each UI surface is wrong in a slightly different way".

### 6.2. There is also a fourth frontend truth model: debug-event capture

`ui/web/src/stores/use-team-event-store.ts` adds yet another projection layer:

- it stores recent WS events in Zustand
- it persists the last `20` events to localStorage
- it extracts `teamId`, `userId`, and `chatId` heuristically from payload shape
- it is used mainly for the live Events page / debug surfaces

This matters because it creates yet another client-visible "truth":

- not the task row
- not the audit table
- not the board state
- but the recent captured websocket event stream

And that stream is itself shaped by `TEAM_RELATED_EVENTS`, which is already incomplete.

So even the debug surface that operators might use to reason about realtime correctness is not guaranteed to show the full lifecycle picture.

That is a very sharp competitor lesson:

- once you have multiple partial truth models, even your debugging UI can mislead you

### 6.3. Query invalidation is not the unifying fallback for team state

I checked the app-level query invalidation layer in `ui/web/src/hooks/use-query-invalidation.ts`.

It invalidates queries for:

- agent run lifecycle
- traces
- sessions
- usage
- cron
- health
- skills

But it does **not** centrally invalidate team task queries on `team.task.*` events.

That means the team UI is not unified through React Query refreshes either.

Instead, team state is rebuilt through a mix of:

- local hook patching
- targeted fetch-one calls
- one-off full detail reloads
- separate event-capture store

So the frontend does not have one recovery path such as:

- "if in doubt, invalidate team queries and converge"

It has several screen-specific repair strategies.

That is exactly the sort of architecture that produces "works on one screen, stale on another".

### 6.4. The WS edge is comparatively disciplined - the middle is where truth decays

This pass strengthened an earlier intuition.

`internal/gateway/event_filter.go` is actually relatively disciplined:

- tenant filtering is fail-closed
- team events are filtered by `hasTeamAccess(teamID)`
- unknown events are denied to non-admins by default

So the main realtime weakness is not the WS boundary itself.

The weakness is the middle path between durable state and UI projection:

- event payload assembly
- metadata preservation
- partial subscriber-derived audit writes
- selective frontend subscriptions
- local state patching vs fetch-one vs full reload

That is why issue `#877` is so important.

It is not "a Telegram topic bug".
It is a proof that:

- backend state can be correct
- event delivery can still happen
- but missing one piece of preserved context (`local_key`) is enough to break the user-visible truth

### 6.5. Audit trail is not the authoritative replay source

The backend also reinforces this split-truth pattern.

`cmd/gateway_events.go` writes `team_task_events` through a bus subscriber:

- lifecycle changes happen first
- bus event is broadcast
- subscriber later records audit row with `RecordTaskEvent(...)`

And `internal/store/pg/teams_tasks_activity.go` confirms that:

- comments and attachments have separate tables
- denormalized counts are maintained best-effort
- audit rows are listed separately from task rows

So even on the backend side, the system does not have a single append-only source that the UI could replay to rebuild task truth.

Instead it has:

- current row truth in `team_tasks`
- separate comments
- separate attachments
- subscriber-written audit events
- websocket payloads

That is workable, but it explains why frontend convergence is harder than it first appears.

### 6.6. Payload shape drift makes projection code more heuristic than it should be

The client code also shows payload-shape normalization pressure:

- some payloads expose `team_id`
- some expose `teamId`
- the event store has helper functions just to guess those fields

This is not catastrophic by itself.
But it is another sign that projections are reconstructing meaning from semi-structured event payloads rather than consuming one hard typed contract.

The more that happens:

- the more event consumers become heuristic
- the easier it becomes for one screen to lag behind another after a payload change

### 6.7. The strongest precise conclusion from this layer

After this pass, the most accurate statement is:

- GoClaw has one strong backend task truth
- but several weaker frontend truth models layered on top of it

Those models are:

- board projection
- chat task projection
- task detail reload model
- global event-capture store
- optional query invalidation for non-team surfaces

They do not consume the same event vocabulary.
They do not rebuild state the same way.
And they do not share one convergence path.

That is why I now see the UI/realtime problem not as "some stale subscriptions".
It is a deeper architectural property:

- **transactional backend truth**
- **non-unified frontend truth reconstruction**

### 7. Event topology is stronger at the boundaries than in the middle

This is a subtler version of the previous point.

The WS boundary itself is careful.
The middle of the system is where complexity grows.

Observed topology:

- domain pipeline publishes typed events on `DomainEventBus`
- gateway/dashboard logic broadcasts `bus.Event` on `msgBus`
- tracing has its own status broadcast path
- the UI often rebuilds local truth from those broadcasts using refetches

So the problem is not "no event architecture".
The problem is "multiple event architectures plus adapters plus metadata preservation responsibilities".

That is exactly where bugs like `#877` and stale-board symptoms like `#555` come from.

### 8. Workspace architecture is good in concept, weaker in hard reality

Conceptually, the workspace layer is pretty good:

- `internal/workspace/workspace_context.go`
- `internal/workspace/resolver_impl.go`

There is a real `WorkspaceContext`:

- active path
- scope
- read-only paths
- team path
- delegation path

That part is good.

But edge-case implementation is weaker:

- path behavior diverged by tenant
- master tenant had fallback bug `#431`
- Windows cross-drive isolation failed in `#836`
- extra allowed paths had to be added later as a patch

Even worse, `internal/tools/workspace_interceptor.go` explicitly fail-opens on team or role resolution failure.

So the model is good.
The enforcement posture is not consistently strong.

### 8.5. Security/auth hardening is uneven, and the narrative can drift from the code

This deserves its own section because it is one of the best competitor lessons.

The pattern I now see is:

- a real security issue is reported
- the team patches the narrow seam
- but the broader permissive default model often remains

Best example: CORS / origin checks.

Issue `#306` was closed with a summary saying the high CORS finding was fixed, and issue `#543` added `GOCLAW_ALLOWED_ORIGINS`.
But the current code in `internal/gateway/server.go` still says:

- if `allowed_origins` is empty -> allow all origins
- tests still explicitly assert this behavior

So the real state is not "fixed and strict now".
The real state is:

- configuration path improved
- warning message improved
- open-by-default model remains

This is very important architecturally.
It means you cannot rely only on issue closure status or changelog wording when evaluating risk.
You have to read the current default behavior.

There is a second example in WS auth:

- issue narratives criticize unauthenticated or degraded viewer access
- current gateway connect path still contains `Fallback -> viewer`

So the broader lesson is:

- `goclaw` often hardens specific incidents
- but it has not fully removed the permissive-default instincts that produced those incidents

### 9. Review and team semantics are richer in the store than in the runtime contract

This is subtle but important.

The task lifecycle model includes:

- `in_review`
- approve / reject
- reviewer role

But the runtime still contains visible gaps:

- `internal/tools/team_tasks_lifecycle.go` repeatedly notes that reviewer role is "not yet active" for cancel / approve / reject paths
- `docs/11-agent-teams.md` explicitly says delegate-agent restrictions were commented out and are not enforced at runtime

So the database model and UI story are ahead of some runtime constraints.

That is a classic maturity mismatch:

- the model is richer than the enforcement
- the product vocabulary is ahead of the actual runtime contract

The same theme appears in subagents.
Issue `#600` implementation summary explicitly deferred per-subagent workspace isolation as "YAGNI".

That is a reasonable product tradeoff, but it means the subagent system is operationally useful before it is fully isolated as a runtime model.

### 10. Prompt/runtime coupling is deeper than it first appears

This was much clearer after reading the resolver and prompt-builder path more closely.

Important files:

- `internal/agent/resolver.go`
- `internal/agent/resolver_helpers.go`
- `internal/agent/loop_tool_filter.go`
- `internal/agent/loop_history.go`
- `internal/agent/systemprompt.go`
- `internal/agent/systemprompt_sections.go`

What is happening:

- orchestration mode changes visible tool set
- orchestration mode also changes prompt sections
- bootstrap/team/availability files are injected or filtered depending on session shape
- team workflow behavior is taught through generated `TEAM.md`
- mode-specific allowlists decide which context files even exist for the turn

This is smart and well-tested.
But it also means part of orchestration correctness is prompt-mediated.

Examples:

- `spawn` vs `team` is not only a runtime capability difference, it is also a different prompt contract
- member vs lead workflow is partly carried by injected `TEAM.md`
- "do not use spawn for delegation" is enforced partly by runtime tool visibility and partly by prompt guidance

So the risk is not "prompts are sloppy".
The risk is:

- some correctness lives in durable state machine logic
- some correctness lives in prompt shaping
- some correctness lives in policy filtering

That is powerful, but it creates hidden distributed semantics.

### 11. Process lifecycle is better than average, but not a true supervision model

`internal/tools/shell.go` is not sloppy code.

Good parts:

- process-group kill on cancellation
- explicit tests in `internal/tools/shell_abort_test.go`
- better than the usual naive `exec.CommandContext` usage

But open issue `#789` is still legitimate.

Why:

- active foreground process groups are killed correctly
- detached background daemons launched with shell tricks like `&` can still outlive the logical run once the parent shell exits successfully

That means `exec` is a command runner with cancellation semantics, not a durable process supervisor.

For orchestration, that distinction matters.

### 12. Subagents are feature-rich, but not as architecturally durable as team tasks

This is one of the biggest "deeper than README" findings.

At first glance, subagents look quite strong:

- depth limits
- concurrency caps
- per-parent child limits
- announce-back
- steer / cancel / wait
- DB persistence
- token accounting

But after reading the code closely, the real shape is:

- active source of truth is still in-memory `SubagentManager.tasks`
- database writes are explicitly fire-and-forget
- the store is mainly used for audit, listing, and cost attribution
- I did not find a runtime path that reconstructs active subagents from `subagent_tasks` after restart
- migration `000034_subagent_tasks.up.sql` mentions restart recovery, but the runtime implementation does not appear to actually do that yet

So the subagent layer is useful and thoughtfully built, but it is not durable in the same way the team-task engine is durable.

Even more telling:

- I found `9` team-task related test files
- I found `0` direct `subagent` runtime test files

That difference is not cosmetic.
It tells you where the platform is truly hardened and where it is still more optimistic.

Issue `#495` reinforces this:

- users already notice the subagent model lacks strong spawn-access control semantics

So the honest read is:

- team tasks are an industrial subsystem
- subagents are a strong subsystem, but one level less mature

### 13. Queue architecture still shows starvation risk under team side-effects

Issue `#266` is worth calling out separately because it is more revealing than a generic "queue bug".

What it shows:

- while team-member work was in progress, the lead's group session became unresponsive
- later diagnosis in the issue comments points to queue architecture limitations and dropped messages
- `TryPublishInbound()` can silently drop when buffers fill
- team-generated side effects and user messages were not isolated strongly enough

This is important because it means:

- the scheduler subsystem is strong in abstraction
- but queue capacity and side-channel load interactions still create starvation conditions in some real flows

So the lesson is not "their scheduler is weak".
The lesson is:

- even a good scheduler can still fail if orchestration side traffic shares too much of the same operational lane budget

### 13.5. Several sensitive gateway methods still depend too much on global static method classification

This is one of the strongest new findings from the deeper pass.

The WS gateway role model is centrally decided by:

- `permissions.MethodRole()`
- `permissions.MethodScopes()`

Those functions use:

- explicit admin list
- explicit write-prefix list
- and then default everything else to `viewer`

This becomes dangerous when new sensitive methods are added but not classified.

Concrete example from current code:

- `heartbeat.set`
- `heartbeat.toggle`
- `heartbeat.test`
- `heartbeat.checklist.set`
- `logs.tail`
- `channels.instances.list`

These methods are registered and implemented, but they are not explicitly classified in `permissions/policy.go`.
The heartbeat handlers themselves also do not add a separate role check.

So under the current model, they inherit the default `viewer` posture.

That is exactly the kind of architecture that produces "one forgotten method becomes a security hole".

Even worse, `channels.instances.list` returns masked credentials but still exposes:

- raw instance `id`
- raw `agent_id`
- `created_by`
- timestamps

So even when secrets are hidden, enumeration surface is still quite broad.

This is a very strong competitor lesson:

- do not make sensitive RPC authorization depend on a central static allowlist with a permissive default
- either classify every method explicitly or attach auth policy at registration time

### 14. Provider stream adapters expose broad-surface fragility

This is not the core orchestration engine, but it is a real architectural signal.

Issues `#884` and `#888` are a good pair:

- `claude-cli` stream errors were discarded because error fields were not mapped through the provider event type
- Codex `response.failed` inside SSE was swallowed as if it were a successful completion

These bugs show the cost of a very broad provider surface:

- subtle wire-format differences leak into runtime correctness
- failure semantics are not normalized strongly enough at the adapter boundary
- user-facing behavior becomes "something went wrong" or `...` instead of a typed failure

This is not where I would judge their orchestrator core.
But it is very relevant as a competitor lesson:

- product breadth multiplies adapter seams
- adapter seams often become silent failure translators

The deeper problem is sharper than that summary suggests.

### 14.1. Failover only works on actual errors, not on silent stream failure states

`internal/providers/error_classify.go` and `internal/providers/failover.go` are built around a simple assumption:

- providers return a real `error`
- that error can be classified as HTTP, timeout, auth, rate limit, overloaded, billing, etc.
- cooldown and failover react to that typed failure

That model is reasonable.
But it depends on adapters surfacing failures honestly.

When a provider turns a failure into a "successful empty response", the whole protective layer is bypassed:

- no retry
- no failover
- no cooldown update
- no accurate user-facing message

This is exactly what `#888` is about.

This assumption also shows up in other routing surfaces.

For example:

- `internal/providers/chatgpt_oauth_router.go` retries only when `callErr != nil`
- a response object with `FinishReason = "error"` but `nil` Go error still counts as success
- cooldown tracking in `RunWithFailover(...)` only records failure when an actual error reaches that layer

So the failure channel is not "bad outcome".
It is specifically "returned Go error".

That is an important architectural property, because it means provider truthfulness is part of the control plane contract, not just the adapter contract.

### 14.2. Codex currently has a concrete success-on-failure seam

In `internal/providers/codex.go`, `processSSEEvent(...)` handles:

- `response.completed`
- `response.incomplete`
- `response.failed`

in the same success-oriented branch.

That means:

- the parser records usage
- may flush accumulated content
- may leave `result.Content` empty
- but returns no error at all

This is not just a UI bug.
It is a contract bug at the provider boundary.

The problem is reinforced in `internal/providers/adapter_codex.go`:

- `FromStreamChunk()` maps `response.failed` to `StreamChunk{Done: true}`
- there is no error surface at the adapter layer

And the test currently locks in that weak behavior:

- `internal/providers/adapter_codex_test.go` has exactly one `response.failed` test
- it expects `Done`, not an error

So the repo does not merely miss the stronger semantics.
It currently tests the weaker semantics as correct.

Issue `#888` describes the downstream symptom exactly:

- Codex backend fails inside an HTTP 200 SSE stream
- GoClaw treats it as ordinary completion
- no retry logic activates
- final output can degrade into empty content or `...`
- tokens are still billed

That is not a UI polish issue.
It is a broken run-truth contract between provider adapter and orchestration runtime.

### 14.3. Claude CLI stream-json error semantics are also lossy

The Claude CLI path is a different transport, but the same architectural weakness appears.

In `internal/providers/claude_cli_types.go`:

- `cliStreamEvent` maps `type`, `subtype`, `result`, `usage`
- but not `is_error`
- and not `error`

So if Claude CLI emits a stream-json error result with the useful human-readable message in `error`, the type layer drops it immediately.

Then in `internal/providers/claude_cli_chat.go`:

- `subtype == "error"` only flips `FinishReason = "error"`
- the actual message is still lost
- if the process exits non-zero and `stderr` is empty, the caller gets a generic shell-style error
- if partial content exists, the provider may even return a response with `nil` error

That is exactly the kind of adapter seam that produces a technically "successful" run with semantically failed intent.

I also checked the test surface here:

- `response.failed` test refs under `internal/providers/*test.go`: `1`
- Claude CLI stream-error test refs for `subtype error` / `is_error` / error-field handling: `0`

So this seam is not strongly defended by tests.

There is also a second weakness here.

The sync path in `ClaudeCLIProvider.Chat(...)` simply runs the CLI and returns `parseJSONResponse(output)`.
But `parseJSONResponse(...)`, `parseJSONArray(...)`, and `parseSingleJSONResult(...)` only convert `subtype == "error"` into:

- `FinishReason = "error"`

They do **not** convert it into a returned Go error.

So the non-streaming Claude CLI path is also vulnerable to the same category of semantic flattening:

- provider run is semantically failed
- adapter returns a response object instead of an error
- pipeline sees "successful call with weird finish reason"

Issue `#884` is the concrete expression of that class:

- Claude CLI emits a real error event with `is_error: true` and a useful `error` message
- GoClaw drops those fields at the type boundary
- the runtime later surfaces a generic useless failure or a success-like empty response path

### 14.4. The pipeline turns some silent failures into apparently valid output

The downstream consequences are even more important than the adapter bug itself.

`internal/pipeline/finalize_stage.go` contains an explicit empty-content fallback:

- if final content is empty and reply is not silent
- set final content to `"..."`

That is product-pragmatic for normal empty replies.
But combined with silent provider failure, it becomes dangerous:

- provider fails internally
- adapter returns no error
- pipeline sees empty success
- finalizer materializes `"..."`

That means a broken provider path can masquerade as a valid short answer.

The more subtle problem is that the main agent pipeline does not appear to treat `FinishReason = "error"` as authoritative failure.

In the hot path:

- `internal/agent/loop_pipeline_callbacks.go` forwards provider responses as `(resp, err)`
- `internal/pipeline/think_stage.go` only branches on:
  - `err != nil`
  - truncation-like states such as `"length"`
  - malformed tool-call cases

I did **not** find a pipeline branch that says:

- if `resp.FinishReason == "error"`, convert to run failure

So `FinishReason = "error"` is effectively decorative unless the provider also returned a real Go error.

That is the key architecture smell here:

- failure semantics are partly carried in `error`
- partly carried in response metadata
- but only one of those channels actually controls retry/failover/task-fail behavior

### 14.5. This leaks directly into orchestration semantics

This is why I care about this seam in an orchestration analysis at all.

`cmd/gateway_consumer_post_turn.go::resolveTeamTaskOutcome(...)` uses a simple post-turn rule:

- if `outcome.Err != nil` -> fail task
- if task tool flags indicate explicit terminal action -> respect it
- if loop detector killed -> fail task
- otherwise -> auto-complete task

And if there is no result content:

- it falls back to `"Agent run ended without explicit result"`

So a provider-level silent failure can become:

- not a failed run
- not a retried run
- not a failover case
- but a completed team task with a useless placeholder result

That is a serious competitor lesson.

The orchestration core is strong, but its correctness still depends on provider adapters preserving truthful run outcomes.
Where those adapters lie or flatten failures, the task engine inherits fake success.

The full bad chain now looks like this:

1. provider/backend fails
2. adapter returns response-like success or only `FinishReason = "error"`
3. `RunWithFailover(...)` and router-level retry never see a real error
4. `ThinkStage` accepts the call as successful
5. `FinalizeStage` may materialize `"..."`
6. post-turn logic may auto-complete the team task with placeholder content

That is no longer "adapter fragility".
That is orchestration truth corruption.

### 14.6. The deepest lesson here

The mistake is not "they support too many providers".

The real mistake is subtler:

- transport adapters are allowed to degrade failure into content state
- and the rest of the runtime is built on the assumption that `error` is the authoritative failure channel

That mismatch creates a bad architectural property:

- the more streaming transports and special backends you support
- the more likely it is that one adapter silently bypasses retry, failover, cooldown, and correct task failure semantics

So the correct competitor takeaway is:

- the failover subsystem idea is good
- the cooldown subsystem idea is good
- but they are only as reliable as the weakest provider adapter's truthfulness

### 14.7. Anthropic shows what the strong version looks like

The contrast with Anthropic is useful because it proves this is not an unavoidable system-wide tradeoff.

In `internal/providers/anthropic_stream.go`:

- SSE `error` events return a real Go error immediately
- stream read failures return a real Go error
- the provider does not try to downgrade stream failure into a response object

That is the healthy architectural pattern:

- adapters normalize provider-specific wire failure into one authoritative runtime failure channel
- the rest of the orchestration stack can stay simple and truthful

So the problem in GoClaw is not "streaming providers are hard".
The problem is inconsistency:

- some adapters preserve failure truth
- some adapters flatten it
- the pipeline assumes everyone preserves it

That inconsistency is exactly the kind of thing that creates silent, intermittent, expensive orchestration bugs.

### 15. Channel layer looks operationally expensive

`internal/channels` is huge:

- `198` files
- about `45k` lines

This is where a lot of practical pain likely lives.

Why:

- per-channel placeholder logic
- per-channel streaming behavior
- per-channel dedup
- routing metadata preservation
- per-platform quirks around threading, replies, mentions, media

This kind of layer easily produces bugs like:

- duplicate responses
- placeholder drift
- wrong thread routing
- broken mention gating
- noisy reconnect behavior

Issue `#261` about duplicate messages is exactly the kind of symptom such a layer produces.

### 16. Product surface drift is real

Two issues expose this clearly:

- `#498` custom tools API documented, but never actually implemented
- `#645` community confusion about long-term direction and removed orchestration tools

This means:

- product docs moved out of sync with actual backend
- mental model changed faster than public documentation
- users felt orchestration semantics shifting under them

That is not just documentation debt.
It often means architectural direction is still moving.

Git history supports that reading.

Very rough commit grep counts from repo history:

- `team`: `184`
- `task`: `138`
- `workspace`: `90`
- `delegat`: `82`
- `identity`: `54`
- `pipeline`: `51`
- `policy`: `51`
- `schedul`: `44`
- `subagent`: `43`

This is not just additive feature growth.
It shows repeated redesign pressure in exactly the hardest orchestration seams.

## What issues reveal about the real weak seams

### Issue cluster summary

From the sampled issue set, recurring pain concentrated in:

- UI / realtime
- providers / models
- storage / tenant / workspace
- Docker / install / runtime packages
- hooks / skills
- policy / permissions
- actor / sender / scope identity

From the 200-issue scrape, keyword-heavy clusters also showed up in:

- `channel`: `12`
- `team`: `10`
- `tenant`: `9`
- `auth`: `8`
- `task`: `8`
- `event`: `6`
- `heartbeat`: `4`
- `workspace`: `3`
- `trace`: `3`

That does not mean those categories are equally severe.
But it does reinforce the same picture:

- real pain is concentrated at cross-system boundaries
- especially where channel/session/scope/tenant/runtime semantics intersect

This is important.

It suggests:

- the core team-task engine is not the main pain generator
- the pain mostly happens at subsystem boundaries
- security fixes and security defaults do not always point in the same direction

### Issue to root-cause map

| Issue | Surface symptom | What it really reveals |
|---|---|---|
| `#437` tenant_id is required | Cannot create first agent | Tenant context injection is easy to miss. Context-driven scoping is brittle |
| `#431` ignores `GOCLAW_WORKSPACE` and escapes to `/system` | Wrong workspace root | Workspace resolution had split responsibility and incomplete fallback |
| `#543` allowed_origins config bug | Warning and config drift around WS origin allowlist | Security hardening happened as config plumbing, but open-by-default origin model remained |
| `#555` board not updated | UI shows wrong task state | Realtime/event sync weaker than task store truth |
| `#616` tool not allowed by policy | User cannot use `team_tasks` | Policy stack is too opaque to debug locally |
| `#675` chat.* lacked ownership checks | Users could touch other sessions | Good example of seam-specific hardening done the right way with shared access helper |
| `#320` built-in skills seeding and runtime failures | Skills do not work cleanly in Docker | Image layout, runtime install, permissions, and skill execution are tightly coupled |
| `#836` Windows multi-drive workspace failure | Multi-agent coordination unusable on Windows | Workspace model made Unix-ish path assumptions and weak edge handling |
| `#870` heartbeat channel isolation request | Global heartbeat file across channels | Wrong scope boundary chosen for the feature |
| `#498` custom tools API missing | Docs mention feature that does not exist | Docs and backend drift, feature model churn |
| `#645` direction confusion | Users unsure what GoClaw is becoming | Product surface expanded faster than mental model stability |
| `#261` duplicate responses | Duplicate output after upgrade | Channel/realtime/placeholder flows are delicate and easy to regress |
| `#266` lead session becomes unresponsive while team task runs | Group session starves while members work | Session scheduler and team side-effects were not fully isolated |
| `#504` task stays in progress if member exits without terminal action | Pipeline hangs on blocked dependents | Agent runtime and durable task lifecycle needed a compensating post-turn rule |
| `#565` enterprise identity proposal | Verified human identity still fragmented | Tenant isolation matured faster than actor identity and org semantics |
| `#789` Stop Run leaves server process alive | Background port/process survives abort | Exec has kill semantics, not full process supervision |
| `#877` task completion event loses `local_key` | Completion routed to wrong forum topic | Event payload context is not preserved robustly across task-runtime -> broadcast path |
| `#838` final answer suppressed on non-streaming channels | Silent bot on simple responses | New pipeline and old delivery assumptions drifted out of sync |
| `#884` claude-cli stream errors discarded | Generic useless error reaches user | Provider adapter boundary loses typed failure semantics |
| `#888` Codex `response.failed` swallowed | Empty `...` answer with billed tokens | SSE provider adapter treats failure as success |
| `#306` security audit closed as resolved | Several hardening items landed, but some permissive defaults still remain | Security issue status can overstate model-level hardening |
| `#866` unauthenticated log subscription and heartbeat injection | Critical auth + default-permit chain | Boundary layers inherited permissive fallback assumptions that become dangerous at scale |
| `#495` subagent spawn permission control | No strong restriction on who can spawn what | Subagent model is rich, but its security policy model is still underdeveloped |
| `#915` group write_file checks use group principal instead of sender | File writer auth fails in groups | Actor identity and scope identity were not separated strongly enough |
| `#506` team got stuck after loop-detector stop | Team dashboard and lifecycle out of sync with runtime kill | Not all agent-stop paths were originally reconciled into task state cleanly |

## The biggest architecture mistakes in `goclaw`

### Mistake 1. Too much implicit state

A lot of behavior depends on:

- context keys
- metadata maps
- tenant scoping injected upstream
- routing fields preserved through multiple layers

This gives flexibility, but it weakens local reasoning.

### Mistake 2. Cleaning the architecture in one layer while legacy semantics still live underneath

This is the deeper lesson behind the v3 pipeline story.

`goclaw` often improves architecture by adding a cleaner subsystem boundary, but some old assumptions still survive behind adapters, compatibility flags, or callback bridges.

That is better than staying monolithic.
But it creates a dangerous half-state:

- public story says "new model"
- internal reality is "new surface, partly old semantics"

This increases drift risk between docs, tests, and runtime behavior.

### Mistake 2.5. Letting prompt shaping carry part of the runtime contract

This is a nuanced mistake because it also comes from a good engineering instinct.

`goclaw` tests prompt construction seriously, which is better than most repos.
But the system still lets several orchestration semantics depend on:

- which files are injected this turn
- which tools are hidden this turn
- which orchestration section is rendered this turn

That means part of runtime correctness is not purely local to the task engine or scheduler.
It is distributed across prompt builder, resolver, and tool filtering.

### Mistake 3. Broad product surface too early

`goclaw` is trying to be many things at once:

- orchestrator
- multi-tenant gateway
- channel hub
- skills runtime
- dashboard
- desktop distribution
- package/runtime manager
- traces/observability surface

This creates lots of value, but also lots of seams.

### Mistake 4. Availability-first fail-open in places that should be stricter

This shows up in permissions and workspace-related code.
It is understandable operationally, but dangerous structurally.

### Mistake 4.5. Closing security bugs without fully removing the permissive underlying model

This is one of the most important meta-lessons from `goclaw`.

They do ship concrete fixes.
But some fixes are:

- configuration hardening
- route-level exceptions
- seam patches

while the broad defaults remain:

- unknown RPC -> viewer
- wrong WS auth -> fallback viewer
- empty allowed origins -> allow all

That means the system can still generate new issues from the same architectural root even after old issues are closed.

### Mistake 5. Durable core and realtime/UI model are not equally mature

The task store is strong.
The event and board synchronization model is weaker.

There is a deeper refinement after reading more code:

- the WS delivery boundary itself is reasonably disciplined
- the weak part is the event topology in the middle and the client-side reconstruction strategy

That mismatch produces "state is correct in backend, wrong in UI" bugs.

### Mistake 6. Not all “persisted” subsystems are equally durable in runtime terms

This is a subtle but very important competitor lesson.

`goclaw` persists both team tasks and subagent tasks.
But those two subsystems do not have the same operational durability.

Team tasks:

- real transactional lifecycle
- restart-safe enough to be a durable orchestrator core

Subagent tasks:

- persisted for audit and visibility
- active control state still lives in memory

That is a perfectly valid engineering tradeoff.
But it becomes dangerous when the product language makes both layers sound equally durable.

### Mistake 7. Domain boundaries leak through global context instead of typed local contracts

The repo already contains a corrective move in `internal/store/run_context.go`.
That is good.
But it also confirms how much implicit propagation already exists.

### Mistake 8. Human identity, scope identity, and channel identity were not unified early enough

This is one of the most important competitor lessons.

`goclaw` solved tenant isolation earlier than it solved actor identity.

That led to a long tail of fixes around:

- sender preservation
- synthetic senders
- actor vs scope
- agent UUID vs agent key
- group shared scope vs individual ownership

The maintainers are clearly hardening this now, but the repo history shows it was not designed cleanly enough from day one.

## The best architectural decisions in `goclaw`

If I had to extract the strongest ideas only, they would be:

1. Durable team task lifecycle as a first-class subsystem
2. Recovery ticker that maintains the board even when humans are absent
3. Scheduler with explicit queue modes and cancellation semantics
4. Staged agent pipeline instead of a giant run function
5. Explicit orchestration modes: spawn / delegate / team
6. Prompt construction treated as testable runtime behavior, not random prose
7. WS event filtering that is stricter than the average dashboard backend
8. Core bug fixes often accompanied by tests and concrete commits
9. Typed task engine richer than most competitors, even if some runtime restrictions still lag the model
10. Post-turn compensating logic that reconciles unreliable agent behavior back into durable task state
11. Security seams sometimes get fixed with reusable helpers, which is the right instinct when they actually do it

## What I would not copy from `goclaw`

⚠️ These are the most important "do not step on this rake" lessons:

- do not let tenant, workspace, agent, and routing identity leak everywhere through raw context values
- do not let "forced new architecture" still depend on hidden legacy bridges without making that transitional state explicit
- do not let prompt shaping become the only thing holding orchestration rules together
- do not make policy depend on 5 to 7 layers without a single explainable decision trace
- do not let unknown RPC methods inherit a permissive role by default
- do not allow degraded viewer sessions after failed auth if your viewer role can still reach meaningful runtime surfaces
- do not split domain events, UI events, and trace-status delivery into multiple topologies without one clear source-of-truth contract
- do not let UI state depend on ad-hoc event patching when the backend already has durable truth
- do not use fail-open defaults in workspace and permission-sensitive paths unless the risk is intentionally accepted
- do not confuse audit persistence with active runtime durability
- do not let docs describe dead features
- do not solve tenant isolation first and postpone human identity semantics until later
- do not make the product surface so broad that channels, packaging, skills runtime, and orchestration all evolve in lockstep

## What is genuinely worth stealing from `goclaw`

These are the parts worth copying conceptually:

- task lifecycle richness
- stale recovery loop
- blocked dependency handling
- scheduler semantics
- pipeline decomposition
- post-turn repair logic when agent behavior is unreliable
- deliberate task schema with explicit orchestration fields and indexes
- orchestration as a dedicated subsystem, not a thin add-on to chat

## Final judgment

The honest judgment is not:

- "`goclaw` is badly built"

The honest judgment is:

- `goclaw` is well-built at its core
- but it is overextended at the seams

That distinction matters.

If you study it only at README level, you may think:

- "wow, they already solved everything"

If you study code and issues together, the more accurate picture is:

- they solved the hard center better than most competitors
- but they also accumulated a lot of product-boundary debt around that center

That is exactly why `goclaw` is a useful competitor to study.

It shows both:

- what a strong orchestration engine looks like
- and how quickly complexity spreads when too many adjacent concerns are absorbed into one product
