# Gastown Risk Register and Open Critical Signals

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file captures the highest-signal open risks that still matter even after
all the deeper architectural analysis.

It is intentionally practical.

## Why this file matters

A system can have beautiful ideas and still carry product-level risks that make
it dangerous or expensive in day-to-day use.

Gastown has several such risks.

## 1. Highest-signal open risks

### A. Reliable nudge delivery is still unresolved

Issue:

- `#1216`

Why it matters:

- nudge delivery is a core control-plane primitive
- if delivery and input clearing are unreliable, orchestration remains fragile

Risk rating: `🎯 9.9   🛡️ 9.4   🧠 6`

### B. Wrong-repo / nested-repo confusion can mislead agents

Issue:

- `#716`

Why it matters:

- the town layout contains multiple nested repositories
- agents can reason in the wrong repo context
- false divergence and wrong git operations become possible

Risk rating: `🎯 9.6   🛡️ 9.2   🧠 5`

### C. Boundary mistakes can cause destructive outcomes

Issues:

- `#824`
- `#885`

Why it matters:

- these are not just UX bugs
- they indicate that path, cwd, and repo-boundary rules are not strict enough
- trust can be broken if the system writes or syncs in the wrong place

Risk rating: `🎯 10   🛡️ 9.7   🧠 7`

### D. Startup/init fragility still exists

Issues:

- `#2922`
- `#3464`
- `#3195`
- `#2690`

Why it matters:

- partial init
- non-atomic writes
- rogue startup races
- thundering herd startup behavior

all point to substrate pressure, not just isolated bugs.

Risk rating: `🎯 9.8   🛡️ 9.4   🧠 7`

### E. Completion and cleanup still have sharp edges

Issues:

- `#2416`
- `#3073`
- `#3363`
- `#3603`

Why it matters:

- `gt done` is central and policy-heavy
- if it fails or takes the wrong branch, work can be lost, left open, or end in
  an ambiguous state

Risk rating: `🎯 9.8   🛡️ 9.3   🧠 7`

### F. Integrity boundaries are not uniformly fail-closed

Issue:

- `#2026`

Why it matters:

- hook and worktree state are durable execution inputs
- if corruption does not hard-stop uniformly, the system can continue on stale
  or partial truth
- that creates replay and trust problems, not just incidental bugs

Risk rating: `🎯 9.7   🛡️ 9.4   🧠 5`

### G. Convoy workflow remains a live risk surface

Issues:

- `#3587`
- `#3597`
- `#3181`
- `#3217`
- `#3507`

Why it matters:

- convoy is one of Gastown's richest features
- it is also one of the clearest places where routing, polling, and state-model
  cracks keep surfacing

Risk rating: `🎯 9.7   🛡️ 9.2   🧠 7`

### H. Portability is still structurally weak

Issues:

- `#3538`
- `#2716`
- `#1382`

Why it matters:

- Windows remains effectively blocked
- ACP and process management still have platform-specific weakness
- headless/sandboxed workers remain second-class

Risk rating: `🎯 9.8   🛡️ 9.5   🧠 5`

### I. Internal success can still overreach into external ownership

Issue:

- `#3198`

Why it matters:

- merging internal rig state is not the same thing as owning upstream PR or
  branch lifecycle
- if those boundaries blur, the orchestrator can mutate or close remote work it
  does not semantically own

Risk rating: `🎯 9.6   🛡️ 9.3   🧠 5`

### J. Shipped autonomy can be weaker than the product story

Issue:

- `#3000`

Why it matters:

- a fresh install could still stall on permission prompts
- effective autonomy depended on extra settings outside the obvious install
  contract
- this makes the real execution model more implicit than the product claims

Risk rating: `🎯 9.3   🛡️ 8.8   🧠 4`

### K. Backend saturation remains a real multi-agent failure mode

Issue:

- `#3623`

Why it matters:

- many short-lived `bd` commands plus long-lived Dolt connections can cascade
  into full backend exhaustion
- dashboard and mail paths can amplify the spiral even when raw queries are fast

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 5`

### L. Validation slack at control boundaries creates future exploit debt

Issue:

- `#3110`

Why it matters:

- even when today's call sites are relatively safe, parser gaps create latent
  risk for future shell-outs or interpolation paths
- this is exactly how "comment says safe, code is permissive" turns into a real
  security seam later

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 3`

### M. Dead code and stale comments can misdirect architectural repair

Issue:

- `#3653`

Why it matters:

- if docs, tests, and comments center a non-production path, contributors will
  keep reasoning about the wrong engine shape
- that slows convergence and preserves compatibility ghosts

Risk rating: `🎯 9.2   🛡️ 8.7   🧠 3`

### N. Preservation safety nets can themselves become destructive

Issue:

- `#3615`

Why it matters:

- a "save your work" path that stages tracked deletions is not a safe fallback
- destructive scope inside preservation machinery is especially dangerous
  because operators trust it during failure modes

Risk rating: `🎯 9.6   🛡️ 9.3   🧠 4`

### O. Namespace collisions can produce cross-rig control corruption

Issue:

- `#3341`

Why it matters:

- route/prefix collisions are enough to make witnesses inspect and act on the
  wrong rig's work
- that means namespace uniqueness is part of safety and lifecycle correctness

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### P. Generator and validator disagreement can create permanent non-convergence

Issue:

- `#3648`

Why it matters:

- when `doctor` and `hooks sync` disagree forever about the same artifact, the
  operator loses a reliable path to green
- this is stronger than a stale-template bug: it means artifact ownership and
  truth are not unified

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### Q. Hidden schema assumptions can break the background engine continuously

Issues:

- `#3197`
- `#3622`

Why it matters:

- a type mismatch in a poller is not just a bad query
- it can disable whole coordination loops and spam failure continuously
- this is a strong warning against implicit schema contracts in background code

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 4`

### R. Ambient launch identity can poison service attribution

Issue:

- `#3006`

Why it matters:

- if daemon or other control-plane services inherit agent identity from their
  launch shell, system-generated actions become misattributed
- that breaks auditability and creates trust debt exactly where operators need
  provenance most

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### S. Coordination-backend loss can turn team autonomy into rogue autonomy

Issue:

- `#3623`

Why it matters:

- once mail and bead updates fail, agents can keep acting without the team
  control fabric
- the issue comments show this can degrade into unplanned solo implementation,
  not just temporary slowness

Risk rating: `🎯 9.7   🛡️ 9.3   🧠 5`

### T. Hidden self-improvement and upstream contribution paths create trust risk

Issue:

- `#3649`

Why it matters:

- users may not consent to their credits, models, or forge identity being used
  for upstream-maintainer goals
- even if the behavior is accidental or formula-scoped, silent opt-in destroys
  the product's authority boundary

Risk rating: `🎯 9.6   🛡️ 9.4   🧠 4`

### U. Large-repo viability is still a first-order adoption risk

Issues:

- `#1059`
- `#1790`

Why it matters:

- full clone assumptions and duplicate object downloads make serious repos
  expensive before the agent system even starts working
- this blocks exactly the kind of high-scale codebases that benefit most from
  orchestrated workers

Risk rating: `🎯 9.4   🛡️ 9.0   🧠 5`

### V. Git verification semantics are still easy to ask incorrectly

Issues:

- `#3224`
- `#3183`
- `#3345`
- `#3400`
- `#3032`

Why it matters:

- wrong comparisons against `origin/main`, fetch URLs, or branch-name suffixes
  can make the system think work is unpushed, duplicated, or safe to land when
  the real branch state says otherwise
- this hits completion, cleanup, patrol, and dedup logic all at once

Risk rating: `🎯 9.6   🛡️ 9.2   🧠 5`

### W. Sparse and partial checkout modes can invalidate naive completion logic

Issues:

- `#3402`
- `#1790`

Why it matters:

- once worktrees are partial, generic dirty-state and deletion checks no longer
  mean what they mean in a full checkout
- the engine can block valid work or report phantom damage if sparse semantics
  are not modeled explicitly

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 5`

### X. Runtime metadata can still leak into user-facing diffs

Issue:

- `#3260`

Why it matters:

- tracked `CLAUDE.md` pollution shows how easily orchestration metadata can
  become review noise or even committed garbage
- this is a trust and cleanliness problem, not just a small template bug

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 4`

### Y. Existing-PR repair and consolidation workflows remain weaker than fresh work creation

Issues:

- `#3602`
- `#3603`
- `#3604`
- `#3588`

Why it matters:

- systems often look strong on greenfield task execution but fail when asked to
  continue or repair already-open work
- duplicate PRs, stalled consolidation, and work left only in abandoned
  worktrees all signal missing second-order workflow contracts

Risk rating: `🎯 9.7   🛡️ 9.3   🧠 6`

### Z. Role invariants are not always established where lifecycle assumes them

Issues:

- `#3652`
- `#3638`

Why it matters:

- some roles rely on agent beads or repair behavior that `Start()` or daemon
  handlers never actually create or execute
- the result is a dangerous gap between observed staleness and actual repair
  power

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### AA. Critical workspace setup is still too dependent on agent compliance

Issue:

- `#3001`

Why it matters:

- if required setup only happens when the agent obeys a prompt step, then
  broken environments appear as random workflow failures
- this turns deterministic bootstrap into fuzzy behavioral compliance

Risk rating: `🎯 9.6   🛡️ 9.2   🧠 4`

### AB. Identity propagation failures in supporting roles can silently stall the system

Issues:

- `#3223`
- `#3410`

Why it matters:

- dogs missing their own identity create plugin-dispatch backlog
- polecats missing git identity create misattributed commits
- identity bugs in non-primary roles still corrupt provenance and throughput

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### AC. Startup loops can become direct credit-burn incidents

Issues:

- `#2614`
- `#3660`

Why it matters:

- failed install or heavy startup can consume large amounts of user model usage
  before useful work begins
- this is a product-trust risk, not just a performance issue

Risk rating: `🎯 9.6   🛡️ 9.3   🧠 4`

### AD. Non-code workflows can be incorrectly judged by code-centric heuristics

Issue:

- `#2496`

Why it matters:

- if "no git diff" implies "done", legitimate research, email, or operational
  tasks get auto-closed without execution
- that makes the system unreliable the moment the workflow surface expands

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 4`

### AE. Multi-runtime observability gaps can make the operator blind to live work

Issue:

- `#3614`

Why it matters:

- if dashboards only recognize one provider's metadata, active workers on other
  runtimes vanish from the main operational surface
- this breaks trust in the control plane exactly when mixed-runtime operation is
  advertised

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### AF. Dispatch without delivery verification wastes sessions and hides failure

Issue:

- `#2748`

Why it matters:

- assigning work and starting a session is not enough if the worker never sees
  the assignment
- empty-hook startups quietly burn tokens and require manual recovery

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### AG. Spawn-unaware supervision can destroy valid work during startup

Issue:

- `#2036`

Why it matters:

- newly launched workers can be killed by patrol logic before they are actually
  ready
- this recreates the same class of race even after other layers have already
  learned to add grace periods

Risk rating: `🎯 9.6   🛡️ 9.2   🧠 4`

### AH. Detection signals without reactive consumers create false confidence

Issue:

- `#3584`

Why it matters:

- stale heartbeats and dead-session signals existed, but no automatic consumer
  turned them into escalation or cleanup
- operators believe detection exists, but operationally the failure is still
  silent

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 3`

### AI. Custom-runtime support is fragile if metadata inheritance is partial

Issue:

- `#2943`

Why it matters:

- custom agents can launch successfully while still lacking process names,
  session IDs, resume flags, and hook semantics
- that creates a dangerous illusion of support without real parity

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### AJ. Cost-unaware orchestration leaves the system blind to thrash economics

Issue:

- `#1143`

Why it matters:

- without persistent cost/outcome learning, the system cannot distinguish
  expensive-but-useful runs from pure thrash
- that keeps scheduling and prompt strategy stuck at guesswork

Risk rating: `🎯 9.1   🛡️ 8.8   🧠 6`

### AK. Federated trust without evidence gates invites silent confabulation

Issue:

- `#2814`

Why it matters:

- cross-rig or cross-system completions can carry fabricated tool results that
  downstream agents elaborate on as if they were real
- this is a protocol-trust problem, not just a model-quality problem

Risk rating: `🎯 9.7   🛡️ 9.4   🧠 6`

### AL. Ad hoc CI interpretation keeps routing and convoy logic inconsistent

Issue:

- `#1978`

Why it matters:

- if CI states are parsed informally, policy blockers, infra failures, and real
  product regressions get mixed together
- that produces bad routing and wasted automation cycles

Risk rating: `🎯 9.2   🛡️ 8.9   🧠 4`

### AM. Runtime observability missing from routing keeps agents solving symptoms

Issue:

- `#1141`

Why it matters:

- without first-class logs, traces, metrics, and test outputs, triage agents
  route work from incomplete ground truth
- the system then optimizes code changes without enough runtime evidence

Risk rating: `🎯 9.1   🛡️ 8.8   🧠 6`

### AN. Startup context can consume the worker before the work even begins

Issue:

- `#3332`

Why it matters:

- prime output, role templates, and startup overlays can eat nearly the whole
  context window, leaving too little budget for actual implementation
- this creates a silent failure mode where workers look alive but can never
  produce useful work

Risk rating: `🎯 9.5   🛡️ 9.1   🧠 4`

### AO. Runtime parity breaks when even one lifecycle path bypasses resolution

Issue:

- `#2417`

Why it matters:

- restart or repair paths that hardcode one runtime can invalidate the whole
  multi-runtime abstraction
- users then get inconsistent behavior depending on which lifecycle path was hit

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### AP. Lack of cost-outcome memory leaves the scheduler blind to avoidable thrash

Issue:

- `#1143`

Why it matters:

- without durable cost/outcome learning, the system cannot tell low-yield loops
  from genuinely expensive but worthwhile work
- that keeps orchestration reactive instead of predictive

Risk rating: `🎯 9.0   🛡️ 8.7   🧠 6`

### AQ. Multi-machine and federated work magnify trust requirements

Issues:

- `#2814`
- `#2407`
- `#2794`

Why it matters:

- once work crosses rig, machine, or town boundaries, unverifiable tool claims
  and narrative completions become systemic trust risks
- stronger transport and collaboration make evidence and attestation more, not
  less, important

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 6`

### AR. Regenerating shared config can destroy external trust state

Issues:

- `#2022`
- `#2050`

Why it matters:

- if a managed settings sync wipes unknown keys, it can erase another tool's
  trust approvals and re-block unattended execution across roles
- this is a config-ownership failure, not just a template bug

Risk rating: `🎯 9.5   🛡️ 9.3   🧠 4`

### AS. Silent operator-environment mutation is a product trust break

Issue:

- `#1548`

Why it matters:

- overriding tmux bindings globally without opt-in damages the operator's own
  environment beyond Gastown sessions
- tools that integrate into shared shells or multiplexers need stronger consent
  rules than isolated CLIs

Risk rating: `🎯 9.3   🛡️ 9.1   🧠 3`

### AT. Heuristic session naming can turn hygiene automation into mass outage

Issues:

- `#2707`
- `#2423`

Why it matters:

- once plugins reconstruct session identity from guesses instead of canonical
  registries, a small naming mismatch can kill the entire town or blind health
  checks completely

Risk rating: `🎯 9.6   🛡️ 9.3   🧠 4`

### AU. Treating "no work" as an error burns trust and attention

Issue:

- `#3148`

Why it matters:

- escalation loops for benign idle state flood the operator and waste context
- this turns routine quiescence into false operational drama

Risk rating: `🎯 9.2   🛡️ 8.9   🧠 3`

### AV. Multiple ambient root aliases are small seams with big drift potential

Issue:

- `#2104`

Why it matters:

- duplicate root env vars with overlapping meaning make shell, runtime, and
  subprocess behavior harder to reason about
- tiny naming seams often become large compatibility tax over time

Risk rating: `🎯 8.9   🛡️ 8.7   🧠 3`

### AW. Restart-heavy config propagation creates unnecessary operational friction

Issue:

- `#945`

Why it matters:

- if model or role config changes require disruptive restarts, operators will
  either avoid tuning or apply risky ad hoc workarounds
- this makes config evolution heavier than it needs to be

Risk rating: `🎯 8.8   🛡️ 8.6   🧠 5`

### AX. Writer-reader transport mismatch can invalidate liveness across runtimes

Issue:

- `#1861`

Why it matters:

- if runtime identity is written to process env but liveness reads only tmux env
  or another channel, non-default runtimes get misclassified as dead
- this creates false zombie cleanup and restart storms

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### AY. Missing capability checks in background steps can create fake resilience

Issue:

- `#1561`

Why it matters:

- orchestration loops that assume a feed or follow capability exists can fail in
  tight loops when the capability is absent
- without deterministic degraded behavior, "reactive waiting" becomes error
  churn

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 4`

### AZ. Branch contamination needs to be blocked before any orchestration side effects

Issue:

- `#2220`

Why it matters:

- once contaminated branches enter sling/merge flows, the system creates noisy
  PRs and confused handoffs before anyone notices
- late discovery is much more expensive than preflight rejection

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 3`

### BA. Cross-boundary writes must be verified by readback, not trusted on acknowledgement

Issue:

- `#2786`

Why it matters:

- a dependency that "adds successfully" but cannot be queried back is not a
  real dependency for orchestration purposes
- routing/database boundaries make optimistic success especially dangerous

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### BB. Patrol loops can report healthy cycles without doing the real work

Issues:

- `#2386`
- `#1456`

Why it matters:

- if cycle counts and digests can be emitted without executed step evidence, the
  operator gets false assurance while checks are skipped
- timeout behavior also becomes harder to reason about if not deterministic

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 5`

### BC. Helper-role workspaces need the same backend guarantees as primary roles

Issue:

- `#2930`

Why it matters:

- helper roles like dogs can enter infinite escalation loops if they do not
  inherit shared backend config correctly
- reliability for "small helper roles" is still part of whole-system health

Risk rating: `🎯 9.2   🛡️ 8.9   🧠 4`

### BD. Compaction and restart flows can silently destroy user continuity

Issue:

- `#2072`

Why it matters:

- if compaction-triggered handoff creates a fresh session instead of a true
  continuation, the user loses context at exactly the moment preservation is
  needed most

Risk rating: `🎯 9.2   🛡️ 8.9   🧠 4`

### BE. Shared push targets need one serialization boundary across all paths

Issue:

- `#594`

Why it matters:

- if two valid workflows can both mutate `main`, locking only one subflow is
  insufficient
- non-fast-forward failures at the final push boundary are expensive and
  confusing recovery points

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### BF. Dependency closure semantics can dispatch downstream work before code is integrated

Issue:

- `#1893`

Why it matters:

- a source task can be "closed" by the worker while its code is still unmerged
- if dependency logic only keys off closure, dependent work starts against a
  reality that does not exist yet

Risk rating: `🎯 9.6   🛡️ 9.2   🧠 5`

### BG. Retrying structural integrity errors hides broken invariants

Issue:

- `#3436`

Why it matters:

- foreign key violations are not transient transport failures
- backoff loops convert clear invariant breakage into slow noisy failure and can
  obscure root cause during startup or spawn

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### BH. Too-tight dashboard budgets make observability lie

Issue:

- `#3589`

Why it matters:

- if UI or API timeouts are shorter than normal backend latency, healthy
  commands appear broken
- operators then debug the wrong thing and dashboards become distrustful

Risk rating: `🎯 9.0   🛡️ 8.8   🧠 3`

### BI. Derived-cost-only telemetry loses the signals needed for real scheduling

Issue:

- `#3375`

Why it matters:

- storing only USD throws away the raw token counts needed for flat-rate,
  quota-driven, or future cost-learning workflows
- this weakens both observability and later anti-thrash scheduling logic

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 3`

### BJ. Missing output-location metadata makes downstream synthesis rely on guessing

Issue:

- `#303`

Why it matters:

- review, synthesis, and audit flows need to know where completed work landed
- without durable output metadata, downstream agents guess branch names,
  worktree paths, or commit locations and create fragile recovery loops

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 4`

### BK. Trace and export schema choices become ecosystem commitments very early

Issue:

- `#1697`

Why it matters:

- once trace interoperability is public, external IDEs and tools start
  depending on that schema
- changing it later becomes contract migration work, not local refactoring

Risk rating: `🎯 8.8   🛡️ 8.6   🧠 5`

### BL. Crash policy that ignores quota/rate-limit class can thrash autonomously

Issue:

- `#3398`

Why it matters:

- usage-limit exits need a different response than genuine crashes
- if both map to one backoff path, the system becomes economically noisy and
  misdiagnoses recoverable pauses as instability

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 4`

### BM. Divergent DDL and runtime-write paths can create split knowledge inside one backend

Issue:

- `#3641`

Why it matters:

- creating schema via embedded helpers while runtime writes go through the live
  sql-server can leave durable state half-visible
- the worker appears to complete successfully until downstream automation
  discovers the backend never learned the same schema

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 5`

### BN. Port occupancy is not enough to adopt a service as authoritative

Issue:

- `#2772`

Why it matters:

- if a process on the expected port is adopted without identity proof, the town
  can talk to the wrong store while status still looks healthy
- this is a particularly dangerous silent-failure class

Risk rating: `🎯 9.6   🛡️ 9.3   🧠 5`

### BO. Hot loops that reread the same config amplify supervision tax silently

Issue:

- `#3463`

Why it matters:

- repeated file reads inside heartbeat paths are easy to ignore because they do
  not crash anything
- at scale they turn orchestration supervision into needless filesystem churn

Risk rating: `🎯 8.9   🛡️ 8.7   🧠 3`

### BP. Generic query wrappers can return wrong truth for specialized stores

Issue:

- `#3037`

Why it matters:

- convoy logic queried dependency state through a generic `bd dep` path that
  did not understand convoy records
- engine correctness then depended on an abstraction that was convenient but
  semantically wrong

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### BQ. Plugin runtime portability is a product contract, not script trivia

Issue:

- `#3635`

Why it matters:

- scheduled backup and archive paths broke on stock macOS because scripts
  assumed a newer shell than the declared shebang guaranteed
- maintenance automation is still part of production reliability

Risk rating: `🎯 9.0   🛡️ 8.8   🧠 3`

### BR. Attach/reconnect paths fail if transport identity is only partially preserved

Issue:

- `#3514`

Why it matters:

- session name alone is not enough when the actual control plane also depends
  on socket or namespace identity
- operators lose trust quickly when "attach to existing session" cannot find
  the real transport

Risk rating: `🎯 8.9   🛡️ 8.8   🧠 3`

### BS. Heuristic routing plugins are often evidence of an under-owned engine contract

Issue:

- `#3404`

Why it matters:

- if common multi-rig routing mistakes need a command-rewriting plugin, then
  core routing is still too implicit for normal operation
- helpful plugins can hide a missing first-class resolution rule

Risk rating: `🎯 8.8   🛡️ 8.6   🧠 4`

### BT. Version skew can create false-success user flows that only fail in the background

Issue:

- `#3533`

Why it matters:

- users can schedule work successfully while the daemon is already doomed to
  reject the workspace
- hidden compatibility walls turn normal actions into delayed-failure traps

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### BU. Missing first-run end-to-end tests leave the real product contract unprotected

Issue:

- `#20`

Why it matters:

- setup regressions can compound across install, rig init, polecat context, and
  assignment before the user ever reaches useful work
- without full bootstrap tests, the shipped experience can be broken even when
  local units pass

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 4`

### BV. Remote endpoint discoverability gaps turn config into folklore

Issue:

- `#2830`

Why it matters:

- when the correct remote backend host exists but is hard to discover, users
  patch many scattered files or env vars and lose confidence in which value is
  authoritative
- backend inheritance then becomes brittle across subprocesses and roles

Risk rating: `🎯 9.0   🛡️ 8.8   🧠 3`

### BW. Routing asymmetry between reads and writes creates self-contradictory truth

Issue:

- `#3145`

Why it matters:

- the system can successfully read an object through one authoritative path but
  fail to create related objects because writes still use ambient context
- this is a deep correctness failure, not just a routing edge case

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### BX. Platform-specific installer bugs can nullify platform support claims

Issue:

- `#3595`

Why it matters:

- a working runtime is irrelevant if the standard install path cannot complete
  on the target platform
- distribution scripts are part of the executable product surface

Risk rating: `🎯 9.0   🛡️ 8.8   🧠 3`

### BY. Opaque runtime presets break down when capabilities are actually independent

Issue:

- `#506`

Why it matters:

- some runtimes need PTY without multiline prompts, others may need the reverse
- one monolithic "special agent path" cannot express these combinations cleanly

Risk rating: `🎯 9.2   🛡️ 8.9   🧠 4`

### BZ. External runtime integrations break when project-context contracts are only partially owned

Issue:

- `#3139`

Why it matters:

- hooks and commands may be provisioned correctly while the provider still lacks
  the persistent context file it expects
- users experience this as random runtime weirdness even though the real issue
  is incomplete integration ownership

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 4`

### CA. Derived cross-rig tracking can look healthy while silently losing source truth

Issue:

- `#3581`

Why it matters:

- convoys can be created successfully but track zero issues if cross-rig bead
  IDs are not resolved through the same authoritative path
- dashboards then become decorative while operators are forced back to raw store
  inspection

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### CB. Direct-push merge assumptions collapse under protected-branch platforms

Issue:

- `#3601`

Why it matters:

- a refinery that only knows "push to main" cannot operate in ecosystems that
  require PRs and hosted merge queues
- the internal merge queue then idles while users bypass it manually

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 5`

### CC. Fork-based contribution needs explicit remote-role contracts

Issue:

- `#3249`

Why it matters:

- once workers cannot push to the canonical repo, the difference between fork,
  upstream, and merge-target remotes becomes first-class
- without role-modeled remotes, PR creation logic becomes brittle and ad hoc

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 4`

### CD. Ambiguous install-method support breaks trust before the product even starts

Issue:

- `#3626`

Why it matters:

- if the product cannot say clearly which install method is supported on which
  platform, users lose confidence before reaching first use
- support ambiguity is especially damaging when the error path cites the wrong
  platform semantics

Risk rating: `🎯 8.9   🛡️ 8.7   🧠 3`

### CE. Build assets that lag dependency toolchain minimums invalidate dev environments

Issue:

- `#3502`

Why it matters:

- Dockerfiles and bootstrap images that pin stale toolchains can make the
  project unbuildable even when the code itself is fine
- the build environment is part of the executable contract for contributors and
  operators

Risk rating: `🎯 8.8   🛡️ 8.7   🧠 3`

### CF. Shipped workflow files can over-promise if automation wiring is absent

Issue:

- `#1753`

Why it matters:

- users and maintainers can assume a workflow is part of the engine simply
  because the file ships and appears in help or tests
- that creates product-contract drift between visible assets and real pipeline
  behavior

Risk rating: `🎯 8.9   🛡️ 8.7   🧠 3`

### CG. Provider-level custom agents remain second-class until they map onto orchestration roles

Issue:

- `#1792`

Why it matters:

- provider-native custom agents raise questions about repos, worktrees,
  parallelism, lifecycle, and automation that cannot be solved by config files
  alone
- without an engine-level model, "support" stays superficial

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 6`

### CH. External forge events need first-class ingress or polling remains the ceiling

Issue:

- `#743`

Why it matters:

- upstream CI/PR events already exist and can drive orchestration more cleanly
  than repeated status polling
- if the engine lacks event ingress, it gives up a high-quality truth source

Risk rating: `🎯 8.9   🛡️ 8.8   🧠 5`

### CI. Multi-town hosting breaks down without transport-level namespace isolation

Issue:

- `#1163`

Why it matters:

- town names alone are not enough if sockets and other transport surfaces still
  collide
- one host running multiple orchestration domains needs true namespace
  separation

Risk rating: `🎯 9.0   🛡️ 8.9   🧠 4`

### CJ. Persistent identity deserves its own layer apart from role mechanics

Issue:

- `#1696`

Why it matters:

- if all long-lived expertise has to live inside one generic role template, the
  system loses continuity and specialization across sessions
- identity and role become entangled and harder to evolve independently

Risk rating: `🎯 8.8   🛡️ 8.7   🧠 4`

### CK. Provider/auth profile management belongs in lifecycle policy, not in operator folklore

Issue:

- `#232`

Why it matters:

- rate limits and quota pressure are normal operational conditions for long-lived
  agent systems
- if provider/account swaps are manual and ad hoc, continuity depends on human
  babysitting instead of orchestrator policy

Risk rating: `🎯 9.2   🛡️ 8.9   🧠 6`

### CL. Shipped workflow files can over-promise if automation wiring is absent

Issue:

- `#1753`

Why it matters:

- users and maintainers can assume a workflow is part of the engine simply
  because the file ships and appears in help or tests
- that creates product-contract drift between visible assets and real pipeline
  behavior

Risk rating: `🎯 8.9   🛡️ 8.7   🧠 3`

### CM. Provider-level custom agents remain second-class until they map onto orchestration roles

Issue:

- `#1792`

Why it matters:

- provider-native custom agents raise questions about repos, worktrees,
  parallelism, lifecycle, and automation that cannot be solved by config files
  alone
- without an engine-level model, "support" stays superficial

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 6`

### CN. External forge events need first-class ingress or polling remains the ceiling

Issue:

- `#743`

Why it matters:

- upstream CI/PR events already exist and can drive orchestration more cleanly
  than repeated status polling
- if the engine lacks event ingress, it gives up a high-quality truth source

Risk rating: `🎯 8.9   🛡️ 8.8   🧠 5`

### CO. Multi-town hosting breaks down without transport-level namespace isolation

Issue:

- `#1163`

Why it matters:

- town names alone are not enough if sockets and other transport surfaces still
  collide
- one host running multiple orchestration domains needs true namespace
  separation

Risk rating: `🎯 9.0   🛡️ 8.9   🧠 4`

### CP. Persistent identity deserves its own layer apart from role mechanics

Issue:

- `#1696`

Why it matters:

- if all long-lived expertise has to live inside one generic role template, the
  system loses continuity and specialization across sessions
- identity and role become entangled and harder to evolve independently

Risk rating: `🎯 8.8   🛡️ 8.7   🧠 4`

### CQ. Verbose agent-facing status formats waste context budget at swarm scale

Issue:

- `#622`

Why it matters:

- if dozens of agents repeatedly consume the same structured state through
  verbose JSON, orchestration burns tokens on protocol overhead rather than work
- this becomes a real scaling tax on mail, convoy, and priming surfaces

Risk rating: `🎯 8.9   🛡️ 8.7   🧠 4`

### CR. Without task-tiered model cascades, orchestration pays frontier prices for cheap work

Issue:

- `#1243`

Why it matters:

- classification and extraction work often do not need the same model tier as
  reasoning or code generation
- one global provider choice wastes both money and quota headroom

Risk rating: `🎯 9.1   🛡️ 8.8   🧠 5`

### CS. If model choice is not role policy, cost-quality behavior drifts with session residue

Issue:

- `#335`

Why it matters:

- relying on whichever model a provider CLI last used is not a stable
  orchestration contract
- roles with very different economic profiles need explicit model policy

Risk rating: `🎯 8.8   🛡️ 8.7   🧠 3`

### CT. Missing layered skill injection forces a bad choice between repo pollution and global bleed

Issue:

- `#1793`

Why it matters:

- without town or rig scoped injection, useful provider-native skills either
  contaminate the source repo or leak across unrelated projects through the
  user's home directory
- neither is a clean orchestration boundary

Risk rating: `🎯 8.9   🛡️ 8.8   🧠 4`

### CU. Semantic disagreement can be silently erased if every conflict is treated as technical

Issue:

- `#88`

Why it matters:

- priority, ownership, and status judgments may reflect expertise rather than
  simple field collisions
- generic conflict resolution can flatten important meaning without any review
  lane

Risk rating: `🎯 9.0   🛡️ 8.9   🧠 4`

### CV. Stack-agnostic onboarding defaults make the first-run experience falsely narrow

Issue:

- `#983`

Why it matters:

- hardcoded stack assumptions make the product feel misconfigured on day one for
  many repositories
- onboarding debt then bleeds into every later formula and command path

Risk rating: `🎯 8.8   🛡️ 8.7   🧠 4`

### CW. Generated orchestration artifacts can leak into user diffs if bootstrap boundaries are weak

Issue:

- `#3397`

Why it matters:

- `.beads/backup/` files landing in PRs breaks trust fast because the system's
  own recovery state starts masquerading as user work
- cleanup after staging is too late; the worktree boundary was already wrong

Risk rating: `🎯 9.5   🛡️ 9.3   🧠 3`

### CX. Observability loops can cost more than the system they observe

Issue:

- `#3396`

Why it matters:

- dashboards and SSE refresh paths that spawn many backend subprocesses can
  turn monitoring into the dominant source of load
- once the status surface becomes the hottest workload, operators lose both
  visibility and performance at the same time

Risk rating: `🎯 9.6   🛡️ 9.3   🧠 5`

### CY. Long-lived daemons need safe retention and rotation contracts

Issue:

- `#3573`

Why it matters:

- unbounded log growth becomes a slow operational failure on developer laptops
- if safe truncation requires writer ownership or restart semantics, rotation is
  part of daemon design, not later housekeeping

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 4`

### CZ. Orphan cleanup must prove non-ownership before killing stateful services

Issue:

- `#3572`

Why it matters:

- leaked Dolt processes waste memory and hold ports, but blind cleanup risks
  killing a still-authoritative backend
- stateful process cleanup needs ownership proof and quiescence checks

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 5`

### DA. Operator transport commands become flaky if they rely on stale pane or session hints

Issues:

- `#3563`
- `#3534`
- `#3565`
- `#3537`

Why it matters:

- nudge, attach, and session shortcuts are user-facing control-plane features
- if they depend on stale pane IDs, old prefix patterns, or sessions that never
  really existed, the product lies about operability

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 5`

### DB. Hidden naming rules and undeclared prerequisites corrode first-run trust

Issue:

- `#3516`

Why it matters:

- silent naming constraints and missing prerequisites make the first run feel
  randomly brittle
- when setup rules are tribal knowledge, later doctor and repair logic inherit
  avoidable ambiguity

Risk rating: `🎯 8.9   🛡️ 8.8   🧠 2`

### DC. Merge and review requirements need explicit queue policy

Issue:

- `#3406`

Why it matters:

- if review semantics are not configurable, the queue silently assumes a weak
  merge contract that many teams do not actually want
- protected-branch behavior then lives outside the orchestrator's own model

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 4`

### DD. Explicit user config can be silently ignored by deterministic fallback logic

Issue:

- `#3594`

Why it matters:

- if user-owned config loses to a hash-based default, the system remains
  predictable but stops being trustworthy
- naming, policy, and pool behavior then drift away from explicit operator
  intent

Risk rating: `🎯 9.0   🛡️ 8.8   🧠 3`

### DE. Machine and human CLI surfaces can drift into incompatible contracts

Issue:

- `#3571`

Why it matters:

- automation that expects JSON but gets decorated human output will fail at the
  exact moment maintenance and digest paths are needed
- a shared CLI without explicit machine modes becomes a control-plane risk

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 3`

### DF. Expected-empty state can silently become recurring alert debt

Issues:

- `#3554`
- `#3598`

Why it matters:

- warning loops about default empty state create log bloat and train operators
  to ignore real anomalies
- once absence is normal, health checks should model it as normal

Risk rating: `🎯 9.2   🛡️ 9.0   🧠 2`

### DG. Watchdogs that ignore canonical config create false incidents

Issues:

- `#3182`
- `#2956`

Why it matters:

- if repair and patrol tools read hardcoded defaults instead of real config,
  healthy systems get escalated as broken
- confidence in the control plane erodes faster than the backend itself

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 3`

### DH. Override and alternate launch paths can silently skip shared invariants

Issues:

- `#3153`
- `#3028`

Why it matters:

- one override flag or one alternate start path can drop settings, hooks,
  readiness, or working-directory invariants
- the engine then has multiple launch classes with different hidden semantics

Risk rating: `🎯 9.6   🛡️ 9.3   🧠 4`

### DI. Legacy sources that keep writing after migration prolong drift indefinitely

Issues:

- `#3272`
- `#3158`

Why it matters:

- duplicate env and metadata writers keep creating noise, ambiguity, and
  backwards truth even after a canonical source exists
- migrations only converge when old write paths actually stop

Risk rating: `🎯 9.0   🛡️ 8.9   🧠 3`

### DJ. Crash recovery can resurrect already-finished work if it only watches process death

Issue:

- `#3399`

Why it matters:

- restarting a worker without checking work state can reanimate closed tasks and
  create idle, duplicate, or bogus sessions
- process recovery must be subordinate to work ownership and status

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### DK. Entity removal that cleans only one plane leaves undead runtime state

Issue:

- `#3658`

Why it matters:

- deleting a worktree without killing its session leaves a half-removed worker
  that later tools must interpret as zombie state
- destructive actions should leave no ambiguity about whether the entity still
  exists

Risk rating: `🎯 9.3   🛡️ 9.0   🧠 3`

### DL. Depending on another tool's built-in enums creates hidden release coupling

Issue:

- `#3539`

Why it matters:

- when upstream removed `agent` as a built-in type, Gastown's spawn path broke
  completely
- retry loops then hid a contract failure behind transient-looking behavior

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### DM. Routing that depends on shallow ID parsing will fail as identifiers evolve

Issue:

- `#3361`

Why it matters:

- if a richer nested ID can no longer route to the same rig, the ID schema is
  outgrowing the resolver
- operators then create aliases just to get around path-shape assumptions

Risk rating: `🎯 9.2   🛡️ 9.0   🧠 4`

### DN. Durable metadata that stores aliases instead of canonical backend names causes false health

Issue:

- `#3357`

Why it matters:

- a prefix looked plausible locally but did not identify the real Dolt database
- backend state and metadata then disagreed about the same rig

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 3`

### DO. Remote viability should fail early with domain-specific diagnosis

Issue:

- `#3054`

Why it matters:

- empty repositories are not rare edge cases during setup
- if preflight does not catch them early, users get low-level clone/fetch noise
  instead of a correct actionable message

Risk rating: `🎯 8.8   🛡️ 8.7   🧠 2`

### DP. Filesystem shape is a poor canonical source for identity membership

Issue:

- `#2767`

Why it matters:

- extra worktrees can be mistaken for real crew identities when checks enumerate
  directories directly
- filesystem layout should not silently redefine expected membership

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 3`

### DQ. Raw string substitution into structured config creates portability drift

Issue:

- `#3250`

Why it matters:

- platform-specific path syntax can invalidate generated JSON or other config
  formats if values are interpolated without format-aware escaping
- once generation is non-idempotent, every sync loop becomes noisy and suspect

Risk rating: `🎯 9.0   🛡️ 8.9   🧠 3`

### DR. Session residue can create false health if status does not prove live execution

Issue:

- `#3146`

Why it matters:

- a dead pane inside an existing tmux session can trick status and restart flows
  into treating a dead worker as alive
- health surfaces must prove liveness, not just leftover shell infrastructure

Risk rating: `🎯 9.3   🛡️ 9.1   🧠 3`

### DS. Post-migration checks that read the old store create silent false-green states

Issue:

- `#2003`

Why it matters:

- when doctor/readiness logic keeps reading deprecated files after a storage
  migration, empty data looks like success
- silent no-op checks corrupt operator trust more deeply than explicit failures

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 4`

### DT. Protocol values that are not portable across query layers can stall the system without crashing it

Issue:

- `#3196`

Why it matters:

- non-finite numeric values like `+Inf` may survive one writer path but break
  polling and query logic later
- the system can stay "up" while core workflows never advance

Risk rating: `🎯 9.2   🛡️ 9.0   🧠 4`

### DU. Wrong official install instructions break trust before runtime even starts

Issue:

- `#3651`

Why it matters:

- release pages and package names are part of the executable product contract
- if official installation text points to the wrong artifact, users cannot tell
  whether later failures are theirs or the product's

Risk rating: `🎯 8.9   🛡️ 8.8   🧠 2`

### DV. Upgrade flows that leave legacy transport namespaces alive can create split-brain

Issue:

- `#3570`

Why it matters:

- changing socket or namespace strategy without reaping old sessions allows old
  and new control planes to coexist
- duplicate agents then compete on shared state with no clean authority boundary

Risk rating: `🎯 9.7   🛡️ 9.4   🧠 5`

### DW. One logical workspace mapping to multiple backing stores creates silent data splits

Issues:

- `#3562`
- `#2682`

Why it matters:

- if rig name and prefix can both become backend database names, work lands in
  one store while supervisors read another
- the system appears idle while the data exists elsewhere

Risk rating: `🎯 9.7   🛡️ 9.4   🧠 5`

### DX. Ephemeral lifecycle models break when durable foreign-key graphs assume persistence

Issue:

- `#3354`

Why it matters:

- transient agent entities living in one table cannot safely emit child rows
  constrained against another durable table by default
- relational integrity must match lifecycle semantics, not just schema habit

Risk rating: `🎯 9.3   🛡️ 9.1   🧠 5`

### DY. Marking work as active before worker acknowledgment creates false progress

Issue:

- `#2635`

Why it matters:

- session start can be mistaken for real execution even if the worker never read
  or understood its assignment
- without explicit ack, startup failures look like silent mid-task stalls

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### DZ. Interactive roles can be falsely considered healthy on runtimes that do not deliver input

Issue:

- `#2066`

Why it matters:

- a detached session may preserve the process while destroying the role's actual
  interactive contract
- operator-facing roles need explicit capability matching, not generic process
  launch

Risk rating: `🎯 9.1   🛡️ 8.9   🧠 3`

### EA. Partial wake subscriptions can leave critical control-plane signals unread

Issue:

- `#3075`

Why it matters:

- if a witness wakes only on one activity source, crash mail or other urgent
  signals may sit unread while the system appears idle
- event-driven orchestration is only as complete as its wake subscriptions

Risk rating: `🎯 9.4   🛡️ 9.1   🧠 4`

### EB. Fresh-clone bootstrap that needs manual migration rituals is not really portable

Issue:

- `#2654`

Why it matters:

- a portable workspace should be hydratable from its declared remotes without
  process killing, port repair, or data-dir migration ceremonies
- if bootstrap logic lives in one subsystem but install logic ignores it, users
  inherit the split-brain

Risk rating: `🎯 9.5   🛡️ 9.2   🧠 6`

### EC. Hidden provisioning planes create configuration and debugging ambiguity

Issue:

- `#3220`

Why it matters:

- overlays and setup hooks can materially change new worktrees by copying files
  or executing scripts
- if that plane is implicit, operators cannot reason about what "fresh" really
  means

Risk rating: `🎯 8.9   🛡️ 8.8   🧠 3`

### ED. CLI help drift is public contract debt, not docs polish

Issue:

- `#3374`

Why it matters:

- when help text promises one dispatch scope and the command enforces another,
  users lose the ability to distinguish misuse from product error
- command UX is part of the engine's external truth surface

Risk rating: `🎯 8.8   🛡️ 8.7   🧠 2`

## 2. Strong quality signals that keep the project worth studying

- around `489` test files under `internal/`
- around `32` design-doc files under `docs/design/`
- active open PR flow on the same hard seams, which means maintainers are still
  investing in them
- release `v1.0.0` in April 2026

This means the right interpretation is:

- serious project with real architectural debt

not:

- unserious project

## 3. Best practices these open risks are pointing toward

### Make repo and workspace boundaries explicit

Do not rely on cwd folklore.

Use explicit workspace identity and boundary checks.

### Make destructive operations fail closed

Any operation that can mutate code or repo state should prefer refusing to run
over guessing the intended target.

### Keep generated state out of user-visible diffs by construction

Ignore, redirect, or isolate orchestrator artifacts before work begins.

Do not rely on later cleanup.

### Make precedence rules explicit and testable

User config should beat deterministic defaults, and machine-readable CLI modes
should never be inferred implicitly.

### Make operator controls bind to live transport identity

Attach, nudge, and dashboard actions should use authoritative session and pane
identity, not cached hints or naming folklore.

### Treat retention and cleanup as lifecycle contracts

Log rotation, orphan-process cleanup, and status refresh loops all need safe
ownership-aware design.

### Keep watchdogs and override paths on the same invariant envelope

Health checks, repair tools, and alternate launch modes should resolve the same
config and preserve the same startup guarantees as the normal path.

### Make canonical registries win over layout and alias shortcuts

Routing, identity membership, and backend names should resolve from canonical
registries and metadata, not from shallow parsing or directory shapes.

### Treat truthful status and migration-safe checks as first-class contracts

Status should prove live execution, and checks should fail loudly if they no
longer read the authoritative store.

### Treat release text, upgrade cleanup, and capability matching as runtime contracts

Install commands, namespace migrations, and role-runtime compatibility should be
validated with the same seriousness as scheduler correctness.

### Treat bootstrap hydration, wake completeness, and command text as first-class contracts

Portable install, complete wake conditions, and truthful CLI help are all part
of the public reliability surface.

### Keep startup and init atomic

Init, registration, startup, and recovery should have explicit phases and
resumable ownership.

### Keep completion narrow

Completion should not become a giant policy macro that also owns too many merge,
cleanup, and routing concerns.

### Keep the richest workflow features on the strongest substrate

If a workflow depends on cross-scope routing, blocked scans, event propagation,
and cleanup relays, the substrate underneath it must be very quiet.

### Keep external authority boundaries explicit

Internal completion should not automatically imply authority over upstream PRs,
branches, or remote repository objects.

### Make autonomy defaults real, not aspirational

If a system presents itself as autonomous after install, the permission and
approval path must already converge in the default setup.

### Treat connection lifecycle and query batching as engine design

Shared state backends under many agents need explicit connection ownership,
batching, and timeout strategy.

### Remove dead production paths fast

Once the real control path changes, stale handlers, comments, and tests become
architectural drag.

### Keep preservation automations narrower than ordinary user workflows

Fallback save paths should be biased toward preserving edits, not sweeping in
all possible git state transitions.

### Make namespace uniqueness a first-class invariant

Prefixes, route keys, and rig identifiers must be checked before activation, not
repaired after cross-talk begins.

### Give every generated artifact one authoritative owner

Validator, generator, and runtime consumer must share the same definition of a
correct artifact.

### Version table schemas and consume them through typed contracts

Background loops should not infer or assume key types informally.

### Scrub ambient identity from services and daemons

Service processes should set their own actor identity explicitly and reject
inherited worker/session identity.

### Degrade autonomy safely when coordination state is unavailable

Loss of shared state or messaging should push workers toward pause, save, or
operator escalation - not free-running solo behavior.

### Keep self-improvement and upstream contribution opt-in

Credits, GitHub identity, and maintainer-facing workflows need explicit user
consent.

### Treat large-repo mode as part of the worker model

Clone topology, object reuse, and sparse materialization belong in the primary
architecture, not in a late optimization pass.

### Model Git verification against the real semantic target

Push URL, actual upstream branch, and commit identity should be explicit engine
 concepts, not inferred from convenient defaults like `origin/main`.

### Keep runtime metadata out of user diffs by construction

Agent instructions, lifecycle context, and orchestration overlays should live in
 ignored or isolated files, not in tracked review surfaces.

### Make continuation and repair of existing PR work first-class

Fixing an open branch, rebasing stale work, or consolidating multiple worker
 branches should be explicit supported workflows.

### Establish role invariants on every start path

Anything patrols depend on must be actively created or repaired at role start,
not only during initial rig creation.

### Run mandatory workspace setup in the engine, not in agent instructions

Initialization that the task depends on should happen before the agent starts
reasoning about the work.

### Inject identity and Git authorship explicitly for every worker type

Mail identity, service identity, and commit identity all need deterministic
setup, including for secondary roles like dogs and plugin runners.

### Make startup bounded in both time and credit burn

Attach, boot, and recovery loops should have explicit cost ceilings and visible
failure states.

### Support non-code task types with explicit completion semantics

Do not let code-diff heuristics stand in for task completion across the whole
product.

### Require observability parity across supported runtimes

If a runtime can do work, the main status and dashboard surfaces must be able to
see it correctly.

### Verify delivery after dispatch

Assignment is not complete until the worker has actually received visible work
 or the system has escalated the failure.

### Add grace periods and spawn states to every supervisor

Watchdogs and patrol loops should share one explicit model of "just started" vs
 "really dead."

### Treat supported runtimes as full contracts, not launch commands

Session metadata, resume semantics, process detection, and hook behavior must
 all come along with runtime support.

### Learn from historical cost and outcome before launching more work

Persist enough signal to estimate expected value, loop risk, and likely waste
 before spawning agents.

### Gate federated or remote completions with evidence

Cross-system trust should rely on receipts, verification, or deterministic
 attestations, not only on narrative status reports.

### Normalize CI state into typed categories

Policy-blocked, infra-broken, and product-regressed are distinct orchestration
 situations.

### Feed routing from runtime observability, not only code and issue metadata

Logs, traces, and test outputs should help decide where work belongs.

### Budget startup context like any other scarce resource

If orchestration instructions consume most of the model window, the worker is
 already partially dead on arrival.

### Enforce runtime parity through one authoritative resolver

Start, restart, recovery, and attach flows should all consume the same runtime
 contract.

### Learn scheduling policy from historical cost and outcome

Persist enough signal to predict when a run is likely thrash before paying for
 it again.

### Tighten verification as systems become multi-machine or federated

Cross-boundary collaboration should come with stronger evidence rules, not
weaker ones.

### Preserve unknown config state unless the file is truly fully owned

If trust flags or neighboring tool state live in the same file, generators must
 merge or preserve rather than replace blindly.

### Make operator-environment integration explicit and reversible

Bindings, shell hooks, and shared-surface mutations should be opt-in and should
 chain to prior behavior where possible.

### Base hygiene and routing on canonical registries

Never force plugins to guess session or route identity from naming folklore.

### Model idle/no-work as a benign state

Background agents should exit quietly when nothing is wrong and nothing is
 pending.

### Keep one canonical root/workspace identity variable

Aliases may exist for migration, but only one name should be authoritative.

### Give config changes a low-disruption propagation path

Hot reload or scoped reload is often safer than forcing full-role restarts.

### Keep writer and reader sides on one metadata transport

Liveness, routing, and session ownership should not depend on one path writing
 env while another path reads only tmux tables or vice versa.

### Make degraded mode explicit when reactive capabilities are unavailable

Background loops should fall back to timeout/backoff semantics rather than
 crashing when a subscription primitive is absent.

### Add contamination preflight before branch-affecting workflows

Scope checks are far cheaper before sling/merge than after review noise lands.

### Round-trip verify writes that cross boundaries

Cross-db, cross-prefix, or cross-service writes are only real once they can be
 observed again through the normal query path.

### Require executed-step evidence for patrol and maintenance loops

Cycle counters and summaries are not enough when the system is supposed to be
 doing real safety work.

### Inherit shared backend config into every workspace class

Helper roles and transient workspaces should not depend on ad hoc manual
 configuration to reach core state backends.

### Prefer continuity-preserving restart semantics

Compaction and quota-management flows should continue prior work unless the user
 explicitly requests a reset.

### Serialize every mutation path to shared targets

If several workflows can push or land into the same target, one lock must cover
 all of them.

### Separate completion from integration in dependency semantics

A worker finishing, a review passing, and code landing are different events and
the dependency engine should model them separately.

### Fail fast on structural integrity errors

Reference violations and broken parent links should trip invariant alarms, not
quietly enter retry loops.

### Budget interactive status paths against measured backend latency

Dashboards should use real command economics or progressive loading instead of
pretending every status read is a cheap local check.

### Preserve raw usage telemetry alongside derived cost views

Keep tokens and other raw evidence so quota analysis and later cost-aware
scheduling remain possible.

### Stamp completed work with durable output-location metadata

Completion should publish enough structured output facts for downstream review,
synthesis, and audit to avoid heuristic searching.

### Treat trace and evidence schemas as first-class public contracts

If external tools can consume your traces or receipts, version and own that
schema deliberately.

### Classify restart causes before applying backoff

Quota, auth, crash, and dependency-loss exits need different orchestration
responses.

### Run schema init through the same authority path as live runtime writes

DDL, registration, and normal inserts should converge on one backend truth, not
 split between embedded and live-server modes.

### Require ownership proof before adopting an already-running service

Port occupancy and basic health checks are not enough for authority.

### Snapshot shared config once per supervision cycle

Hot loops should carry one coherent view of config and topology through the
 tick.

### Query specialized orchestration stores through their own typed readers

Do not route engine correctness through generic user-facing CLI abstractions.

### Declare and test plugin host-runtime compatibility

Shell version, interpreter, and platform assumptions belong to the product
 contract once plugins run in scheduled maintenance paths.

### Preserve full transport identity for live attach and reconnect flows

Sockets, namespaces, and targets should survive any attach handoff.

### Fix recurrent routing ambiguity in the engine, not only with helper plugins

Helpful rewrites are fine, but they should not substitute for first-class
 default routing rules.

### Surface compatibility walls at the command boundary

If queued work cannot execute because of version skew or backend mismatch, tell
the user at scheduling time, not only in daemon logs later.

### Protect the first-run journey with full integration tests

Install, rig init, worker context, and first assignment need one end-to-end
test path.

### Give remote backends one clearly owned discovery path

Endpoints should be easy to find, inherit, diagnose, and compare against live
connections.

### Keep routing resolution symmetric across reads and writes

Authoritative targeting should apply to creation and mutation paths, not only to
queries.

### Treat packaging and postinstall logic as supported runtime surface

Platform support includes download, extraction, and activation steps.

### Model runtime capabilities as orthogonal flags

PTY requirements, prompt-shape limits, resume style, and similar constraints
should be independently representable.

### Own provider-specific project-context contracts explicitly

External runtimes need their expected persistent context files or explicit
redirection configured as part of integration.

### Preserve canonical IDs inside all derived tracking artifacts

Convoys, queues, and dashboards should not lose source truth when work crosses
rig or store boundaries.

### Make external merge modes explicit

Direct push, GitHub PR merge, hosted merge queue, and similar paths are
different orchestration strategies, not one implicit default.

### Model remotes by role, not just by URL

Canonical repo, fork remote, upstream, and merge target need explicit semantics.

### Publish an exact install-method support matrix

The product should say clearly which install/build path is valid on which
platform.

### Version build assets with the toolchain floor they actually require

Dockerfiles and local bootstrap images should move with dependency minimums.

### Mark shipped workflows by wiring status explicitly

Manual-only, experimental, and fully automated workflows should not be
indistinguishable in the product surface.

### Give provider-level custom agents a real engine model

If a provider feature can run in parallel or without a repo, the orchestrator
should know what that means operationally.

### Accept authoritative external events through typed ingress

Webhooks and similar upstream signals should complement or replace polling where
they are the cleaner source of truth.

### Isolate multiple orchestration domains at the namespace boundary

Separate sockets, state roots, and service namespaces per town or domain.

### Separate role behavior from long-lived identity overlays

Persistent specialization should not force mutations of the base role contract.

### Model provider/auth profiles as schedulable resources

Accounts, models, and harness variants should participate in engine policy with
cooldowns, fallback chains, and stickiness.

## 4. Bad practices these risks tell us to ban

- implicit repo targeting
- mutating based on guessed cwd
- startup races without strong locking or phase ownership
- one command owning too much policy surface
- advanced workflow features on top of already-fragile routing and state layers
- trusting interactive terminal infrastructure as a durable control boundary
- assuming internal success implies authority over external forge artifacts
- selling autonomy while depending on hidden out-of-band settings for it to work
- letting shared backend exhaustion emerge from "harmless" short-lived command spawning
- leaving parser helpers looser than their documented contract
- letting dead paths and stale comments survive long enough to become contributor folklore
- letting safety-net auto-save paths stage destructive diffs by default
- allowing routing namespaces to collide and treating repair as acceptable
- accepting generator/validator disagreement as normal maintenance noise
- hard-coding schema assumptions into continuously running pollers
- allowing services to inherit actor identity from the shell that launched them
- letting coordination-backend failure silently convert team autonomy into
  isolated worker improvisation
- shipping self-improvement or upstream-maintainer workflows without explicit
  consent boundaries
- assuming large repositories can be supported later without redesigning clone
  and materialization strategy
- approximating Git truth with `origin/main`, fetch URLs, or branch-name
  heuristics
- reusing full-checkout completion logic in sparse/partial worktrees
- letting runtime context files modify tracked source-repo surfaces
- optimizing for fresh branch creation while leaving existing-PR repair as a
  manual recovery path
- assuming patrol and daemon logic can repair invariants they never actually
  establish
- making required workspace setup depend on prompt compliance
- treating identity injection as optional for secondary roles
- allowing startup or failed-install loops to spend credits without tight bounds
- assuming code-diff heuristics generalize to non-code workflows
- advertising multi-runtime support while keeping provider-specific blind spots
  in primary dashboards
- treating dispatch as successful before the worker visibly receives work
- letting one supervisor learn spawn-aware rules while another still kills fresh
  workers
- treating stale-heartbeat detection as sufficient without a consumer loop
- exposing custom runtimes through config while withholding the metadata needed
  for real parity
- spending credits without any persistent model of historical cost vs outcome
- trusting federated completions without verifying tool-use evidence
- parsing CI outcome ad hoc instead of normalizing it into typed orchestration state
- routing work without direct access to runtime observability signals
- treating startup context size as harmless prompt overhead
- allowing restart or repair paths to bypass the normal runtime resolver
- assuming federation can rely on the same trust model as a single local town
- replacing shared config files wholesale when they contain user or external-tool state
- mutating tmux or shell behavior without explicit operator consent
- reconstructing session identity from names instead of asking the authoritative registry
- escalating benign idle state as though it were failure
- letting multiple root env names coexist indefinitely without one canonical meaning
- forcing disruptive restarts for routine config changes when scoped reload is possible
- writing metadata through one channel and reading it back through another incompatible one
- assuming reactive feed/follow capabilities exist without a safe degraded path
- discovering branch contamination only after side effects have begun
- trusting cross-boundary success responses without readback verification
- reporting patrol success without step-level evidence
- treating helper-role backend wiring as less important than primary-role wiring
- using restart flows that silently reset context during preservation scenarios
- locking one merge path while leaving another producer free to mutate the same target
- treating dependency closure as equivalent to code integration
- retrying structural integrity failures as though they were transient infra noise
- hardcoding dashboard budgets below normal backend latency and calling the result "status"
- discarding raw usage signals once one normalized cost number has been computed
- marking work complete without durable output-location metadata for downstream consumers
- treating trace/export formats as cosmetic output instead of public protocol
- applying one crash-loop policy to quota exhaustion, real crashes, and auth failures alike
- splitting schema init and live runtime writes across different authority paths
- adopting already-running services based only on port occupancy
- rereading the same topology/config file many times inside one control tick
- routing specialized engine queries through generic user-facing CLI wrappers
- shipping scheduled plugins without owning their declared shell/runtime floor
- trying to reattach live sessions with only partial transport identity
- depending on rewrite plugins to correct everyday routing ambiguity
- letting version-skew walls hide behind delayed daemon failures
- treating first-run integration tests as optional CI polish
- forcing users to discover remote backend endpoints through scattered folklore
- resolving routes authoritatively on reads but ambiently on writes
- claiming platform support while the standard installer is platform-broken
- encoding runtime support as one opaque special case instead of explicit capability flags
- assuming one provider-agnostic context-file contract without owning provider-specific reality
- creating tracking artifacts that lose canonical source IDs across rig boundaries
- hardwiring direct push as the only real merge strategy
- treating fork remotes as a rare manual workaround instead of a first-class mode
- publishing install methods without a truthful platform-by-method support matrix
- letting Dockerfiles or build images lag behind dependency toolchain minimums
- shipping workflow artifacts that look automated but are only manual conventions
- calling provider-level custom agents "supported" without mapping them onto engine roles and lifecycle
- ignoring authoritative forge events and forcing everything through polling
- hosting multiple towns without separate transport namespaces
- stuffing long-lived agent identity into generic role templates
- leaving provider/account failover as manual operator lore instead of lifecycle policy

## Final takeaway

Gastown's open issues reveal something important:

the biggest remaining risks are not "missing features".

They are places where:

- boundary rules are still too soft
- lifecycle operations are still too wide
- the substrate still has too much room for ambiguity
