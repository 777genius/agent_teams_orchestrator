# Paperclip Summary

## One-page verdict

Paperclip is strong where it behaves like a durable company control plane:

- companies
- org charts
- goals
- issues
- approvals
- budgets
- memberships
- heartbeat runs

It is weaker where too much of the execution loop still depends on repeated model wakes and route-specific/product-specific glue:

- heartbeat prompt cost
- swallowed or missing wakeups
- overloaded review semantics
- false-green run outcomes
- auth closure on some routes
- workspace power boundaries

## Shortest fair comparison vs us

- As a **company control plane**, `paperclip` is stronger.
- As a **terminal-first coding orchestrator**, our current project is stronger.

## Best parts

- explicit execution semantics
- single-assignee + checkout model
- durable approval/budget/governance objects
- adapter model split into server/UI/CLI
- plugin capability model
- embedded Postgres operator story

## Weakest parts

- expensive heartbeat tax
- wake routing edge cases
- `in_review` overloaded with too many meanings
- route-level auth seams
- dangerous workspace power surfaces
- docs sometimes ahead of real operator discoverability

## Confidence

- Paperclip as durable control plane: `🎯 9.2   🛡️ 8.9   🧠 6`
- Paperclip as coding runtime: `🎯 8.9   🛡️ 8.6   🧠 4`
