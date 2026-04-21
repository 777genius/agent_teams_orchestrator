# Approval Loop And Stage Overload

## The good part

Paperclip is still much stronger than most competitors on approvals as domain objects.

The service layer in `server/src/services/approvals.ts` is disciplined:

- `approve` and `reject` only resolve from `pending` or `revision_requested`
- `requestRevision` only applies from `pending`
- `resubmit` only applies from `revision_requested`
- same-terminal retries are idempotent through the `applied` flag

This is good control-plane engineering.

## What became clearer

The deeper pass showed that the weak seam is no longer "approvals are shallow".

The weak seam is:

- approval resolution is strong
- approval re-entry into execution is weaker

## Strong patterns worth stealing

### Route side effects are at least trying to be explicit

`POST /approvals/:id/approve` does more than flip a row.

It also:

- logs activity
- finds linked issues
- tries to wake the requesting agent

That is the right instinct.

It treats approval resolution as a workflow event, not just storage.

### Idempotent route behavior improved meaningfully

Issue `#499` looks mostly historical now.

Current code gates route-level side effects on `applied`.

That is a real positive lesson:

- if a route emits operational side effects
- it must know whether state actually changed

## Still-weak seams

### Revision and rejection still do not wake the requester

Issue `#3780` still matches current code.

`approve` wakes the requester.

`reject` and `request-revision` do not.

That means the clean lifecycle exists in storage, but not in the live loop.

This is a very important control-plane lesson:

⚠️ a persisted approval object is not enough if the requester never re-enters execution.

### No reliable polling fallback for `revision_requested`

The problem is not only missing wake.

There is also no strong polling fallback for agents to discover `revision_requested` approvals during ordinary timer heartbeats.

So a missed wake is not a small latency problem.

It can become a workflow stall.

### `in_review` is still overloaded

`server/src/services/issue-execution-policy.ts` still uses:

- `status = "in_review"`

for both:

- review stages
- approval stages

That means operator-visible status is carrying too many meanings.

The stage data is richer than the top-level issue status.

This is not fatal, but it is expensive:

- UI meaning gets softer
- agent prompts must infer more
- board users have to inspect deeper fields to know what kind of waiting they are seeing

### Auto-skip logic is clever, but makes semantics less obvious

`canAutoSkipPendingStage()` is smart.

If a review stage would just route back to the same principal on a `done` transition, it can be skipped.

That is useful ergonomically.

But it also means stage progression is no longer obvious from the status alone.

This is another example of:

- strong explicit center
- but a richer and costlier shell around it

## Architect takeaway

Steal:

- explicit approval transition guards
- route side effects gated on a real "state changed" signal
- approval rows as first-class control-plane objects

Avoid:

- assuming an approval loop is complete once the DB model is clean
- using one top-level status to represent several human review meanings
- letting approval resolution depend on wakes without a durable re-entry fallback
