# Overstory Summary

## Short verdict

`overstory` is strongest as a **local coding swarm substrate** and a **runtime adapter laboratory**.

It is weaker as a **durable orchestration engine** than `goclaw`, because too much correctness still depends on:
- tmux
- worktree lifecycle
- hook deployment
- prompt contracts between roles
- repo-local SQLite state

The cleanest one-line summary:

**`overstory` has unusually good runtime abstraction and unusually expensive substrate assumptions.**

## What is genuinely strong

- Explicit `AgentRuntime` abstraction in `src/runtimes/types.ts`
- A real attempt to support multiple coding-agent runtimes behind one orchestrator
- Worktree isolation as the default implementation unit
- SQLite-backed local coordination primitives: mail, merge queue, sessions, events
- Strong watchdog mindset: mechanical health, AI triage, monitor layer
- Good self-critique culture via `STEELMAN.md`
- Very high test density for a CLI-heavy TypeScript project

## What is genuinely risky

- tmux is still a critical substrate, not a cosmetic implementation detail
- Cross-repo orchestration still shows split-brain behavior around `.overstory/mail.db`
- Role correctness depends too much on prompt quality and role discipline
- Runtime adapter maturity is uneven
- Headless/RPC future is strong in concept, but not uniformly landed
- Merge/state sync semantics can become timing-sensitive and operator-surprising

## Best mental model

- `goclaw` is closer to a **durable agent platform**
- `gastown` is closer to an **ambitious orchestration experiment on shaky substrate**
- `overstory` sits in between:
  - much more disciplined than `gastown`
  - much less durable than `goclaw`
  - stronger than both in **runtime abstraction as a first-class theme**
