# OpenHarness Multi-Agent Coordination

## What is genuinely interesting

OpenHarness is not bluffing about having multi-agent pieces.

The important ones are real:

- coordinator mode
- built-in agent definitions
- persistent team lifecycle
- file mailbox
- permission-sync protocol
- backend registry
- `subprocess` and `in_process` teammate modes
- git worktree isolation

That is already more real than many projects that only advertise "agent teams".

## Coordinator mode

Coordinator mode is enabled through `CLAUDE_CODE_COORDINATOR_MODE`.

Strength:

- there is a distinct orchestration prompt
- worker-specific tool surface exists
- coordinator behaviors are at least made explicit

Risk:

- this is still env-var and prompt mediated
- it is not a single hard execution envelope

In other words:

- the coordinator idea is real
- the coordinator contract is still soft

## Dual team model

This is one of the most important warnings in the whole project.

There is:

- legacy `TeamRegistry` in `coordinator_mode.py`
- persistent `TeamLifecycleManager` in `swarm/team_lifecycle.py`

And `TeamLifecycleManager` explicitly says it can work alongside the in-memory registry without changing it.

That is a classic early migration smell:

- better new model exists
- older simpler model is still alive
- both participate in real behavior

This is exactly the kind of seam that later becomes drift if not closed aggressively.

## File mailbox

The mailbox is simple and good in a local-first sense:

- one JSON file per message
- atomic write via temp file + `os.replace`
- explicit unread/read lifecycle
- lock around writes
- testable routing by team and agent

This is good because:

- it is explicit
- easy to debug
- easy to inspect on disk

But it also creates a future substrate risk:

- filesystem semantics become part of orchestration truth
- ordering, cleanup, scale, and crash behavior all inherit file-queue limits

## Permission sync already has two protocols

`permission_sync.py` supports:

- file-based pending/resolved directories
- mailbox-based request/response

That is both interesting and risky.

Interesting:

- they are clearly exploring real coordination patterns

Risky:

- two active control protocols for one permission workflow is already dual truth pressure

## WorktreeManager

This is one of the strongest subsystems in OpenHarness.

Good decisions:

- slug validation rejects traversal and absolute paths
- stable branch naming
- resume existing valid worktree
- symlink large common dirs to avoid duplication
- explicit cleanup path

This is a genuinely reusable positive reference for local coding swarms.

## Backend registry

`BackendRegistry` is a good idea:

- explicit backend abstraction
- explicit detection pipeline
- pane backend and worker backend thought about separately

But it also exposes the harness bias:

- tmux
- iTerm2
- subprocess
- in-process fallback

This is great for local operator ergonomics.
It also means environment coupling is part of the architecture, not just a UI detail.

## In-process teammate backend

The `contextvars` design is actually good.

The backend gets:

- per-agent isolated context
- abort controller
- message queue
- mailbox drain loop
- status and token tracking

But the current implementation also reveals immaturity:

- if no `query_context` is supplied, it falls back to a stub run

That is a very clear sign of an architecture that is still converging.

## Short verdict on this seam

OpenHarness already has meaningful multi-agent coordination primitives.

But the coordination layer is not fully closed yet because it still has:

- dual team truth
- dual permission sync protocols
- prompt/env-driven coordinator semantics
- backend/environment coupling
