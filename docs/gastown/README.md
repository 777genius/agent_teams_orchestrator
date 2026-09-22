# Gastown Research Index

Date: 2026-04-16  
Studied revision: `bdbe8c4b` on `main`

This folder is a retrieval-oriented split of the monolithic deep dive in
[`../gastown-deep-dive.md`](../gastown-deep-dive.md).

Use this folder when you want fast access to one Gastown topic without loading
the entire long-form analysis.

## Quick verdict

- orchestration imagination - `9.4/10`
- coding-agent workflow imagination - `9.0/10`
- runtime substrate quality - `5.6/10`
- operational predictability - `6.1/10`
- cross-platform architecture - `4.2/10`
- recoverability mindset - `7.5/10`
- overall architecture - `7.2/10`

## Most interesting findings

If you only read a few things, start here:

- **Best hidden gem** - `identity != session != sandbox` plus persistent polecats  
  [`14-strong-concepts-beneath-the-mess.md`](./14-strong-concepts-beneath-the-mess.md)
- **Most underrated practical rule** - clean bootstrap over adopt, and never infer identity from ambient files  
  [`14-strong-concepts-beneath-the-mess.md`](./14-strong-concepts-beneath-the-mess.md)
- **Best future-facing correction** - Factory Worker API: `push / structured / run_id / fail-closed`  
  [`13-maintainer-corrections-and-principles.md`](./13-maintainer-corrections-and-principles.md)
- **Best ecosystem-facing idea** - configuration, not compilation for third-party agent integration  
  [`13-maintainer-corrections-and-principles.md`](./13-maintainer-corrections-and-principles.md)
- **Smartest strategic idea** - don't converge to conversation-as-control-plane just because everyone else does  
  [`16-strategic-vision-vs-overreach.md`](./16-strategic-vision-vs-overreach.md)
- **Best control-plane idea** - separate mechanical supervision from reasoning supervision  
  [`24-layered-control-and-strategic-overreach.md`](./24-layered-control-and-strategic-overreach.md)
- **Best boring-but-critical lesson** - atomic writes, per-entity locks, restart as architecture  
  [`21-concurrency-and-integrity-lessons.md`](./21-concurrency-and-integrity-lessons.md)
- **Most dangerous hidden tax** - docs, prompts, formulas, and runtime do not always agree  
  [`22-operational-folklore-and-doc-drift.md`](./22-operational-folklore-and-doc-drift.md)
- **Best inter-agent concept** - mail as a real protocol, not just shared chat  
  [`14-strong-concepts-beneath-the-mess.md`](./14-strong-concepts-beneath-the-mess.md)
- **Best ecosystem contract** - progressive integration tiers for third-party agent CLIs  
  [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)
- **Best trust/evidence idea** - verification over trust, with validated completions and stamps as durable data  
  [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)
- **Best anti-lock-in idea** - minimum viable participation without adopting the full runtime  
  [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)
- **Best reputation rule** - yearbook rule: no self-stamping, trust earned from validated work  
  [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)
- **Strongest identity-discipline lesson** - identity should be injected authoritatively, never inferred from ambient files or inherited blindly from launch context  
  [`14-strong-concepts-beneath-the-mess.md`](./14-strong-concepts-beneath-the-mess.md) and [`22-operational-folklore-and-doc-drift.md`](./22-operational-folklore-and-doc-drift.md)
- **Most sensitive product-trust lesson** - self-improvement or upstream-facing work must be explicit opt-in, not silent use of user credits or GitHub identity  
  [`18-safety-boundaries-and-operational-philosophy.md`](./18-safety-boundaries-and-operational-philosophy.md) and [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)
- **Best scale/economics lesson** - large-repo support, clone strategy, and worktree materialization are architecture, not optimization garnish  
  [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best failure-mode lesson from issues** - if coordination backend dies, autonomy must degrade toward pause, not rogue solo work  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Most dangerous identity leak from issues** - daemons and services must scrub ambient agent identity before acting  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best Git-contract lesson from issues** - push target, upstream branch, and commit identity must be modeled explicitly, not approximated with `origin/main` heuristics  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Most underrated workflow lesson from issues** - fixing existing PRs and consolidating already-open work must be first-class, not manual recovery  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Most useful startup lesson from issues** - required workspace setup must be engine-run, not prompt-run  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Most dangerous trust-cost lesson from issues** - startup and failed-install loops must have hard bounds on credit burn  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best multi-runtime lesson from issues** - if a worker can run, dashboard and status surfaces must be able to see it provider-agnostically  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best anti-thrash lesson from issues** - orchestration should learn from historical cost vs outcome before launching more work  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best federation-trust lesson from issues** - remote completions need evidence gates, not just narrative success claims  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best dispatch lesson from issues** - "session started" is not enough, delivery must be verified  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Most dangerous hidden startup cost** - orchestration bootstrap can consume the context window before real work starts  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best runtime-parity lesson from issues** - one hardcoded Claude-shaped restart path is enough to break the abstraction  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best config-ownership lesson from issues** - if you share a settings file with another tool, preserve unknown keys or you will destroy trust state  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best operator-consent lesson from issues** - tmux/shell integration must be explicit opt-in and should chain existing behavior  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best hygiene lesson from issues** - session and route identity must come from authoritative registries, not guessed naming rules  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best noise-reduction lesson from issues** - "no work" must be a silent normal state, not a recurring escalation  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best preflight lesson from issues** - contamination and scope checks should happen before sling/merge side effects  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best round-trip lesson from issues** - a cross-boundary write is not real until normal query paths can read it back  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best continuity lesson from issues** - compaction/restart paths should preserve context by default, not silently reset it  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best serialization lesson from issues** - all workflows that mutate the same shared target need one common lock boundary  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best dependency-semantics lesson from issues** - downstream work must wait for integration/merge when that is the real dependency, not just for a worker to say "done"  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best fail-fast lesson from issues** - structural integrity errors should stop the run loudly, not disappear into exponential backoff  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best raw-telemetry lesson from issues** - preserve token counts and other raw usage signals, not only derived USD views  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best synthesis-output lesson from issues** - completed work should publish durable output-location metadata so downstream agents do not guess where results live  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best observability-budget lesson from issues** - dashboards need latency budgets aligned with real backend cost, or status becomes a lie  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best trace-interoperability lesson from issues** - export and trace schemas are ecosystem contracts, not late-stage UI garnish  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)
- **Best service-ownership lesson from issues** - do not adopt a running backend just because the port is occupied; prove ownership first  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best specialized-store lesson from issues** - internal engine features should read their own authoritative schema, not generic CLI wrappers  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best restart-classification lesson from issues** - quota/rate-limit exits need different policy than genuine crashes  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best hot-loop lesson from issues** - control ticks should snapshot shared config once, not reread it everywhere  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best plugin-contract lesson from issues** - scheduled plugins must declare and test their real host-runtime assumptions  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best version-skew lesson from issues** - compatibility walls should surface at the user action boundary, not only in daemon logs later  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best first-run lesson from issues** - full install/bootstrap integration tests protect the real product contract  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best routing-symmetry lesson from issues** - authoritative target resolution must be identical for reads and writes  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best remote-endpoint lesson from issues** - remote backend discovery needs one canonical visible config path  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best runtime-capability lesson from issues** - PTY needs, prompt-shape limits, and similar constraints should be modeled as orthogonal capability flags  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best external-runtime lesson from issues** - provider integrations are incomplete until the project-context file contract is owned explicitly  
  [`04-startup-and-runtime-contracts.md`](./04-startup-and-runtime-contracts.md), [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best cross-rig tracking lesson from issues** - derived tracking artifacts must preserve canonical source IDs across store boundaries  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best merge-mode lesson from issues** - direct push, PR merge, and hosted merge queue are distinct orchestration modes and should be explicit  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best remote-role lesson from issues** - fork, upstream, and canonical remotes need first-class semantics  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best install-matrix lesson from issues** - each install/build method needs an exact supported-platform story  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best shipped-vs-wired lesson from issues** - workflow files should clearly say whether they are manual-only, experimental, or fully automated  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best external-event lesson from issues** - forge webhooks are control-plane ingress, not just notification extras  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best multi-town lesson from issues** - separate orchestration domains at the socket/namespace boundary, not only in names  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best identity-layering lesson from issues** - long-lived persona/identity should be layered separately from role mechanics  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best provider-profile lesson from issues** - provider/auth/model profiles should be schedulable lifecycle resources, not ad hoc operator swaps  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best protocol-economics lesson from issues** - agent-facing wire formats can be a major token/cost lever at swarm scale  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best local-cascade lesson from issues** - cheap task classes should be able to run on local or lower-cost tiers before escalating to frontier models  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best role-model-policy lesson from issues** - model choice should be declarative per role, not left to sticky provider session state  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best skills-injection lesson from issues** - provider-native skills need layered injection without repo pollution or global bleed  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best semantic-conflict lesson from issues** - not all conflicts are merge conflicts; some need explicit decision escalation  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best onboarding-defaults lesson from issues** - first-run config should detect the stack, pick conservative defaults, and never overwrite user intent  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best generated-artifact lesson from issues** - orchestrator backup and recovery files must be excluded before work starts, not cleaned out of PRs later  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best observability-economics lesson from issues** - dashboards and status loops must be cheaper than the workloads they observe  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best operator-transport lesson from issues** - attach, nudge, and session shortcuts need live transport identity, not stale pane or prefix hints  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best retention lesson from issues** - log rotation and orphan-process cleanup are lifecycle contracts for long-running orchestration backends  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best precedence lesson from issues** - explicit user config must beat deterministic defaults and legacy writers must stop once a canonical source exists  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best machine-interface lesson from issues** - machine-readable CLI output must be explicit, never inferred from human-oriented command paths  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best warning-budget lesson from issues** - expected-empty state should be modeled as normal, not logged forever as a warning  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best override-parity lesson from issues** - alternate launch paths and `--agent` overrides must preserve the full startup invariant envelope  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best work-revalidation lesson from issues** - crash recovery must confirm work is still open before restarting a worker  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best cleanup-completeness lesson from issues** - deleting a worker is only done when its worktree, session, and runtime ownership are all gone  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best upstream-enum lesson from issues** - domain types should not remain coupled to another tool's built-in enum set  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best canonical-ID lesson from issues** - routing should follow canonical prefix meaning, not shallow assumptions about ID shape  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best canonical-name lesson from issues** - durable metadata must store real backend identifiers, not friendly prefixes or aliases  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best preflight-diagnosis lesson from issues** - setup should fail early with domain-aware messages before lower-level clone or fetch noise leaks out  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best registry-over-layout lesson from issues** - expected identities should come from canonical membership state, not raw directories on disk  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best structured-template lesson from issues** - generated JSON or hooks config must use format-aware escaping, not raw string substitution  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best truthful-status lesson from issues** - status should prove live execution, not just the existence of a stale tmux session  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best post-migration lesson from issues** - health and readiness checks must move with the source of truth or fail loudly  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best fail-closed integrity lesson from issues** - corrupted hook/worktree metadata should hard-stop every dependent path, not only some of them  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`21-concurrency-and-integrity-lessons.md`](./21-concurrency-and-integrity-lessons.md)
- **Best finite-protocol-values lesson from issues** - event and polling schemas should avoid values that cannot survive every storage/query boundary  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best release-truth lesson from issues** - official release pages and install commands are part of the executable product contract  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best upgrade-split-brain lesson from issues** - namespace or socket migrations must reap legacy transport state automatically  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md), [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md), and [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- **Best one-rig-one-store lesson from issues** - one logical rig should resolve to exactly one canonical backend database  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best worker-ack lesson from issues** - session alive and work understood are separate lifecycle edges and should be modeled separately  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best interactive-capability lesson from issues** - operator-facing roles need explicit input/PTY capability matching, not generic detached session launch  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best wake-completeness lesson from issues** - event loops must subscribe to every safety-relevant wake source, not just one activity stream  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best fresh-bootstrap lesson from issues** - a fresh clone should hydrate authoritative state without migration rituals or split-brain dances  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best provisioning-contract lesson from issues** - overlays and setup hooks are real provisioning planes and should be explicit, not hidden in code  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Best command-truth lesson from issues** - CLI help text and actual dispatch scope must match exactly  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md) and [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- **Most useful doctrine** - `events are truth, labels are cache`, `catalog is not truth`  
  [`15-doctrines-and-overextensions.md`](./15-doctrines-and-overextensions.md)
- **Most ambitious strategic idea** - protocol/federation surface stronger than current substrate  
  [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)

## Fast routing

Open this file when you need:

- overall judgment and scores  
  [`00-verdict.md`](./00-verdict.md)
- what Gastown is genuinely good at  
  [`01-strengths.md`](./01-strengths.md)
- the full list of systemic architectural fault lines  
  [`02-systemic-fault-lines.md`](./02-systemic-fault-lines.md)
- Beads, Dolt, tmux, routing, liveness, agent beads, shadow state, repair tax  
  [`03-substrate-and-state.md`](./03-substrate-and-state.md)
- startup, runtime identity, role configs, env transport, capability schema  
  [`04-startup-and-runtime-contracts.md`](./04-startup-and-runtime-contracts.md)
- workflow engine, convoys, wisps, sagas, daemon, observer-first recovery  
  [`05-workflow-and-recovery.md`](./05-workflow-and-recovery.md)
- important issues, community signals, what recurring bugs reveal  
  [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md)
- what is worth stealing conceptually  
  [`07-what-to-steal.md`](./07-what-to-steal.md)
- what must not be copied into a new orchestrator  
  [`08-what-not-to-copy.md`](./08-what-not-to-copy.md)
- hotspots, churn, maturity signals, why the code still deserves respect  
  [`09-hotspots-and-maturity.md`](./09-hotspots-and-maturity.md)
- one fast architect-level file with best practices, anti-patterns, and design lessons  
  [`11-architectural-lessons.md`](./11-architectural-lessons.md)
- one architect-level file split by angles: runtime, scaling, portability, security, extensibility  
  [`12-multi-angle-assessment.md`](./12-multi-angle-assessment.md)
- one file focused on what the maintainers themselves are correcting and which future-facing principles are strongest  
  [`13-maintainer-corrections-and-principles.md`](./13-maintainer-corrections-and-principles.md)
- one file isolating the strongest conceptual ideas that are still worth learning from despite the expensive implementation  
  [`14-strong-concepts-beneath-the-mess.md`](./14-strong-concepts-beneath-the-mess.md)
- one file about Gastown's core doctrines - which principles are strong, and where philosophy turns into architectural overreach  
  [`15-doctrines-and-overextensions.md`](./15-doctrines-and-overextensions.md)
- one file about long-horizon strategy - where Gastown's federation and ecosystem vision is strong, and where it overreaches current substrate maturity  
  [`16-strategic-vision-vs-overreach.md`](./16-strategic-vision-vs-overreach.md)
- one practical file with the highest-signal open risks and what they imply for architecting a safer orchestrator  
  [`17-risk-register-and-open-criticals.md`](./17-risk-register-and-open-criticals.md)
- one file focused on safety, trust boundaries, cleanup philosophy, and where Gastown's operational instincts are strong vs too implicit  
  [`18-safety-boundaries-and-operational-philosophy.md`](./18-safety-boundaries-and-operational-philosophy.md)
- one file focused on install/upgrade/version-skew/observability lessons that matter in real operations  
  [`19-ops-upgrades-and-observability.md`](./19-ops-upgrades-and-observability.md)
- one file focused on execution-plane separation, sandbox backends, and the "minimum viable participation" protocol idea  
  [`20-execution-planes-and-minimal-protocols.md`](./20-execution-planes-and-minimal-protocols.md)
- one file focused on concurrency, integrity, atomic writes, startup locks, restart gaps, and where Gastown is locally right vs globally inconsistent  
  [`21-concurrency-and-integrity-lessons.md`](./21-concurrency-and-integrity-lessons.md)
- one file focused on docs drift, prompt/formula drift, repair folklore, and why contract convergence is a real architecture concern  
  [`22-operational-folklore-and-doc-drift.md`](./22-operational-folklore-and-doc-drift.md)
- one file focused on Gastown's public contract: official docs, ecosystem promises, and where the public mental model is stronger or weaker than shipped runtime  
  [`23-public-contract-and-ecosystem-surface.md`](./23-public-contract-and-ecosystem-surface.md)
- one file focused on layered control: daemon, Boot, Deacon, dogs, federation ambition, and where strong hierarchy turns into over-architecture  
  [`24-layered-control-and-strategic-overreach.md`](./24-layered-control-and-strategic-overreach.md)
- exact mapping from old monolith sections to the new split layout  
  [`10-section-map.md`](./10-section-map.md)

## One-line summary

> Gastown is one of the most original multi-agent coding orchestrators out
> there, but it pays a very high architectural tax for building advanced
> coordination on top of a substrate that is too fragile, too implicit, and
> too tightly coupled to specific tools.

## Best use of this research

Study Gastown for:

- orchestration primitives
- role design
- mailbox/handoff ideas
- worktree-first worker isolation
- serious recovery thinking

Do **not** treat it as a clean reference for:

- substrate design
- startup contracts
- runtime identity
- tool abstraction
- long-term maintainability

## Side experiments worth noticing

These are interesting, but not core enough to drive the main verdict:

- TOON / token-optimized structured output for agent-facing commands
- provider-level custom agents as future harness targets
- MVGT as minimum-protocol participation without full runtime adoption
- Wasteland / federation as long-horizon ecosystem surface
- attribution, validation, and trust as product primitives rather than "nice-to-have reporting"
- source-repo isolation and mayor-clone cleanliness as explicit product rules
