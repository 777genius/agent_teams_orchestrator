# OpenHarness Strong Subsystems And Quiet Engineering

## Core point

The most reusable parts of OpenHarness are not the flashy README claims.

They are the boring local subsystems where the contract is explicit and the implementation is honest.

## 1. Worktree isolation is one of the best things in the repo

`swarm/worktree.py` is architecturally strong because it keeps the rules explicit:

- slug validation is strict
- path traversal is rejected
- branch naming is stable
- existing worktrees can be resumed
- large shared directories are symlinked instead of duplicated
- cleanup path exists

Why this matters:

- it turns isolation into a first-class coding primitive
- it fits local coding agents extremely well
- it avoids pretending the only isolation model is "one cwd and hope"

## 2. Headless worker mode is a real architectural decision

`ui/app.py` gives background workers a dedicated stdin-driven non-TTY path.

That matters because:

- background tasks should not be forced through a TUI lifecycle
- subprocess workers need a pipe-friendly execution contract
- issue `#97` forced them into the correct separation

This is one of the cleanest lessons in the codebase:

- worker runtime and interactive UI should be separate products

## 3. Atomic write plus file lock hardening happened early

Issue `#129` forced them to replace naive write patterns with:

- `utils/fs.py`
- `utils/file_lock.py`
- real atomic write discipline
- explicit locking for read-modify-write flows

This is the kind of quiet engineering taste that matters more than a fancy orchestration diagram.

## 4. In-process worker isolation uses the right Python primitive

`swarm/in_process.py` uses `contextvars` instead of global mutable state.

That gives them:

- per-agent identity isolation
- per-agent abort control
- per-agent message queue
- per-agent runtime stats

This is a very good local runtime choice.

## 5. Provider abstraction is stronger than expected for such a young repo

`api/registry.py` and `api/openai_client.py` show real engineering care:

- provider registry as one source of truth
- OpenAI-compatible normalization
- base URL normalization
- reasoning-content handling for thinking models
- support for multiple provider families and gateways

This is a real strength, even though some higher-level seams still leak Anthropic assumptions.

## 6. Platform honesty is better than average

`platforms.py` does something many young projects refuse to do:

- it admits some features are not supported on native Windows
- it narrows capabilities explicitly

That is more trustworthy than pretending every surface works everywhere.

## 7. Compaction is not a toy feature

`services/compact/__init__.py` is much more serious than typical "summarize the chat" features.

It has:

- microcompact
- session-memory compaction
- full LLM compaction
- checkpoints
- preserved attachments
- preserved tool discoveries
- task-focus carryover
- reactive retry path on prompt-too-long failures

This is a real subsystem, not a UI trick.

## 8. Issue-driven hardening is visible in the code shape

This project does not only patch happy-path bugs.

You can see architecture-relevant learning:

- issue `#97` -> headless worker separation
- issue `#129` -> atomic write and lock discipline
- issue `#137` -> better parallel tool result integrity
- issue `#107` -> base URL normalization
- issue `#103` -> restore/runtime prompt freshness thinking

That is a good engineering signal.

## Takeaway

The strongest parts of OpenHarness are the places where:

- the contract is explicit
- the boundary is local
- the state is inspectable
- the hardening is boring

Those are the parts worth stealing.
