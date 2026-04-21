# OpenHarness Issues and Early Maturity Signals

## The important pattern

The issue tracker already reads like a very young but very serious harness:

- fast feature growth
- fast bug discovery
- fast patching
- still-forming contracts

This is good news and bad news at the same time.

## Open issues that matter most architecturally

### `#153` - hard-coded `haiku` in built-in subagents

What it reveals:

- built-in agent definitions still contain provider-specific assumptions
- inheritance of parent model/provider is not yet a closed contract

Lesson:

- do not let built-in agents smuggle provider dialect assumptions into orchestration

### `#150` - Docker sandbox domain policies not enforced

What it reveals:

- safety/product surface is ahead of actual runtime closure

Lesson:

- unsupported policy must fail closed or be rejected, not silently widened

### `#149` - personalization stores exported secrets

What it reveals:

- the project has not yet fully separated:
  - useful local environment memory
  - durable secret-bearing state

Lesson:

- secret extraction and local personalization need a much harder boundary

### `#102` - need a unified internal background task data model

This is one of the most revealing signals.

It suggests even adjacent HKUDS projects are explicitly realizing:

- task model closure matters
- manager/tool/bridge/event surfaces must converge on one model

That is a very good sign for honesty.
It is also a sign the contract is still evolving.

## Closed issues that reveal healthy hardening

### `#129` - persistent state corruption

Positive signal:

- they noticed and fixed a real boring systems bug
- they responded with atomic write and locking, not cosmetic patching

### `#137` - parallel tool turns could brick the session

Positive signal:

- they are hitting real engine concurrency faults
- the fix direction is about preserving tool-result contract integrity

### `#97` - subprocess backend tried to mount Ink TUI on non-TTY stdin

Positive signal:

- they learned the correct architectural split:
  - background worker != TUI process

## Maturity verdict

OpenHarness is young enough that issues still expose foundational seams.

But it is also mature enough in engineering instinct that many of those issues are:

- specific
- reproducible
- architecture-relevant

That is a good competitor signal.

The project is not calm.
It is real.
