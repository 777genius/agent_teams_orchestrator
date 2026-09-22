# Workspaces And Runtime Services

## Why this layer matters

Paperclip is more serious than many competitors about where work actually happens.

It models:

- shared vs isolated workspaces
- project workspace policy
- execution workspace settings
- runtime services attached to workspaces

This is good architectural ambition.

## What is strong

### Explicit workspace policy vocabulary

The policy layer distinguishes:

- shared workspace
- isolated workspace
- operator branch
- agent default

That is much better than implicit "just use cwd".

### Runtime services

`workspace-runtime.ts` shows a real attempt to make runtime services first-class:

- service state
- scope
- reuse keys
- lifecycle
- health

This is a serious operator feature, not a toy.

## Risks and weak seams

### 1. Powerful commands become host power surfaces

Issue `#883` highlights the architectural risk:

- `provisionCommand`
- `teardownCommand`

Once user-editable/project-scoped commands run on the host, the workspace layer becomes a security boundary, not just a convenience feature.

### 2. Operator/runtime mismatch

Issue `#469` shows that even strong workspace ideas can fail at the operator edge if paths, assumptions, or availability are off.

### 3. Complexity tax

This layer is broad enough to become its own platform:

- policies
- runtime services
- branching/worktree semantics
- workspace reuse
- lifecycle cleanup

That is powerful, but expensive.

## Comparison to us

We are still stronger at:

- deterministic local workspace bootstrap
- direct local lead/runtime control

Paperclip is stronger at:

- explicit persisted workspace policy
- operator-visible runtime services

## Architect takeaway

Steal:

- explicit workspace policy vocabulary
- workspace/runtime service modeling

Avoid:

- host-power commands without very hard boundaries
- letting the workspace subsystem silently become a second platform inside the platform
