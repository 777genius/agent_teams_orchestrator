# OpenHarness Summary

## One-line verdict

OpenHarness is an unusually strong very-young competitor: it already has real local multi-agent coordination primitives, but too much of the contract still depends on prompt/env conventions, file-based control paths, and early-stage subsystem drift.

## What is genuinely strong

- Local multi-agent primitives are real, not just marketing:
  - persistent `TeamLifecycleManager`
  - file-based mailbox
  - `WorktreeManager`
  - headless worker mode
  - backend registry for `subprocess` and `in_process`
- Quiet engineering taste is often good:
  - `atomic_write_text`
  - cross-platform `exclusive_file_lock`
  - metadata allowlists for persisted session state
  - worktree slug validation
  - `contextvars` isolation for in-process teammates
- Auto-compaction is more serious than average:
  - microcompact
  - structured summary compaction
  - checkpoints
  - preserved attachments and task-focus carryover

## What is weak

- Dual models are already visible:
  - legacy in-memory `TeamRegistry`
  - persistent `TeamLifecycleManager`
- Coordinator semantics are softer than they look:
  - env-var mode switch
  - prompt-driven coordinator behavior
  - tool routing depends on conventions
- File-based control planes are carrying a lot of weight:
  - mailbox
  - permission sync
  - team metadata
- Sandbox story is currently overstated:
  - Docker domain policy contents are not enforced
- Personalization crosses a dangerous boundary:
  - session extraction can persist raw secret-bearing exports into future prompts
- Some execution paths still show early-architecture seams:
  - provider-specific built-in model defaults
  - issue-driven hardening around subprocess/TUI/task semantics

## Simplest mental model

OpenHarness is closer to:

- a strong local agent harness
- with emerging orchestration features

than to:

- a durable platform-grade orchestration engine

It is more structurally interesting than most new projects, but it is still early enough that some good-looking subsystems are only half-closed contracts.

## Strongest areas

1. Worktree isolation and local execution ergonomics
2. Headless worker separation from TUI flow
3. Atomic-write and file-lock hardening after early corruption bugs
4. File mailbox as an explicit and testable local protocol
5. Auto-compaction and long-session continuity thinking

## Weakest areas

1. Dual truth between old and new team/task models
2. Prompt/env-driven coordinator contract
3. File-based control plane as long-term substrate risk
4. Sandbox policy honesty gap
5. Personalization boundary discipline

## Best short summary

OpenHarness is impressive because it already has serious local swarm primitives.

OpenHarness is risky because too much of its current contract still lives in:

- env vars
- prompt rules
- file mailboxes
- compatibility layers
- subsystem-specific assumptions
