# Heartbeat Recovery And Wakeup Seams

## The strongest thing here

Paperclip still has one of the clearest execution centers in this category.

The good part is explicit and real:

- `checkoutRunId`
- `executionRunId`
- explicit checkout/release paths
- issue-linked runs
- conservative stranded-work reconciliation

That center is strong.

## The more expensive truth

The orchestration shell around that center is now layered enough that it has become a subsystem of its own.

The main moving parts are:

- wake coalescing in `server/src/services/heartbeat.ts`
- deferred issue-execution wakeups
- approval-requester wakeups
- missing-comment retry backstop
- release-time promotion and optional reopen
- stranded assigned `todo` and `in_progress` recovery wakes

This is no longer "just a queue".

It is a policy-rich execution shell.

## What is strong

### Checkout and execution are not the same thing

`server/src/services/issues.ts` and `doc/execution-semantics.md` make a good distinction:

- checkout answers who owns execution rights
- execution run answers which live run is active

That split is genuinely strong and worth stealing.

### Recovery is conservative by default

`reconcileStrandedAssignedIssues()` does not retry forever.

It does:

- one recovery wake for stranded `todo`
- one continuation wake for stranded `in_progress`
- then a visible escalation to `blocked`

That is much better than endless hidden retries.

## The real seams

### 1. Release and promotion are still brittle

Current `master` still shows the `#3819` class of bug in `releaseIssueExecutionAndPromote()`:

- it clears `executionRunId`
- it clears `executionAgentNameKey`
- it clears `executionLockedAt`
- it does **not** clear `checkoutRunId`

That means the center model is good, but the cleanup closure is still not fully honest.

This matters because stale checkout locks are one of the worst orchestrator lies:

- the agent looks alive
- the run can look green
- the issue is effectively pinned to a dead run

### 2. Wake coalescing can swallow intent

`enqueueWakeup()` in `server/src/services/heartbeat.ts` will:

- coalesce onto a same-scope queued/running run
- or defer onto `deferred_issue_execution`

That is good for duplicate suppression.

But it creates a real seam for mid-run notifications.

Issue `#3432` is the clearest example:

- approval is resolved
- requester wake is queued while requester is still mid-run
- wake can be merged into the active run context
- requester does not necessarily observe the approval before exiting

This is a classic problem of "event was delivered to the wrong execution window".

### 3. Comment correctness depends on a backstop chain

The path around comments is already quite layered:

- `findRunIssueComment()`
- `finalizeIssueCommentPolicy()`
- `enqueueMissingIssueCommentRetry()`
- `releaseIssueExecutionAndPromote()`
- `shouldReopenDeferredCommentWake`

This is smart engineering, but it is also a warning.

The system is no longer relying only on:

- agent posts comment
- run closes

It is now relying on:

- correct attribution
- correct `createdByRunId`
- correct wake classification
- correct deferred promotion
- correct reopen behavior

Issues `#3817` and fresh `#3935` show what happens when this chain breaks:

- comment gets misattributed
- self-comment guard does not fire
- agent gets retriggered
- `done` can drift back into active states
- loops appear

### 4. Recovery can become a shadow policy layer

`reconcileStrandedAssignedIssues()` is architecturally reasonable, but it is already policy-heavy enough to be a warning:

- retry reason inspection
- different logic for `todo` and `in_progress`
- escalation comments
- live execution path checks

Issue `#3882` is the best sign here:

⚠️ once the product supports perpetual or standing-order patterns, generic stranded-work recovery can quietly become a token burner.

That is not a failure of the center model.
It is a failure of recovery policy fit.

### 5. Parent/child propagation is still subtle

`routes/issues.ts` now has explicit parent wake logic when a child becomes terminal.

That is a good direction.

But issue `#3822` shows the underlying truth:

- hierarchy wake semantics are expensive to get right
- parent/sub-issue structure is not enough
- status propagation and wake policy must still be designed explicitly

## Architect takeaway

Steal:

- checkout vs execution split
- visible escalation after bounded recovery
- explicit execution-semantics docs

Avoid:

- stacking too many correctness backstops around comments and wake promotion
- letting coalescing semantics silently decide whether an important event is actually seen
- building recovery rules that quietly become a second policy language
