# Portability And Governance Import Seams

## Why this seam matters

Paperclip is one of the few competitors trying to make whole companies portable.

That is strategically strong.

But the minute portability becomes real, it collides with governance:

- new agents
- approval gates
- safe import modes
- CLI/operator expectations

That is where the architecture becomes expensive.

## What is genuinely good

Paperclip's portability model is still one of its best strategic ideas:

- markdown-first company packages
- GitHub-native import/export
- dry-run preview
- collision strategies
- vendor-neutral package core plus Paperclip fidelity sidecar

This is strong product thinking.

## The seam

### GitOps promise versus governance gates

Issue `#3918` is the best warning.

The report says:

- operator adds a new agent to a company package
- runs import again
- new agent is silently absent afterward

That is exactly the kind of failure that destroys trust in portability workflows.

## Important current-head nuance

After re-checking current `master`, the import path in `server/src/services/company-portability.ts` does appear to have a create branch that:

- creates new imported agents
- sets status to `pending_approval` when `requireBoardApprovalForNewAgents` is on

So the current code is closer to the honest behavior you would want.

That means one of two things is likely true:

- `#3918` reflects a release-specific bug that current head partly or fully fixed
- or the bug was in a narrower import path / operator flow than the main create branch now visible in head

Either way, the lesson is the same:

⚠️ portability features must fail loudly or create explicit pending objects.
They must never silently "mostly reconcile".

## The real product law here

If the product says:

- package on disk is company truth
- import is the reconciler

then governance must still preserve operator honesty:

- create pending_approval rows
- or exit non-zero
- or demand an explicit operator allowlist

What it must not do is quietly skip and still look successful.

## Architect takeaway

Steal:

- markdown-first package model
- dry-run preview and collision planning
- safe import modes with narrower authority

Avoid:

- GitOps stories that become dishonest the moment governance gates apply
- reconciler behavior that is neither fully applied nor clearly rejected
