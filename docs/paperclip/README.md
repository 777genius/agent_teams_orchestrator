# Paperclip Structured Notes

Date: 2026-04-18
Studied revision: `b9a80dcf226c50c8778a70443e41557980376a03` on `master`

This folder is the structured companion to the large archive:

- `docs/paperclip-competitor-deep-analysis.md`

Use this folder when you want fast lookup by seam instead of one large document.

## Short verdict

Paperclip has a strong durable company control plane and a weaker, more expensive heartbeat-driven execution shell.

In practice:

- the company/task/governance center is genuinely strong
- the local coding-runtime story is much weaker than our current project
- heartbeat cost, review semantics, wake routing, and some auth/workspace edges are where the pain concentrates

## Quick index

- `00-summary.md`
  - one-page verdict and quick comparison
- `01-repo-facts-and-positioning.md`
  - repo facts, product thesis, stack, and what kind of system it is really building
- `02-domain-and-control-plane.md`
  - companies, orgs, goals, issues, approvals, budgets, memberships
- `03-execution-engine-and-heartbeats.md`
  - checkout, execution locks, wakeups, stranded-work recovery, false-green risks
- `04-adapters-runtime-and-sessions.md`
  - adapter split, runtime shape, session resume, compaction, prompt tax
- `05-approvals-budgets-and-governance.md`
  - approvals, budget incidents, board powers, governance strengths and weak seams
- `06-auth-access-and-multi-user.md`
  - memberships, grants, invites, route auth, company access
- `07-workspaces-and-runtime-services.md`
  - isolated/shared workspaces, runtime services, power surfaces, security trade-offs
- `08-plugins-and-extension-model.md`
  - capability gating, sandboxing, extension maturity, auth drift
- `09-ui-product-surface-and-operator-story.md`
  - board UI, discoverability, activity surface, docs/runtime drift
- `10-issues-hotspots-and-tests.md`
  - issue clusters, churn hotspots, test density, real maintenance cost
- `11-best-practices-to-steal.md`
  - what is genuinely worth copying
- `12-critical-anti-patterns-to-avoid.md`
  - what should be treated as red flags
- `13-compare-vs-us.md`
  - direct comparison versus `agent_teams_orchestrator`
- `14-top-architect-takeaways.md`
  - dense architect summary of what to copy and what to ban
- `15-company-portability-and-package-model.md`
  - markdown-first company packages, GitHub-native import/export, and the strategic upside/risk of company portability
- `16-heartbeat-recovery-and-wakeup-seams.md`
  - deeper pass on wake coalescing, deferred promotion, comment backstops, recovery wakes, and loop risks
- `17-auth-route-closure-and-capability-drift.md`
  - current-head auth closure reality: what is historically fixed, what is still open, and where capability drift remains
- `18-operator-truth-and-state-honesty.md`
  - where the operator UI is strong, and where blocked/live/review/approval truth still drifts
- `19-portability-and-governance-import-seams.md`
  - what is strategically strong about portability, and where GitOps/governance/operator honesty can still break
- `20-adapter-cost-and-context-pressure.md`
  - heartbeat prompt tax, session compaction mistakes, universal skill bloat, and adapter truth drift
- `21-run-identity-attribution-and-auth-fallbacks.md`
  - actor middleware strength, local-trusted fallback, run attribution drift, and why comment authorship is an execution seam
- `22-approval-loop-and-stage-overload.md`
  - approval route honesty, missing requester wakes, and why `in_review` still carries too much meaning
- `23-workspace-power-and-host-boundaries.md`
  - host-executed workspace commands, runtime-service auth, portability omission, and where power is actually guarded
- `24-noninteractive-control-plane-and-automation-gaps.md`
  - where board control is strong, but non-browser operator automation is still softer than the product story
- `25-parent-child-coordination-and-manager-wakes.md`
  - why hierarchy exists, but manager progression is still weaker and more timer-driven than a true reactive orchestrator
- `26-security-defaults-and-deployment-envelope.md`
  - dangerous adapter defaults, local_trusted envelope, JWT/telemetry posture, and what is actually still live versus stale in security issue reports
- `27-plugin-network-boundaries-and-defensive-security-taste.md`
  - SSRF-safe plugin HTTP fetch, pinned IP routing, no-redirect behavior, and why this subsystem is stronger than many other seams
- `28-false-green-runs-and-task-truth.md`
  - why process success is still too close to run success, and where Paperclip still lacks a stronger task-truth contract
- `29-idempotency-and-stale-lock-integrity.md`
  - the sharp contrast between strong approval idempotency and weaker routine stale-lock recovery
- `30-observability-redaction-and-data-hygiene.md`
  - where local redaction taste is strong, but whole-surface logging and data hygiene still diverge
- `31-instruction-bundle-normalization-and-compatibility-shadows.md`
  - why managed instruction bundles are promising, but legacy compatibility carriers still cast a portability shadow

## Fast lookup by question

- "What is Paperclip really trying to be?"
  - `01-repo-facts-and-positioning.md`
- "How strong is the domain/control-plane model?"
  - `02-domain-and-control-plane.md`
- "How strong is the task engine and heartbeat loop?"
  - `03-execution-engine-and-heartbeats.md`
- "Why does heartbeat cost keep showing up in issues?"
  - `03-execution-engine-and-heartbeats.md`
  - `04-adapters-runtime-and-sessions.md`
- "How good is the adapter/runtime model?"
  - `04-adapters-runtime-and-sessions.md`
- "How mature are approvals, budgets, and governance?"
  - `05-approvals-budgets-and-governance.md`
- "How good is multi-user access and auth?"
  - `06-auth-access-and-multi-user.md`
- "What is strong and risky about workspaces?"
  - `07-workspaces-and-runtime-services.md`
- "How good is the plugin model?"
  - `08-plugins-and-extension-model.md`
- "How good is the operator UI really?"
  - `09-ui-product-surface-and-operator-story.md`
- "What do issues and history say about the real pain points?"
  - `10-issues-hotspots-and-tests.md`
- "What should we steal?"
  - `11-best-practices-to-steal.md`
- "What must we avoid?"
  - `12-critical-anti-patterns-to-avoid.md`
- "How does it compare with our current project?"
  - `13-compare-vs-us.md`
- "Give me the shortest architect-level synthesis"
  - `14-top-architect-takeaways.md`
- "What is interesting about Paperclip's company portability/package model?"
  - `15-company-portability-and-package-model.md`
- "Where exactly is the expensive heartbeat shell weaker than the center model?"
  - `16-heartbeat-recovery-and-wakeup-seams.md`
  - `20-adapter-cost-and-context-pressure.md`
- "Which auth issues are historical versus still live in current master?"
  - `17-auth-route-closure-and-capability-drift.md`
- "Where does the operator UI drift from runtime truth?"
  - `18-operator-truth-and-state-honesty.md`
- "How good is the portability model really, and where does it clash with governance?"
  - `19-portability-and-governance-import-seams.md`
- "Where exactly can run identity drift into comment attribution and wake loops?"
  - `21-run-identity-attribution-and-auth-fallbacks.md`
- "How honest is the approval loop once you include request-revision, reject, and issue-stage review?"
  - `22-approval-loop-and-stage-overload.md`
- "How dangerous are workspace commands really, and what guards already exist?"
  - `23-workspace-power-and-host-boundaries.md`
- "Is Paperclip actually good for non-interactive operator bots or mediator agents?"
  - `24-noninteractive-control-plane-and-automation-gaps.md`
- "How good is parent-child manager orchestration in Paperclip?"
  - `25-parent-child-coordination-and-manager-wakes.md`
- "Which Paperclip security defaults are still really dangerous, and which issue claims are already stale?"
  - `26-security-defaults-and-deployment-envelope.md`
- "Do they have any genuinely strong security-oriented subsystem we should study?"
  - `27-plugin-network-boundaries-and-defensive-security-taste.md`
- "Where exactly does Paperclip still produce false-green runs?"
  - `28-false-green-runs-and-task-truth.md`
- "Which Paperclip subsystem already handles retries and duplicate actions honestly, and which one still looks stale-lock fragile?"
  - `29-idempotency-and-stale-lock-integrity.md`
- "How good is their logging/redaction hygiene really?"
  - `30-observability-redaction-and-data-hygiene.md`
- "How mature is the managed instruction bundle model, and where does compatibility drift remain?"
  - `31-instruction-bundle-normalization-and-compatibility-shadows.md`
