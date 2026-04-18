# Critical Anti Patterns To Avoid

## 1. Expensive heartbeat tax

`🎯 9.9   🛡️ 9.2   🧠 6`

If "is there work?" still requires a fat model wake, cost becomes architecture.

This is one of the most important Paperclip warnings.

## 2. Success equals exit code

`🎯 9.8   🛡️ 9.1   🧠 4`

If the agent exits 0 but did no useful work, the orchestrator must not paint that run green.

## 3. Overloaded review state

`🎯 9.6   🛡️ 8.9   🧠 4`

One `in_review` state should not mean:

- direction review
- deliverable acceptance
- management sign-off

at the same time.

## 4. Governance objects without full operator discoverability

`🎯 9.5   🛡️ 8.8   🧠 3`

If approvals exist in DB and API but operators still cannot find them easily, the product loop is still incomplete.

## 5. Route-level auth drift

`🎯 9.7   🛡️ 9.0   🧠 4`

A good access model is not enough if individual routes forget to enforce it consistently.

## 6. Powerful workspace commands without a hard safety boundary

`🎯 9.8   🛡️ 9.0   🧠 5`

Provision and teardown commands are not just convenience.

They are host-power surfaces.

## 7. Breadth outruns seam closure

`🎯 9.4   🛡️ 8.7   🧠 6`

Paperclip is broad enough that:

- approvals
- heartbeats
- workspaces
- plugins
- budgets
- multi-user access

all compete for closure at once.

That creates maintenance tax.

## 8. Convenience fallback stronger than run identity

`🎯 9.6   🛡️ 9.0   🧠 4`

If missing run-scoped auth quietly falls back to a stronger human actor, comment authorship and self-wake suppression can drift in very expensive ways.

## 9. Board-first routes on execution-side surfaces

`🎯 9.5   🛡️ 8.9   🧠 4`

If plugin or runtime execution surfaces still front-load board-only auth, product capability promises will drift from what agents can actually do.

## 10. Parent-child coordination that still depends on timer rediscovery

`🎯 9.3   🛡️ 8.7   🧠 5`

If child completion does not produce a first-class parent wake, manager orchestration gets pushed into prompts, timers, and manual nudges.

## 11. Dangerous unattended adapter defaults

`🎯 9.6   🛡️ 9.0   🧠 4`

If sandbox-bypass or permission-skip flags become the normal default path for local agents, safety posture quietly inverts.

## 12. Process success mistaken for task truth

`🎯 9.8   🛡️ 9.1   🧠 4`

A clean exit with no meaningful work movement must not become a green run by default.

## 13. Stale-lock fallback narrower than the uniqueness contract

`🎯 9.7   🛡️ 9.1   🧠 5`

If the DB says an open routine execution issue already blocks creation, recovery code must be able to find that blocker even when its run link is stale or terminal.

Otherwise duplicate-key handling becomes operator pain, not resilience.

## 14. Strong local redaction helpers with weak HTTP logging closure

`🎯 9.6   🛡️ 9.1   🧠 4`

Having several good redaction utilities does not help if the public HTTP error logger still writes raw request bodies.

Whole-surface observability safety matters more than isolated helper quality.

## 15. Prompt-side compatibility fixes instead of storage normalization

`🎯 9.3   🛡️ 8.8   🧠 4`

If managed instruction bundles still rely on runtime hints to resolve legacy path dialects, the storage contract is not actually closed.

Fix persisted truth first, not only runtime interpretation.
