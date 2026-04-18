# False Green Runs And Task Truth

## The strongest new lesson

One of the most valuable deeper lessons from `paperclip` is this:

⚠️ **run success is still too close to process success**.

Current heartbeat outcome logic is still fundamentally:

- if `exitCode == 0`
- and `errorMessage == null`
- then outcome = `succeeded`

That is a clean implementation.

But it is not a sufficiently truthful orchestration contract.

## What this means in practice

A run can go green even when:

- no useful work happened
- permissions blocked all actions
- provider returned a contradictory "success-ish" result
- the agent drifted onto unrelated work
- expected deliverables were never produced

## What the issue record says

Several issues point to the same class of problem:

- `#1117` - permission-blocked Claude run exits 0 and looks successful
- `#3148` - `subtype=success` style adapter output even when nothing happened
- `#3879` - assigned critical task drifted into unrelated work but session still looked clean
- `#849` - no deliverable validation after run
- `#1997` - task truth too weak to represent `needs_human` / `needs_verification`
- `#1683` - agents jump to `done` too early instead of review/board closure

These are not six unrelated bugs.

They are one architectural class:

- **the system knows too much about process outcome and too little about work truth**

## Important nuance

Some earlier false-green cases were already tightened.

For example, issue `#1763` around transient provider overload appears mostly addressed:

- adapter now surfaces real error
- exit code is effectively corrected

So this is not "they ignore all provider failure".

The deeper and still-live problem is narrower:

- even with better provider failure handling
- the success model is still not tied strongly enough to task truth

## Why this is architecturally expensive

Because once operators stop trusting green runs, they must inspect:

- transcript
- comments
- file changes
- issue status
- activity log

to know whether the run actually moved work forward.

That is a huge tax.

The system may still be technically consistent.

But operator trust drops.

## What is missing

### 1. No strong "work happened" contract

The run model does not strongly encode:

- meaningful Paperclip API activity happened
- issue status advanced truthfully
- expected deliverables appeared
- run stayed on its assigned task

### 2. Task state vocabulary is still too narrow

Paperclip already has `blocked`.

But issue `#1997` is pointing at a real gap:

- `needs_human`
- `needs_verification`
- explicit "cannot proceed honestly"

are still weaker than they should be.

### 3. Drift detection is not first-class enough

Issue `#3879` is especially important.

The problem is not just "wrong comment".

It is:

- assigned task context existed
- run still drifted to unrelated initiative
- run still looked clean enough to complete

This is a hard orchestrator lesson:

⚠️ staying on the assigned task must be part of success semantics, not just prompt advice.

## Architect takeaway

Steal:

- explicit adapter error normalization when possible
- persisted comment/run linkage like `createdByRunId`

Avoid:

- equating clean process exit with truthful task completion
- forcing operators to infer "real success" from transcript archaeology
- leaving "blocked / needs human / needs verification / incomplete" outside the core success model
