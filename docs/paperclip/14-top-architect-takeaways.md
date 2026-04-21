# Top Architect Takeaways

## Shortest architect synthesis

Paperclip is best understood as:

- a strong **durable control-plane center**
- wrapped in a more expensive **heartbeat execution shell**

## Laws worth copying

### Law 1. Persisted objects beat conversational reconstruction

Companies, issues, approvals, budgets, and memberships should be real rows, not UI illusions.

### Law 2. Structure, dependency, ownership, and execution are different things

Do not blur:

- parenthood
- blockers
- assignee
- live run

### Law 3. Recovery is normal runtime, not panic cleanup

Conservative automatic repair followed by visible escalation is a good law.

### Law 4. Governance belongs in the same control plane

If approvals and budgets matter, they should not live outside the orchestrator.

### Law 5. Extensions need hard host boundaries

Capability-gated plugins are much better than ad hoc extension hooks.

### Law 6. Portability only counts when governance stays honest

Import flows must either create explicit pending objects or fail loudly.

### Law 7. Run identity must stay stronger than convenience fallback

If comments, wakes, and audit depend on run attribution, missing run-scoped auth cannot quietly degrade into a stronger human actor.

### Law 8. Host power must be named as host power

Workspace commands and runtime-service launch surfaces are not convenience toggles once they execute shell on the host.

### Law 9. Trusted-local mode needs a hard deployment envelope

If you offer an operator-convenience mode, constrain it at startup with bind/exposure invariants instead of relying on docs alone.

### Law 10. Success must mean work truth, not clean exit

Run outcome should reflect whether the assigned work advanced honestly, not only whether the adapter process exited without error.

### Law 11. Retries and duplicates need service-level idempotency, not route folklore

The approval subsystem gets this mostly right:

- mutate conditionally
- return whether state actually changed
- gate side effects on that fact

That law should be generalized anywhere dispatch, wakeups, or retries exist.

### Law 12. Storage normalization is stronger than prompt hints

If a managed instructions bundle has a canonical storage form, persist that form.

Do not rely on runtime instructions to repair legacy path dialects forever.

### Law 13. Observability must be sealed as a whole surface

Local redaction helpers are not enough.

The HTTP logger, event logger, transcript logger, and activity logger all need the same contract honesty.

## Anti-laws to ban

### Ban 1. Paying too much orchestration cost through LLM heartbeats

Cheap deterministic checks should answer "is there work?" whenever possible.

### Ban 2. Exit code as the only success contract

Meaningful success must reflect actual work movement, not only clean process exit.

### Ban 3. One status carrying several different human meanings

Review states need explicit semantics.

### Ban 4. Route auth by habit instead of by closed contract

Good models fail if route closure is inconsistent.

### Ban 5. Power surfaces without a hard safety boundary

Workspace provisioning commands are security boundaries, not convenience flags.

### Ban 6. Layered wake/retry/reopen rules becoming a hidden engine

If the coordination shell grows richer than the center contract, cost and debugging tax will compound fast.

### Ban 7. Board-first personalities on execution routes

Execution-side surfaces should not keep inheriting board-only route behavior after the runtime model says agents need them.

### Ban 8. Timer-driven rediscovery as the main coordination path

Parent-child progression and approval revision loops should not depend mainly on the next heartbeat noticing state.

### Ban 9. Dangerous local-adapter flags as the default experience

If unattended throughput requires a dangerous flag, that flag should stay visibly dangerous.

### Ban 10. Strong local hardening in one subsystem used as an excuse for softer defaults elsewhere

One SSRF-safe plugin layer does not compensate for dangerous shell, auth, or task-truth seams elsewhere.

### Ban 11. Uniqueness recovery that only understands "live" instead of "blocking"

If the DB uniqueness rule blocks on a stale open object, recovery code must understand that same blocker shape.

### Ban 12. Raw request-body logging on error paths

Error logging is part of the security boundary in a self-hosted control plane.

### Ban 13. Compatibility shadows that outlive the migration

Legacy bundle paths, legacy prompts, and route-level hints should not quietly become a permanent second contract.

## Final verdict

Steal from Paperclip:

- durable control-plane laws
- execution contract clarity
- governance objects

Do not copy from Paperclip:

- expensive heartbeat tax
- false-green success behavior
- overloaded review states
- coordination correctness spread across coalescing, retries, deferred promotion, and reopen rules
- stale-lock recovery that is narrower than the blocking truth in the DB
- uneven observability hygiene across logger surfaces
- compatibility shadows around managed instruction bundles
- product breadth before seam closure
