# GoClaw Structured Notes

Date: 2026-04-16
Studied revision: `f5917b0e` on `origin/dev`

This folder is the structured companion to the large archive:

- `docs/goclaw-competitor-deep-analysis.md`

Use this folder when you want fast lookup by seam instead of one giant document.

## Short verdict

GoClaw has a strong orchestration engine and weak seams around that engine.

In practice:

- the durable task core is genuinely strong
- scheduler and recovery are solid
- identity, execution-mode, event, UI, and auth seams are much weaker

## Quick index

- `00-summary.md`
  - one-page verdict, strongest parts, weakest parts
- `01-scorecard.md`
  - subsystem scores and short interpretation
- `02-engine-core.md`
  - task lifecycle, recovery, scheduler, staged runtime
- `03-consistency-and-events.md`
  - how many truths the system really has
- `04-scheduler-and-admission.md`
  - queue core vs real ingress shell
- `05-identity-and-context.md`
  - actor, scope, sender, `UserID`, context sprawl
- `06-execution-modes-and-run-contract.md`
  - `RunKind`, announce/delegate/notification, path-specific envelopes
- `07-auth-policy-and-access.md`
  - RBAC, viewer defaults, human access checks, fail-open seams
- `08-ui-and-realtime.md`
  - backend truth vs UI truth, websocket/event projection problems
- `09-providers-and-runtime-boundaries.md`
  - provider failures, fake-success seams, orchestration impact
- `10-tests-history-and-issues.md`
  - hotspots, churn, test gaps, issue clusters, patch-train signals
- `11-strong-decisions.md`
  - what is genuinely good and worth stealing
- `12-mistakes-and-lessons.md`
  - what is dangerous and should not be copied
- `13-best-practices-to-steal.md`
  - architect-level practices worth adopting
- `14-critical-anti-patterns-to-avoid.md`
  - dangerous patterns that should be treated as red flags
- `15-architecture-lenses.md`
  - review the system from multiple architect perspectives
- `16-compensating-architecture-signals.md`
  - where GoClaw uses healthy compensation vs compensating for missing contracts
- `17-docs-and-product-drift.md`
  - where docs, product story, and runtime diverge
- `18-evolution-hotspots-and-maintenance-cost.md`
  - what git history says about the most expensive seams
- `19-top-architect-takeaways.md`
  - short architect-grade synthesis of what to copy and what to avoid
- `20-extensibility-and-surface-maturity.md`
  - which extension surfaces are actually mature and which are drift-prone
- `21-operations-onboarding-and-product-lessons.md`
  - what deployment and onboarding say about the architecture
- `22-security-vs-availability-tradeoffs.md`
  - where availability-first helps and where it becomes dangerous
- `23-first-class-vs-soft-subsystems.md`
  - which subsystems are genuinely mature and which are still semantically soft
- `24-type-discipline-and-contract-honesty.md`
  - where names, labels, and types stop matching real semantics
- `25-hidden-design-laws.md`
  - repeated design laws that explain why the system is both strong and expensive
- `26-ingress-and-transport-tax.md`
  - what many transports do to correctness and maintenance cost
- `27-multi-tenant-and-edition-split-lessons.md`
  - lessons from strong tenanting and PG/SQLite edition parity
- `28-cache-invalidation-and-freshness.md`
  - where cache design is strong and where freshness contracts fragment
- `29-migrations-and-backward-compat-pressure.md`
  - what they do right in migration discipline and where compatibility becomes runtime tax
- `30-hooks-as-a-reference-subsystem.md`
  - one of the best positive reference implementations in the codebase
- `31-breadth-vs-contract-pressure.md`
  - how product breadth multiplies pressure on execution contracts
- `32-steal-vs-ban-checklist.md`
  - condensed architect checklist of what to copy and what to forbid
- `33-observability-and-debuggability.md`
  - tracing, auditability, debugging surface, and where signals still fail to converge
- `34-failure-domains-and-scaling-pressure.md`
  - where scaling is strong and where failure domains multiply
- `35-best-practices-by-architect-role.md`
  - role-specific lessons for domain, runtime, security, platform, ops, and frontend architects
- `36-architect-playbook.md`
  - dense architect playbook with laws, anti-laws, direct copy patterns, and review-time bans
- `37-non-obvious-good-decisions.md`
  - smaller but high-quality engineering decisions worth stealing
- `38-subtle-risks-and-anti-patterns.md`
  - quiet patterns that look locally reasonable but become dangerous system-wide
- `39-reusable-patterns-beyond-the-core.md`
  - smaller reusable engineering patterns beyond the obvious orchestration core
- `40-hidden-control-plane-risks.md`
  - how hints, budgets, wrappers, and compatibility branches can become a shadow control plane
- `41-idempotency-and-operational-contracts.md`
  - skill upload idempotency, restore modes, versioning, session write-behind, owner/bypass semantics
- `42-quiet-engineering-taste-and-platform-risks.md`
  - direct-exec boundaries, shell hardening, bounded dedup, observer-driven hardening, quiet platform risks
- `43-protective-friction-and-guarded-power.md`
  - package/runtime protections, rate limiting, SSRF-safe hooks, permission modes, guarded power surfaces
- `44-operator-facing-honesty-and-product-drift.md`
  - onboarding truth, Docker vs native drift, update semantics, config clarity, operator-facing contract honesty
- `45-reference-security-surfaces.md`
  - local security subsystems worth copying: hook env allowlists, SSRF-safe HTTP, ACP permission modes, constrained binary intake
- `46-capability-drift-and-surface-promises.md`
  - how docs, UI, routes, images, and environments drift apart and overstate product maturity
- `47-defensive-minimalism-and-scoped-capability.md`
  - prompt modes, context allowlists, bootstrap narrowing, prompt budgeting, and the fail-open risks in reduced modes
- `48-reasoning-budgets-and-compatibility-shadows.md`
  - provider-owned reasoning defaults, reserve tokens, reasoning fallback policy, and the compatibility shadow from legacy thinking controls
- `49-bootstrap-onboarding-and-contract-healing.md`
  - BOOTSTRAP as explicit first-run state, auto-healing onboarding flows, and the drift risks around comments, prompts, and ingress-specific shortcuts
- `50-vault-ingestion-and-defensive-omission.md`
  - safe workspace walking, symlink refusal, external-content distrust, exclusion of authority-bearing context files, and small drift risks in this ingestion layer
- `51-input-guard-and-untrusted-content-boundaries.md`
  - prompt-injection tripwires, detection vs blocking, MCP/web untrusted-content marking, and the limits of regex-based guards

## Fast lookup by question

- "How good is their core engine?"
  - `02-engine-core.md`
- "Why do identity and permissions keep causing trouble?"
  - `05-identity-and-context.md`
  - `07-auth-policy-and-access.md`
- "Why is `announce` / `delegate` / `notification` structurally shaky?"
  - `06-execution-modes-and-run-contract.md`
- "Why can backend truth and UI truth drift apart?"
  - `03-consistency-and-events.md`
  - `08-ui-and-realtime.md`
- "How good is their scheduler really?"
  - `04-scheduler-and-admission.md`
- "What do history and issues say about the real weak seams?"
  - `10-tests-history-and-issues.md`
- "What should we steal?"
  - `11-strong-decisions.md`
  - `13-best-practices-to-steal.md`
- "What must we not repeat?"
  - `12-mistakes-and-lessons.md`
  - `14-critical-anti-patterns-to-avoid.md`
- "How would a top architect review this from different angles?"
  - `15-architecture-lenses.md`
- "Where do they use compensation well vs badly?"
  - `16-compensating-architecture-signals.md`
- "Where are docs stronger than runtime reality?"
  - `17-docs-and-product-drift.md`
- "What does history say about their real maintenance tax?"
  - `18-evolution-hotspots-and-maintenance-cost.md`
- "What are the sharpest architect takeaways?"
  - `19-top-architect-takeaways.md`
- "Which extension surfaces are truly first-class?"
  - `20-extensibility-and-surface-maturity.md`
- "What does ops/onboarding reveal about the architecture?"
  - `21-operations-onboarding-and-product-lessons.md`
- "How do security and availability trade off in this system?"
  - `22-security-vs-availability-tradeoffs.md`
- "Which parts are truly first-class and which only look first-class?"
  - `23-first-class-vs-soft-subsystems.md`
- "Where does the code lose type/contract honesty?"
  - `24-type-discipline-and-contract-honesty.md`
- "What hidden laws actually govern the system?"
  - `25-hidden-design-laws.md`
- "What tax do many transports and ingress paths create?"
  - `26-ingress-and-transport-tax.md`
- "What do multi-tenancy and edition split teach us?"
  - `27-multi-tenant-and-edition-split-lessons.md`
- "How good is their cache invalidation and freshness discipline?"
  - `28-cache-invalidation-and-freshness.md`
- "What do migrations and backward compatibility teach us?"
  - `29-migrations-and-backward-compat-pressure.md`
- "Which subsystem should we copy as a positive reference?"
  - `30-hooks-as-a-reference-subsystem.md`
- "How does product breadth create architecture tax?"
  - `31-breadth-vs-contract-pressure.md`
- "Give me the shortest architect checklist of what to steal and what to ban"
  - `32-steal-vs-ban-checklist.md`
- "How good is their observability and debugging model?"
  - `33-observability-and-debuggability.md`
- "Where do failure domains and scaling pressure really live?"
  - `34-failure-domains-and-scaling-pressure.md`
- "Translate this study into lessons by architect role"
  - `35-best-practices-by-architect-role.md`
- "Give me the densest architect playbook from the whole study"
  - `36-architect-playbook.md`
- "What quietly good engineering decisions are easy to miss?"
  - `37-non-obvious-good-decisions.md`
- "What subtle anti-patterns should trigger review alarms?"
  - `38-subtle-risks-and-anti-patterns.md`
- "What quieter engineering patterns are worth stealing beyond the core?"
  - `39-reusable-patterns-beyond-the-core.md`
- "Where could a hidden control plane form?"
  - `40-hidden-control-plane-risks.md`
- "What good operational and idempotency patterns are worth stealing?"
  - `41-idempotency-and-operational-contracts.md`
- "What quieter engineering taste is worth copying and what small risks should alarm us?"
  - `42-quiet-engineering-taste-and-platform-risks.md`
- "What guarded power and protective friction patterns are worth stealing?"
  - `43-protective-friction-and-guarded-power.md`
- "Where does operator-facing truth drift away from runtime reality?"
  - `44-operator-facing-honesty-and-product-drift.md`
- "Which local security surfaces are actually worth copying?"
  - `45-reference-security-surfaces.md`
- "How do product surfaces over-promise capability?"
  - `46-capability-drift-and-surface-promises.md`
- "What does GoClaw get right and wrong in prompt slimming and scoped capability?"
  - `47-defensive-minimalism-and-scoped-capability.md`
- "How do reasoning controls, token budgets, and legacy shims interact?"
  - `48-reasoning-budgets-and-compatibility-shadows.md`
- "What does their bootstrap/onboarding layer teach us?"
  - `49-bootstrap-onboarding-and-contract-healing.md`
- "What do their vault ingestion rules teach us?"
  - `50-vault-ingestion-and-defensive-omission.md`
- "How honest is their prompt-injection and untrusted-content safety layer?"
  - `51-input-guard-and-untrusted-content-boundaries.md`
- "What does their workspace sharing model teach us?"
  - `52-workspace-sharing-and-dual-workspace-truth.md`
- "What does their RunContext migration teach us?"
  - `53-run-context-consolidation-and-carrier-drift.md`
- "What does their self-adaptation layer teach us?"
  - `54-measured-self-adaptation-and-evolution-boundaries.md`
- "What does their compaction and pruning model teach us?"
  - `55-context-pressure-and-shadow-policy.md`

## Reading order

If you have 5 minutes:

1. `00-summary.md`
2. `01-scorecard.md`
3. `12-mistakes-and-lessons.md`

If you have 20 minutes:

1. `02-engine-core.md`
2. `05-identity-and-context.md`
3. `06-execution-modes-and-run-contract.md`
4. `07-auth-policy-and-access.md`
5. `10-tests-history-and-issues.md`
6. `16-compensating-architecture-signals.md`
7. `19-top-architect-takeaways.md`
8. `20-extensibility-and-surface-maturity.md`
9. `21-operations-onboarding-and-product-lessons.md`
10. `22-security-vs-availability-tradeoffs.md`
11. `23-first-class-vs-soft-subsystems.md`
12. `24-type-discipline-and-contract-honesty.md`
13. `25-hidden-design-laws.md`
14. `26-ingress-and-transport-tax.md`
15. `27-multi-tenant-and-edition-split-lessons.md`
16. `28-cache-invalidation-and-freshness.md`
17. `29-migrations-and-backward-compat-pressure.md`
18. `30-hooks-as-a-reference-subsystem.md`
19. `31-breadth-vs-contract-pressure.md`
20. `32-steal-vs-ban-checklist.md`
21. `33-observability-and-debuggability.md`
22. `34-failure-domains-and-scaling-pressure.md`
23. `35-best-practices-by-architect-role.md`
24. `36-architect-playbook.md`
25. `37-non-obvious-good-decisions.md`
26. `38-subtle-risks-and-anti-patterns.md`
27. `39-reusable-patterns-beyond-the-core.md`
28. `40-hidden-control-plane-risks.md`
29. `41-idempotency-and-operational-contracts.md`
30. `42-quiet-engineering-taste-and-platform-risks.md`
31. `43-protective-friction-and-guarded-power.md`
32. `44-operator-facing-honesty-and-product-drift.md`
33. `45-reference-security-surfaces.md`
34. `46-capability-drift-and-surface-promises.md`
35. `47-defensive-minimalism-and-scoped-capability.md`
36. `48-reasoning-budgets-and-compatibility-shadows.md`
37. `49-bootstrap-onboarding-and-contract-healing.md`
38. `50-vault-ingestion-and-defensive-omission.md`
39. `51-input-guard-and-untrusted-content-boundaries.md`
40. `52-workspace-sharing-and-dual-workspace-truth.md`
41. `53-run-context-consolidation-and-carrier-drift.md`
42. `54-measured-self-adaptation-and-evolution-boundaries.md`
43. `55-context-pressure-and-shadow-policy.md`
