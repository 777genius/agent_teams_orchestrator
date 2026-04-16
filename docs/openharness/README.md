# OpenHarness Structured Notes

Date: 2026-04-16
Studied revision: `78160047` on `origin/main`

This folder is the structured companion to:

- `docs/openharness-competitor-analysis.md`

Use it when you want fast lookup by seam instead of one giant document.

## Short verdict

OpenHarness is a very promising young local-first agent harness with real multi-agent primitives, but it is not yet a calm mature orchestration platform.

In practice:

- the local coordination primitives are more serious than most new entrants
- worktree isolation, mailbox, headless worker mode, and atomic state fixes are real strengths
- the deepest current risks are dual models, soft coordinator contracts, file-based control planes, sandbox honesty gaps, and provider-specific assumptions

## Quick index

- `00-summary.md`
  - one-page verdict, strongest parts, weakest parts
- `01-repo-facts-and-traction.md`
  - verified repo facts, release state, issue pattern, maturity interpretation
- `02-runtime-and-core-architecture.md`
  - task manager, runtime model, auto-compaction, what the real center of the system is
- `03-multi-agent-coordination.md`
  - coordinator mode, team lifecycle, mailbox, permission sync, worktrees, backend registry
- `04-state-persistence-and-quiet-engineering.md`
  - atomic writes, file locks, metadata allowlists, contextvars isolation, local engineering taste
- `05-security-and-boundaries.md`
  - sandbox, personalization, prompt-side rules injection, policy honesty, boundary quality
- `06-issues-and-early-maturity-signals.md`
  - what the issue tracker says about current failure classes and maturity
- `07-best-practices-to-steal.md`
  - patterns worth copying into a new orchestrator
- `08-critical-anti-patterns-to-avoid.md`
  - patterns that should trigger design-review rejection
- `09-compare-vs-goclaw-and-us.md`
  - where OpenHarness is stronger, weaker, and differently shaped than GoClaw and our stack
- `10-top-architect-takeaways.md`
  - dense architect-grade synthesis
- `11-scorecard-and-main-verdict.md`
  - scorecard, strongest subsystems, weakest seams, plain-language verdict
- `12-strong-subsystems-and-quiet-engineering.md`
  - the best actual subsystems and the quiet engineering taste worth stealing
- `13-control-plane-and-soft-contracts.md`
  - where env flags, prompts, and file protocols start acting like the real control plane
- `14-compaction-continuity-and-context-pressure.md`
  - auto-compaction, continuity artifacts, checkpoint carryover, context-pressure lessons
- `15-security-boundaries-and-policy-honesty.md`
  - strongest security taste, weakest enforcement claims, policy honesty analysis
- `16-provider-surface-and-model-contracts.md`
  - provider registry, OpenAI-compatible layer, hard-coded model seams, portability verdict
- `17-ohmo-autopilot-and-growth-pressure.md`
  - `ohmo`, autopilot, gateway/runtime pooling, and growth-pressure analysis
- `18-tests-history-and-maturity.md`
  - direct test runs, churn, issue history, maturity and confidence levels
- `19-best-practices-by-architect-role.md`
  - what to steal and what to ban from domain/runtime/security/frontend/operator angles
- `20-architect-playbook.md`
  - shortest architect synthesis and laws after studying OpenHarness
- `21-compatibility-shadows-and-fallback-drift.md`
  - legacy/fallback seams, dual truths during migration, and early compatibility pressure
- `22-research-freeze-and-coverage-map.md`
  - what is already covered, what is directly verified, what is still softer interpretation

## Fast lookup by question

- "What is OpenHarness in one page?"
  - `00-summary.md`
- "How fresh and real is the traction?"
  - `01-repo-facts-and-traction.md`
- "What is their actual center of gravity?"
  - `02-runtime-and-core-architecture.md`
- "How serious are the multi-agent pieces?"
  - `03-multi-agent-coordination.md`
- "What quiet engineering taste is actually good?"
  - `04-state-persistence-and-quiet-engineering.md`
- "How honest are their security and sandbox stories?"
  - `05-security-and-boundaries.md`
- "What do the issues say about maturity?"
  - `06-issues-and-early-maturity-signals.md`
- "What should we steal?"
  - `07-best-practices-to-steal.md`
- "What must we not copy?"
  - `08-critical-anti-patterns-to-avoid.md`
- "How do they compare to GoClaw and us?"
  - `09-compare-vs-goclaw-and-us.md`
- "Give me the shortest architect synthesis"
  - `10-top-architect-takeaways.md`
- "Give me a scorecard and bottom-line verdict"
  - `11-scorecard-and-main-verdict.md`
- "Which subsystems are actually strong, not just advertised?"
  - `12-strong-subsystems-and-quiet-engineering.md`
- "Where does a hidden control plane start forming?"
  - `13-control-plane-and-soft-contracts.md`
- "How serious is compaction and continuity?"
  - `14-compaction-continuity-and-context-pressure.md`
- "How honest are their security boundaries?"
  - `15-security-boundaries-and-policy-honesty.md`
- "How portable is their provider layer really?"
  - `16-provider-surface-and-model-contracts.md`
- "How important are ohmo and autopilot?"
  - `17-ohmo-autopilot-and-growth-pressure.md`
- "How much should we trust their tests and maturity signals?"
  - `18-tests-history-and-maturity.md`
- "What should different architects steal or ban?"
  - `19-best-practices-by-architect-role.md`
- "What is the shortest architect playbook?"
  - `20-architect-playbook.md`
- "Where are the fallback and compatibility shadows?"
  - `21-compatibility-shadows-and-fallback-drift.md`
- "What exactly is already fixed in the archive, and how strong is the evidence?"
  - `22-research-freeze-and-coverage-map.md`

## Reading order

If you have 5 minutes:

1. `00-summary.md`
2. `07-best-practices-to-steal.md`
3. `08-critical-anti-patterns-to-avoid.md`
4. `11-scorecard-and-main-verdict.md`
5. `20-architect-playbook.md`

If you have 20 minutes:

1. `00-summary.md`
2. `02-runtime-and-core-architecture.md`
3. `03-multi-agent-coordination.md`
4. `05-security-and-boundaries.md`
5. `06-issues-and-early-maturity-signals.md`
6. `09-compare-vs-goclaw-and-us.md`
7. `11-scorecard-and-main-verdict.md`
8. `14-compaction-continuity-and-context-pressure.md`
9. `15-security-boundaries-and-policy-honesty.md`
10. `16-provider-surface-and-model-contracts.md`
11. `17-ohmo-autopilot-and-growth-pressure.md`
12. `18-tests-history-and-maturity.md`
13. `20-architect-playbook.md`
14. `21-compatibility-shadows-and-fallback-drift.md`
15. `22-research-freeze-and-coverage-map.md`
