# Parent Child Coordination And Manager Wakes

## The good part

Paperclip already has some real building blocks for hierarchical execution:

- parent and child issues
- explicit assignees
- wake-on-assignment
- execution-stage wakeups for review and approval

So this is not a system with no hierarchy model at all.

## What became clearer

The deeper pass showed that generic manager-style orchestration is still weaker than the control-plane center suggests.

The main gap is simple:

- child completion is not a first-class wake for the parent manager

## Why this matters

For a human operator, this is only mildly annoying.

For a manager agent, it is a real orchestration seam.

Issue `#1280` expresses it well:

- child task reaches `done`
- parent manager often remains in "waiting for child"
- progression depends on timer heartbeat, manual comment wake, or prompt logic

That means the orchestration story is still partly:

- status-driven
- but not fully status-reactive

## What the route logic currently favors

Current issue wake logic in `server/src/routes/issues.ts` mainly wakes on:

- assignee change
- backlog to active status change
- blocked to todo
- comments and mentions
- explicit review/approval stage transitions

That is a sensible core.

But it does **not** amount to:

- generic parent wake on child terminal transition

So the system is optimized more for:

- direct assignee execution

than for:

- higher-order manager coordination

## Why this is a useful lesson

This is a classic "strong control plane, weaker orchestration reactivity" signal.

The issue hierarchy exists.

But the parent/child coordination contract is still partially prompt-and-timer driven.

That is expensive because it pushes too much coordination burden into:

- manager prompts
- heartbeat intervals
- plugin patches
- manual nudges

## Architect takeaway

Steal:

- explicit issue hierarchy as a real object model
- wake reasons tied to concrete execution events

Avoid:

- assuming parent/child structure automatically creates manager orchestration
- making timer heartbeats the main path for learning that a child finished
- forcing manager agents to rediscover child completion through prompts instead of first-class reactive signals
