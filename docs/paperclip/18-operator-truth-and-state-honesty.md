# Operator Truth And State Honesty

## The UI is not weak

Paperclip's UI is stronger than average for this category.

It has real operator objects:

- inbox
- approvals
- dashboards
- issue detail
- agent detail
- live runs
- costs

That is all real product work.

## The deeper problem

The weaker layer is not "missing screens".

It is operator truth honesty.

In several places, the system knows something more precise than what it tells the operator.

## Best examples

### 1. `blocked` versus "Waiting for output"

Issue `#3820` is the cleanest example.

The complaint is not that the backend has no state.

The complaint is that the operator sees:

- issue status = `blocked`
- UI card = "Waiting for output"

Those are different meanings.

This is a classic state-honesty problem:

- durable state says "work is blocked"
- UI secondary surface implies "work is actively pending"

### 2. Approvals exist, but discoverability is still easy to miss

Current code does have operator surfaces:

- `sidebar-badges.ts` counts actionable approvals
- `Dashboard.tsx` links to `/approvals`
- `Inbox.tsx` has approvals sections

So issue `#3821` is not about missing data.

It is about interaction closure:

- the product says approvals are core
- but the operator still may not have one obvious "what needs my decision now?" path

### 3. `in_review` is too semantically overloaded

Issue `#2496` is very important.

The problem is not only status naming.

The deeper problem is that `in_review` currently compresses multiple intents:

- direction review
- deliverable acceptance
- phase approval
- maybe board decision gating

That hurts both:

- humans, because inbox items are ambiguous
- agents, because downstream closure rules become guesswork

### 4. Fresh issues still show workflow honesty gaps

Recent issues reinforce the same theme:

- `#3921` - status dropdown requires comment for stage transition, but offers no comment input
- `#3919` - inbox badge counts done issues

Those are not core-domain failures.

They are operator-loop trust failures.

## Why this matters

Paperclip is a board/operator product.

That means it is not enough for the backend to be right.

The operator must be able to answer, quickly and honestly:

- what is actually blocked
- what is actually running
- what actually needs my decision
- what kind of review is being requested

When that answer is fuzzy, the product becomes expensive to supervise.

## Architect takeaway

Steal:

- real operator surfaces for approvals, live runs, and governance
- inbox as a first-class board surface

Avoid:

- showing secondary runtime hints as if they outrank primary domain state
- collapsing multiple review semantics into one broad status
- assuming that having an approvals page means approvals are truly discoverable
