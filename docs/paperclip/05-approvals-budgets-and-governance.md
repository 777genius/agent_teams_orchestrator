# Approvals Budgets And Governance

## This is one of Paperclip's biggest strengths

Approvals and budgets are not decorative.

They are persisted product objects with real routes, services, and operator flows.

That already puts Paperclip ahead of our current project in governance maturity.

## What is strong

### Approvals as first-order objects

Paperclip has:

- approval rows
- approval comments
- issue-approval links
- revision-request flow

This is a serious governance surface.

### Budget policies and incidents

Budget enforcement includes:

- scope types
- incidents
- warning vs hard-stop logic
- pause actions

This is much more mature than our current runtime budget story.

### Board powers

The docs and routes are explicit about:

- pause/resume/terminate agents
- override budgets
- approve/reject/revision flows

That is exactly what a board/control-plane product should own.

## Weak seams

### 1. Discoverability gap

Issue `#3821` shows the key failure:

- pending approval exists
- but board user cannot find it in the UI easily

That means the domain is ahead of operator closure.

### 2. Approval lifecycle incompleteness

Issue `#2718` shows a weak spot:

- approved requests can pile up without a clean terminal lifecycle

This is a sign that the approval object exists, but some product lifecycle semantics are still shallow.

### 3. Wake routing on approval resolution

Issues:

- `#3432`
- `#3780`

These show that governance objects are strong, but the re-entry path back into execution is still imperfect.

### 4. Review semantics overloaded into `in_review`

Issue `#2496` matters here too.

If governance/review intent is not explicit enough, both UI and agents start over-inferring.

## Architect takeaway

Steal:

- approvals as persisted domain objects
- budget policy + incident modeling
- explicit board-level override powers

Avoid:

- assuming governance is finished once the row and route exist
- overloading one review state with multiple approval meanings
