# Auth Access And Multi User

## Paperclip is ahead of us here

Compared with our current project, Paperclip is materially stronger in:

- multi-user access
- invites
- memberships
- coarse human roles
- instance-admin concept
- company-scoped permissions

Our current project is still much more single-operator in spirit.

## Strong parts

### Membership model

`company_memberships` plus permission grants is a solid base:

- principal type
- principal id
- company id
- status
- membership role

That is a real control-plane access model.

### Company access checks

`assertCompanyAccess` is a meaningful architectural center:

- agents cannot cross companies
- board users are limited by company membership
- viewer is read-only on mutating routes

This is much better than many comparable projects.

## Weak seams

### 1. Route closure bugs still matter, even if some are historical now

Issue `#20` is a good example:

- the model is company-scoped
- but one route forgot to apply company access checks
- cross-tenant agent-key creation became possible

This shows the usual truth:

⚠️ good access models still fail when route closure is inconsistent.

Important nuance from the deeper pass:

- current `master` appears to have fixed this specific route family by routing key management through `getAccessibleAgent()` plus `assertCompanyAccess`
- the lesson is still valuable, but this one now looks more like a historical warning than a still-live hole

### 2. Board-centric assumptions can block valid agent behavior

Issue `#3271`:

- plugin tool endpoints used `assertBoard`
- agent JWTs could not access tools that should be agent-usable

This is a classic policy/personality mismatch.

And this one still looks live on current `master`:

- plugin tool routes still front-load `assertBoardOrgAccess(req)`
- only later do they apply `assertCompanyAccess(req, runContext.companyId)`

So the product story says "runtime tool surface", while the route still behaves like a board surface.

### 3. Authenticated bootstrap is still fragile

Issue `#3181` is especially important because it blocks first-admin creation in authenticated installs.

That makes onboarding an architectural seam, not only a UX problem.

## Role model maturity

The role system is still fairly coarse:

- owner
- admin
- operator
- viewer

This is probably the right V1/V2 trade-off.

It is better than pretending to have rich enterprise RBAC too early.

## Architect takeaway

Steal:

- explicit membership rows
- company-scoped access model
- company access assertions as a core boundary

Avoid:

- assuming a good model is enough without route-by-route closure
- letting "board-only" assumptions leak into surfaces that agents actually need
