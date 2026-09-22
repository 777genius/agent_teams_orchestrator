# Issues Hotspots And Tests

## What the issue tracker says

The repeating pain clusters are:

### Heartbeat cost and prompt growth

- `#2854`
- `#3813`
- `#3438`

This is one of the main real-world pain points.

### Silent or misleading success

- `#1117`
- `#1997`
- `#3819`
- `#3935`

This is one of the most dangerous trust failures.

### Wakeup, retry, and recovery shell problems

- `#3432`
- `#3824`
- `#3882`
- `#3894`

This is the cluster that says the execution center is strong, but the coordination shell around it is getting expensive.

### Approval discoverability and resolution routing

- `#3821`
- `#3432`
- `#3780`
- `#2718`

This shows governance objects are strong, but the full operator loop is not always sealed.

### Auth/bootstrap/access seams

- `#20`
- `#3271`
- `#3181`

The model is good, but route closure and onboarding still need care.

### Operator truth drift

- `#3820`
- `#2496`
- `#3921`
- `#3919`

These are not "missing feature" reports.

They are signs that the operator story is broader than the currently closed UI truth model.

### Portability and GitOps honesty

- `#3918`

This is strategically important because Paperclip wants portability to be a core product story, not an edge feature.

### Workspace/runtime power boundaries

- `#883`
- `#469`

Strong features, expensive boundaries.

## Hotspots by churn

Since 2026-01-01 the hotter files include:

- `server/src/services/heartbeat.ts` - `88`
- `server/src/routes/issues.ts` - `74`
- `server/src/services/issues.ts` - `62`
- `server/src/services/workspace-runtime.ts` - `26`
- `packages/adapter-utils/src/server-utils.ts` - `32`

And on the UI side:

- `ui/src/pages/IssueDetail.tsx` - `116`
- `ui/src/pages/AgentDetail.tsx` - `116`
- `ui/src/pages/Inbox.tsx` - `102`

This is a meaningful signal:

- the center task/runtime/operator loop is where cost is concentrated

The deeper pass adds one more useful nuance:

- some hotspot issues are still visibly live in current `master` (`#3271`, `#3819`, `#3813`)
- some are valuable historical warnings that current head appears to have already tightened (`#20`)

## Test surface

Quick signals from the repo:

- heartbeat-related tests in `server/src/__tests__`: `8`
- issue-related tests: `18`
- invite/access/authz-related tests: `20`
- plugin-related tests: `4`

This is not exhaustive coverage analysis, but it does show:

- Paperclip is testing real control-plane seams
- the biggest pains still live exactly where the product is most ambitious

## Bottom line

Paperclip is not weak because nobody thought about these problems.

It is expensive because:

- the product is broad
- the heartbeat shell is costly
- the operator loop has several still-hot seams
