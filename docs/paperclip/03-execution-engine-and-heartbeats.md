# Execution Engine And Heartbeats

## The strongest thing here

Paperclip writes down its execution model unusually clearly.

The best separation in `doc/execution-semantics.md` is:

- structure
- dependency
- ownership
- execution

That separation is architecturally excellent.

## Hard execution concepts

Paperclip distinguishes:

- `checkoutRunId`
- `executionRunId`

This is a strong pattern.

Meaning:

- checkout answers who owns execution rights
- execution run answers which live path is currently moving the issue

That is better than one overloaded lock field.

## Recovery model

Paperclip has a conservative stranded-work model:

- stranded assigned `todo` -> one recovery wake -> then visible escalation/block
- stranded assigned `in_progress` -> one continuation wake -> then visible escalation/block

This is a mature middle ground:

- not naive
- not over-automated
- not silent

## Wakeup model

Wakeups come from:

- scheduler/timer
- assignment
- comment
- manual invoke
- approval resolution

That is coherent in theory.

## Where the real problems are

### 1. Heartbeat cost tax

Issue evidence:

- `#2854`
- `#3813`
- `#3438`

The problem is not just "prompts are large".

The real issue is:

⚠️ too much orchestration truth is still discovered through model wakes instead of cheap deterministic checks.

### 2. Release and wake promotion still have sharp edges

Current `master` still shows the `#3819` class of cleanup mismatch:

- `releaseIssueExecutionAndPromote()` clears execution-lock fields
- but still does not clear `checkoutRunId`

That is exactly the kind of bug that creates silent "agent looks alive but does nothing" failures.

### 3. Comment attribution and reopen logic are now a real seam

Issue evidence:

- `#3817`
- `#3935`

The dangerous part is not only misattribution.

It is the chain around:

- comment attribution
- self-comment detection
- missing-comment retry
- deferred wake promotion
- optional reopen from terminal state

That is already a fairly expensive correctness shell.

### 4. Parent/manager wake gaps

Issue evidence:

- `#1280`
- `#901`

The center model is strong, but some dependency/notification edges still leave managers waiting for the next timer instead of immediate reaction.

### 5. Swallowed wakeups

Issue evidence:

- `#3432`

Approval-related wakeups can effectively disappear when merged into the wrong run context.

This is a serious seam because it breaks the promise that "approval resolution returns work to the right actor".

### 6. Recovery policy is becoming a subsystem

Issue evidence:

- `#3882`
- `#3824`

Paperclip's recovery logic is still better than naive infinite retry.

But it is now rich enough that:

- wake reasons
- retry reasons
- escalation rules
- stranded-work heuristics

are becoming a second policy layer around the execution center.

### 7. False-green success

Issue evidence:

- `#1117`
- `#1997`

If the run exits 0 but the agent actually did nothing useful, the run model is too trusting.

For orchestrators, this is one of the worst kinds of lie.

## Bottom line

Paperclip has a stronger execution contract than most competitors.

But:

⚠️ its heartbeat shell is more expensive and more failure-prone than the center model suggests.

## What to steal

- explicit execution semantics docs
- checkout vs execution lock split
- conservative stranded-work recovery

## What to avoid

- letting orchestration depend on expensive repeated wakes for basic "is there work?" checks
- equating process exit with meaningful success
- letting comment/retry/reopen/wake-promotion rules accumulate until they become a hidden orchestration engine
