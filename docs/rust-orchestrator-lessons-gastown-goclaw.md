# Rust Orchestrator Architecture Notes from Gastown and GoClaw

Date: 2026-04-16

Compared revisions:
- Gastown: `bdbe8c4b0e45f318576c838355fcc85b15e74b8f` from 2026-04-15
- GoClaw: `2cbf838158034bbca06a8fe3ced8041467dffd80` from 2026-04-16

Method:
- cloned latest Gastown and inspected code, design docs, and open issues
- refreshed local GoClaw clone and re-checked scheduler, task lifecycle, tracing, and eventing
- prioritized architecture, failure modes, issue tracker pain, and lessons relevant to a new Rust orchestrator

## Executive Verdict

If the goal is to build a new Rust orchestrator that is stronger than both:

- take Gastown's ideas around explicit mailbox semantics, worktree-based worker isolation, rich recovery roles, and scheduler state separation
- take GoClaw's boring but correct durable task store, explicit task lifecycle, cleaner service boundaries, and less magical runtime model
- reject Gastown's tmux-as-control-plane and Beads-as-runtime-substrate
- reject GoClaw's tendency toward best-effort side channels where dropped events can desync UI or secondary systems

Short version:

| Dimension | Gastown | GoClaw | What to do in Rust |
|---|---:|---:|---|
| Orchestration ideas | 9.5 | 8.5 | Steal more from Gastown |
| Durability of engine | 6.0 | 9.0 | Steal more from GoClaw |
| Runtime transport design | 4.5 | 8.0 | Follow GoClaw-style explicit runtime boundaries |
| Worker isolation model | 9.0 | 7.0 | Steal from Gastown |
| Store / lifecycle correctness | 5.5 | 9.0 | Follow GoClaw |
| Recovery model | 8.0 | 8.5 | Combine both |
| Platform portability | 3.5 | 8.0 | Do much better than Gastown |
| Frontend contract potential | 8.5 | 8.0 | Build explicit projections for UI from day 1 |

## What Gastown Gets Very Right

### 1. Explicit multi-agent topology

Gastown has a real orchestration model, not just "spawn helpers":

- Mayor for global coordination
- Deacon for daemon / patrol / recovery
- Witness per rig for health and cleanup
- Refinery for merge queue
- Polecats as execution workers
- Crew as human-managed workspaces

This is strong because responsibilities are conceptually separated. You can reason about escalation, cleanup, merge, and dispatch as different concerns instead of burying them in one god-runtime.

Sources:
- `/tmp/gastown-latest/docs/design/architecture.md`
- `/tmp/gastown-latest/docs/design/mail-protocol.md`

### 2. Mailbox and handoff model

Gastown treats agent-to-agent communication as a first-class protocol with explicit message types like `POLECAT_DONE`, `MERGE_READY`, `MERGED`, `MERGE_FAILED`, `REWORK_REQUEST`, `RECOVERED_BEAD`, `RECOVERY_NEEDED`, `HELP`, `HANDOFF`.

That is better than implicit side effects because:

- the protocol is inspectable
- recovery paths are explicit
- multi-agent coordination stays legible
- frontend can render meaningful workflows from protocol events

Source:
- `/tmp/gastown-latest/docs/design/mail-protocol.md`

### 3. Separate transient scheduler state from durable work state

This is one of the best ideas in Gastown.

The scheduler stores transient dispatch state in a separate sling-context object instead of mutating the main work bead. That is exactly the right instinct. Work truth and scheduling truth should not be the same record.

Source:
- `/tmp/gastown-latest/internal/scheduler/capacity/pipeline.go`
- `/tmp/gastown-latest/internal/beads/beads_sling_context.go`
- `/tmp/gastown-latest/docs/design/scheduler.md`

### 4. Worktree-first worker isolation

Polecats and refinery use worktrees rather than full clones. That is a very good fit for coding agents:

- fast spawn
- shared object storage
- clean branch isolation
- less disk and clone churn

This is materially better than making every worker a full clone by default.

Source:
- `/tmp/gastown-latest/docs/design/architecture.md`

### 5. Recovery is treated as a core subsystem

Gastown does not pretend failures are rare. Witness and Deacon explicitly handle:

- zombie sessions
- recovered abandoned work
- redispatch
- cooldown
- escalation after repeated failure

Even if the substrate is shaky, the mindset is correct: recovery must be designed, not improvised.

Source:
- `/tmp/gastown-latest/internal/deacon/redispatch.go`
- `/tmp/gastown-latest/internal/witness/manager.go`
- `/tmp/gastown-latest/docs/design/mail-protocol.md`

### 6. Run-correlated observability

Gastown's telemetry direction is strong. The `run.id` concept and OTLP-style event modeling are exactly what an orchestrator needs. A run should correlate:

- session lifecycle
- prompt delivery
- tool usage
- mail
- costs
- errors
- stop reason

Source:
- `/tmp/gastown-latest/docs/otel-data-model.md`

## Where Gastown Is Architecturally Wrong

### 1. Beads is used as operational runtime substrate

This is the biggest mistake.

Beads is issue-tracker-like infrastructure, but Gastown relies on it for critical runtime truth:

- roles
- molecules
- convoys
- routing
- merge queue state
- some lifecycle and recovery state

That choice leaks everywhere. Once the substrate is not designed as a hard runtime database, compensating complexity grows fast.

Community pain is loud here:
- issue tracker state becomes critical runtime state
- routing failures create silent wrong-database behavior
- metadata and prefix drift create split-brain
- partial initialization is hard to repair

Sources:
- [Gastown issue #764](https://github.com/gastownhall/gastown/issues/764)
- [Gastown issue #2922](https://github.com/gastownhall/gastown/issues/2922)
- `/tmp/gastown-latest/docs/design/dolt-storage.md`

### 2. tmux is the control plane

This is the second major mistake.

Gastown currently depends on tmux for:

- session lifecycle
- prompt injection
- idle detection
- liveness
- nudge delivery
- pane scraping

That makes the system timing-sensitive, platform-coupled, and fundamentally less reliable than an explicit runtime protocol.

The issue tracker shows that this is not theoretical:
- stale pane IDs
- invalid pane targeting
- split-brain sockets
- sessions starting outside tmux
- headless mode pressure
- Windows essentially blocked

Sources:
- `/tmp/gastown-latest/internal/tmux/tmux.go`
- `/tmp/gastown-latest/docs/agent-provider-integration.md`
- `/tmp/gastown-latest/docs/design/agent-api-inventory.md`
- `/tmp/gastown-latest/docs/design/factory-worker-api.md`
- [Gastown issue #1216](https://github.com/gastownhall/gastown/issues/1216)
- [Gastown issue #3538](https://github.com/gastownhall/gastown/issues/3538)

### 3. Initialization and identity are too fragile

Rig creation and beads initialization have clearly accumulated repair logic:

- run `bd init`
- ensure metadata
- drop orphan DBs
- rewrite issue prefix
- append route
- later verify identity
- later repair if mismatch

Once setup flow contains "create", "rewrite", "repair", "verify", "cleanup orphan", that usually means the true invariant was never enforced at the correct layer.

Source:
- `/tmp/gastown-latest/internal/rig/manager.go`
- `/tmp/gastown-latest/internal/doltserver/doltserver.go`
- [Gastown issue #2405](https://github.com/gastownhall/gastown/issues/2405)
- [Gastown issue #2922](https://github.com/gastownhall/gastown/issues/2922)

### 4. Ambient directory structure leaks into agent reasoning

Nested repo confusion is not just UX noise. It is a sign that runtime identity and workspace boundaries are too implicit.

Agents should never have to infer which repo is the "real" one from current directory layout.

Source:
- [Gastown issue #716](https://github.com/gastownhall/gastown/issues/716)

### 5. Handoff continuity trusts model summarization too much

Auto-handoff producing empty or weak continuation context is exactly the kind of failure that breaks unattended orchestration.

LLM summaries are useful, but they must never be the only continuity mechanism.

Source:
- [Gastown issue #1996](https://github.com/gastownhall/gastown/issues/1996)

### 6. Crash visibility is incomplete

If a worker subprocess dies and the system emits no durable crash event, your orchestration engine is not trustworthy enough.

Source:
- [Gastown issue #2534](https://github.com/gastownhall/gastown/issues/2534)

## What GoClaw Gets Very Right

### 1. Durable task lifecycle in a real store

GoClaw's strongest engineering choice is that team tasks are durable, explicit, and store-backed. Status is not "kind of inferred from runtime". It is modeled.

Key statuses:
- `pending`
- `in_progress`
- `completed`
- `blocked`
- `failed`
- `in_review`
- `cancelled`
- `stale`

Source:
- `/tmp/goclaw/internal/store/team_store.go`
- `/tmp/goclaw/internal/tools/team_tasks_lifecycle.go`

### 2. Clear scheduler and queue semantics

GoClaw's per-session queues and lane manager are much more normal service architecture:

- queue / followup / interrupt
- drop-old / drop-new
- bounded queues
- debounce
- per-lane concurrency
- adaptive throttling near context pressure

This is far less magical than Gastown and much easier to reason about.

Source:
- `/tmp/goclaw/internal/scheduler/queue.go`
- `/tmp/goclaw/internal/scheduler/lanes.go`

### 3. Recovery as batched store operations

The task ticker is a good pattern:

- recover expired locks
- mark pending tasks stale
- mark in-review tasks stale
- fix orphaned blocked tasks
- schedule followups

This is less romantic than Witness/Deacon choreography, but operationally robust.

Source:
- `/tmp/goclaw/internal/tasks/task_ticker.go`

### 4. Better separation between engine layers

GoClaw is cleaner than Gastown at separating:

- scheduler
- task store
- tracing
- event bus
- tools
- channels
- UI

That matters if you want a Rust system that stays maintainable after 50k lines.

## Where GoClaw Is Architecturally Weak

### 1. Some important buses are still best-effort

GoClaw's event bus and some notification buffers can drop events under pressure:

- eventbus queue full -> drop
- tracing span buffer full -> drop
- task ticker inbound / outbound buffers full -> drop notifications

That is acceptable for soft secondary signals, but dangerous if any consumer starts treating them as truth.

Rust rule: event bus can be lossy only for non-authoritative projections. Never for task state, run state, or approvals.

Source:
- `/tmp/goclaw/internal/eventbus/bus_impl.go`
- `/tmp/goclaw/internal/tracing/collector.go`
- `/tmp/goclaw/internal/tasks/task_ticker.go`

### 2. Recovery gaps get postponed when telemetry model is incomplete

GoClaw explicitly disables stale trace recovery because the current model lacks `last_span_at` and would kill healthy long runs.

That is good engineering honesty, but it is still a design lesson:

- if you want safe recovery, model the right heartbeat fields early
- otherwise you will either false-kill or stop recovering at all

Source:
- `/tmp/goclaw/internal/tracing/collector.go`

### 3. Product breadth increases complexity pressure

GoClaw carries a very broad platform surface: multi-provider, multi-channel, tenancy, approvals, web UI, desktop, traces, KG, packages, etc.

This is not "wrong", but it means the core can be harder to evolve cleanly if the orchestrator is not protected from product sprawl.

### 4. UI / projection consistency is not always perfect

Open issues show user-facing stale state problems, for example board updates lagging behind task reality.

That is a reminder that the frontend should consume durable projections, not just opportunistic event pushes.

Sources:
- [GoClaw issue #555](https://github.com/nextlevelbuilder/goclaw/issues/555)
- [GoClaw issue #884](https://github.com/nextlevelbuilder/goclaw/issues/884)

## Architecture Rules for the New Rust Orchestrator

These are the rules I would treat as hard constraints, not preferences.

### Hard Rule 1 - No terminal input as a control plane

Never make agent messaging depend on sending text into the same input field used by a human operator.

Allowed:
- structured local RPC
- Unix socket / named pipe
- stdio JSON-RPC bridge
- explicit worker control protocol

Forbidden:
- `send-keys`
- pane scraping as source of truth
- prompt regex for idle detection

### Hard Rule 2 - No critical runtime truth in issue-like objects

Tasks, sessions, runs, worker leases, locks, review state, dependencies, and approvals must live in a durable orchestrator store.

Issue-like artifacts can exist for UX or collaboration, but they cannot be the only truth.

### Hard Rule 3 - Init must be atomic or resumable

No half-created rigs, half-written routes, or identity before backing infra exists.

Use explicit init phases:
- `creating`
- `infra_ready`
- `workspace_ready`
- `registered`
- `healthy`

Either commit all phases transactionally, or resume from a durable checkpoint.

### Hard Rule 4 - Scheduler state and task state are separate

Steal Gastown's idea, but implement it better.

Durable task:
- what work exists
- status
- dependencies
- owner
- review state

Transient scheduling state:
- queued
- dispatch attempt count
- selected worker
- retry backoff
- cooldown
- queue mode

### Hard Rule 5 - Worker transport is abstracted from day 1

Define a Rust trait like:

```rust
trait WorkerBackend {
    async fn spawn(&self, spec: WorkerSpawnSpec) -> Result<WorkerHandle>;
    async fn submit(&self, worker_id: WorkerId, prompt: PromptEnvelope) -> Result<SubmitAck>;
    async fn interrupt(&self, worker_id: WorkerId) -> Result<()>;
    async fn query(&self, worker_id: WorkerId) -> Result<WorkerState>;
    async fn shutdown(&self, worker_id: WorkerId) -> Result<()>;
}
```

Then implement:
- local PTY backend
- headless CLI/backend API backend
- remote runner backend later

Do not bake tmux, screen, or one vendor CLI into the engine.

### Hard Rule 6 - Every run and process emits durable lifecycle events

At minimum:
- `spawned`
- `ready`
- `busy`
- `idle`
- `heartbeat`
- `crashed`
- `stopped`
- `timed_out`
- `cancelled`

And those events must be durable enough that the frontend and recovery logic can trust them.

### Hard Rule 7 - Handoff must have deterministic fallback

Handoff should be:

1. deterministic snapshot from local truth
2. optional LLM summary layered on top

Deterministic payload should include:
- task id and dependencies
- git branch and base
- changed files
- recent commands / tool calls
- last successful checks
- pending blockers
- last worker state

LLM summary is additive, not foundational.

### Hard Rule 8 - The event bus is not the source of truth

Use event bus for:
- UI fanout
- notifications
- telemetry sinks
- side effects

Never use it as the only place where core state transitions happen.

### Hard Rule 9 - Distinguish authoritative store from UI projections

Frontend wants fast, denormalized data. Engine wants clean truth.

So build both:
- authoritative tables for tasks, runs, sessions, reviews, messages
- projection tables or cached views for board, inbox, live agent status, task logs

### Hard Rule 10 - Workspace identity must be explicit

Every action should know:
- workspace root
- canonical code root
- worker sandbox/worktree root
- task scope
- team scope

Never ask the model to guess from cwd layout.

## Proposed Rust Architecture

### Core modules

1. `orchestrator-core`
- task graph
- dependencies
- review state machine
- retry and stale policies
- durable invariants

2. `orchestrator-store`
- repository interfaces
- SQLite or Postgres implementation
- migrations
- append-only event log for audit

3. `orchestrator-scheduler`
- queue / followup / interrupt
- lane pools
- lease acquisition
- backoff and cooldown

4. `orchestrator-runtime`
- worker backends
- local PTY bridge
- process supervision
- heartbeats

5. `orchestrator-mail`
- inbox / outbox
- typed messages
- handoff packets
- escalation

6. `orchestrator-recovery`
- stuck run detection
- expired lease recovery
- orphan blocker cleanup
- recovery suggestions / auto-retry

7. `orchestrator-tracing`
- run lifecycle
- tool calls
- cost / token usage
- structured errors

8. `orchestrator-api`
- frontend projection endpoints
- websocket fanout
- stable contract for board, inbox, logs, runs, review

### Recommended persistence model

Best default for this project:

- local-first SQLite with WAL for single-user / small-team development
- repository interfaces clean enough to add Postgres later
- append-only event log plus normalized current-state tables

Reason:
- simpler than Postgres on day 1
- more durable and queryable than file JSON
- easier than Beads/Dolt routing
- still compatible with desktop-first UX

Do not start with:
- issue tracker as DB
- raw JSON files as authoritative runtime store
- event sourcing only, with no state tables

## Frontend Contract Guidance

Since the frontend contract will likely stay close to Claude Agent Teams / `claude_team`, expose first-class resources for:

- teams
- agents
- tasks
- task dependencies
- task comments
- task events
- task attachments
- task review state
- runs
- run logs
- worker sessions
- processes
- approvals
- handoffs

Important rule:

the frontend should never need to infer task status by scraping logs or reconstructing state from partial events.

It should be able to ask:

- what is the authoritative task state
- what run is working on it now
- what happened in order
- what can the operator do next

## The Best Hybrid to Build

If I had to summarize the target architecture in one sentence:

Build GoClaw's durable engine shape, inject Gastown's mailbox and worker-isolation ideas, and expose a Claude Agent Teams style cockpit contract on top.

That means:

- GoClaw for the engine spine
- Gastown for the orchestration imagination
- your own frontend for the operator experience

## Final Scores

### Gastown

- architecture imagination: 9.5/10
- orchestration substrate correctness: 5.5/10
- recovery mindset: 8.5/10
- portability and operational safety: 4.0/10

### GoClaw

- orchestration engine correctness: 9.0/10
- runtime transport design: 8.0/10
- event / projection safety: 7.0/10
- overall platform discipline: 8.5/10

### Recommended direction for the Rust orchestrator

- originality target: Gastown
- engine shape target: GoClaw
- operator UX target: Claude Agent Teams / `claude_team`

If you keep only three principles from this memo:

1. do not make terminal injection part of the engine contract
2. do not store core runtime truth in issue-like artifacts
3. separate durable work truth from transient scheduling truth
