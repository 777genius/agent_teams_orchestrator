# Adapter Cost And Context Pressure

## The good idea

Paperclip at least knows this is a real subsystem.

It has:

- adapter-level session management metadata
- session compaction policy resolution
- run-scoped env injection for local subprocess adapters
- explicit heartbeat protocol docs

That is better than pretending cost and context are incidental.

## The big problem

The execution shell is still expensive by default.

Three patterns keep showing up:

- too many wakeups just to discover there is no work
- too much universal context shipped to every role
- too much trust in adapter claims about native context handling

## What the issues say

### 1. Heartbeat tax is not theoretical

Issue `#2854` is the cleanest user-language version:

- operators are burning expensive model budget
- often just to learn there is nothing to do

This is not a prompt-writing problem.

It is an execution-model cost problem.

### 2. Universal skills create role-irrelevant context bloat

Issue `#3438` points to a very specific anti-pattern:

- one large Paperclip skill
- admin/CEO-only sections
- shipped to every agent

This is a classic context-tax smell.

It is especially bad in heartbeat systems because the same tax repeats on every wake.

### 3. Session policy can drift away from reality

Issue `#3813` is extremely important architecturally.

`packages/adapter-utils/src/session-compaction.ts` currently marks:

- `claude_local`
- `codex_local`
- `hermes_local`

as `nativeContextManagement: "confirmed"` and applies zero-threshold adapter-managed compaction.

The issue report argues current `codex_local` behavior does **not** justify that confidence.

This is a very useful lesson:

⚠️ adapter capability claims become dangerous when they disable independent safety rails.

### 4. Non-subprocess adapters lose some run-scoped guarantees

Issue `#3894` is a good example.

Local CLI adapters can inject run-scoped auth into a spawned child process.

Gateway-style adapters or already-running agent processes are different.

That means a design that looks uniform at the control-plane layer may still have materially weaker guarantees in certain adapter families.

## What is worth stealing

### Adapter-level session policy abstraction

The shape in `session-compaction.ts` is useful:

- `supportsSessionResume`
- `nativeContextManagement`
- adapter default compaction policy

That is a good abstraction.

### Run-scoped env injection for subprocess adapters

The local adapter pattern is also good:

- build per-run Paperclip env
- inject into child
- keep execution contract close to the spawned process

That is much better than relying only on prompt text for runtime identity.

## Architect takeaway

Steal:

- adapter session-management metadata as a first-class concept
- explicit run-scoped env injection where the runtime model allows it
- role-aware context narrowing

Avoid:

- assuming "native context management" without telemetry-backed proof
- shipping one universal orchestration skill to every role
- letting heartbeat polling become the default way to discover whether work exists
