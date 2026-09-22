# OpenHarness Control Plane And Soft Contracts

## Core warning

OpenHarness has a real runtime, but too much orchestration meaning still lives in soft carriers:

- env vars
- prompt framing
- file protocols
- in-memory managers
- restart conventions

That is the main reason it feels promising but not yet calm.

## 1. Coordinator mode is real, but the contract is still soft

`coordinator/coordinator_mode.py` gives them:

- explicit coordinator tools
- explicit worker tools
- explicit coordinator prompt
- explicit mode detection

But the mode is still driven by:

- `CLAUDE_CODE_COORDINATOR_MODE`
- prompt instructions
- worker convention

That is a real feature, but not yet a hard execution envelope.

## 2. Dual team truth is already present

The repo still contains:

- legacy in-memory `TeamRegistry`
- persistent `TeamLifecycleManager`

And the new lifecycle manager explicitly says it can work alongside the old registry.

This is exactly how migration drift begins:

- better model exists
- older model survives
- both remain behaviorally relevant

## 3. Permission sync already has two live protocols

`swarm/permission_sync.py` supports:

- directory-based pending/resolved files
- mailbox-based request/response

This is a powerful experimental stage, but a dangerous steady-state architecture.

One permission workflow should not permanently depend on multiple active transport contracts unless that is a deliberate and strongly bounded compatibility plan.

## 4. BackgroundTaskManager is useful, but not durable truth

`tasks/manager.py` is a useful local substrate:

- explicit task creation
- log files on disk
- task restart path
- write-to-stdin abstraction

But the authoritative state is still in-memory:

- `_tasks`
- `_processes`
- `_waiters`
- `_locks`
- `_generations`

This is fine for a local harness.
It is not enough for a durable orchestration engine.

## 5. File mailbox is both a strength and a trap

`swarm/mailbox.py` is easy to reason about:

- one JSON file per message
- atomic write
- lock on write
- explicit read and mark-read flow

But file mailbox also means:

- ordering becomes filesystem behavior
- cleanup becomes part of correctness
- scaling and retention become queue design problems
- cross-protocol compatibility becomes long-lived baggage if not closed early

## 6. One-shot worker restart semantics are practical, but soft

`run_task_worker()` processes one stdin payload and exits.

`BackgroundTaskManager` is then responsible for restarting later if the coordinator wants a follow-up.

This is practical for a local harness.
It also means message continuity partly depends on restart conventions, not only on one durable run contract.

## 7. Prompt assembly is part of the control plane

`prompts/context.py` does not merely decorate UX.
It participates in behavior by injecting:

- delegation guidance
- skills
- `CLAUDE.md`
- local rules
- issue/PR/repo context
- memories

This makes the system powerful.
It also means orchestration behavior is partly carried by prompt assembly instead of being enforced structurally.

## Short verdict on this seam

OpenHarness already has a real control plane.

The problem is that the control plane is still assembled from multiple soft carriers rather than one strongly closed execution contract.
