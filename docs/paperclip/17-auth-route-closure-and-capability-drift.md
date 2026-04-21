# Auth Route Closure And Capability Drift

## The center is strong

`server/src/routes/authz.ts` is a meaningful architectural center.

`assertCompanyAccess()` does the right high-level things:

- agent keys are company-scoped
- board users are limited by memberships
- viewers are read-only on mutating routes

Compared with many competitors, this is a real access model.

## What the deeper pass changed

After looking again at current `master`, the important nuance is:

- some auth issues are historical and already fixed in code
- some capability/auth mismatches are still live

That distinction matters.

## Historical bug that current head seems to have fixed

### Agent API key cross-company hole

Issue `#20` reported that agent key routes used `assertBoard(req)` without company access checks.

Current `master` no longer looks like that.

The key routes now call `getAccessibleAgent()`, which in turn calls `assertCompanyAccess(req, agent.companyId)`.

So the architectural lesson is still valid:

- a strong center is not enough
- route closure matters

But this specific hole looks historically valuable rather than still-live on current head.

## Still-live mismatch on current head

### Plugin tools still look more board-centric than their product story

Issue `#3271` still matches the current code path.

`server/src/routes/plugins.ts` still uses:

- `assertBoardOrgAccess(req)` on `GET /plugins/tools`
- `assertBoardOrgAccess(req)` on `POST /plugins/tools/execute`

Only after that does it call `assertCompanyAccess(req, runContext.companyId)`.

That means:

- the route is conceptually execution-side
- the tool has `runContext`
- the company guard exists
- but the route is still front-loaded with a board-only gate

This is a good example of capability drift:

- the runtime wants agents to execute plugin tools
- the route personality still thinks like a board UI surface

## Why this matters architecturally

This is not just an auth bug.

It is a contract honesty problem:

- the plugin system says tools are part of runtime extensibility
- the route layer still partially treats them as board-only admin surfaces

That is how product promises drift away from enforced behavior.

## Multi-user model remains a real strength

Even with these seams, Paperclip is ahead of us here.

Strong pieces:

- `company_memberships`
- permission grants
- invite flows
- company-scoped human access
- instance admin

This remains a genuinely better control-plane access story than our current project.

## Architect takeaway

Steal:

- one central `assertCompanyAccess`-style boundary
- explicit membership rows and principal grants
- the discipline of separating board identity from agent identity

Avoid:

- assuming the model is "done" while route personalities still disagree with product capability surfaces
- letting execution-side features inherit board-only auth by accident
