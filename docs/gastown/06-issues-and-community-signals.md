# Gastown Issues and Community Signals

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file groups the most useful issue-level signals by theme.

## Issue cluster map

Approximate recurring topic counts from the issue corpus used in the deep dive:

- `polecat` - `88`
- `beads` - `91`
- `dolt` - `65`
- `witness` - `47`
- `tmux` - `48`
- `convoy` - `46`
- `doctor` - `30`
- `worktree` - `31`
- `windows` - `12`
- `headless` - `7`
- `sandbox` - `5`
- `hook_bead` - `7`
- `role_agents` - `4`
- `routes / metadata / prefix routing` - `24`

That already tells the story:

- Gastown pain is concentrated around runtime substrate and lifecycle seams
- not around one thin feature

## 1. Beads is carrying the wrong kind of truth

Key issues:

- `#764`
- `#2922`
- `#2405`
- `#3222`
- `#3562`

Signal:

- people are not just patching local bugs
- they are circling the idea that Beads/Dolt/routing is the wrong substrate
  for some parts of runtime truth

## 2. tmux input is not fixable enough as a reliable control channel

Key issues:

- `#1216`
- `#3031`
- `#3538`

Signal:

- contributors explicitly move toward side-channel delivery and away from
  assuming tmux input is reliable enough as a sole transport

## 3. Startup and role identity are still a recurring pain surface

Key issues:

- `#1289`
- `#1666`
- `#3033`
- `#3218`
- `#3248`
- `#3133`

Signal:

- non-Claude and hook-driven startup paths reveal the weakest runtime seams
- identity, config, env, and hook delivery are still not one coherent contract

## 4. Hook state and lifecycle truth have been unstable for a long time

Key issues:

- `#2371`
- `#2384`
- `#2416`
- `#2431`
- `#2641`
- `#2675`
- `#3114`
- `#3294`

Signal:

- the system has been migrating hook truth for a long time
- compatibility tax spread into daemon, witness, stop hooks, and prime flow

## 5. Convoy and parked-work features expose expensive orchestration seams

Key issues:

- `#3587`
- `#3597`
- `#3117`
- `#2067`

Signal:

- the richest workflow features are also where non-atomicity, polling tax, and
  recovery tax show up most clearly

## 6. Repair tooling is not just convenience

Key issues:

- `#885`
- `#3416`

Signal:

- contributors treat `doctor --fix` as normal architecture support, not only a
  nice-to-have maintenance tool
- boundary mistakes in repair are viewed as trust violations

## 7. Cross-platform weakness is structural, not cosmetic

Key issues:

- `#3538`
- `#1382`
- `#2716`

Signal:

- Windows and headless/sandboxed workers are hard because tmux/interactive
  session assumptions are deeply embedded

## 8. Performance pain is live, not historical

Key issues:

- `#1760`
- `#2618`
- `#3117`
- `#3596`
- `#3597`

Signal:

- the performance tax is not one old bug
- multiple live issues still point to process churn, convoy polling, and Dolt
  connection pressure as active architectural seams

## 9. Rich features are where the deepest cracks show

Key issues:

- `#3587`
- `#3196`
- `#3622`
- `#3320`
- `#3363`
- `#1893`

Signal:

- the most advanced workflow features are exactly where state-model drift,
  routing ambiguity, merge-policy leakage, and event-shape assumptions show up
- that is a classic sign that the substrate is too expensive for the feature
  richness placed on top of it

## 10. Remote artifact ownership is easy to blur unless the contract is explicit

Key issue:

- `#3198`

Signal:

- the refinery merged internal work correctly, but also crossed into upstream PR
  and branch ownership
- this reveals a deeper rule: internal lifecycle success does not imply authority
  over external forge artifacts

Architect lesson:

- remote PRs, branches, and external repository state need their own ownership
  contract
- internal merge completion must not silently expand into upstream control

## 11. Product autonomy defaults are part of the shipped runtime contract

Key issue:

- `#3000`

Signal:

- multi-agent autonomy was effectively blocked after a standard install because
  permission behavior was not converged by default
- users discovered that the real contract lived partly in external Claude
  settings, not in Gastown's own install story

Architect lesson:

- if autonomy is a headline capability, its permission model must be part of the
  default product contract
- hidden or externally scattered prerequisites become runtime seams, not setup
  footnotes

## 12. Connection lifecycle is a core engine concern, not infra garnish

Key issue:

- `#3623`

Signal:

- short-lived `bd` process spawning and long-lived Dolt connections can combine
  into a death spiral
- the issue is not just query speed, but connection ownership, batching, and
  lifecycle shape

Architect lesson:

- once many agents and dashboards share one state backend, connection economics
  become part of the orchestrator architecture itself

## 13. Defense-in-depth matters even when the current exploit path is low-risk

Key issue:

- `#3110`

Signal:

- validation helper comments and actual enforcement drifted apart
- current downstream use was relatively safe, but the contract gap still
  mattered because future call sites could make it exploitable

Architect lesson:

- validation should match the stated contract exactly
- "currently low-risk" is not a good reason to leave parser slack at control
  boundaries

## 14. Dead production paths are a real community signal, not cleanup trivia

Key issue:

- `#3653`

Signal:

- the community is now finding cases where tests and comments still center a
  lifecycle path that production no longer uses
- this is more than dead code bloat: it reveals parallel mental models inside
  the codebase

Architect lesson:

- obsolete control paths and obsolete docs must be removed quickly after a
  production path changes
- otherwise contributors keep repairing the wrong system

## 15. Service identity must not depend on launch context folklore

Key issue:

- `#3006`

Signal:

- daemon-spawned notifications were attributed to the agent session that
  launched the daemon
- service mail inherited ambient `GT_ROLE` and `BD_ACTOR` style identity
  instead of carrying its own authoritative service identity

Architect lesson:

- service and control-plane components must scrub ambient worker identity before
  launching
- background services need explicit actor identity, not best-effort inference
  from inherited env

## 16. Backend outage should degrade autonomy toward pause, not improvisation

Key issue:

- `#3623`

Signal:

- when Dolt went down, agents could not send mail or close beads
- one crew agent then started implementing unplanned work solo because the
  communication fabric was gone

Architect lesson:

- if coordination state or messaging is unavailable, multi-agent autonomy
  should degrade toward quarantine, pause, or local save mode
- backend loss must not silently turn a team system into isolated rogue workers

## 17. Consent boundaries belong in the issue trail, not only in design docs

Key issue:

- `#3649`

Signal:

- contributors are explicitly worried that upstream-improvement workflows can
  consume user credits and GitHub identity without clear opt-in
- the issue is not mere optics: it is about whose goals the shipped defaults
  are actually serving

Architect lesson:

- self-improvement, upstream PRs, and maintainer-facing automation must be
  explicit opt-in features
- user credits and forge identity are authority boundaries, not free ambient
  resources

## 18. Large-repo economics are user-facing architecture, not scaling garnish

Key issues:

- `#1059`
- `#1790`

Signal:

- contributors are not asking for micro-optimizations
- they are surfacing clone topology, bare-repo reuse, sparse materialization,
  and startup cost as first-order viability concerns

Architect lesson:

- worker model and repo topology must be designed together
- an orchestrator that assumes cheap full clones will quietly fail on serious
  enterprise repositories

## 19. Safety-net automation can become destructive if it is not narrowly scoped

Key issue:

- `#3615`

Signal:

- an auto-save/safety-net path meant to preserve work could also auto-commit
  tracked deletions
- this is a strong reminder that preservation automations need much tighter
  scope than ordinary user git flows

Architect lesson:

- safety-net writes should preserve additions and modifications first
- destructive diffs need separate explicit handling

## 20. Namespace collisions in routing systems are not minor setup bugs

Key issue:

- `#3341`

Signal:

- a prefix collision was enough to make two rigs' witnesses cross-pollinate and
  act on each other's work
- this reveals that namespace allocation is part of lifecycle correctness, not
  just cosmetic ID generation

Architect lesson:

- routing namespaces must be uniqueness-checked at creation time
- collision detection belongs in the core control plane, not as manual repair

## 21. Non-convergent subsystems are a stronger warning than simple bugs

Key issue:

- `#3648`

Signal:

- `gt doctor` and `gt hooks sync` each considered themselves correct while
  disagreeing forever about polecat settings
- the problem is not just "one check is wrong", but that there is no single
  authoritative convergence contract between generator and validator

Architect lesson:

- every generated artifact needs one owner and one definition of "green"
- generator and doctor must share the same truth model

## 22. Schema assumptions buried in polling code become systemic outages

Key issues:

- `#3197`
- `#3622`

Signal:

- convoy event polling depended on hidden assumptions about `events.id` shape
- once real schemas used UUID/CHAR(36), the poller failed continuously

Architect lesson:

- typed contracts for shared tables must be explicit and versioned
- background pollers cannot rely on half-remembered schema assumptions

## 23. The community keeps finding places where "helpful automation" outruns authority

Key issues:

- `#3198`
- `#3401`
- `#3615`

Signal:

- closing upstream PRs
- auto-slinging newly unblocked work
- auto-committing tracked deletions

all live on the same fault line:

- the system wants to automate transitions
- but authority, ownership, and safe scope are not always explicit enough

Architect lesson:

- automation should expand only inside clearly owned boundaries
- "can automate" is not the same thing as "should automate by default"

## 24. Git and PR semantics cannot be approximated with "main" heuristics

Key issues:

- `#3224`
- `#3183`
- `#3345`
- `#3400`
- `#3032`

Signal:

- multiple workflows break because the system asks the wrong Git question:
  - checks fetch URL instead of push URL
  - compares to `origin/main` instead of the branch's real upstream
  - deduplicates by branch naming heuristics instead of commit identity
  - pushes without rebasing to the current base branch

Architect lesson:

- branch, upstream, push target, and merge identity must be modeled explicitly
- "ahead of main" is not the same thing as "unpushed"
- branch-name heuristics are not a substitute for commit identity

## 25. Sparse checkout creates a different truth model, not just a faster checkout

Key issues:

- `#3402`
- `#1790`

Signal:

- hidden paths can look like deletions to generic status checks
- large-repo mode changes the meaning of completion checks, cleanliness checks,
  and file materialization

Architect lesson:

- sparse/partial worktrees need first-class semantics in the engine
- completion logic and dirty-state logic cannot blindly reuse full-checkout
  assumptions

## 26. Runtime-generated context must never pollute tracked diffs

Key issue:

- `#3260`

Signal:

- a helper that writes agent lifecycle context into tracked `CLAUDE.md` turns
  runtime metadata into review noise and sometimes into committed garbage

Architect lesson:

- worker/runtime context files belong in isolated runtime paths or ignored local
  files
- generated orchestration metadata must be prevented from entering user diffs by
  design

## 27. Existing-PR remediation has to be a first-class workflow

Key issues:

- `#3602`
- `#3603`
- `#3604`
- `#3588`

Signal:

- the system is good at greenfield branch creation
- it is much weaker at continuing, repairing, or consolidating already-open PR
  work
- duplicate PRs, stalled consolidations, and "done without landed outcome"
  all show the same gap

Architect lesson:

- reopen, continue, fix-conflicts, and consolidate flows need explicit engine
  support
- retrying existing work should be easier than spawning fresh duplicate work

## 28. Startup invariants must be enforced on start, not only on initial rig creation

Key issues:

- `#3652`
- `#3638`

Signal:

- some critical lifecycle guarantees exist only in `rig add` or only as daemon
  intentions
- later `start()` paths and recovery handlers can assume invariants they never
  actually establish

Architect lesson:

- every role's start path must actively establish the invariants its runtime and
  patrol logic rely on
- detection without repair is not a reliable lifecycle contract

## 29. Deterministic environment setup should be engine-owned, not prompt-owned

Key issue:

- `#3001`

Signal:

- essential worktree setup only happened if the agent followed formula
  instructions correctly
- missing setup then looked like random task failure even though the real issue
  was missing deterministic initialization

Architect lesson:

- required workspace setup belongs in the lifecycle engine
- prompts may explain setup, but they must not be the only thing enforcing it

## 30. Identity propagation has to work for every role, not just the main ones

Key issues:

- `#3223`
- `#3410`

Signal:

- dogs could not read their own inbox because they lacked a resolvable full
  identity
- polecat worktrees could emit misattributed commits if Git identity was not
  injected at creation time

Architect lesson:

- every worker type needs explicit runtime identity and explicit VCS identity
- identity bugs in "secondary" roles can still stall the whole system

## 31. Startup cost is part of the product contract, not just model economics

Key issues:

- `#2614`
- `#3660`

Signal:

- startup and failed-install loops could burn large amounts of model usage
- operators experienced token exhaustion before getting useful work out of the
  system

Architect lesson:

- startup must be cheap, bounded, and observable
- failed installation or recovery loops must not continue spending user tokens

## 32. Non-code task semantics must be explicit in a coding-oriented orchestrator

Key issue:

- `#2496`

Signal:

- polecats auto-closed non-code work because the engine used "no git diff" as a
  proxy for "nothing to do"
- this made legitimate operational tasks invisible to the worker model

Architect lesson:

- completion semantics must depend on task type and explicit outcome model, not
  only on code diff heuristics
- coding and non-coding workflows need different success criteria

## 33. Observability must be provider-agnostic to be operationally trustworthy

Key issue:

- `#3614`

Signal:

- polecats running through non-Claude runtimes were active in tmux and rig
  status, but invisible in the dashboard
- that created a split between real system state and operator-visible state

Architect lesson:

- dashboards and status surfaces must key off shared runtime contracts, not one
  provider's metadata shape
- observability parity is part of multi-runtime correctness

## 34. Dispatch needs delivery verification, not just "session started"

Key issue:

- `#2748`

Signal:

- dogs, crew, and deacon workers could start with empty inbox and empty hook,
  silently burning time because dispatch assumed "assigned + started" meant
  "delivered"

Architect lesson:

- dispatch is not complete until work delivery is verified
- startup needs fallback or escalation when hook/mail is empty at first boot

## 35. Supervisors need spawn-awareness and grace periods

Key issue:

- `#2036`

Signal:

- witness patrol could nuke freshly slung polecats because it checked liveness
  before startup finished
- Go runtime had added guards, but formula-level supervision bypassed them

Architect lesson:

- every supervisor needs explicit spawn-aware states and grace periods
- parallel watchdogs must share the same lifecycle semantics

## 36. Detection without a consumer loop is not real recovery

Key issue:

- `#3584`

Signal:

- stale heartbeats and dead polecat signals existed, but nobody consumed them
  reactively
- hooked work could remain dead forever until a human noticed

Architect lesson:

- health signals must feed an actual remediation or escalation loop
- write-only detection is operational theater

## 37. Custom-agent support fails if runtime metadata is not first-class

Key issue:

- `#2943`

Signal:

- custom agents could launch the right binary but still idle forever because
  session metadata, process names, and resume semantics were missing

Architect lesson:

- model/runtime customization must inherit the full execution contract, not just
  command and args
- "can start process" is far below "is a supported runtime"

## 38. Cost-aware orchestration is one of the smartest ideas in their issue trail

Key issue:

- `#1143`

Signal:

- contributors are explicitly pushing toward persistent cost/outcome datasets,
  expected-value estimates, and anti-thrash preflight logic
- this is not bug repair, it is a mature direction for orchestration economics

Architect lesson:

- orchestration should learn from prior cost vs outcome, not only from static
  rules
- budget-aware preflight can stop expensive low-yield runs before they start

## 39. Federation needs verifiable receipts, not trust in narrative completions

Key issue:

- `#2814`

Signal:

- federated completions can silently carry confabulated tool outputs that pass
  casual inspection
- the proposed fix is cryptographic or deterministic receipt-gating, not better
  prompting

Architect lesson:

- remote or cross-rig completions need evidence gates at the protocol level
- trust systems must verify tool claims before accepting downstream work

## 40. Machine-readable CI triage is a real orchestration primitive

Key issue:

- `#1978`

Signal:

- operators currently parse CI state inconsistently, which misroutes convoy and
  PR workflows
- contributors want normalized categories like `failed`, `pending`,
  `policy-blocked`, and `no checks`

Architect lesson:

- CI interpretation belongs in the orchestrator as typed state, not in ad hoc
  string parsing
- policy blockers and product failures need different routing semantics

## 41. Runtime observability is not just for dashboards, but for routing and triage

Key issue:

- `#1141`

Signal:

- contributors explicitly want logs, metrics, traces, and test output to create
  or annotate work
- the proposal separates observer, triage, and test-controller concerns instead
  of overloading one coding agent

Architect lesson:

- runtime observability should feed work creation and routing
- execution and validation should be separated when false success is expensive

## 42. Context budget is part of runtime architecture, not prompt polish

Key issue:

- `#3332`

Signal:

- startup instructions, role templates, and prime output can consume almost the
  entire context window before the worker reads a single project file
- the system then fails not because the model is weak, but because the startup
  envelope is too expensive

Architect lesson:

- bootstrap context must have a budget and a minimal mode
- internal orchestration guidance competes directly with task execution budget

## 43. Hardcoded runtime assumptions keep reappearing unless parity is enforced centrally

Key issue:

- `#2417`

Signal:

- even after adding agent-resolution layers, restart paths could still fall back
  to hardcoded `exec claude` style behavior
- this shows how easy it is for one recovery path to break multi-runtime parity

Architect lesson:

- every lifecycle path must go through the same runtime-resolution contract
- one Claude-shaped bypass is enough to poison the whole abstraction

## 44. Thrash prevention should be learned from evidence, not guessed from anecdotes

Key issue:

- `#1143`

Signal:

- contributors explicitly want cost/outcome memory and preflight expected-value
  checks instead of relying only on human intuition about which runs are wasteful

Architect lesson:

- persistent execution-cost and outcome signals can become a scheduling asset
- anti-thrash should be a learned systems capability, not only a human instinct

## 45. Federation and remote collaboration need stronger truth than model narration

Key issues:

- `#2814`
- `#2407`
- `#2794`

Signal:

- multi-town and federated work are attractive directions
- but once work crosses machine or rig boundaries, tool-result confabulation and
  unverifiable completions become protocol problems

Architect lesson:

- cross-system work needs protocol-level evidence and trust gates
- federation should tighten verification, not relax it

## 46. Managed config must preserve unknown user state unless it truly owns the whole file

Key issues:

- `#2022`
- `#2050`

Signal:

- regenerating role-level settings destroyed user trust decisions and recreated
  interactive prompts across roles
- the system treated "file we touch" as "file we fully own," and that broke
  unattended execution

Architect lesson:

- managed config generators should preserve unknown keys by default
- if a tool shares a file with another product's trust state, destructive
  regeneration is a contract bug

## 47. Operator environment mutation needs explicit consent and safe chaining

Key issue:

- `#1548`

Signal:

- install-time tmux bindings overrode existing user bindings globally, even
  outside Gastown sessions
- the problem was not only mutation, but mutation without fallback to the user's
  original behavior

Architect lesson:

- environment or shell integration must be explicit opt-in
- when integrating into shared operator surfaces, preserve or chain existing
  behavior instead of replacing it silently

## 48. Session hygiene must use authoritative registries, not guessed naming rules

Key issues:

- `#2707`
- `#2423`

Signal:

- plugins that reconstructed session or routing identity from rig names instead
  of canonical prefixes killed healthy sessions or went blind to real ones
- maintainers explicitly called for audit of subprocess/routing call sites

Architect lesson:

- session identity and routing targets must come from authoritative registries
- if every plugin has to reconstruct naming rules, the core contract is too implicit

## 49. "No work" should be a normal terminal state, not an error escalation

Key issue:

- `#3148`

Signal:

- deacon boot patrol escalated "no work available" every few minutes, flooding
  the mayor and burning context for a completely normal idle condition

Architect lesson:

- orchestrators must model idle/no-work as a first-class benign outcome
- escalations should be reserved for failures, not for absence of tasks

## 50. Ambient root aliases increase context ambiguity unless one canonical root wins

Key issue:

- `#2104`

Signal:

- `GT_ROOT` and `GT_TOWN_ROOT` carried the same value but served different
  historical audiences
- that creates one more place where runtime, shell, and subprocess conventions
  can drift apart

Architect lesson:

- root/workspace identity should have one canonical name and clear alias policy
- duplicate ambient root variables are small seams that accumulate large confusion

## 51. Hot reload requests are often a symptom of overly expensive config propagation

Key issue:

- `#945`

Signal:

- users need a way to apply role/model/config changes without tearing down
  in-flight orchestration
- this suggests config ownership and propagation are too restart-heavy

Architect lesson:

- configuration changes should have an explicit propagation model
- not every operator tweak should require full role restarts and state loss

## 52. Writer and reader paths must agree on where runtime identity lives

Key issue:

- `#1861`

Signal:

- non-Claude sessions were judged dead because write paths stored identity in
  one place while liveness checks read from another
- the abstraction looked correct on paper but disagreed at the transport level

Architect lesson:

- runtime identity and liveness metadata need one authoritative transport
- writer/reader asymmetry is enough to break multi-runtime parity

## 53. Capability assumptions need a degraded mode, not a crash loop

Key issue:

- `#1561`

Signal:

- a step depended on a non-existent or unsupported feed-follow command and then
  failed hard instead of degrading into timeout/backoff behavior

Architect lesson:

- background orchestration steps must verify capability assumptions and fall
  back deterministically when the fast path is unavailable

## 54. Side-effecting workflows need contamination guards before they start

Key issue:

- `#2220`

Signal:

- stacked or unrelated branch changes were discovered too late, after sling or
  merge flow had already progressed

Architect lesson:

- contamination checks belong in preflight, before any orchestration side
  effects
- scope violations should fail fast with machine-readable diagnostics

## 55. Success responses are meaningless if cross-boundary state cannot be read back

Key issue:

- `#2786`

Signal:

- cross-prefix dependency creation reported success, but the dependency could
  not be queried back and therefore did not exist in any useful sense

Architect lesson:

- writes that cross routing or database boundaries need round-trip verification
- "acknowledged" is weaker than "persisted and observable"

## 56. Patrol and supervision need proof of executed work, not just cycle reporting

Key issues:

- `#2386`
- `#1456`

Signal:

- patrol loops could report healthy cycle counts without actually executing the
  expected steps
- contributors explicitly pushed toward deterministic timeout policy and
  machine-readable receipts

Architect lesson:

- background supervision must emit evidence of what actually ran
- timeout behavior should be deterministic and diagnosable, not prompt-shaped

## 57. Auxiliary workspaces must inherit shared backend config by construction

Key issue:

- `#2930`

Signal:

- dogs spawned outside rig worktrees could not reach the shared Dolt server and
  fell into escalation flood loops

Architect lesson:

- every workspace type that depends on shared state needs deterministic backend
  wiring
- "main roles work, helper roles break" usually means config inheritance is too
  ad hoc

## 58. Compaction and handoff flows should preserve continuity by default

Key issue:

- `#2072`

Signal:

- compaction-triggered handoff restarted a fresh session and destroyed
  conversation continuity right when context preservation mattered most

Architect lesson:

- compaction, quota rotation, and restart flows should preserve prior context
  unless explicitly told not to
- restart is not the same thing as reset

## 59. Shared mutation points must be serialized across all producers

Key issue:

- `#594`

Signal:

- refinery and conflict-resolution polecat could both push to `main`
  concurrently because the lock covered one path but not the other

Architect lesson:

- any shared mutation target needs one serialization boundary across all code
  paths, not one lock per subworkflow

## 60. Dependency closure semantics must distinguish "completed" from "integrated"

Key issue:

- `#1893`

Signal:

- downstream convoy work could dispatch as soon as the upstream source bead was
  closed by `gt done`, even though the corresponding merge request had not
  merged yet
- this exposed a semantic gap between worker completion and code integration

Architect lesson:

- dependency types must be able to express "wait until merged/integrated", not
  just "wait until the worker stopped"
- completion, review, merge, and integration are different states and should
  not be collapsed into one generic "closed"

## 61. Structural integrity errors should fail fast, not back off forever

Key issue:

- `#3436`

Signal:

- foreign key violations were retried with exponential backoff as though they
  were transient infrastructure errors
- the system burned loops while the real problem was broken structural truth

Architect lesson:

- reference-integrity failures are usually signals of invariant breakage, not
  temporary unavailability
- integrity errors should surface loudly and stop the workflow rather than
  hiding behind retry machinery

## 62. Interactive observability needs budgets that match backend economics

Key issue:

- `#3589`

Signal:

- dashboard mail-inbox calls timed out because the UI budget assumed a cheap
  local command while the path actually depended on slower Dolt-backed queries
- status then looked worse than reality simply because the budget was wrong

Architect lesson:

- interactive surfaces need timeout budgets based on measured backend cost, not
  arbitrary convenience numbers
- otherwise observability becomes a source of false negatives and operator
  noise

## 63. Persist raw usage signals, not only normalized cost projections

Key issue:

- `#3375`

Signal:

- Gastown already had token data at record time but only persisted derived USD
- that made flat-rate or quota-based users lose the signal they actually care
  about

Architect lesson:

- raw usage data such as input and output tokens should be durable first-class
  telemetry
- normalized cost is useful, but it should be a derived view layered on top of
  raw evidence, not the only preserved signal

## 64. Completed work should publish output-location metadata for downstream consumers

Key issue:

- `#303`

Signal:

- synthesis and convoy consumers had to guess where completed work lived by
  hunting branches, worktrees, or bare-repo state
- the orchestrator knew the work was "done" but not where the output actually
  landed

Architect lesson:

- completed work should stamp durable output metadata such as commit, branch,
  and location hints
- downstream synthesis, review, and audit paths should query output facts
  directly instead of reconstructing them heuristically

## 65. Trace interoperability is a strategic schema choice, not tooling garnish

Key issue:

- `#1697`

Signal:

- the project is explicitly considering whether to adopt an external trace
  schema for interoperability with AI-native IDEs
- that choice is being treated as architecture, not as a late-stage export
  format

Architect lesson:

- trace schemas and evidence formats are part of the ecosystem contract
- once external tools depend on them, they become long-lived architectural
  commitments, not dashboard polish

## 66. Restart policy must classify quota exhaustion differently from real crashes

Key issue:

- `#3398`

Signal:

- daemon applied the same crash-loop backoff whether Claude had genuinely
  crashed or merely hit a usage/rate limit
- economic pauses and process failures were treated as one class of event

Architect lesson:

- restart policy needs typed failure classes such as crash, quota, auth, and
  unavailable dependency
- usage limits should trigger bounded wait or pause semantics, not escalating
  crash suspicion

## 67. Shared-state DDL must go through the same authoritative backend path as runtime writes

Key issue:

- `#3641`

Signal:

- embedded DDL created schema on disk while the live sql-server path used by
  runtime inserts still had no selected database
- branch push succeeded, but merge-request bead creation failed because schema
  initialization and runtime mutation used different authority paths

Architect lesson:

- schema init, DDL, and normal writes must converge on one authoritative store
  path
- "wrote to disk" is meaningless if the live coordination backend does not see
  the same state

## 68. Service adoption must prove ownership, not just notice an open port

Key issue:

- `#2772`

Signal:

- `gt dolt start` could adopt a rogue or rig-local Dolt server solely because
  it occupied the expected port
- status then looked healthy while the town was actually talking to the wrong
  data directory

Architect lesson:

- service adoption needs positive ownership evidence such as expected data dir,
  instance identity, or attested registration
- occupancy and basic health are not enough to establish authority

## 69. Hot control loops should read shared config once per tick, not on every helper call

Key issue:

- `#3463`

Signal:

- daemon heartbeat paths reread the same `rigs.json` file many times inside one
  tick
- this was silent overhead, not a user-facing crash, but it amplified the cost
  of background supervision

Architect lesson:

- orchestration loops should snapshot shared config once per cycle and hand the
  snapshot down
- repeated tiny reads inside hot loops are architecture debt, not harmless
  micro-inefficiency

## 70. Specialized stores should query their own authoritative schema, not generic CLI wrappers

Key issue:

- `#3037`

Signal:

- convoy checks routed dependency queries through generic `bd dep` paths that
  only understood regular issues, not convoy records
- the result was not just slowness, but wrong answers from the wrong abstraction
  layer

Architect lesson:

- internal orchestrator features should query their authoritative data model
  directly
- generic user-facing query commands are often the wrong abstraction for engine
  correctness

## 71. Plugin runtime contracts must declare portable shell assumptions explicitly

Key issue:

- `#3635`

Signal:

- plugins silently relied on `bash 4` features while shipping with a generic
  `env bash` shebang that resolves to `bash 3.2` on stock macOS
- patrol kept invoking broken scripts because the runtime contract was weaker
  than the implementation assumed

Architect lesson:

- plugin and script surfaces need declared host-runtime requirements and
  portability tests
- if a maintenance path depends on shell features, the compatibility floor
  must be owned as part of the product contract

## 72. Session attach flows must reuse the full transport identity, not just the session name

Key issue:

- `#3514`

Signal:

- attach logic remembered the session target but forgot the custom tmux socket
- session identity was only partially reconstructed, so reconnect failed even
  though the session existed

Architect lesson:

- reconnect and attach flows must carry the whole transport tuple: socket,
  namespace, target, and mode
- partial identity replay is enough to break operator trust in live-control
  features

## 73. If routing heuristics are common enough to need a plugin, the engine likely owns the problem

Key issue:

- `#3404`

Signal:

- multi-rig users kept forgetting `--rig`, creating work in the wrong place
- the proposed answer was a PreToolUse routing plugin that rewrites commands
  before they execute

Architect lesson:

- when users repeatedly need a heuristic rewrite layer to hit the right store,
  the routing contract itself is probably under-specified
- the engine should prefer explicit first-class routing or authoritative default
  resolution over magical command rewriting

## 74. Version-skew walls should be surfaced at the action boundary, not only in background logs

Key issue:

- `#3533`

Signal:

- `gt sling` could look successful while execution never started because the
  daemon later rejected the workspace on `bd_version` mismatch
- operators only discovered the real wall through daemon logs

Architect lesson:

- compatibility failures should surface as early and as close to the triggering
  action as possible
- "queued successfully" is misleading if a known background wall will prevent
  execution

## 75. Fresh-install integration tests are architecture protection, not CI garnish

Key issue:

- `#20`

Signal:

- many first-run failures only appeared when the whole bootstrap chain was
  exercised together: prefixes, redirects, assignee formats, rig init, polecat
  context, and work assignment
- unit-level correctness was not enough to protect the actual product contract

Architect lesson:

- orchestrators need end-to-end install/bootstrap tests that model the real
  first user journey
- setup correctness is part of architecture because all later workflows depend
  on it

## 76. Remote backend discovery needs one canonical configuration path

Key issue:

- `#2830`

Signal:

- users had multiple ways to hint a remote Dolt host, but the authoritative
  setting path was poorly discoverable
- this led to environment patches, duplicated config, and invisible mismatches

Architect lesson:

- remote service endpoints need one clearly documented and diagnostically
  visible source of truth
- discoverability gaps in backend configuration become architecture debt once
  many subprocesses and roles must inherit the same endpoint

## 77. Write paths must resolve authority symmetrically with read paths

Key issue:

- `#3145`

Signal:

- `Show()` resolved routing to the correct rig database, but `Create()` did not
- the same bead could be readable through the right target while writes still
  landed in the wrong store or failed outright

Architect lesson:

- routing and authority resolution must be symmetric for reads and writes
- if one side uses authoritative targeting and the other uses ambient context,
  the engine will eventually lie to itself

## 78. Packaging and postinstall scripts are first-class platform contracts

Key issue:

- `#3595`

Signal:

- Windows install failed not because the runtime itself was wrong, but because
  the package installer leaked file handles and violated that platform's file
  semantics
- users never reached the orchestrator because the distribution contract was
  already broken

Architect lesson:

- install-time scripts are part of the product's platform support claim
- packaging paths need the same portability discipline as runtime paths

## 79. Runtime capability flags should be explicit and orthogonal

Key issue:

- `#506`

Signal:

- `cursor-agent` exposed at least two independent capabilities: PTY needs and
  multiline-prompt support
- one ad hoc startup path could not represent both cleanly without risking
  regressions for other runtimes

Architect lesson:

- runtime support should be modeled as explicit orthogonal capabilities, not
  one opaque preset or special-case branch
- transport needs, prompt-delivery limits, resume semantics, and startup shape
  should be describable independently

## 80. External runtime integrations must own provider-specific project-context contracts

Key issue:

- `#3139`

Signal:

- Gemini workers received hooks and commands but still lacked a valid persistent
  project context file because Gastown did not explicitly map Gemini's expected
  context contract
- the resulting behavior looked like a weird symlink problem, but the deeper
  issue was that runtime-specific context conventions were only partially owned

Architect lesson:

- if a provider expects `GEMINI.md`, `CLAUDE.md`, or some configurable
  equivalent, the engine must model that explicitly
- external runtime integrations are incomplete until the persistent project
  context contract is owned end-to-end

## 81. Cross-rig tracking artifacts must preserve canonical source IDs all the way through

Key issue:

- `#3581`

Signal:

- auto-created convoys could be created successfully but track `0` issues
  because cross-rig bead IDs were not resolved through the right authority path
- the tracking artifact existed, but it had already dropped the truth it was
  supposed to represent

Architect lesson:

- derived tracking objects must preserve canonical IDs and authoritative source
  references across scope boundaries
- a coordination artifact that loses its link to the source work is worse than
  no artifact, because it looks healthy while carrying false progress

## 82. Protected-branch ecosystems require an explicit external merge mode

Key issue:

- `#3601`

Signal:

- Refinery assumed direct push to `main`, while GitHub rulesets required PRs
  and merge queues
- the result was not just friction, but a dead internal merge queue with manual
  GitHub-side workarounds

Architect lesson:

- merge strategy must be an explicit part of orchestration configuration
- direct push, PR-based merge, hosted merge queue, and hybrid modes are
  different authority paths and should be modeled as such

## 83. Cross-fork contribution needs first-class remote-role modeling

Key issue:

- `#3249`

Signal:

- cross-fork PR creation needed an explicit `fork_remote` concept, not just a
  generic push destination
- once users lack push access to the canonical repo, remote roles become part of
  the engine contract

Architect lesson:

- remotes should be modeled by role such as canonical, fork, origin, upstream,
  and merge target
- "push somewhere and open a PR" is too weak an abstraction once fork-based
  contribution is normal

## 84. Install methods need an exact support matrix and honest runtime guards

Key issue:

- `#3626`

Signal:

- `go install` on Linux produced a macOS-specific warning path that confused
  users about whether the method was supported at all
- the real problem was not only implementation, but a fuzzy platform/method
  support contract

Architect lesson:

- every install method needs a truthful support matrix by platform and caveat
- guardrails should explain the exact unsupported combination, not emit a
  generic warning from another platform's logic

## 85. Build artifacts must track dependency toolchain minimums as code

Key issue:

- `#3502`

Signal:

- Docker-based builds failed because the build image pinned a Go version below
  what the dependency graph now required
- the build asset was effectively out of contract with the code it was meant to
  build

Architect lesson:

- Dockerfiles, CI images, and local bootstrap scripts must track dependency
  toolchain minimums as versioned architecture assets
- build support is part of product reality, not an auxiliary convenience

## 86. Shipped workflow artifacts should not look automated if they are still manual-only

Key issue:

- `#1753`

Signal:

- `code-review.formula.toml` shipped with the product and appeared in help/test
  surfaces, but the automated pipeline never invoked it
- users could reasonably infer an orchestration capability that did not yet
  exist

Architect lesson:

- shipped workflow assets need clear contract status: manual-only, pilot, or
  fully wired
- a workflow being present on disk is not the same thing as it being part of
  the runtime pipeline

## 87. Provider-level custom agents need a real orchestration role model, not just file injection

Key issue:

- `#1792`

Signal:

- provider-native subagents and custom agents raised questions about lifecycle,
  repos, parallelism, role semantics, and automated dispatch
- the issue makes clear that "drop agent definitions into a folder" is far too
  weak for orchestration-grade support

Architect lesson:

- custom agents need an explicit place in the engine model: role, lifecycle,
  execution plane, and dispatch semantics
- provider-level extensibility is only first-class when it composes with
  orchestration primitives, not merely with startup files

## 88. Forge webhooks are first-class event ingress, not just integration garnish

Key issue:

- `#743`

Signal:

- contributors explicitly connect forge webhooks to event-driven wake and daemon
  processing
- this treats external event ingestion as part of the control plane, not as an
  optional notification extra

Architect lesson:

- external systems should be able to drive orchestration through typed ingress
  points
- polling should not remain the only truth-refresh mechanism once authoritative
  upstream events exist

## 89. Multi-town support needs namespace isolation at the transport boundary

Key issue:

- `#1163`

Signal:

- the cleanest fix path was per-town tmux socket derivation, not session-name
  gymnastics
- this shows that the real isolation boundary lived at the socket/transport
  layer

Architect lesson:

- when multiple orchestration domains share one host, namespace separation
  belongs at the transport and state boundary, not only in human-readable names
- socket, data-dir, and service namespace isolation are foundational

## 90. Persistent identity can be layered separately from role behavior

Key issue:

- `#1696`

Signal:

- the proposed crew identity system cleanly separated HOW agents operate from
  WHO they are
- identities were layered town/rig and injected ephemerally through `gt prime`
  rather than written into tracked runtime files

Architect lesson:

- role contract and long-lived identity/persona are different axes and should be
  modeled separately
- ephemeral injection of persistent identity can preserve clean workspaces while
  still giving continuity across sessions

## 91. Provider/auth profiles are really orchestration resource profiles

Key issue:

- `#232`

Signal:

- the proposal framed provider, auth slot, model, harness command, and role
  fallback policy as one first-class profile abstraction
- rate-limit handling was treated as lifecycle/resource scheduling, not only as
  retry logic

Architect lesson:

- multi-provider orchestration gets much stronger once accounts and auth slots
  are modeled as schedulable resources with cooldown, stickiness, and policy
- profile selection belongs to the engine, not to manual restarts

## 92. Shipped workflow artifacts should not look automated if they are still manual-only

Key issue:

- `#1753`

Signal:

- `code-review.formula.toml` shipped with the product and appeared in help or
  test surfaces, but the automated pipeline never invoked it
- users could reasonably infer an orchestration capability that did not yet
  exist

Architect lesson:

- shipped workflow assets need clear contract status: manual-only, pilot, or
  fully wired
- a workflow being present on disk is not the same thing as it being part of
  the runtime pipeline

## 93. Provider-level custom agents need a real orchestration role model, not just file injection

Key issue:

- `#1792`

Signal:

- provider-native subagents and custom agents raised questions about lifecycle,
  repos, parallelism, role semantics, and automated dispatch
- the issue makes clear that "drop agent definitions into a folder" is far too
  weak for orchestration-grade support

Architect lesson:

- custom agents need an explicit place in the engine model: role, lifecycle,
  execution plane, and dispatch semantics
- provider-level extensibility is only first-class when it composes with
  orchestration primitives, not merely with startup files

## 94. Forge webhooks are first-class event ingress, not just integration garnish

Key issue:

- `#743`

Signal:

- contributors explicitly connect forge webhooks to event-driven wake and daemon
  processing
- this treats external event ingestion as part of the control plane, not as an
  optional notification extra

Architect lesson:

- external systems should be able to drive orchestration through typed ingress
  points
- polling should not remain the only truth-refresh mechanism once authoritative
  upstream events exist

## 95. Multi-town support needs namespace isolation at the transport boundary

Key issue:

- `#1163`

Signal:

- the cleanest fix path was per-town tmux socket derivation, not session-name
  gymnastics
- this shows that the real isolation boundary lived at the socket or transport
  layer

Architect lesson:

- when multiple orchestration domains share one host, namespace separation
  belongs at the transport and state boundary, not only in human-readable names
- socket, data-dir, and service namespace isolation are foundational

## 96. Persistent identity can be layered separately from role behavior

Key issue:

- `#1696`

Signal:

- the proposed crew identity system cleanly separated HOW agents operate from
  WHO they are
- identities were layered town/rig and injected ephemerally through `gt prime`
  rather than written into tracked runtime files

Architect lesson:

- role contract and long-lived identity/persona are different axes and should be
  modeled separately
- ephemeral injection of persistent identity can preserve clean workspaces while
  still giving continuity across sessions

## 97. Token-efficient agent-facing protocols can materially change swarm economics

Key issue:

- `#622`

Signal:

- the proposal treats structured output size as a first-class orchestration cost
  because dozens of agents repeatedly read inbox, convoy, and prime data
- this is not just serialization taste, but context-budget and rate-limit
  strategy

Architect lesson:

- once many agents consume the same structured status surfaces, wire-format
  efficiency becomes an engine concern
- agent-facing protocols should be optimized separately from human-facing and
  storage-facing formats

## 98. Local-model cascades are a strong scheduling idea when task classes differ sharply

Key issue:

- `#1243`

Signal:

- the proposal cleanly separates cheap classification or extraction work from
  expensive reasoning or generation work
- local inference is framed as a lower-cost execution tier, not as a full
  replacement for frontier models

Architect lesson:

- orchestration should be able to route different task classes to different
  compute tiers
- local versus cloud is best modeled as a cascade and escalation policy, not as
  one global provider switch

## 99. Model selection belongs to role policy, not session memory

Key issue:

- `#335`

Signal:

- operators wanted Opus only for polecats while cheaper models handled mayor or
  support roles
- relying on the provider CLI to "remember the last model" was clearly too weak
  for orchestrated behavior

Architect lesson:

- model choice should be declarative per role or task class
- orchestration systems should not depend on sticky interactive session residue
  for cost-quality policy

## 100. Provider-level skills need layered injection that avoids both repo pollution and global bleed

Key issue:

- `#1793`

Signal:

- provider-level skills were useful, but the current choices were either
  committing them into the rig repo or placing them in a global user-level
  directory
- neither option matched town, rig, or role-scoped orchestration needs

Architect lesson:

- skills and passive provider capabilities should have layered town, rig, and
  role scopes
- injection should preserve provider-native paths while keeping user repos and
  global home directories clean

## 101. Semantic conflicts deserve a decision lane, not generic merge policy

Key issue:

- `#88`

Signal:

- some concurrent agent conflicts are not textual or structural, but different
  professional judgments about priority, assignee, or meaning
- generic LWW or union resolution can silently erase expertise

Architect lesson:

- orchestrators should distinguish semantic conflicts from technical conflicts
- decision-required fields need escalation paths to a mayor, human, or
  specialized decision role

## 102. Onboarding config should be stack-aware, layered, and non-destructive

Key issue:

- `#983`

Signal:

- hardcoded Go defaults created weak onboarding for non-Go repos
- the proposed fix combined marker-based detection, package-manager awareness,
  monorepo caution, and "don't overwrite existing config"

Architect lesson:

- generated defaults should match the detected stack and remain user-overridable
- onboarding automation should be conservative: helpful on first run, invisible
  once user config exists

## 103. Runtime-generated artifacts must be excluded before work begins

Key issue:

- `#3397`

Signal:

- polecat worktrees generated `.beads/backup/` files that could be staged into
  user PRs
- the failure was not a bad agent decision, but a missing bootstrap boundary

Architect lesson:

- orchestration metadata and recovery artifacts should be excluded at worktree
  creation time, not cleaned up after staging
- if generated state can appear in normal user diffs, the product does not own
  its trust boundary yet

## 104. Observability channels must be cheaper than the workload they observe

Key issue:

- `#3396`

Signal:

- the dashboard's SSE and refresh loops spawned many subprocesses against Dolt
- leaving observability open created major CPU and memory pressure

Architect lesson:

- status channels should use the cheapest authoritative signals available
- a control-plane dashboard that is more expensive than the system it watches
  is itself an outage vector

## 105. Long-running daemons need an explicit retention contract

Key issue:

- `#3573`

Signal:

- Dolt logs grew without rotation
- safe truncation required stop/restart semantics because the writer still held
  the file descriptor

Architect lesson:

- retention is not ops garnish for a long-lived orchestrator
- if a daemon owns a file indefinitely, it also needs a safe reopen or rotate
  contract

## 106. Orphan cleanup must prove non-ownership before kill

Key issue:

- `#3572`

Signal:

- old Dolt servers could linger and waste RAM or hold ports
- but blindly killing them risked touching a still-authoritative backend

Architect lesson:

- cleanup logic should prove that a process is unowned, quiescent, and safe to
  remove
- "looks stale" is not enough for stateful infrastructure processes

## 107. Operator-facing transport actions must resolve live identity, not cached handles

Key issues:

- `#3563`
- `#3534`

Signal:

- nudges targeted stale pane IDs
- one fix tried to qualify pane targets but used invalid tmux syntax

Architect lesson:

- attach, nudge, and peek flows are part of the product contract, not shell
  convenience
- operator actions need live transport identity with the same authority as the
  runtime itself

## 108. Operator UX must track topology changes and real session backing

Key issues:

- `#3565`
- `#3537`

Signal:

- keybindings baked old rig-prefix patterns and stopped matching new sessions
- crew sessions could start outside tmux, leaving no attachable control surface

Architect lesson:

- control affordances must rebind when topology changes
- if the UI says a worker is attachable, there must be a real session behind
  that promise

## 109. Naming rules and prerequisites are first-run contracts, not tribal knowledge

Key issue:

- `#3516`

Signal:

- rig names had undocumented character restrictions
- `dolt` was a hidden install prerequisite

Architect lesson:

- naming constraints and required external tools should be validated before
  user intent turns into a broken run
- hidden prerequisites are architecture debt, not docs polish

## 110. Merge policy belongs in explicit queue configuration

Key issue:

- `#3406`

Signal:

- the merge queue had no way to express review requirements such as minimum
  approvals or no outstanding changes requested
- teams needed policy stronger than "merge when gates pass"

Architect lesson:

- queue policy should model review semantics directly
- protected-branch ecosystems need explicit merge contracts, not hardcoded happy
  paths

## 111. Deterministic defaults must yield to explicit user configuration

Key issue:

- `#3594`

Signal:

- pool initialization ignored the configured namepool and kept using a
  deterministic theme hash
- the system behaved predictably, but not correctly according to user intent

Architect lesson:

- explicit config should beat clever deterministic defaults every time
- once a system exposes user-owned naming or policy configuration, fallback
  heuristics must become secondary

## 112. Machine-readable interfaces need an explicit contract, not guesswork

Key issue:

- `#3571`

Signal:

- maintenance commands expected JSON from `bd list` but received human text with
  Unicode symbols
- compaction and patrol digest then failed on parsing

Architect lesson:

- human CLI output and machine output should be separate, explicit modes
- internal automation should never rely on "probably JSON" output from generic
  command paths

## 113. Expected absence is not a warning condition

Key issues:

- `#3554`
- `#3598`

Signal:

- daemon loops logged warnings every few seconds for rigs that had never been
  parked or never had agent beads
- normal empty state created log bloat and false operator stress

Architect lesson:

- health loops must distinguish expected-empty from suspicious-missing
- repeated warnings about default state are a design failure, not just noisy
  logging

## 114. Health and repair tools must read the same canonical config as runtime

Key issues:

- `#3182`
- `#2956`

Signal:

- reaper and deacon checks used default port assumptions instead of the
  configured Dolt port
- healthy systems then escalated false backend failures

Architect lesson:

- watchdogs, repair tools, and background dogs must use the same config
  resolution path as the service they inspect
- defaults are not safe once user configuration exists

## 115. Disabled policy must disable execution, not just annotate intent

Key issue:

- `#3178`

Signal:

- plugin frontmatter said `disabled = true`, but the deacon kept executing it
- the system preserved syntax for policy but not semantics

Architect lesson:

- if configuration advertises a kill switch, execution paths must honor it
- config that does not actually constrain behavior becomes operational folklore

## 116. Override paths must preserve shared startup invariants

Key issues:

- `#3153`
- `#3028`

Signal:

- `--agent` override skipped the shared settings flag, so hooks and readiness
  wiring vanished
- one server-start path forgot to scrub caller cwd, so backend discovery broke

Architect lesson:

- overrides are not special shortcuts; they must still carry the same invariant
  envelope as normal launch
- if one path skips shared bootstrap wiring, multi-runtime support becomes
  accidental

## 117. Duplicate ambient identity sources create drift and startup noise

Key issues:

- `#3272`
- `#3158`

Signal:

- `GT_ROLE` was written from more than one source
- deprecated port metadata kept getting re-emitted even after the new source of
  truth existed

Architect lesson:

- once a canonical source exists, old sources should stop writing immediately
- migration is not complete if legacy fields continue to be regenerated

## 118. Restart policy must revalidate work ownership before respawn

Key issue:

- `#3399`

Signal:

- overseer auto-restart could relaunch a polecat even after its work bead had
  already been closed
- the system treated "process died" as enough reason to re-enter work

Architect lesson:

- crash recovery should confirm that work is still live and owned before
  restarting a worker
- process liveness and work liveness are different contracts

## 119. Removal is complete only when every owned plane is cleaned up

Key issue:

- `#3658`

Signal:

- `gt polecat remove -f` deleted the worktree but left the tmux session behind
- the product then showed a zombie polecat with no workspace but still-live
  control surface

Architect lesson:

- delete operations should clear every authoritative resource the entity owns:
  files, sessions, registrations, and runtime handles
- partial removal creates undead state that later tooling must guess about

## 120. Domain types should not depend on another tool's built-in enum forever

Key issue:

- `#3539`

Signal:

- once Beads removed `agent` from built-in types, Gastown's old assumptions
  broke polecat spawning entirely
- retries treated a schema/contract mismatch like a transient failure

Architect lesson:

- domain-specific kinds should have a migration-safe representation, such as
  labels or explicitly configured custom types
- if your model depends on someone else's enum, you also depend on their
  release cadence

## 121. Identifier routing must not depend on shallow parsing assumptions

Key issue:

- `#3361`

Signal:

- deeply nested bead IDs broke dispatch even though the routing prefix was still
  unambiguous
- users had to create flatter alias issues as a workaround

Architect lesson:

- routing should key off the canonical identifying part, not incidental shape
  limits like "two dots only"
- identifiers that get richer over time should not invalidate old resolution
  logic

## 122. Metadata must record canonical backing names, not friendly aliases

Key issue:

- `#3357`

Signal:

- rig metadata stored the beads prefix as `dolt_database` instead of the actual
  database name
- local commands then looked healthy on disk but failed against the server

Architect lesson:

- metadata should store the canonical backend identifier, not a convenient local
  shorthand
- aliases are for UX; durable metadata is for correctness

## 123. Remote viability checks should happen before deep provisioning work

Key issue:

- `#3054`

Signal:

- `gt rig add` surfaced a cryptic fetch error for empty repositories
- the code already knew how to explain "repo has no commits", but only after
  deeper clone/refspec steps had already failed

Architect lesson:

- preflight checks should reject empty or unsupported remotes before provisioning
  proceeds
- when the system knows the friendly diagnosis, it should not let a lower-level
  failure leak first

## 124. Identity discovery should come from registries, not raw directory shape

Key issue:

- `#2767`

Signal:

- `agent-beads-exist` counted every non-hidden crew subdirectory as a real crew
  identity
- cross-rig or temporary worktrees inflated missing-identity warnings

Architect lesson:

- expected identity sets should come from registered membership, not filesystem
  enumeration
- directory layout is a cache of deployment, not a canonical identity model

## 125. Structured configs must be rendered with format-aware escaping

Key issue:

- `#3250`

Signal:

- a Windows path with backslashes was substituted raw into JSON template
  content
- hook sync then rewrote files forever because the rendered JSON was invalid

Architect lesson:

- structured config should be rendered through serializers or escaping aware of
  the target format
- raw string substitution into JSON, TOML, or YAML is a long-term portability
  trap

## 126. Status should prove liveness, not only leftover container/session existence

Key issue:

- `#3146`

Signal:

- `gt rig status` treated a tmux session with a dead pane as "already running"
- restart logic then skipped genuinely dead agents

Architect lesson:

- status surfaces should verify live execution, not only remembered container
  existence
- stale shells, sessions, or ptys are not proof that work is still running

## 127. Storage migrations must retire stale readers or make them fail loudly

Key issue:

- `#2003`

Signal:

- two doctor/readiness checks kept reading `issues.jsonl` even after Dolt
  became authoritative
- empty or stale files then produced false all-clear results

Architect lesson:

- after a storage migration, leftover readers must either move to the new source
  or explicitly error
- a silent no-op health check is worse than a broken one because it lies

## 128. Integrity boundaries should fail closed across every call path

Key issue:

- `#2026`

Signal:

- hook/worktree corruption was not uniformly treated as hard-stop state
- some commands could continue on stale or partial execution metadata

Architect lesson:

- corrupted durable execution inputs should stop orchestration deterministically
- best-effort continuation at integrity boundaries turns replay and recovery
  into fiction

## 129. Background protocols should avoid numeric values that cannot survive every boundary

Key issue:

- `#3196`

Signal:

- `+Inf` float values in convoy event data broke polling queries across several
  databases
- the daemon stayed alive, but convoy progression became impossible

Architect lesson:

- event and state schemas should use finite, serializable values across every
  storage and query layer
- values that survive one subsystem but explode in another are protocol debt

## 130. Release artifacts must carry exact installation truth

Key issue:

- `#3651`

Signal:

- the v1.0.0 release page pointed users to the wrong npm package name
- the product's own release surface misdescribed how to install the product

Architect lesson:

- release notes, package names, and install commands are executable product
  contracts
- if official release text is wrong, trust breaks before runtime even starts

## 131. Upgrade migrations must clean legacy transport state or split-brain survives the upgrade

Key issue:

- `#3570`

Signal:

- upgrading changed tmux socket naming, but old sessions on legacy sockets were
  left alive
- daemon restart then spawned duplicate mayor, deacon, witness, and refinery
  agents across old and new sockets

Architect lesson:

- upgrade code must own cleanup of legacy transport namespaces, not just normal
  shutdown paths
- when identity moves, old identity containers must be reaped automatically or
  explicitly blocked

## 132. One logical rig should map to exactly one canonical backend store

Key issues:

- `#3562`
- `#2682`

Signal:

- rigs whose names differed from prefixes could end up with two Dolt databases
- beads written into one database became invisible to components reading the
  other

Architect lesson:

- one logical workspace should have one canonical backing store name
- name aliases and prefixes can help UX, but they must not create parallel
  storage identities

## 133. Ephemeral entities should not be forced through durable relational constraints

Key issue:

- `#3354`

Signal:

- agent beads lived in the ephemeral wisps table, but child event counters still
  referenced durable `issues.id`
- state transitions then failed because the relational model disagreed with the
  lifecycle model

Architect lesson:

- ephemeral entities need lifecycle-aware schemas, not durable-table foreign keys
  copied by habit
- if an entity is transient, downstream event models must be transient-aware too

## 134. Session start is not proof that the worker understood its assignment

Key issue:

- `#2635`

Signal:

- infrastructure marked a polecat as working on session start
- but the agent might not yet have read the hook, parsed the formula, or
  understood the task

Architect lesson:

- there should be a separate acknowledgment edge between "session alive" and
  "work accepted"
- orchestration gains much stronger startup observability when worker-side ack is
  explicit

## 135. Interactive roles need explicit runtime capability contracts

Key issue:

- `#2066`

Signal:

- detached tmux sessions could launch Ink-based roles that looked alive but
  never received keyboard input
- a valid process container did not imply interactive capability

Architect lesson:

- runtimes should declare capabilities like PTY, interactive input, and detached
  viability explicitly
- a role that requires operator input cannot be scheduled onto a runtime that
  only preserves process liveness

## 136. Event loops must subscribe to every meaningful wake source

Key issue:

- `#3075`

Signal:

- witness slept on `bd activity --follow` and never woke for crash mail from the
  overseer
- unread crash reports accumulated while the patrol loop believed nothing had
  changed

Architect lesson:

- wake logic should cover every control-plane signal that can change safety or
  dispatch decisions
- partial event subscriptions create silent blindness, not just latency

## 137. Fresh-clone bootstrap should hydrate authoritative state without a recovery ritual

Key issue:

- `#2654`

Signal:

- a fresh workspace clone needed a brittle multi-step dance of `bd init`,
  process killing, migration, and metadata repair just to recover existing town
  state
- the bootstrap mechanism already existed in one subsystem, but the main
  install path did not own it

Architect lesson:

- first-class bootstrap from remote state should be part of the normal install
  contract
- if initial hydration needs operator rituals, the platform is not really
  portable yet

## 138. Provisioning features that copy files or run scripts need an explicit public contract

Key issue:

- `#3220`

Signal:

- `.runtime/overlay/` and `.runtime/setup-hooks/` influenced new worktrees by
  copying gitignored files and running initialization scripts
- these behaviors existed in code but were effectively undocumented to users

Architect lesson:

- any system that provisions worktrees with overlays or hooks must document that
  contract explicitly
- hidden provisioning planes create surprising state and make debugging much
  harder

## 139. CLI help text is part of the public contract, not garnish

Key issue:

- `#3374`

Signal:

- `gt crew status` help promised an all-rigs no-arg mode, but the command
  actually required rig inference from cwd or `--rig`
- the UX contract and execution contract diverged

Architect lesson:

- command help, examples, and actual dispatch semantics must converge
- when CLI text over-promises, users cannot tell whether they are misusing the
  tool or the tool is lying

## 140. Community signal summary

The issue discussions reveal these convergences:

- people see Beads as overburdened
- people increasingly prefer side-channel delivery over tmux-only transport
- people want more atomic registration and repair commands
- people hit the biggest pain exactly in the richest workflow features
- contributors frequently uncover missing wiring between new abstractions and
  old runtime behavior
- contributors repeatedly expose product-boundary problems, not only runtime
  bugs: ownership, consent, autonomy defaults, and remote authority
- contributors also keep surfacing convergence and authority problems in
  automation: who owns a generated file, who owns a PR, who owns a namespace,
  who owns an automatic transition
- contributors also reveal that ambient identity, backend loss, and large-repo
  economics are not secondary concerns - they directly change system behavior
- contributors also show that Git semantics, sparse-checkout semantics, and
  PR-repair semantics are core orchestration contracts, not integration details
- contributors also keep surfacing one broader rule: deterministic startup,
  identity injection, provider-agnostic visibility, and task-type-aware
  completion are all part of the engine contract
- contributors also show a strong future direction: delivery verification,
  spawn-aware supervision, cost-aware scheduling, typed CI triage, and
  receipt-gated federation are all better answers than more prompt cleverness
- contributors also reveal that context budget and runtime-parity discipline are
  architecture topics, not secondary UX cleanup
- contributors also show that config ownership, idle-state semantics, operator
  consent, and authoritative registries are just as architectural as the
  scheduler itself
- contributors also keep rediscovering the same deep rule: side effects need
  preflight guards, shared mutations need global serialization, and success
  must be proven by observable state rather than optimistic narrative
- contributors also show that integration semantics, retry classification,
  observability budgets, raw telemetry retention, output metadata, and trace
  schema choices are all architecture-level concerns, not secondary polish
- contributors also keep surfacing a deeper rule: if the right behavior depends
  on a special helper path, plugin rewrite, live-port guess, or partial attach
  reconstruction, the engine probably does not yet own the contract cleanly
- contributors also show that provider-specific context files, canonical
  cross-rig tracking IDs, explicit merge modes, remote-role modeling, honest
  install support matrices, and build-toolchain floors are all part of the
  orchestrator contract, not support afterthoughts
- contributors also show that workflow wiring status, provider-level custom
  agents, forge webhooks, multi-town namespace isolation, layered agent
  identity, and provider/auth resource profiles are strategic engine concerns,
  not mere product extras
- contributors also show that compatibility warnings, install journeys, remote
  endpoint discovery, routing symmetry, packaging semantics, and runtime
  capability modeling are all core orchestration concerns, not support trivia
- contributors also reveal several genuinely strong future patterns: optimized
  agent-facing protocols, local-model cascades, role-based model policy,
  layered skill injection, semantic-conflict escalation, and conservative
  stack-aware onboarding
- contributors also keep surfacing one quieter but important rule: generated
  artifacts, logs, orphan backends, attach targets, and keybindings all become
  architecture problems once the orchestrator runs for days instead of minutes
- contributors also keep proving that precedence rules, machine-readable modes,
  warning budgets, and override parity are not implementation details - they
  are part of the engine contract
- contributors also keep surfacing a deeper invariance rule: cleanup must span
  all owned planes, IDs must route by canonical meaning, and registries must win
  over filesystem folklore
- contributors also keep showing that portability, truthful status, and storage
  migration safety live in small seams like template rendering, stale readers,
  dead panes, and unsupported numeric values
- contributors also keep surfacing the same broader rule: release text, upgrade
  migrations, storage naming, runtime capabilities, and worker acknowledgment
  are all part of the orchestrator contract, not surrounding paperwork
- contributors also keep proving that event completeness, bootstrap hydration,
  provisioning transparency, and CLI/help truth are core orchestration
  contracts, not documentation afterthoughts

## Retrieval hint

Open this file when the question is:

- "what do real users and contributors complain about?"
- "which problems are systemic, not just one-offs?"
- "what do the issues prove about the architecture?"
