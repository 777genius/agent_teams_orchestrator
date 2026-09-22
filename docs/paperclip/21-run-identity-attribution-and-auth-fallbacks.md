# Run Identity Attribution And Auth Fallbacks

## The strong idea

`paperclip` does have a real identity center.

`server/src/middleware/auth.ts` explicitly distinguishes:

- board session
- board API key
- agent API key
- agent JWT
- local trusted implicit board

That is a good shape.

It is much better than systems that reconstruct actor identity from random headers deep in handlers.

## What became clearer

The deeper pass showed that the weak seam is not "missing auth model".

The weak seam is:

- convenience fallback
- run attribution
- comment authorship
- self-comment suppression

all meeting in one place.

## What is strong

### Run-scoped JWT is the right direction

For local subprocess adapters, Paperclip tries to inject a per-run local agent JWT.

That is a genuinely good contract:

- run has its own identity
- mutating calls can carry `run_id`
- comments and activity can be tied back to the execution

This is much better than relying only on prompt text.

### One middleware decides actor shape

The centralization in `actorMiddleware()` is a real strength.

Architecturally, it means:

- actor resolution is visible
- route code can stay smaller
- board vs agent identity is at least conceptually explicit

## The expensive seam

### `local_trusted` starts from implicit board identity

In `local_trusted` mode, `actorMiddleware()` starts every request as:

- `type = "board"`
- `source = "local_implicit"`

before any bearer auth is resolved.

That is convenient for local operators.

But it means the fallback personality is already board-shaped.

### `X-Paperclip-Run-Id` alone does not become agent identity

If there is no bearer token, but `x-paperclip-run-id` exists, current code only attaches:

- `req.actor.runId = runIdHeader`

It does **not** resolve the run back into:

- agent actor
- company
- run-scoped authority

That matters because a request can now carry:

- run context
- but not run-backed actor identity

This is exactly the kind of seam that later turns into attribution bugs.

### Missing JWT secret downgrades local runs into weaker truth

`server/src/services/heartbeat.ts` will warn and continue if local JWT generation fails:

- `local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY`

That is operator-friendly.

But it is also dangerous because the run can continue in a weaker auth state.

Issue `#3817` is the clearest manifestation:

- agent completion comment can be attributed to the user
- self-comment suppression does not trigger
- agent retriggers itself
- `done` can drift back into active states

The core lesson is:

⚠️ convenience fallback + run attribution + wake policy is a dangerous combination.

## Why this is architecturally interesting

This is not a generic auth bug.

It is a contract-honesty seam.

The system already knows:

- actor identity matters
- run identity matters
- comment authorship matters

But the fallback path still allows those to partially separate.

That is why the resulting bugs are so costly:

- audit drift
- duplicate comments
- false reruns
- status regression

## Architect takeaway

Steal:

- one explicit actor middleware
- run-scoped JWT identity for local subprocess execution
- comment rows carrying `createdByRunId`

Avoid:

- defaulting to a stronger human actor when run-scoped auth is absent
- letting `runId` travel without a matching resolved actor
- treating attribution fallback as harmless in a system where comments trigger execution
