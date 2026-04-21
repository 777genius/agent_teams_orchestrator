# OpenHarness Top Architect Takeaways

## The main law

OpenHarness is strongest where it uses:

- explicit local primitives
- explicit file/process contracts
- boring crash-safe engineering

OpenHarness is weakest where it relies on:

- prompt obedience
- env-flag semantics
- dual models
- implied policy honesty

## What to steal

- headless worker path
- worktree isolation
- simple explicit mailbox
- atomic-write plus lock discipline
- structured compaction with continuity metadata
- `contextvars` isolation for in-process workers

## What to ban

- dual truth between old and new team/task models
- prompt-only coordinator contracts
- provider-specific built-in assumptions
- sandbox surfaces that over-promise policy enforcement
- personalization that can persist secrets into future prompts

## Architectural score in plain language

As a local harness:

- surprisingly strong

As a durable orchestrator:

- not there yet

As a source of new ideas:

- very worth watching

## Final synthesis

The correct way to learn from OpenHarness is:

- copy its strong local primitives
- do not mistake those primitives for a fully closed orchestration architecture
