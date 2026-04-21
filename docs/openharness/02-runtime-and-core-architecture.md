# OpenHarness Runtime and Core Architecture

## What the center of the system really is

OpenHarness does not have a GoClaw-style durable orchestration engine.

Its actual center of gravity is:

- the interactive runtime
- the background task manager
- the prompt assembly path
- the local swarm helpers around that runtime

That makes it feel more like:

- a powerful local agent harness

than like:

- a durable autonomous orchestration backend

## BackgroundTaskManager

`BackgroundTaskManager` is the main execution substrate for shell and agent tasks.

Good properties:

- explicit `TaskRecord` shape
- one task ID per background unit
- output files for later inspection
- restart logic for agent-style tasks that accept follow-up input
- generation tracking to avoid stale watcher writes after restart

Important limits:

- `_tasks` live in memory
- `_processes` live in memory
- `_waiters` live in memory
- task truth is not durably reconstructed after process restart

So the task model is useful and operator-friendly, but not yet a durable orchestration truth source.

## Headless worker mode is a real architectural decision

This is one of the best decisions in the project.

`run_task_worker()` in `ui/app.py` is a dedicated stdin-driven worker path that avoids the React/Ink TUI entirely.

Why this matters:

- subprocess workers do not pretend to be interactive terminals
- there is an explicit non-TTY execution mode
- the architecture learned from issue `#97`

This is exactly the kind of split a serious local harness should make.

## Prompt assembly is heavy and important

The runtime system prompt is assembled from many sources:

- base system prompt
- coordinator mode prompt
- fast-mode hints
- reasoning settings
- skills section
- delegation section
- `CLAUDE.md`
- local rules
- issue / PR / repo context
- memory and relevant memories

This is powerful, but it also means prompt assembly is already part of the operational control plane.

That is acceptable only if the runtime contract stays honest about what is:

- hard capability enforcement
- prompt-only guidance

## Auto-compaction is better than average

OpenHarness has a noticeably serious compaction subsystem:

- microcompact for cheap token reduction
- session-memory compaction as deterministic fallback
- full LLM-based compaction
- preserved attachments and tool discovery
- compact checkpoints and carryover metadata
- auto-compact trigger state

This is one of the more mature technical subsystems in the project.

The important lesson is not "copy the exact implementation".
The lesson is:

- long-session continuity is treated as a first-class runtime concern

## The main architectural truth

OpenHarness has a stronger local execution runtime than its age suggests.

But its center is still:

- runtime-centric
- local-process-centric
- partially in-memory

That is why it feels powerful and flexible, but not yet durable in the same way as a stronger store-backed orchestrator.
