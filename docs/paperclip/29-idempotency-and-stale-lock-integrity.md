# Idempotency And Stale-Lock Integrity

## The strongest positive pattern

`paperclip` already shows that it understands a very important control-plane law:

- side effects should happen only when state actually changed

The clearest example is approvals.

In `server/src/services/approvals.ts`, `resolveApproval()` returns:

- `approval`
- `applied`

That is good architecture.

It means the service layer tells the caller whether the transition really happened.

Then `server/src/routes/approvals.ts` gates route-level side effects on `if (applied)`:

- activity logs
- requester wakeups
- hire hooks

There is even a focused regression test file:

- `server/src/__tests__/approval-routes-idempotency.test.ts`

This is the kind of boring, durable contract we should steal.

## The weaker neighboring seam

The routines path is noticeably less closed.

Issue `#3407` is the clearest signal:

- intermittent duplicate key failures on `issues_open_routine_execution_uq`
- stale open routine issue can block future dispatch

The current code in `server/src/services/routines.ts` makes the problem visible.

`dispatchRoutineRun()` handles `23505` on `issues_open_routine_execution_uq` and tries to recover by calling:

- `findLiveExecutionIssue()`

But `findLiveExecutionIssue()` only matches routine issues that are joined to:

- a live `issues.executionRunId`
- or a live `heartbeatRuns.contextSnapshot.issueId`

So the fallback is narrower than the uniqueness contract.

If the system has:

- an open routine-origin issue
- but its linked execution run is terminal or missing

then the unique index can still reject the insert, while the fallback lookup misses the already-open blocker.

That is exactly the kind of stale-lock seam that produces:

- duplicate-key failures
- "why did dispatch fail if an issue already exists?"
- operator confusion

## Why this is architecturally valuable

This contrast is unusually useful.

Paperclip already demonstrates the better law in approvals:

- mutate conditionally
- return a state-change flag
- gate side effects on that flag

But routines still look more like:

- optimistic create
- fallback lookup
- partial recovery based on "live" rather than "blocking"

So the lesson is not just "they have a bug".

The lesson is:

⚠️ even a mature control plane can have different idempotency maturity levels in adjacent subsystems.

## Test asymmetry matters

There is a routine coalescing test in `server/src/__tests__/routines-service.test.ts`.

That is good.

But the current test surface does not look equally targeted for:

- duplicate-key recovery on stale execution links
- open issue still blocking after terminal run linkage
- conflict fallback under retry or scheduler races

That asymmetry is part of the story.

Approvals look like a subsystem that already got its idempotency law.

Routines still look like a subsystem that only partly has it.

## Architect takeaway

Steal:

- service-layer `applied` flags
- side effects gated on real state change
- targeted idempotency regression tests

Avoid:

- uniqueness fallback that only sees "live" blockers when the DB uniqueness rule is broader
- optimistic create paths that rely on a narrower recovery query
- assuming coalescing tests are enough proof of stale-lock safety
