# UI Product Surface And Operator Story

## What kind of UI Paperclip is building

Paperclip is building a board/operator product surface, not a coding cockpit.

The UI emphasizes:

- dashboard
- inbox
- issue detail
- org chart
- agent detail
- approvals
- budgets
- activity

That fits the product thesis.

## Strong UI/product decisions

- board-level abstraction is clear
- company/agent/task/governance objects are visible
- runs, logs, status, and costs are first-class
- org chart is not an afterthought

## Main weakness

The operator surface is sometimes less closed than the docs imply.

### Best example: approvals

Docs say approvals appear in the approval queue/UI.

Issue `#3821` says pending approvals were effectively undiscoverable without CLI/API lookup.

That is an important kind of drift:

- domain exists
- route exists
- operator path is still incomplete

The deeper pass makes this more precise:

- `sidebar-badges.ts` already counts actionable approvals
- `Dashboard.tsx` already links to `/approvals`
- `Inbox.tsx` already has approval sections

So this is not a missing-data bug.

It is an operator-path closure bug.

### Blocked truth versus live-run truth

Issue `#3820` is another very good signal:

- issue status says `blocked`
- issue detail can still show "Waiting for output"

That is exactly the kind of mixed operator signal that erodes trust over time.

### `in_review` means too many things

Issue `#2496` shows another important drift:

- direction review
- deliverable acceptance
- approval-like human review

all collapse into the same visible state.

That is a product language problem, not just a backend problem.

### Hot UI pages in history

Git churn since 2026-01-01 shows the hottest UI files include:

- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/AgentDetail.tsx`
- `ui/src/pages/Inbox.tsx`

That means the main operator surfaces are still actively being stabilized.

## Comparison to us

Paperclip UI is stronger than our current project in:

- board/operator product surface
- governance visibility
- company/task admin flows

Our current project is stronger in:

- terminal-first operator steering
- tight coding control loop
- low-latency local execution feel

## Architect takeaway

Steal:

- operator-centered surfaces for approvals, budgets, and task visibility

Avoid:

- assuming persisted objects automatically imply a closed operator workflow
- letting secondary runtime hints visually outrank the primary domain state
- overloading one review status with multiple human meanings
