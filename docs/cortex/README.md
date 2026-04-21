# Cortex Structured Notes

Date: 2026-04-16
Studied revision: `38d505069113dc558654025e4fff91b08b35b34f` on `main`

This folder is the structured companion to:

- `docs/cortex-competitor-deep-analysis.md`

Use it when you want fast lookup by seam instead of one giant document.

## Short verdict

Cortex is a very young but architecturally interesting competitor.

In practice:

- it has strong OTP taste and much more distributed-systems imagination than most agent projects
- the DAG, mesh, gossip, sidecar, and LiveView surfaces are real, not just README cosplay
- but its durable truth is still much more workspace-file-first than engine-first
- so it currently feels more like a sophisticated orchestration lab than a calm durable platform

## Quick index

- `00-summary.md`
  - one-page verdict, strongest parts, weakest parts
- `01-repo-facts-and-traction.md`
  - verified repo facts, releases, contributors, issues, test/doc maturity signals
- `02-otp-runtime-and-supervision.md`
  - supervision tree, OTP taste, registries, long-running process model
- `03-orchestration-engine-and-truth-model.md`
  - DAG engine, gating, workspace truth, DB role, outcomes
- `04-mesh-gossip-and-distributed-ideas.md`
  - what is genuinely interesting in mesh/gossip and what is still soft
- `05-gateway-sidecar-and-external-workers.md`
  - gRPC gateway, sidecar worker, external provider, pending task routing
- `06-recovery-and-reconciliation.md`
  - log parser, workspace sync, reconcile/resume model, coordinator crash recovery
- `07-ui-observability-and-product-surface.md`
  - LiveView UI, event model, dashboard value, projection limits
- `08-tests-history-and-maturity.md`
  - CI, test surface, churn, repo age, proof-vs-story analysis
- `09-best-practices-to-steal.md`
  - patterns worth copying into a new orchestrator
- `10-critical-anti-patterns-to-avoid.md`
  - patterns that should trigger design-review rejection
- `11-compare-vs-goclaw-gastown-and-us.md`
  - where Cortex is stronger, weaker, and differently shaped
- `12-scorecard-and-main-verdict.md`
  - subsystem scores and plain-language verdict
- `13-strong-ideas-beneath-early-maturity.md`
  - the best ideas that are better than the repo’s proof level
- `14-workspace-first-vs-db-first.md`
  - why Cortex currently feels file-first and what that means
- `15-top-architect-takeaways.md`
  - dense architect synthesis of what to copy and what to forbid
- `16-quiet-engineering-and-soft-edges.md`
  - smaller good decisions, softer contracts, and pragmatic seams that could age badly

## Fast lookup by question

- "What is Cortex in one page?"
  - `00-summary.md`
- "How real is the traction and maturity?"
  - `01-repo-facts-and-traction.md`
  - `08-tests-history-and-maturity.md`
- "How strong is their OTP/runtime architecture?"
  - `02-otp-runtime-and-supervision.md`
- "How strong is the orchestration engine really?"
  - `03-orchestration-engine-and-truth-model.md`
  - `14-workspace-first-vs-db-first.md`
- "Are mesh and gossip real or mostly story?"
  - `04-mesh-gossip-and-distributed-ideas.md`
- "How serious is the gateway/sidecar path?"
  - `05-gateway-sidecar-and-external-workers.md`
- "What happens after crashes and half-finished runs?"
  - `06-recovery-and-reconciliation.md`
- "How good is their UI/observability surface?"
  - `07-ui-observability-and-product-surface.md`
- "What should we steal?"
  - `09-best-practices-to-steal.md`
- "What must we not copy?"
  - `10-critical-anti-patterns-to-avoid.md`
- "How does Cortex compare to GoClaw, Gastown, and us?"
  - `11-compare-vs-goclaw-gastown-and-us.md`
- "Give me the scorecard and bottom line"
  - `12-scorecard-and-main-verdict.md`
- "What are the strongest ideas hidden inside this early repo?"
  - `13-strong-ideas-beneath-early-maturity.md`
- "Why does it feel research-grade rather than platform-grade?"
  - `14-workspace-first-vs-db-first.md`
- "Give me the shortest architect synthesis"
  - `15-top-architect-takeaways.md`
- "What smaller engineering decisions are worth stealing and what soft edges should worry us?"
  - `16-quiet-engineering-and-soft-edges.md`

## Reading order

If you have 5 minutes:

1. `00-summary.md`
2. `09-best-practices-to-steal.md`
3. `10-critical-anti-patterns-to-avoid.md`
4. `12-scorecard-and-main-verdict.md`
5. `15-top-architect-takeaways.md`

If you have 20 minutes:

1. `00-summary.md`
2. `02-otp-runtime-and-supervision.md`
3. `03-orchestration-engine-and-truth-model.md`
4. `04-mesh-gossip-and-distributed-ideas.md`
5. `05-gateway-sidecar-and-external-workers.md`
6. `06-recovery-and-reconciliation.md`
7. `08-tests-history-and-maturity.md`
8. `11-compare-vs-goclaw-gastown-and-us.md`
9. `12-scorecard-and-main-verdict.md`
10. `14-workspace-first-vs-db-first.md`
11. `15-top-architect-takeaways.md`
12. `16-quiet-engineering-and-soft-edges.md`
