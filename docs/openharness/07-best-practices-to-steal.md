# OpenHarness Best Practices to Steal

## Core principle

Do not copy OpenHarness broadly.
Copy the parts where it is explicit, local-first, and structurally honest.

## 1. Separate headless worker mode from interactive TUI

This is one of the cleanest decisions in the codebase.

Why it matters:

- background tasks should not pretend to be terminal apps
- subprocess workers should have an execution path designed for pipes, not TTYs

## 2. Treat worktree isolation as a first-class coding primitive

Their `WorktreeManager` is worth studying.

Good parts:

- path validation
- resumable worktrees
- stable naming
- cleanup support
- cheap reuse of large shared dirs

## 3. Use a simple explicit mailbox before inventing clever distributed messaging

The file mailbox is not infinitely scalable.
But it is:

- debuggable
- testable
- explicit
- easy to inspect

For local-first orchestrators this is a very good starting pattern.

## 4. Harden persistence early with atomic writes and locks

This is quiet but crucial.

The `#129` hardening is exactly the kind of boring engineering that should happen early, not after months of corruption pain.

## 5. Keep compaction as a real subsystem

OpenHarness treats long-session continuity seriously.

Worth stealing:

- staged compaction
- checkpoints
- preserved carryover state
- continuity boundary messages

## 6. Use `contextvars` for in-process worker identity

For Python local execution, this is the right primitive.

It is much better than:

- global mutable singletons for worker identity
- manual argument threading everywhere

## 7. Build backend abstraction explicitly

Their backend registry has the right instinct:

- backend type is a real concept
- detection is explicit
- platform capability matrix exists

The implementation is still environment-heavy, but the abstraction direction is correct.

## 8. Keep issue-driven hardening architecture-aware

Several fixes were not random patches.
They improved the actual subsystem shape:

- raw-mode bug -> headless worker path
- corruption bug -> atomic writes and locks
- parallel tool failure -> better tool-result integrity thinking

That practice is worth copying.
