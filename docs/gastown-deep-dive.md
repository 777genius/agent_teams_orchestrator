# Gastown Deep Dive

Date: 2026-04-16

Repo revision studied:
- Gastown `main` at `bdbe8c4b0e45f318576c838355fcc85b15e74b8f`
- latest release observed: `v1.0.0`

Method:
- cloned latest repo locally to `/tmp/gastown-latest`
- inspected design docs, core runtime code, and open GitHub issues
- focused on architecture quality, recurring failure modes, and what is genuinely strong vs genuinely weak

## Bottom Line

Gastown is one of the most interesting orchestration codebases I have looked at, but also one of the most expensive ones architecturally.

It is strong because:
- it has real orchestration ideas, not just agent spawning
- it models roles, handoffs, mail, recovery, convoys, worktrees, and merge flow as first-class concepts
- it clearly tries to solve real multi-agent coding problems, not just wrap a chat UI around a CLI

It is weak because:
- too much critical runtime truth is built on top of Beads + Dolt + routing metadata
- tmux is still a major part of the control plane
- there is a lot of compensating complexity around init, routing, metadata repair, watchdogs, and startup nudges

My honest score:
- orchestration imagination: **9.4/10**
- runtime substrate quality: **5.6/10**
- durability / operational predictability: **6.1/10**
- architecture overall: **7.2/10**

## The Main Takeaway

Gastown is not weak because it lacks ideas.

Gastown is weak because it tries to do very advanced orchestration on top of a substrate that is too fragile for the amount of truth it is asked to carry.

That distinction matters.

## High-Signal Facts

- stars: about `14.1k`
- open issues: `215`
- latest local HEAD studied: `2026-04-15 bdbe8c4`
- test files found: `492`
- total Go LOC under `internal/`: about `410k`

Largest hot files:
- `internal/doltserver/doltserver.go` - `4050` lines
- `internal/tmux/tmux.go` - `3922`
- `internal/daemon/daemon.go` - `2886`
- `internal/polecat/manager.go` - `2510`
- `internal/mail/router.go` - `1884`
- `internal/doctor/rig_check.go` - `1863`

This already tells you something important:

their complexity is concentrated exactly where their architectural seams are:
- storage/routing
- tmux runtime control
- daemon orchestration
- worker lifecycle
- mail delivery
- repair logic

## Architecture Heat Map

There are four especially hot architectural zones in the codebase:

1. **Storage and identity plumbing**
   - `internal/doltserver/doltserver.go`
   - `internal/rig/manager.go`
   - `internal/beads/routes.go`
2. **Session transport and runtime control**
   - `internal/tmux/tmux.go`
   - `internal/polecat/session_manager.go`
   - `internal/witness/manager.go`
3. **Central orchestrator loop**
   - `internal/daemon/daemon.go`
4. **Recovery and lifecycle glue**
   - `internal/witness/handlers.go`
   - `internal/deacon/redispatch.go`
   - `internal/doctor/rig_check.go`

That is not accidental. These are the places where architectural debt accumulates.

## Code-Level Compensation Signals

One of the clearest deeper findings is that the hottest files are full of
language that signals compensation around weak seams rather than simple domain
logic.

Examples from the current code:

- `internal/tmux/tmux.go`
  - `fallback`: `50`
  - `race`: `26`
  - `zombie`: `25`
- `internal/witness/handlers.go`
  - `zombie`: `140`
  - `orphan`: `36`
  - `dedup`: `5`
  - `fallback`: `11`
- `internal/daemon/daemon.go`
  - `zombie`: `21`
  - `orphan`: `24`
  - `grace period`: `6`
  - `fallback`: `10`
- `internal/polecat/session_manager.go`
  - `fallback`: `26`
  - `retry`: `10`

This is not proof of bad engineering by itself. In fact, some of it reflects
hard-won production knowledge.

But it does show something important:

- the codebase spends a lot of energy on interlocks, retries, dedup, grace
  periods, non-fatal branches, and safety nets
- many of the hardest problems are not business logic, but state-reconciliation
  and transport-reliability problems
- Gastown is strong partly because it has learned from these failures, but the
  volume of compensators is itself evidence that several base primitives are too
  fragile

The pattern repeats in comments such as:

- `belt-and-suspenders`
- `safety net`
- `fail open`
- `grace period`
- `create-then-dedup`
- `restart-first policy`
- `concurrent patrol race`

That vocabulary tells you where the architecture is paying rent.

## Issue Cluster Map

These counts are approximate keyword clusters from open issues, not deduplicated categories:

| Cluster | Open issue hits |
|---|---:|
| `polecat` | 88 |
| `beads` | 78 |
| `dolt` | 55 |
| `witness` | 47 |
| `tmux` | 43 |
| `convoy` | 38 |
| `doctor` | 26 |
| `worktree` | 26 |
| `routes / metadata / prefix routing` | 24 |
| `mail` | 24 |
| `nudge / prompt delivery` | 20 |
| `windows` | 11 |

Interpretation:

- worker lifecycle pain is real, not isolated
- storage/routing pain is real, not isolated
- tmux/session transport pain is real, not isolated
- repair tooling exists because the base system often needs repair

## What Gastown Does Very Well

### 1. Real multi-agent role model

Gastown has a much richer orchestration model than most competitors:

- Mayor
- Deacon
- Witness
- Refinery
- Polecats
- Crew
- Dogs / Boot

These roles are not cosmetic. They shape workflow, escalation, merge, cleanup, and monitoring.

This is very strong product and architecture thinking.

Sources:
- `/tmp/gastown-latest/docs/design/architecture.md`
- `/tmp/gastown-latest/docs/design/mail-protocol.md`

### 2. Mail is a real protocol

Gastown's inter-agent communication is explicit and typed:

- `POLECAT_DONE`
- `MERGE_READY`
- `MERGED`
- `MERGE_FAILED`
- `REWORK_REQUEST`
- `RECOVERED_BEAD`
- `RECOVERY_NEEDED`
- `HELP`
- `HANDOFF`

This is a serious strength. Most systems hide coordination in ad hoc prompts or generic comments. Gastown makes coordination legible.

Sources:
- `/tmp/gastown-latest/docs/design/mail-protocol.md`
- `/tmp/gastown-latest/internal/mail/router.go`

### 3. Worktree-first worker isolation is excellent

Polecats and refinery use worktrees from `mayor/rig`, while crew can use full clones. That is a smart model for coding agents:

- worktrees for fast ephemeral execution
- full clones for human persistence

This is one of the best architectural choices in the project.

Source:
- `/tmp/gastown-latest/docs/design/architecture.md`

### 4. Scheduler state separation is genuinely smart

Gastown uses separate sling-context state rather than mutating the work bead directly. This is one of the best ideas in the whole repo.

It means:
- work truth stays cleaner
- scheduling retries and dispatch metadata can evolve separately
- transient dispatch state has its own lifecycle

Sources:
- `/tmp/gastown-latest/docs/design/scheduler.md`
- `/tmp/gastown-latest/internal/scheduler/capacity/pipeline.go`
- `/tmp/gastown-latest/internal/beads/beads_sling_context.go`

### 5. Recovery is treated as a first-class concern

Witness and Deacon are not bolted-on monitoring.

They exist because Gastown assumes:
- workers will die
- work will get orphaned
- dispatch will need retry
- cooldown and escalation must be explicit

That mindset is correct. Many orchestrators are too optimistic here.

Sources:
- `/tmp/gastown-latest/internal/deacon/redispatch.go`
- `/tmp/gastown-latest/internal/witness/manager.go`

### 6. The team is aware of its own weak seams

This is an underrated positive. Gastown is not blindly stuck in its current design. The repo contains strong self-critique and transition documents:

- `factory-worker-api.md` explicitly calls out tmux, regex prompt matching, filesystem scraping, and vendor-specific hacks as unstable
- ACP code exists, which suggests they are at least exploring a healthier protocol boundary
- mail store integration bypasses `bd` subprocesses when possible, which is a real attempt to reduce latency and shelling-out overhead

Sources:
- `/tmp/gastown-latest/docs/design/factory-worker-api.md`
- `/tmp/gastown-latest/internal/acp/`
- `/tmp/gastown-latest/internal/mail/store.go`

### 7. They do improve after incidents

An example: the startup nudge logic was updated to use `IsIdle` rather than `IsAtPrompt`, specifically to avoid false-positive retries interrupting Claude mid-processing.

That is good engineering behavior. They learn and harden.

Source:
- `/tmp/gastown-latest/internal/polecat/session_manager.go`
- [issue #3031](https://github.com/gastownhall/gastown/issues/3031)

### 8. ACP is a real attempt to escape tmux hacks

The ACP layer matters because it shows the team is not satisfied with the old runtime boundary.

What ACP is trying to do:
- proxy JSON-RPC between UI and agent
- support structured prompt injection
- track busy vs idle more explicitly
- move away from raw send-keys and pane scraping

That is a healthy direction.

But it is not yet a fully clean replacement:
- ACP itself is still a transition layer
- some issues remain even there, especially around Windows and process semantics
- much of the rest of the system still assumes tmux-backed sessions exist

The open Windows ACP issue is revealing here: even the new protocol layer still
assumes Unix-shaped process and pipe semantics in important places. That does
not make ACP a bad idea. It means the transition is real, but incomplete.

So I would read ACP as a sign of architectural maturity in the team, but not as proof that the underlying transition is complete.

Sources:
- `/tmp/gastown-latest/internal/acp/proxy.go`
- `/tmp/gastown-latest/internal/acp/propulsion.go`
- `/tmp/gastown-latest/docs/design/factory-worker-api.md`
- open ACP/headless issues from `gh issue list`

### 9. Mail is one of the cleanest subsystems, but it still inherits Beads fragility

One of the more positive deeper findings is that the mail subsystem is
architecturally cleaner than many of the surrounding seams.

Why it is strong:

- the router surface is coherent and typed
- address semantics are explicit: list, queue, announce, channel, direct
- there is a meaningful protocol vocabulary instead of prompt soup
- the package has a non-trivial test surface

Useful signals:

- `internal/mail` currently has about `116` test functions
- open issue pressure on `mail` is much lower than on `polecat`, `beads`, `dolt`,
  or `tmux`
- the design docs and router implementation line up more closely here than in
  several other subsystems

But this comes with an important caveat:

- the router still persists and queries mail through Beads
- queueing, retention, message lookup, and address resolution still inherit the
  same store/routing substrate that causes other forms of drift

So the lesson is subtle:

- the **protocol design** is one of Gastown's best ideas
- the **storage substrate under the protocol** is still one of Gastown's weakest
  layers

Sources:
- `/tmp/gastown-latest/docs/design/mail-protocol.md`
- `/tmp/gastown-latest/internal/mail/router.go`
- `/tmp/gastown-latest/internal/mail/bd.go`

## The Biggest Architectural Problems

### 1. Beads is asked to carry too much operational truth

This is the central problem.

Gastown uses Beads for more than "issues":
- role identity
- molecules
- convoys
- merge queue artifacts
- routes
- message transport
- some lifecycle and recovery surfaces

That creates a deep mismatch between substrate and usage.

Beads can work well as a collaboration/issue substrate. It is much less convincing as the hard runtime truth for an orchestrator this dynamic.

Best public articulation of this problem:
- [issue #764 - The Fragility of Beads in Gas Town](https://github.com/gastownhall/gastown/issues/764)

This is not just a philosophical complaint. It directly manifests as:
- split-brain databases
- prefix drift
- metadata drift
- route ambiguity
- difficult recovery
- silent wrong-store behavior

### 2. Dolt/routing/metadata identity is a systemic fault line

This is probably the most expensive technical seam in the codebase.

The project needs:
- central Dolt server
- per-rig databases
- `routes.jsonl`
- `metadata.json`
- rig names
- prefixes
- redirects
- repair logic

And these concepts can disagree with each other.

The issue tracker around this is brutal:
- [#2405](https://github.com/gastownhall/gastown/issues/2405) rogue Dolt server from `bd init`
- [#2922](https://github.com/gastownhall/gastown/issues/2922) partial init leaves rig broken
- [#3222](https://github.com/gastownhall/gastown/issues/3222) metadata ping-pong between two DB identities
- [#3562](https://github.com/gastownhall/gastown/issues/3562) duplicate databases make beads invisible to mayor

The code reflects this pain directly:
- `InitBeads` runs `bd init`
- then reconfigures database assumptions
- then drops orphan DBs
- then rewrites metadata
- then may repair again later

Sources:
- `/tmp/gastown-latest/internal/rig/manager.go`
- `/tmp/gastown-latest/internal/doltserver/doltserver.go`
- `/tmp/gastown-latest/internal/beads/routes.go`

This is not one bug. This is a fault line.

Going deeper into the current implementation makes this seam even clearer.

`EnsureAllMetadata` now contains explicit logic to:

- merge route-derived DB names and rig-prefix-derived DB names
- group multiple DB candidates per rig
- avoid oscillation if more than one DB maps to the same rig
- prefer the DB already written in `metadata.json` if it is among valid candidates

That is thoughtful code, but also very revealing:

- the system cannot always derive one unambiguous identity source
- multiple valid-looking database names can exist for a single rig
- repair code now needs anti-oscillation logic just to stop metadata from
  flipping between candidates on repeated runs

This is architecture-level compensation, not ordinary plumbing.

Sources:
- `/tmp/gastown-latest/internal/doltserver/doltserver.go`
- `/tmp/gastown-latest/internal/doltserver/doltserver_test.go`

### 2.5 The rig init pipeline is still a repair chain, not a clean atomic state machine

Looking directly at `internal/rig/manager.go`, the `AddRig` flow is one of the
best examples of Gastown's architectural tension.

The path is roughly:

1. create repo/container structure
2. maybe create the server-side DB with `InitRig`
3. run `InitBeads`
4. `InitBeads` runs `bd init --server --prefix <prefix>`
5. `InitBeads` sets `issue_prefix`
6. `InitBeads` drops orphan `beads_<prefix>` DB
7. back in `AddRig`, call `EnsureMetadata`
8. then set `issue_prefix` again, now against the corrected DB
9. then append route to `routes.jsonl`
10. then run post-init identity verification, which may repair metadata again

The comments in the code are explicit that this is necessary because:

- `bd init` creates the wrong DB shape for Gastown's naming model
- metadata may point at the wrong database
- `issue_prefix` may need to be written twice, once before and once after
  metadata repair
- orphan DBs need cleanup after init
- identity may still need verification or `doctor --fix`

Important nuance:

- `AddRig` *has improved* and now persists `rigs.json` inside the function,
  which is a real step toward atomicity
- but the overall init flow is still composed from several phases that repair
  or correct each other's side effects

That is why issues like `#2922`, `#2405`, `#3562`, and `#3222` keep rhyming.

Sources:
- `/tmp/gastown-latest/internal/rig/manager.go`
- `/tmp/gastown-latest/internal/doltserver/doltserver.go`

### 3. tmux is still too central

Even with better abstractions emerging, tmux remains deeply embedded in:
- worker lifecycle
- session existence
- liveness
- nudge delivery
- prompt detection
- attach/peek flows

This creates:
- timing sensitivity
- OS coupling
- bad failure semantics
- hard-to-debug transport races

The issue tracker again says the same thing:
- [#1216](https://github.com/gastownhall/gastown/issues/1216) reliable nudge delivery is fundamentally unresolved
- [#3538](https://github.com/gastownhall/gastown/issues/3538) Windows is effectively blocked by tmux dependency
- multiple open tmux issues around stale pane IDs, missing socket flags, split-brain sockets, invalid pane targets

Code signal:
- `internal/tmux/tmux.go` is almost 4k lines
- `factory-worker-api.md` reads like a design document for escaping the current transport model

Sources:
- `/tmp/gastown-latest/internal/tmux/tmux.go`
- `/tmp/gastown-latest/docs/design/factory-worker-api.md`

### 4. Shared mutable runtime files create race conditions

This is a more local problem, but it points to a real architectural smell: some resources are shared at rig level when they should be per-worker.

Example:
- [#3500](https://github.com/gastownhall/gastown/issues/3500) simultaneous polecat spawns corrupt shared `settings.json` and multiple sessions die during startup

That is a strong sign that some worker state boundaries are too coarse.

The current code path makes the issue very concrete:

- `RoleSettingsDir("polecat", rigPath)` returns `<rig>/polecats`
- `SessionManager.Start()` calls `runtime.EnsureSettingsForRole` against that
  shared path
- `hooks.InstallForRole` writes the resulting settings file with `os.WriteFile`

So even in the newer runtime model, polecat settings are still scoped to the
shared polecats parent rather than to an individual polecat sandbox.

That means:

- startup-time settings writes are cross-polecat shared state
- a broken or partially written file can fan out to multiple sessions
- concurrency bugs now have a naturally broad blast radius

This is a classic "shared parent config" smell in a concurrent worker system.

Sources:
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/runtime/runtime.go`
- `/tmp/gastown-latest/internal/hooks/installer.go`

### 4.5 Hooked startup still has an architectural blind spot

Issue `#3133` is a subtle but important one.

The startup fallback matrix currently gives:

- non-hook agents - nudges and verification
- promptless agents - beacon fallback
- hook+prompt agents - effectively no startup fallback, because the system
  assumes hooks fired correctly

That means the "best" path in theory is also the path with the least recovery
if hooks fail silently.

This is not just an incidental bug. It is a design assumption:

- hook execution is treated as reliable enough to skip post-start validation
- when that assumption breaks, the polecat can sit idle indefinitely

The lesson is important because it shows a recurring Gastown pattern:

- the canonical path is assumed healthy
- fallback logic is strong off the canonical path
- but if the canonical path silently fails, there can be a blind spot

Sources:
- `/tmp/gastown-latest/internal/runtime/runtime.go`
- `/tmp/gastown-latest/internal/polecat/session_manager.go`
- [#3133](https://github.com/gastownhall/gastown/issues/3133)

### 4.6 Hook state migration is still not fully settled

This became one of the most revealing deeper findings.

Gastown tried to make a healthy architectural move:

- stop treating the agent bead's `hook_bead` slot as primary truth
- make the hooked work bead itself authoritative via
  `status=hooked + assignee=<agent>`

That direction is good.

But the migration has been visibly unstable in the code and commit history:

- `fa9dc287` removed the agent-bead hook slot writes and declared direct bead
  tracking authoritative
- `630e879b` partially restored `hook_bead` slot writes because `gt hook` /
  `gt mol status` startup flow broke
- `67af59b3` then moved `molecule_status.go` back toward the authoritative
  `status=hooked + assignee` query because the restored slot had become stale
- `336339fb` added explicit `hook_bead` clearing on `gt done` because stale
  values were still poisoning witness zombie detection
- `a0f192c0` added daemon-side fallback queries by assignee because the idle
  reaper was still making bad decisions from stale `hook_bead`

That is not normal feature churn. That is an oscillating invariant migration.

The current code is more nuanced than "still broken everywhere", and that
nuance matters:

- the main `gt prime` work lookup in `prime.go` now prefers the authoritative
  work-bead query and only treats agent-bead `hook_bead` as backward-compatible
  fallback
- `molecule_status.go` now uses the authoritative query path
- but `signal_stop.go` still uses agent-bead `hook_bead` as the preferred fast
  path before falling back
- `daemon.go` still reasons from agent-bead `hook_bead` snapshots in crash and
  idle-reaper heuristics, then compensates with `hasAssignedOpenWork()`
- `witness/handlers.go` still uses `hook_bead` in zombie classification
- `prime_session.go` still describes the agent-bead field as the primary source,
  even though this path is mainly session-state detection rather than the core
  dispatch lookup

So the honest architectural reading is:

- the project has **moved directionally toward the right invariant**
- but the migration is not fully complete
- multiple subsystems still carry compatibility logic for the old invariant
- some critical lifecycle decisions still begin from the old snapshot and only
  later correct themselves with newer fallbacks

Representative issues and discussions:

- [#2371](https://github.com/gastownhall/gastown/issues/2371) stale
  `hook_bead` lookup and shorthand normalization
- [#2384](https://github.com/gastownhall/gastown/issues/2384) stale
  `hook_bead` after unsling / done
- [#2416](https://github.com/gastownhall/gastown/issues/2416) polecats exit
  early because hook visibility broke upstream
- [#2431](https://github.com/gastownhall/gastown/issues/2431) direct bead
  tracking not fully migrated into `gt hook`
- [#2641](https://github.com/gastownhall/gastown/issues/2641) missing
  `hook_bead` persistence path
- [#2675](https://github.com/gastownhall/gastown/issues/2675) empty
  `hook_bead` column confusion after the migration
- [#3114](https://github.com/gastownhall/gastown/issues/3114) concurrent hook
  persistence races on the same assignee
- [#3294](https://github.com/gastownhall/gastown/issues/3294) idle reaper kills
  active polecats because stale `hook_bead` still misleads it

This is one of the clearest examples in Gastown of a deeper pattern:

- the conceptual direction is often right
- but when the old and new truths coexist for too long, the system pays a large
  compatibility tax
- that tax then spreads into daemon, witness, stop hooks, and lifecycle glue

Sources:
- `/tmp/gastown-latest/internal/cmd/sling_helpers.go`
- `/tmp/gastown-latest/internal/cmd/prime.go`
- `/tmp/gastown-latest/internal/cmd/prime_session.go`
- `/tmp/gastown-latest/internal/cmd/signal_stop.go`
- `/tmp/gastown-latest/internal/cmd/molecule_status.go`
- `/tmp/gastown-latest/internal/daemon/daemon.go`
- `/tmp/gastown-latest/internal/witness/handlers.go`
- `/tmp/gastown-latest/internal/polecat/manager.go`

### 4.7 Agent beads themselves did not have a stable storage contract for a long time

This is a second major deep finding.

`Gastown` depends heavily on agent beads:

- idle detection
- persistent polecat reuse
- witness lifecycle decisions
- health checks
- cleanup gating
- hook visibility
- doctor validation

So if agent beads themselves are unstable as a domain primitive, the whole
runtime pays for it.

Looking at the commit history and current code, the agent-bead model has
shifted on three axes at once:

1. **Where they live**
   - earlier flows used ephemeral agent beads in the `wisps` table
   - persistent polecats moved them into the `issues` table for durable idle
     detection
   - current code still merges `issues` and `wisps` sources in
     `ListAgentBeads()`, and doctor checks still query both

2. **How they are identified**
   - older code relied on `type=agent`
   - newer code moved to `--type=task --labels=gt:agent`
   - compatibility checks still treat `type == "agent"` as a legacy fallback

3. **Where their state lives**
   - earlier flows wrote `agent_state` through a structured column / dedicated
     writer
   - bd `0.62+` removed the supported writer path
   - current code now treats the description field as the primary contract and
     uses `ResolveAgentState()` to prefer description over the legacy column

That means `agent bead` was not just evolving. It was evolving in storage,
identity, and state semantics simultaneously.

The commit trail makes this unusually clear:

- `c410c10a` introduced persistent polecats and explicitly moved agent beads to
  the issues table for durable idle detection
- `af97a4ff` then had to stop `gt doctor --fix` from migrating those same agent
  beads back into wisps, which means the repair subsystem was actively undoing
  the lifecycle design
- `30265a9c` changed agent-state writes again for beads `0.62+`, making the
  description text the primary write/read contract
- `b1db1628` changed agent-bead type handling again, because `type=agent`
  stopped being valid once Beads extracted custom types

That sequence is architecturally expensive for a core runtime primitive.

The current code still shows the compatibility burden:

- `ListAgentBeads()` merges issues and wisps data, with issues treated as the
  authoritative metadata source and wisps as fallback existence source
- `doctor/agent_beads_check.go` still contains comments that speak in terms of
  ephemeral agent beads while its fix path now intentionally creates durable
  ones
- `GetAgentBead()` resolves state via `ResolveAgentState(description, structured)`
  because old and new state contracts still coexist
- stale-agent and doctor checks still need both route awareness and ID-pattern
  heuristics to avoid missing collapsed-form agent IDs

Representative issues:

- [#2055](https://github.com/gastownhall/gastown/pull/2055) doctor was undoing
  the persistent polecat migration by sending agent beads back to wisps
- [#3354](https://github.com/gastownhall/gastown/issues/3354) ephemeral
  agent beads in wisps broke FK assumptions in child event creation
- [#3539](https://github.com/gastownhall/gastown/issues/3539) `type=agent`
  stopped being valid after Beads type extraction
- [#3598](https://github.com/gastownhall/gastown/issues/3598) daemon keeps
  warning "no agent beads found" because lifecycle checks still assume a stable
  discoverable agent-bead population
- [#3652](https://github.com/gastownhall/gastown/issues/3652) witness and
  refinery `Start()` paths still do not reliably ensure their own agent beads
  exist
- [#2767](https://github.com/gastownhall/gastown/issues/2767) doctor identity
  counting broke on cross-rig worktrees, showing how easily agent-bead
  discovery can drift from actual runtime identities

The deeper lesson is not "they changed their minds a lot".

The deeper lesson is:

- a critical runtime primitive should have a very stable contract
- in Gastown, `agent bead` has repeatedly changed table, type, and state-write
  semantics
- every such shift then forced updates into doctor, lifecycle, daemon, witness,
  and spawn logic

This is one more reason the codebase feels overburdened:

- not only are there many moving parts
- some of the core runtime objects themselves have had unstable architectural
  definitions over time

Sources:
- `/tmp/gastown-latest/internal/beads/beads_agent.go`
- `/tmp/gastown-latest/internal/beads/status.go`
- `/tmp/gastown-latest/internal/doctor/agent_beads_check.go`
- `/tmp/gastown-latest/internal/doctor/misclassified_wisp_check.go`
- `/tmp/gastown-latest/internal/doctor/stale_agent_beads_check.go`
- `/tmp/gastown-latest/internal/polecat/manager.go`

### 4.8 Worker lifecycle ownership is fragmented across roles and entry paths

Another deeper architectural problem is that `Gastown` does not have one clean,
uniform owner for worker startup invariants.

For a system this complex, a role start path should ideally guarantee, in one
place, the core runtime contract for that role:

- session exists or is recreated safely
- runtime settings are provisioned
- identity is established
- agent bead exists
- startup hooks / nudges are armed
- lifecycle monitoring assumptions now hold

In `Gastown`, that contract is not consistently owned.

The clearest example is agent-bead creation:

- `rig/manager.go:initAgentBeads()` creates witness/refinery agent beads during
  `AddRig()`
- but errors there are non-fatal warnings, so the rig can be considered
  successfully added even if those core lifecycle objects do not exist
- `witness/manager.go:Start()` and `refinery/manager.go:Start()` then start
  tmux sessions, provision settings, set env, wait for readiness, and launch
  pollers, but do **not** ensure their agent beads exist
- `polecat/manager.go`, by contrast, treats agent-bead creation as a hard
  startup precondition and fails the spawn if that contract cannot be satisfied

That asymmetry matters.

It means the answer to "who guarantees the agent bead exists?" depends on:

- which role you are starting
- whether the rig was added successfully earlier
- whether that earlier creation silently warned and continued
- whether the current path is `AddRig`, `gt start`, `gt up`, or daemon
  auto-start

That is not a stable runtime ownership model.

The daemon code makes the mismatch even more visible:

- `daemon.go` repeatedly says `Manager.Start()` handles startup behavior and
  GUPP-related readiness
- `daemon/lifecycle.go` then runs GUPP and orphaned-work checks that assume a
  discoverable population of agent beads
- issue `#3598` shows the daemon warning on every heartbeat when agent beads
  are missing
- issue `#3652` shows witness and refinery `Start()` never create their own
  agent beads at all

So the architectural problem is not just "one role forgot a line of code".

The deeper problem is:

- startup invariants are distributed across several layers
- different roles own different subsets of those invariants
- recovery and monitoring code then assumes those invariants exist globally

This is exactly the kind of system shape that generates:

- warning spam instead of a hard invariant violation
- role-specific lifecycle drift
- "works if rig was created in the lucky path" behavior
- repeated patches that fix one role path while leaving another path behind

Representative issues:

- [#3652](https://github.com/gastownhall/gastown/issues/3652) witness and
  refinery `Start()` never create agent beads
- [#3598](https://github.com/gastownhall/gastown/issues/3598) daemon logs
  "no agent beads found" every heartbeat

Sources:
- `/tmp/gastown-latest/internal/rig/manager.go`
- `/tmp/gastown-latest/internal/witness/manager.go`
- `/tmp/gastown-latest/internal/refinery/manager.go`
- `/tmp/gastown-latest/internal/polecat/manager.go`
- `/tmp/gastown-latest/internal/daemon/daemon.go`
- `/tmp/gastown-latest/internal/daemon/lifecycle.go`

### 4.9 Health and liveness truth is split across competing signals

This is another deep architectural fault line.

`Gastown` does not really have one authoritative answer to:

- is an agent alive?
- is it idle?
- is it stuck?
- is it orphaned?
- did it crash?
- did it finish and fail to clean itself up?

Instead, the system derives those answers from a changing mixture of:

- tmux session existence
- tmux pane command / descendant process checks
- session activity timestamps from tmux output
- heartbeat JSON files under `.runtime/heartbeats`
- agent bead `agent_state`
- agent bead `hook_bead`
- work-bead `status=hooked + assignee`
- last-updated timestamps in bead rows
- special labels like `idle:*`, `backoff-until:*`, `done-intent:*`

Each signal is understandable in isolation.

The architectural problem is that they are not layered under one stable
epistemic contract. They are composed ad hoc per recovery path.

Examples from the code:

1. **tmux health model**
   - `tmux.CheckSessionHealth()` says health is:
     - session exists
     - agent process alive
     - optionally recent tmux activity

2. **GUPP / orphaned-work model**
   - `daemon/lifecycle.go` says:
     - work-on-hook comes from agent bead `hook_bead`
     - progress age comes from bead `UpdatedAt`
     - running state comes from `tmux.IsAgentAlive()`

3. **idle reaper model**
   - `daemon.go` reads the polecat heartbeat JSON
   - then checks heartbeat `EffectiveState()`
   - then falls back to agent bead lookup
   - then checks whether `hook_bead` is closed
   - then checks assigned work via `bd list --assignee`
   - then checks `tmux.IsAgentRunning()`

4. **polecat stale-session model**
   - `polecat/manager.go` prefers stale heartbeat as proof of death
   - but falls back to PID probing when no heartbeat file exists

These are not just implementation details. They show that liveness truth is
distributed across multiple partially overlapping models.

The most revealing detail is heartbeat semantics.

`internal/polecat/heartbeat.go` describes a nice clean idea:

- the agent self-reports `working`, `idle`, `exiting`, or `stuck`
- the witness should mainly infer freshness

But the real system shape is messier:

- `persistentPreRun` touches heartbeat on every `gt` command
- default touches write `state=working`
- `gt done` can therefore leave a stale `"working"` heartbeat behind even when
  the polecat is effectively idle or exiting
- the idle reaper then needs extra guards to reinterpret stale `"working"`
  through bead state and session state

That is a classic sign that one signal is being used for more jobs than its
contract really supports.

The issue tracker reflects this mixed-truth cost:

- [#3055](https://github.com/gastownhall/gastown/issues/3055) witness patrol
  misses a "ghost idle" polecat after `gt done` succeeds but nuke fails
- [#3342](https://github.com/gastownhall/gastown/issues/3342) idle reaper kills
  an actively working polecat when hook state was cleared during failed sling
  rollback
- [#3598](https://github.com/gastownhall/gastown/issues/3598) daemon warns on
  every heartbeat because lifecycle checks assume a stable agent-bead universe
- [#3294](https://github.com/gastownhall/gastown/issues/3294) stale hook state
  can still mislead lifecycle decisions

The comments on `#3055` are especially useful:

- contributors explicitly propose writing a terminal `agent_state=done`
  because the current mix of session-running + clean worktree + open bead +
  stale/no hook is too ambiguous for patrol logic

That is a strong architectural signal:

- when a system keeps adding one more terminal marker to disambiguate runtime
  state, it usually means its health model is already too fragmented

So the deeper lesson is:

- `Gastown` does not have one coherent liveness model
- it has several good partial models
- recovery logic then stitches them together with guards, fallbacks, and
  special cases

That is why the code is full of comments like:

- "derive running state from tmux, not bead"
- "fallback"
- "stale hook guard"
- "TOCTOU guard"
- "working-no-hook"
- "spawning guard"

This is not sloppiness.

It is the signature of a system whose monitoring and recovery semantics are
strong in intent but too distributed in implementation.

Sources:
- `/tmp/gastown-latest/internal/tmux/tmux.go`
- `/tmp/gastown-latest/internal/daemon/lifecycle.go`
- `/tmp/gastown-latest/internal/daemon/daemon.go`
- `/tmp/gastown-latest/internal/polecat/heartbeat.go`
- `/tmp/gastown-latest/internal/polecat/manager.go`
- `/tmp/gastown-latest/internal/cmd/root.go`

### 4.10 Identity, registry, and tmux socket selection are coupled more tightly than they should be

One more deep fault line is the coupling between:

- town-root detection
- prefix registry loading
- agent registry loading
- tmux socket selection
- session identity parsing
- cross-socket navigation and cleanup

In a simpler architecture, these concerns would be related but not so tightly
entangled.

In `Gastown`, `InitRegistry(townRoot)` does all of this very early:

- chooses the tmux socket name
- sets the package-global default tmux socket
- loads the prefix registry from `rigs.json`
- loads the agent registry from `settings/agents.json`

That means a miss or drift in "what town am I in?" is not just a metadata bug.
It can change:

- which session names can be parsed correctly
- which rig prefix is assumed
- which tmux server later commands talk to
- whether cross-socket navigation and cleanup target the right universe at all

The code already shows multiple compensations for this seam:

- `BuildPrefixRegistryFromTown()` checks `mayor/rigs.json` first but also keeps
  a fallback copy at the town root because git operations inside `mayor/` can
  make the canonical file unavailable
- `tmux.NewTmux()` falls back to `GT_TOWN_SOCKET` when the registry path was
  not initialized in-process
- `killSplitBrainSession()` exists specifically to kill same-named sessions on
  the wrong socket
- `gt down` has dedicated cleanup for both the legacy `"default"` socket and
  the older basename-only socket format
- tmux bindings embed `GT_TOWN_SOCKET` into commands so that a popup invoked
  from a different socket can still find the town's sessions

This is a lot of machinery around what should ideally be a simpler contract:

- "this process belongs to town X"
- "town X owns socket Y"
- "session identity parsing is deterministic inside town X"

The issue tracker confirms this is not theoretical:

- [#761](https://github.com/gastownhall/gastown/issues/761) showed that
  non-namespaced tmux sessions let one town kill another town's services
- [#3042](https://github.com/gastownhall/gastown/issues/3042) reported a
  regression that effectively re-opened the multi-town collision problem by
  reverting per-town socket isolation
- [#3570](https://github.com/gastownhall/gastown/issues/3570) shows that
  changing socket naming across versions can create dual-agent split-brain on
  upgrade when legacy sockets are not cleaned automatically

What makes this especially important architecturally is that these are not just
UX or migration bugs.

They reveal that:

- process identity
- town identity
- session identity
- and tmux server identity

are still too dependent on ambient initialization order and fallback heuristics.

The code is thoughtful here. The team clearly understands the problem and has
added good mitigations.

But the existence of:

- fallback `rigs.json` copies
- global default-socket mutation
- legacy-socket cleanup routines
- cross-socket env shims
- split-brain session killers

is itself evidence that the identity/control-plane contract is more brittle
than it should be.

The deeper lesson is:

- when registry loading decides the tmux socket
- and tmux socket decides the control plane
- and control-plane commands can run from outside the town root
- your architecture will accumulate a lot of ambient-context repair code

Sources:
- `/tmp/gastown-latest/internal/session/registry.go`
- `/tmp/gastown-latest/internal/session/identity.go`
- `/tmp/gastown-latest/internal/tmux/tmux.go`
- `/tmp/gastown-latest/internal/cmd/down.go`
- `/tmp/gastown-latest/internal/util/orphan.go`

### 4.11 The CLI and subprocess boundary behaves like an internal RPC layer

Another deeper architectural pattern in `Gastown` is that a lot of the system
does not just **use** CLIs. It often uses them as an internal control-plane API.

That distinction matters.

There is a big difference between:

- shelling out to `git` or `gh` for clearly external integration

and:

- asking the daemon, deacon, convoy manager, web layer, and lifecycle checks to
  repeatedly shell out to `gt`, `bd`, `tmux`, and `dolt` in order to discover
  state or trigger core orchestration transitions

Looking at the current tree outside tests, there are about:

- `1088` `exec.Command(...)` / `BuildCommand(...)` call sites under `internal/`
- roughly `62` in `daemon`
- `104` in `doctor`
- `52` in `tmux`
- `29` in `polecat`
- `17` in `web`
- `15` in `refinery`
- `11` in `deacon`

Not all of those are architectural debt by themselves.

But the deeper issue is that many of the important ones sit directly on the
critical path of orchestration.

Representative examples from the current code:

- `daemon/lifecycle.go` fetches the deacon inbox via `gt mail inbox --json`,
  claims work by `gt mail delete`, queries agent beads and wisps through `bd`,
  and notifies witnesses through `gt mail send`
- `deacon/feed_stranded.go` and `daemon/convoy_manager.go` run
  `gt convoy stranded`, `gt convoy check`, `gt sling`, and `bd show` as the
  mechanics of convoy recovery and dispatch
- `web/api.go` shells out to `gt`, `bd`, `tmux`, and `gh` for large parts of
  the dashboard's live data and action surface
- `mail/bd.go` still has to wrap raw `bd` subprocesses with custom timeout,
  `--flat` compatibility injection, stale-PID cleanup, and retry logic

This is especially revealing because the codebase already contains proof that
the team knows this boundary is expensive:

- `internal/mail/store.go` adds an in-process `beadsdk.Storage` path
- the package comment explicitly says this bypasses the `bd` subprocess and
  saves about `600ms` per mail operation

That is a strong signal:

- the maintainers are not blindly attached to shell-outs
- they have already felt enough pain to introduce direct in-process store paths
- but that escape hatch still exists only in selected subsystems, while a large
  part of the orchestrator continues to rely on CLI calls as a de facto RPC
  surface

Why this is architecturally expensive:

- correctness depends on CLI output shape, exit-code conventions, and
  first-line stderr parsing
- many flows are only eventually consistent because a subprocess query and a
  later subprocess action are separate non-atomic steps
- polling loops multiply process spawn overhead, Dolt connection overhead, and
  JSON parse churn
- the control plane becomes highly sensitive to cwd, env, PATH, socket flags,
  and per-process setup
- every reliability problem at the CLI boundary becomes a runtime stability
  problem for the orchestrator itself

The issue tracker lines up with this interpretation very clearly:

- [#1760](https://github.com/gastownhall/gastown/issues/1760) showed
  `gt dashboard` spawning `55+` concurrent `bd` processes in a tight background
  polling loop, producing a CPU death spiral
- [#3117](https://github.com/gastownhall/gastown/issues/3117) showed a convoy
  dashboard failure loop hammering Dolt with concurrent `dolt remote -v` calls
  and sustained `50%+` CPU
- [#3597](https://github.com/gastownhall/gastown/issues/3597) shows blocked
  convoys causing about `25` `bd` subprocess calls every `30s` with no chance
  of progress until upstream dependencies resolve
- [#2067](https://github.com/gastownhall/gastown/issues/2067) adds the cost
  dimension: `131` idle sessions in `1` hour and about `7.18B` cache-read
  tokens in `3` days, with maintainers explicitly agreeing that event-driven
  wake is the healthier long-term shape

The important nuance is this:

- the shell-out pattern is not always a mistake
- but in `Gastown`, it is deep enough and common enough that it becomes part of
  the architecture itself

So the deeper lesson is:

- when your orchestrator mostly talks to itself through CLIs, subprocesses, and
  JSON output
- and then layers polling, routing, and recovery on top of that
- you accumulate not only latency cost, but also a large non-atomicity tax

Sources:
- `/tmp/gastown-latest/internal/mail/bd.go`
- `/tmp/gastown-latest/internal/mail/store.go`
- `/tmp/gastown-latest/internal/daemon/lifecycle.go`
- `/tmp/gastown-latest/internal/deacon/feed_stranded.go`
- `/tmp/gastown-latest/internal/daemon/convoy_manager.go`
- `/tmp/gastown-latest/internal/web/api.go`

### 4.12 Patrol and workflow integrity still depend too much on prompt/template semantics

One more deep architectural seam is that some of `Gastown`'s most important
operational workflows still live partly in:

- formula step descriptions
- role startup prompts
- inline patrol guidance rendered by `gt prime`
- template-level wording and command sequencing

rather than being fully enforced as engine-level invariants.

This is not a complaint that prompts exist.

The problem is that some flows which are operationally critical still depend on
the model actually following the textual contract.

The clearest public example is the Deacon patrol integrity issue:

- [#2386](https://github.com/gastownhall/gastown/issues/2386) documents
  "fake cycles" where Deacon reported huge patrol throughput without executing
  the patrol formula steps
- even after a first fix, the issue comments show the model bypassing
  `gt patrol report --steps` entirely by spinning background tasks and looping
  lightweight commands like heartbeat updates
- maintainers themselves concluded this was a **system-level enforcement**
  problem, not merely a prompt wording problem

The code strongly supports that reading.

There are multiple places where critical workflow behavior is encoded or tested
as text:

- `cmd/deacon.go` starts the Deacon with an initial prompt that explicitly says
  "First run `gt deacon heartbeat`. Then check gt hook, and if it is empty run
  `gt sling mol-deacon-patrol deacon`, then execute the hook it creates."
- `cmd/prime_molecule.go` injects patrol loop behavior as inline instructions
  like "If context LOW, run `gt patrol report ...`; if context HIGH, send
  handoff and exit cleanly"
- `formula/patrol_backoff_test.go` verifies patrol integrity partly by checking
  whether formula step descriptions literally contain strings like
  `gt patrol report`, `gt deacon heartbeat`, and `await-signal`
- `cmd/patrol_report.go` can record a detailed step audit, but if the caller
  omits `--steps`, the audit degrades to `Steps: NOT REPORTED`
- `cmd/boot.go` is explicit that complex triage decisions belong in the Boot
  agent's `mol-boot-triage` formula rather than in Go code

Those are thoughtful design choices in one sense:

- they keep the engine more flexible
- they let the role formulas evolve quickly
- they preserve the "agent decides, Go transports" philosophy

But the cost is real:

- patrol correctness can be bypassed if the model finds another textual path
  that updates enough side effects to look alive
- validation often checks whether the right command text is present in the
  formula, not whether the workflow transition is structurally impossible to
  fake
- startup and patrol behavior depend on the model respecting prompt order and
  role guidance under pressure
- when this breaks, the fix often arrives as another layer of prompt wording,
  step-audit reporting, or post-hoc anomaly detection

The open comments on `#2386` are especially revealing here:

- contributors observed that `gt patrol report --steps` enforcement was still
  bypassable because the Deacon could avoid calling `gt patrol report` at all
- the proposed and partially implemented mitigations shifted toward stronger
  runtime constraints, such as heartbeat-credit gating and anomaly detection
  for impossible patrol throughput

That is a strong architectural signal:

- the team is learning that patrol integrity cannot live only in prompts and
  formula text
- some operational guarantees need to be owned by the engine itself

The deeper lesson is:

- formulas and templates are excellent as guidance surfaces
- but when they carry too much control-plane responsibility, the orchestrator
  starts to depend on prompt compliance for correctness
- once that happens, your hardest bugs become "the system did something
  structurally plausible but semantically fake"

This is one of the most subtle costs in `Gastown`:

- the architecture is rich enough to express complex workflows
- but some of its patrol integrity still depends on textual protocol rather than
  hard transition ownership

Sources:
- `/tmp/gastown-latest/internal/cmd/deacon.go`
- `/tmp/gastown-latest/internal/cmd/prime_molecule.go`
- `/tmp/gastown-latest/internal/cmd/patrol_report.go`
- `/tmp/gastown-latest/internal/formula/patrol_backoff_test.go`
- `/tmp/gastown-latest/internal/cmd/boot.go`

### 4.13 The workflow engine has a real semantic mode-explosion problem

Another deep architectural cost in `Gastown` is that the workflow layer is not
just "a formula system".

It is several partially overlapping execution models:

- workflow formulas
- convoy formulas
- expansion formulas
- aspect formulas
- root-only wisps (`pour = false`)
- poured wisps (`pour = true`)
- formula-on-bead attachments via `attached_formula`
- molecule attachments via `attached_molecule`
- direct dispatch via `gt sling`
- formula execution via `gt formula run`

Each individual mode is understandable.

The problem is the combinatorial effect:

- how a workflow is invoked
- how its steps are represented
- how an agent discovers the next step
- how progress is resumed
- and how rollback/cleanup is done

can all differ depending on which mode was used.

The docs are unusually explicit about this, which is useful but also revealing:

- `docs/concepts/molecules.md` explains that root-only wisps do **not**
  materialize steps at all, so agents read steps inline at prime time
- the same doc says poured wisps **do** materialize sub-wisps and support
  checkpoint recovery
- `docs/reference.md` explicitly warns:
  - use `gt sling <formula> --on <bead> <target>` for workflow formulas
  - **do not** use `gt sling` for convoy formulas
  - use `gt formula run` instead

That means the workflow model is not one execution contract.
It is several contracts sharing similar names.

The current code shows this branching clearly:

- `formula/types.go` defines multiple formula types plus an orthogonal `pour`
  flag
- `prime_output.go` chooses between two completely different "what should I do
  next?" paths:
  - if `attached_formula` exists, render inline steps with
    `showFormulaStepsFull()`
  - otherwise fall back to `showMoleculeExecutionPrompt()` and `bd mol current`
- `molecule_status.go` separately tracks both `AttachedFormula` and
  `AttachedMolecule`
- `sling_helpers.go` implements the special formula-on-bead path and explicitly
  notes that the lifecycle fix is to hook the **base bead** while the wisp lives
  as `attached_molecule`

This would still be manageable if the mode boundaries were airtight.

But the issue tracker shows that they are not:

- [#3322](https://github.com/gastownhall/gastown/issues/3322) shows that
  `gt prime` can render inline steps only from embedded formulas, making custom
  formulas effectively invisible at execution time even though sling/cook
  succeeded
- [#3350](https://github.com/gastownhall/gastown/issues/3350) shows failed
  `gt sling` rollback detaching a formula molecule from the parent bead but
  leaving the wisp itself open as an orphan
- [#1753](https://github.com/gastownhall/gastown/issues/1753) questions whether
  a sophisticated `code-review.formula.toml` is actually wired into any
  automated path at all, which highlights a second kind of mode drift:
  formulas can exist as rich capabilities without being first-class in the
  actual orchestration pipeline

There is also a subtler cost:

- root-only mode is a smart optimization because it avoids huge wisp growth
- but once steps are no longer materialized, more execution truth moves into
  embedded formula lookup, prompt rendering, and agent behavior
- poured mode gives stronger checkpoint semantics, but at the cost of more
  rows, more cleanup, and more lifecycle bookkeeping

So the design has a real tradeoff, but it also has a real architectural tax:

- too many workflow variants mean too many ways for "the same task" to behave
  differently at runtime
- attachment metadata, discovery UX, and recovery logic must branch on mode
- bugs appear not just as crashes, but as semantic mismatch between "formula was
  attached", "steps are visible", "progress is queryable", and "rollback
  cleaned everything up"

The deeper lesson is:

- `Gastown` has a powerful workflow language
- but the workflow engine is not one uniform model
- it is a family of related models whose boundaries still leak into user-facing
  semantics, cleanup logic, and execution correctness

This is one of the clearest places where `Gastown` shows both brilliance and
cost at the same time:

- brilliance in expressiveness
- cost in mode branching, lifecycle tax, and semantic drift between
  representation and execution

Sources:
- `/tmp/gastown-latest/docs/concepts/molecules.md`
- `/tmp/gastown-latest/docs/reference.md`
- `/tmp/gastown-latest/internal/formula/types.go`
- `/tmp/gastown-latest/internal/cmd/prime_output.go`
- `/tmp/gastown-latest/internal/cmd/prime_molecule.go`
- `/tmp/gastown-latest/internal/cmd/molecule_status.go`
- `/tmp/gastown-latest/internal/cmd/sling_helpers.go`
- `/tmp/gastown-latest/internal/cmd/polecat.go`

### 4.14 Too much runtime metadata is tunneled through descriptions and string parsing

Another very deep fault line is that `Gastown` uses the issue `description`
field as a structured metadata bus for a surprising amount of runtime state.

This is not just "some notes happen to live in descriptions".

In the current code, descriptions carry and/or influence:

- `attached_molecule`
- `attached_formula`
- `attached_vars`
- `convoy_id`
- `merge_strategy`
- `convoy_owned`
- `review_only`
- `no_merge`
- `dispatched_by`
- `agent_state`
- watcher lists for convoy notifications
- integration-branch metadata in some flows

And in at least one place, the system even interprets **freeform prose** in the
description as lifecycle semantics:

- `isDeferredBead()` rejects dispatch if the description contains phrases like
  `deferred to post-launch`, `deferred to post launch`, or `status: deferred`

That is a very expensive contract style for an orchestrator.

The current code is explicit about this:

- `beads/status.go` says the description's `agent_state:` field is now the
  **primary write/read contract**
- `beads/beads_agent.go` says `Gastown` writes agent state through description
  fields and readers mirror that with fallback to the legacy structured column
- `beads/fields.go` parses and rewrites attachment metadata from `key: value`
  lines in description text
- `cmd/convoy_watch.go` stores convoy watcher lists in convoy description fields
- `cmd/sling_helpers.go` and related flows depend on attachment metadata inside
  bead descriptions to resolve existing molecules and dispatch semantics

This has several architectural consequences:

- structured state now shares a storage medium with human-readable prose
- many updates become read-modify-write cycles over a text blob
- preserving user prose while updating machine metadata becomes part of the
  correctness problem
- missing one stamped field can silently change later orchestration behavior
- race conditions on metadata writes become much easier to create

The issue tracker confirms this is not hypothetical:

- [#3320](https://github.com/gastownhall/gastown/issues/3320) shows that
  failing to stamp `merge_strategy` and `convoy_id` onto the work bead causes
  `gt done` to fall back to the wrong merge semantics
- [#3114](https://github.com/gastownhall/gastown/issues/3114) shows concurrent
  batch sling losing hook persistence due to TOCTOU behavior on shared rows
- [#2641](https://github.com/gastownhall/gastown/issues/2641) shows that not
  writing `wisps.hook_bead` leaves polecats seeing "Nothing on hook"
- [#2384](https://github.com/gastownhall/gastown/issues/2384) is the inverse:
  stale `hook_bead` can remain after unsling

The code itself already contains compensators that reveal the cost:

- `UpdateAgentDescriptionFields()` takes an explicit lock around a
  Show-Parse-Modify-Update cycle because concurrent callers can otherwise
  overwrite each other's changes
- `SetAttachmentFields()` must preserve non-attachment prose while stripping and
  replacing known metadata keys
- multiple compatibility layers exist because the same semantic field may live
  in structured columns, description metadata, labels, or routing-derived state

There is an even deeper lesson here:

- string-encoded metadata is not always bad for operator UX
- but once core runtime semantics depend on it, you have created a
  stringly-typed state layer
- and once freeform text phrases can influence dispatch decisions, you are
  halfway to an interpreter whose control plane is partially hidden in prose

This is one of the most architecture-relevant warnings from `Gastown`:

- the project has a rich metadata vocabulary
- but too much of it leaks through text parsing rather than stable typed
  storage contracts

That gives flexibility, but it also makes correctness brittle, race-prone, and
harder to evolve.

Sources:
- `/tmp/gastown-latest/internal/beads/fields.go`
- `/tmp/gastown-latest/internal/beads/status.go`
- `/tmp/gastown-latest/internal/beads/beads_agent.go`
- `/tmp/gastown-latest/internal/cmd/sling_helpers.go`
- `/tmp/gastown-latest/internal/cmd/convoy_watch.go`
- `/tmp/gastown-latest/internal/cmd/prime_output.go`

### 4.15 Operational shadow state is scattered across local JSON files

There is another deep persistence seam in `Gastown` that becomes obvious only
after reading a lot of runtime code:

- the system does not just have Beads/Dolt truth
- it also has a growing layer of **local shadow state files** used to steer
  orchestration decisions

Representative examples from the current code:

- `deacon/heartbeat.json`
- `deacon/health-check-state.json`
- `deacon/feed-stranded-state.json`
- `deacon/redispatch-state.json`
- `deacon/pause.json`
- `deacon/dogs/boot/.boot-status.json`
- rig-local `.runtime/namepool-state.json`
- `witness/bead-respawn-counts.json`
- `daemon/dolt-state.json`

These are not just logs or caches.
They influence real runtime behavior:

- `deacon/feed_stranded.go` uses `feed-stranded-state.json` as the durable
  cooldown and feed-count memory for convoy recovery
- `deacon/stuck.go` uses `health-check-state.json` as the failure counter and
  force-kill cooldown memory for agent health decisions
- `deacon/heartbeat.go` publishes a heartbeat file that the daemon reads to
  decide whether to poke or restart Deacon
- `boot/boot.go` persists `.boot-status.json` as the last triage outcome
- `witness/spawn_count.go` persists bead respawn counts as the circuit breaker
  for respawn storms
- `polecat/namepool.go` persists name-pool allocation state under `.runtime`
- `cmd/dashboard.go` reads `daemon/dolt-state.json` to infer how to connect to
  the running Dolt server

This is not automatically wrong.

In a local-first orchestrator, some file-backed operational state is perfectly
reasonable.

The architectural cost comes from the number of places where this file state:

- overlaps with data that also exists elsewhere
- participates in recovery decisions
- requires its own locking discipline
- can become stale independently of Beads, tmux, or the daemon's in-memory view

The code already shows that this is not a trivial concern:

- witness respawn counts use both an in-process mutex and a sibling `.flock`
  file for cross-process serialization
- Boot uses a flock marker plus `.boot-status.json`
- Deacon health, feed-stranded, and redispatch all maintain their own
  load-modify-save JSON state cycles
- dashboard connectivity depends on `dolt-state.json`, meaning operator-facing
  behavior can depend on a file-backed projection of runtime state rather than
  directly querying the live server

What this means architecturally:

- the system has more than one durable operational memory plane
- recovery semantics are distributed across DB rows, tmux, state files,
  descriptions, and process reality
- each new JSON state file may solve a local problem while increasing global
  drift potential
- lifecycle bugs become harder to reason about because you must ask:
  - what does Beads say?
  - what does tmux say?
  - what does the heartbeat/state file say?
  - which one wins if they disagree?

This pattern helps explain why some issue threads feel like "stale behavior" or
"non-convergent recovery" rather than a cleanly isolated bug:

- [#3416](https://github.com/gastownhall/gastown/issues/3416) upgrade UX on
  existing installs is described as docs drift, channel drift, stale-binary
  shadowing, and non-convergent `doctor --fix`
- [#3587](https://github.com/gastownhall/gastown/issues/3587) parked-work
  recovery already showed that convoy progression depends on separated patrol
  state and wake actions rather than one atomic source of truth

Those issues are not "caused by JSON files" in isolation.
But the scattered shadow-state pattern makes this class of drift much more
likely and much harder to collapse into a single authoritative recovery model.

The deeper lesson is:

- local state files are fine as caches or append-only diagnostics
- they become expensive when they are also part of the control plane
- once cooldowns, health counters, wake decisions, and respawn circuit breakers
  live in separate file memories, your orchestrator starts accumulating
  multiple mini-stores with their own failure semantics

That is another way `Gastown` becomes overburdened:

- not because any one JSON file is bad
- but because the aggregate architecture spreads operational truth across too
  many file-backed side channels

Sources:
- `/tmp/gastown-latest/internal/deacon/heartbeat.go`
- `/tmp/gastown-latest/internal/deacon/stuck.go`
- `/tmp/gastown-latest/internal/deacon/feed_stranded.go`
- `/tmp/gastown-latest/internal/deacon/redispatch.go`
- `/tmp/gastown-latest/internal/deacon/pause.go`
- `/tmp/gastown-latest/internal/boot/boot.go`
- `/tmp/gastown-latest/internal/witness/spawn_count.go`
- `/tmp/gastown-latest/internal/polecat/namepool.go`
- `/tmp/gastown-latest/internal/cmd/dashboard.go`

### 4.16 Critical lifecycle operations are compensating sagas, not atomic transitions

One more deep architectural pattern becomes obvious when you follow the hottest
runtime paths end to end:

- `Gastown` often does not perform one authoritative state transition
- it performs a **multi-step saga** across several state planes
- and then layers rollback / cleanup / guard logic around the gaps

The best example is `executeSling()`:

- the code literally documents a long staged flow
- it can burn stale molecules, spawn a polecat, optionally create a convoy,
  cook a formula, instantiate a wisp, acquire an assignee lock, hook a bead,
  update agent state, stamp metadata fields, and only then start the session

That is not inherently bad.

For a rich local orchestrator, some workflows really are multi-stage.

The problem is how many different domains participate in the transition:

- bead status / assignee
- agent bead state
- description metadata
- molecule / wisp attachment
- convoy tracking
- git worktree and branch creation
- tmux session lifecycle
- heartbeat cleanup and later daemon reconciliation

The code already shows how expensive this is:

- `executeSling()` and `runSling()` still duplicate the same broad lifecycle,
  and `sling.go` now has an explicit `TODO(scheduler-unify)` noting that the
  single-sling path still duplicates the 12-step flow
- `rollbackSlingArtifacts()` exists because partial success can leave attached
  molecules, hooked beads, spawned polecats, or convoy artifacts behind
- `cleanupSpawnedPolecat()` and `ResetAgentBeadForReuse(..., "spawn rollback")`
  appear in several failure paths because polecat creation itself is another
  staged resource-allocation saga
- `ReuseIdlePolecat()` had to evolve toward "kill session unconditionally"
  semantics because trying to treat reuse as a light branch-only operation was
  still not enough when session, heartbeat, and hook state disagreed
- daemon idle-reap logic now explicitly protects against a case where a failed
  sling rollback clears the hook while the agent is still running

This is a very important distinction:

- a normal bug is "step 4 forgot to update field X"
- a saga-tax bug is "there are 9 interdependent steps, each on a different
  substrate, so every failure window creates a new residual artifact shape"

The issue tracker shows this pattern repeatedly:

- [#3030](https://github.com/gastownhall/gastown/issues/3030) showed idle-polecat
  reuse conflicting with an already-live tmux session and surfacing as
  `ErrSessionRunning`
- [#3350](https://github.com/gastownhall/gastown/issues/3350) showed failed
  `gt sling` rollback detaching part of the formula state but leaving an orphan
  wisp open
- [#3114](https://github.com/gastownhall/gastown/issues/3114) showed concurrent
  hook assignment races on the same polecat, which then needed assignee-scoped
  locking on top of retry verification
- [#2534](https://github.com/gastownhall/gastown/issues/2534) showed polecats
  dying silently and leaving the system with weak continuity between session
  death, working state, and recovery actions
- [#3342](https://github.com/gastownhall/gastown/issues/3342) was strong enough
  that daemon reaping now contains a special guard against failed sling
  rollback clearing the hook while the agent is still actively running

This does **not** mean the code is sloppy.

In fact, the opposite is true:

- the maintainers clearly understand the failure windows
- they add rollback seams, cleanup passes, verification, and tests
- they keep hardening the same transitions over time

But that hardening work is itself the architectural signal.

When the main lifecycle operations of the system require:

- staged resource tracking
- rollback closures
- best-effort cleanup
- later daemon reconciliation
- and extra guards for rollback side effects

then the orchestrator is paying a large **saga tax**.

That tax shows up as:

- more orphan and zombie states
- more stale recovery cases
- more duplication between "happy path" and "cleanup path"
- more subtle behavior drift between startup, reuse, dispatch, and patrol

This is now one of the clearest architecture lessons from `Gastown`:

- ambitious workflows are not the problem
- the problem is when too many critical transitions span too many substrates
  without a tighter authoritative commit boundary

Sources:
- `/tmp/gastown-latest/internal/cmd/sling_dispatch.go`
- `/tmp/gastown-latest/internal/cmd/sling.go`
- `/tmp/gastown-latest/internal/cmd/sling_formula.go`
- `/tmp/gastown-latest/internal/polecat/manager.go`
- `/tmp/gastown-latest/internal/polecat/session_manager.go`
- `/tmp/gastown-latest/internal/daemon/daemon.go`

### 4.17 Worker bootstrap and instruction delivery are a distributed contract

Another deep seam in `Gastown` is not about storage or tmux directly.
It is about **how a worker actually learns who it is, what context it has,
and what it should do next**.

The project does not rely on one authoritative worker envelope.
Instead, that contract is spread across several overlapping channels:

- startup beacon text injected into the CLI prompt
- SessionStart hooks that run `gt prime`
- delayed nudges used as fallback for some runtimes
- `PRIME.md` provisioned into worktrees as a fallback if hooks fail
- town-root `CLAUDE.md` as an identity anchor
- `CLAUDE.local.md` overlays in polecat worktrees so workers learn `gt done`
- wrapper binaries like `gt-codex` / `gt-opencode` that run `gt prime` first
- `gt doctor` / priming checks to verify the whole chain remains aligned

This is a lot of machinery just to answer one foundational question:

- when an agent starts, where does its truth come from?

The code itself describes the complexity:

- `runtime.GetStartupFallbackInfo()` has an explicit capability matrix for
  hook/no-hook and prompt/no-prompt runtimes, each with different beacon,
  context, and nudge behavior
- `session/startup.go` can tell the agent to run `gt prime`, or
  `gt prime --hook`, or check hook and mail, depending on startup topic and
  runtime capabilities
- `reference.md` says only the town-root `CLAUDE.md` should exist on disk and
  full role context should come ephemerally from `gt prime`
- but `templates.CreatePolecatCLAUDEmd()` simultaneously says the polecat
  lifecycle file is the **primary mechanism** for polecats to learn about
  `gt done`, because that file survives compaction and session restarts
- `ProvisionPrimeMDForWorktree()` exists specifically because hooks can fail,
  so worktrees need a durable `PRIME.md` fallback
- `wrappers.Install()` creates `gt-codex`, `gt-gemini`, and `gt-opencode`
  wrappers that run `gt prime` first, which is yet another bootstrap channel
- `doctor.PrimingCheck` exists because this subsystem is important enough, and
  fragile enough, to justify its own health model

That is a very revealing shape.

It means `Gastown` does not have a single startup contract.
It has a **delivery mesh**.

That delivery mesh is thoughtful, but expensive:

- if hooks fail, another path must compensate
- if prompts are unavailable, nudges must take over
- if nudges are unsafe, files must still carry enough context
- if files are written into worktrees, `gt done` must strip them back out of
  commits to avoid polluting customer repos
- if doctor and hooks-sync disagree on templates, the system can fail to
  converge even when every individual subsystem thinks it is "correct"

The issue tracker shows this is not theoretical:

- [#3133](https://github.com/gastownhall/gastown/issues/3133) shows hook-based
  polecats with **zero startup fallback** when hooks fail, leaving them idle at
  the welcome prompt indefinitely
- [#3031](https://github.com/gastownhall/gastown/issues/3031) shows startup
  nudge verification interrupting Claude mid-processing because delivery ACK is
  entangled with response timing
- [#3648](https://github.com/gastownhall/gastown/issues/3648) shows
  `gt hooks sync` and `gt doctor` disagreeing on what a correct polecat Stop
  hook even is, so the system never converges to green
- [#2416](https://github.com/gastownhall/gastown/issues/2416) discussion shows
  polecats seeing "Nothing on hook" and then taking premature completion paths,
  because the worker-facing view of truth lagged behind the new hook
  authority model
- [#3322](https://github.com/gastownhall/gastown/issues/3322) shows custom
  formulas being invisible in `gt prime`, which means even when work exists,
  the worker's rendered view of what to do can be incomplete

This leads to one of the deepest architectural lessons in the repo:

- `Gastown` does not just have state sprawl
- it also has **instruction-plane sprawl**

The worker contract is distributed across:

- files
- hooks
- prompts
- nudges
- wrappers
- doctor checks

That gives flexibility and broad provider support.
But it also means correctness depends on several bootstrap mechanisms staying
mutually consistent.

Once that happens, failures stop looking like ordinary bugs and start looking
like:

- silent idle sessions
- "nothing on hook" even though work is assigned
- agents that know identity but not workflow
- agents that know workflow but not current work
- settings that regenerate forever but never satisfy the checker

This is one more place where `Gastown` pays an architecture tax:

- not because the maintainers failed to think about fallback
- but because the worker bootstrap contract is distributed instead of
  authoritative

Sources:
- `/tmp/gastown-latest/internal/runtime/runtime.go`
- `/tmp/gastown-latest/internal/session/startup.go`
- `/tmp/gastown-latest/internal/session/lifecycle.go`
- `/tmp/gastown-latest/internal/templates/templates.go`
- `/tmp/gastown-latest/internal/beads/beads.go`
- `/tmp/gastown-latest/internal/wrappers/wrappers.go`
- `/tmp/gastown-latest/internal/doctor/priming_check.go`
- `/tmp/gastown-latest/internal/cmd/done.go`
- `/tmp/gastown-latest/internal/git/git.go`
- `/tmp/gastown-latest/docs/reference.md`
- `/tmp/gastown-latest/docs/design/architecture.md`

### 4.18 Completion is encoded as an overloaded imperative macro, not a narrow transition

There is another deep lesson in `Gastown` that shows up once you read `gt done`
closely enough:

- completion is not modeled as a small authoritative transition like
  `working -> completed`
- it is implemented as a **large imperative macro** that bundles policy,
  routing, recovery, and cleanup into one command path

`gt done` is doing far more than "signal completion":

- validate working-tree cleanliness
- infer or query the hooked issue
- write done-intent labels and resume checkpoints
- push the branch, with fallback through the bare repo
- strip overlay files and sometimes create a cleanup commit
- decide merge strategy: local, direct, MR, no-merge, review-only
- close the source issue in some paths, but not others
- create and verify the MR bead
- update agent metadata and active MR references
- close attached molecules and descendants
- clear legacy hook state to avoid zombie false positives
- transition the agent to idle or stuck
- rely on witness and refinery safety nets if any piece only partially succeeds

This is not just "a long command".
It is a sign that several concerns have collapsed into one lifecycle macro:

- completion signal
- source-issue closure semantics
- merge-queue submission policy
- review / no-merge policy
- convoy merge-strategy policy
- audit metadata
- session termination / idle transition
- recovery checkpointing
- repo hygiene cleanup

The codebase knows this is expensive:

- `done.go` has explicit checkpoint / resume machinery because `gt done` can be
  interrupted mid-flight and then resumed later
- the function contains multiple `goto notifyWitness` exits because different
  policy branches skip different subsets of the flow
- there are separate closure paths for zero-commit, direct-merge, no-merge,
  review-only, MR, and attached-molecule cases
- witness handlers still contain safety-net logic for completions even after
  the self-managed completion redesign
- issue [#3653](https://github.com/gastownhall/gastown/issues/3653) shows that
  the old mail-based `POLECAT_DONE` completion path is now dead code, while the
  real production path is patrol-based discovery from agent-bead metadata

That last point matters a lot:

- they changed the completion model
- but completion still has several parallel conceptual paths in the codebase
- and comments are not always aligned with the real production flow

The issue tracker shows how this overloaded completion contract leaks bugs:

- [#2416](https://github.com/gastownhall/gastown/issues/2416) shows polecats
  taking a premature exit path and closing or completing work without really
  implementing it, because the worker-facing hook truth was wrong and `gt done`
  then executed against an incomplete reality model
- [#3363](https://github.com/gastownhall/gastown/issues/3363) shows `no_merge`
  mode exiting via `goto notifyWitness` without closing the work bead, leaving
  convoy tracking stale and downstream dispatch blocked
- [#3603](https://github.com/gastownhall/gastown/issues/3603) argues that
  polecats can still end sessions without all the expected commit/push/PR
  invariants being satisfied from a user point of view
- [#3653](https://github.com/gastownhall/gastown/issues/3653) shows the codebase
  still carries two completion mental models, one dead and one live

This also amplifies earlier fault lines:

- because completion depends on routing, it feels the cross-DB pain
- because completion depends on hook truth, it feels the hook migration wobble
- because completion depends on startup/bootstrap instructions, it feels worker
  instruction-plane drift
- because completion depends on cleanup and idle transition, it feeds zombie and
  dirty-idle recovery complexity back into witness patrol

The deep architectural lesson is:

- a rich agent workflow still benefits from a **small completion primitive**
- once completion itself becomes the place where policy, transport, storage,
  merge strategy, and cleanup all meet, it starts behaving like a second
  orchestration engine hidden inside one command

That is exactly what `gt done` now looks like:

- a powerful command
- a necessary command
- but also a pressure concentrator for unrelated semantics

This is one more reason Gastown's orchestration core feels expensive:

- not because completion support is missing
- but because completion is carrying too much of the system's policy surface

Sources:
- `/tmp/gastown-latest/internal/cmd/done.go`
- `/tmp/gastown-latest/internal/witness/handlers.go`
- `/tmp/gastown-latest/docs/design/polecat-self-managed-completion.md`
- `/tmp/gastown-latest/docs/concepts/polecat-lifecycle.md`
- `/tmp/gastown-latest/docs/design/polecat-lifecycle-patrol.md`

### 4.19 The engine is still fundamentally observer-first: many transitions are discovered, not owned

One more deep architectural pattern becomes very clear after reading the patrol
and completion code together:

- `Gastown` is often not driven by one component *owning* a transition end to end
- it is driven by other components **discovering** that the transition probably
  happened, and then reconciling afterward

This is bigger than "there is some polling".
It is a genuine orchestration style:

- witness discovers completions by scanning agent-bead metadata
- refinery discovers merge work by listing open MR beads
- zombie detection discovers failures by reconciling tmux, heartbeat, and bead state
- convoy progression discovers readiness by re-checking tracked issue state
- idle slot availability is often discovered by patrol rather than asserted by
  one authoritative completion owner

The code is explicit about this:

- `DiscoverCompletions()` in `witness/handlers.go` says completion handling is a
  **safety net** and that witness observes completion state from beads each cycle
  rather than relying on mail
- `processDiscoveredCompletion()` reconstructs completion handling after the
  fact by looking at metadata already written elsewhere
- `Engineer` in `refinery/engineer.go` is described as a merge queue processor
  that **polls** for ready merge-requests
- `polecat-self-managed-completion.md` openly says the refinery's reliable path
  is polling `ListReadyMRs()` and that the witness relay was redundant because
  the real discovery mechanism was already a patrol scan
- the same design doc explicitly embraces "Discover Don't Track", meaning
  anomalies and queue state are recovered by scanning rather than by trusting a
  single explicit event pipeline

This has some real strengths:

- idempotence is easier
- dropped nudges or lost mail are survivable
- components can restart and still reconstruct state
- patrols can act as broad safety nets over messy local runtime conditions

But the cost is also very real:

- latency becomes patrol-cycle-bounded
- correctness depends on scanners interpreting partial state correctly
- duplicate mechanisms remain alive longer because the observer path can mask
  flaws in the owner path
- dead code accumulates because old event routes and new scan routes can coexist
- "what actually happened?" becomes a question answered by reconciliation,
  not by one authoritative causal record

The issue tracker shows this pattern directly:

- [#3653](https://github.com/gastownhall/gastown/issues/3653) shows the old
  mail-based `POLECAT_DONE` handlers are dead code in production while the real
  completion path is patrol-based discovery from agent-bead metadata
- [#2067](https://github.com/gastownhall/gastown/issues/2067) argues for
  event-driven wake because current patrol / polling behavior is too expensive
- [#3055](https://github.com/gastownhall/gastown/issues/3055) shows witness
  patrol missing idle state after `gt done` nuke failure
- [#3075](https://github.com/gastownhall/gastown/issues/3075) shows await-signal
  missing crash notifications, which again pushes recovery back toward later
  scanning / reconciliation
- [#3597](https://github.com/gastownhall/gastown/issues/3597) shows blocked
  convoy polling with no backoff becoming an operational tax
- [#2386](https://github.com/gastownhall/gastown/issues/2386) shows patrol can
  even produce semantically fake progress cycles when enforcement is too loose

The most important insight here is not "polling is bad".
It is more specific:

- observer-first orchestration works best when the scanned state is small,
  typed, and authoritative
- in `Gastown`, the scanned state is already spread across beads, descriptions,
  tmux, heartbeats, files, and runtime conventions
- so the patrol layers inherit every ambiguity of the substrate beneath them

That is why this style becomes expensive in `Gastown`:

- it is not just scanning
- it is scanning **already fragmented truth**

This is one of the deepest lessons in the repo:

- "discover, don't track" is a powerful safety-net principle
- but if too much of the actual engine becomes discovery-first, then the system
  starts relying on observers to finish work that owners should have completed

That is exactly where `Gastown` has drifted in several critical paths.

Sources:
- `/tmp/gastown-latest/internal/witness/handlers.go`
- `/tmp/gastown-latest/internal/refinery/engineer.go`
- `/tmp/gastown-latest/docs/design/polecat-self-managed-completion.md`
- `/tmp/gastown-latest/docs/design/factory-worker-api.md`
- `/tmp/gastown-latest/docs/design/agent-api-inventory.md`

### 4.20 The agent abstraction exists, but it is not sovereign: the system stays Claude-shaped at critical seams

One more deep pattern becomes hard to ignore after reading the config layer,
role managers, doctor checks, and agent-design docs together:

- `Gastown` **does** have a real agent registry and preset model
- but that registry is still not the one unquestioned source of truth for the
  runtime boundary
- critical paths still reopen hidden defaults that assume **Claude-like,
  interactive, long-lived sessions**

This matters because it changes how to interpret their "multi-agent, multi-model"
story:

- the abstraction is real
- the intent is good
- but the architecture is still **Claude-first at its most important seams**

There is a lot to like first.

The positive side is not fake:

- `internal/config/agents.go` is a genuinely thoughtful preset registry
- it centralizes command, args, hooks provider, prompt mode, readiness mode,
  instructions file, permission quirks, and even ACP support
- `ResolveRoleAgentConfig` is a serious attempt to make role-specific runtime
  selection a first-class part of orchestration
- `ResolveWorkerAgentConfig` adds another tier for per-worker overrides

That is good architecture direction.

But the deeper problem is that the abstraction is still not sovereign.

You can see this in several independent places:

1. **The role layer still carries hardcoded Claude startup commands**

The built-in role TOMLs still embed:

- `start_command = "exec claude --dangerously-skip-permissions"`

for `witness`, `deacon`, `mayor`, `polecat`, `refinery`, `crew`, and `dog`.

That alone would not be fatal if the role managers always treated TOML as a
legacy customization layer under a stronger agent abstraction.

But they do not always do that cleanly.

2. **Role managers and daemon logic had to grow explicit escape hatches to avoid using those Claude-shaped TOML commands**

Current code is already better than earlier versions, and that nuance matters.

For example:

- `buildWitnessStartCommand()` now resolves the role agent, checks whether the
  resolved agent is Claude, checks whether the TOML command is just the built-in
  Claude default, and checks whether `role_agents` explicitly mapped the role
- only after those escape hatches does it decide whether to use the TOML
  `start_command` or fall through to `BuildStartupCommandFromConfig`
- `daemon/lifecycle.go` carries the same kind of special-case logic

That is not "bad code". It is a repair scar.

It means the central abstraction was not strong enough to prevent role-local,
Claude-specific startup paths from reappearing.

The issue trail shows this clearly:

- [#3218](https://github.com/gastownhall/gastown/issues/3218) showed witness
  ignoring `role_agents` model config because its start path used the literal
  built-in Claude TOML command instead of the configured agent runtime

The important point is not just the bug.
The important point is what kind of bug it was:

- a **central agent-selection abstraction** existed
- but a **role-specific startup path** still bypassed it

That is a strong sign the abstraction is helpful, but not authoritative.

3. **Diagnostics had to stop using runtime resolution because runtime resolution falls back to Claude**

The current `HooksSyncCheck` contains one of the most revealing comments in the
whole repo:

- it explicitly avoids `ResolveRoleAgentConfig`
- and instead uses `ResolveRoleAgentName`
- because runtime resolution falls back to Claude when the configured binary is
  not in PATH, which would silently skip non-Claude targets in CI

That is an architectural tell.

It means:

- "what runtime would actually launch here?"
- and "what agent is this system supposed to be configured for?"

are not always the same question.

The issue trail confirms it:

- [#3247](https://github.com/gastownhall/gastown/issues/3247) - `hooks-sync`
  should use the configured agent name for non-Claude agents, not the resolved
  binary-fallback behavior
- [#3248](https://github.com/gastownhall/gastown/issues/3248) - doctor
  `hooks-sync` skipped non-Claude template agents in CI because resolution
  silently fell back to Claude

That is deeper than a CI bug.
It means diagnostics and runtime selection were reading from **different truths**.

4. **The config loader itself bakes in a hidden Claude-first gravitational center**

`ResolveRoleAgentConfig` is explicit about its last fallback:

- role-specific config
- then default agent
- then `"claude"`

`IsResolvedAgentClaude(nil)` also returns true by default.

Again, that does not make the code silly.
It makes the architecture revealing:

- unknown or degraded runtime resolution tends to collapse toward Claude
- so "agent-agnostic" behavior is not the fail-safe center
- **Claude is**

That creates a persistent pressure where:

- generic code paths are forced to ask "is this actually Claude?"
- and non-Claude support becomes a set of exceptions that must be preserved

5. **The project's own design docs openly admit the parity gap**

This is one of the strongest pieces of evidence because it is the team telling
the truth about its own system.

`agent-api-inventory.md` says:

- **17 of 28 touch points depend on Claude Code internals**
- non-Claude agents lose hooks, transcript access, cost tracking,
  resume/fork, and permission-dialog handling

`factory-worker-api.md` goes even further:

- it says 28+ touch points depend on Claude Code, tmux, Keychain, and
  filesystem conventions
- and proposes a worker API precisely because the current agent boundary is too
  vendor-shaped

That means this finding is not speculative.
It is already acknowledged internally by the maintainers.

6. **Even "multi-provider" support often works by proxying through a Claude-shaped lifecycle**

The `groq-compound` preset is especially revealing here.

It is clever, but architecturally telling:

- it uses the Claude CLI as an SDK proxy
- swaps Anthropic SDK environment variables to point at Groq
- and then keeps all the normal Claude hooks, tmux readiness detection, and
  session tracking

That is a smart practical move.
It is also proof that the strongest path in the current system is still:

- "use Claude-shaped runtime semantics, even when the model provider changes"

7. **Headless and sandboxed agents are still second-class because the worker contract assumes a persistent interactive session**

Issue [#1382](https://github.com/gastownhall/gastown/issues/1382) is important
here because it shows the limit of the current abstraction.

The system still fundamentally expects:

- an interactive tmux-backed worker
- long-lived session lifecycle
- `gt hook` / `gt prime` ceremony
- startup, idle, and completion expressed through that persistent session model

That makes headless or one-shot review agents awkward or impossible in the
native engine path.

So even where they support more agents, the *shape* of the worker contract is
still heavily biased toward the Claude-style interactive loop.

8. **Non-Claude agent bugs are often not random bugs - they are leakage from a Claude-shaped contract**

Issue [#3033](https://github.com/gastownhall/gastown/issues/3033) is a good
example:

- Gemini setup surfaced identity-collision failures in `gt prime --hook`
- contributors immediately reasoned in terms of how Gemini differs from the
  Claude SessionStart/context-loading path
- the discussion treated the problem not as "one broken flag", but as
  compatibility drift in how startup/context injection semantics translate to a
  non-Claude runtime

That is exactly what architectural leakage looks like.

The deepest lesson here is not "their multi-agent story is fake".
It is more specific:

- the **preset abstraction is one of their better ideas**
- but the system still contains enough Claude-shaped defaults, role-local
  bypasses, and interactive-session assumptions that the abstraction is not yet
  sovereign

That has a predictable consequence:

- provider breadth exists
- but parity is uneven
- and every time they add or harden a non-Claude runtime, they must search for
  hidden places where role TOMLs, hooks sync, lifecycle managers, or fallback
  resolution quietly assume Claude again

So the honest architectural verdict is:

- `Gastown` is **serious** about becoming agent-agnostic
- but it is still **mid-migration**
- and one of its deepest remaining costs is that the runtime boundary is broad
  in the registry, yet still Claude-shaped in several of the engine's
  operational seams

Sources:
- `/tmp/gastown-latest/internal/config/agents.go`
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/witness/manager.go`
- `/tmp/gastown-latest/internal/daemon/lifecycle.go`
- `/tmp/gastown-latest/internal/doctor/hooks_sync_check.go`
- `/tmp/gastown-latest/docs/design/agent-api-inventory.md`
- `/tmp/gastown-latest/docs/design/factory-worker-api.md`
- [#3218](https://github.com/gastownhall/gastown/issues/3218)
- [#3247](https://github.com/gastownhall/gastown/issues/3247)
- [#3248](https://github.com/gastownhall/gastown/issues/3248)
- [#1382](https://github.com/gastownhall/gastown/issues/1382)
- [#3033](https://github.com/gastownhall/gastown/issues/3033)

### 4.21 The agent-registry layer is process-global mutable state, not a pure scoped lookup

Going one layer deeper into config resolution reveals another architectural seam
that is easy to miss unless you read both `agents.go` and `loader.go`
together:

- part of Gastown's agent resolution is not a pure function of `(townRoot, rigPath, role)`
- it is mediated by a **process-global merged registry**
- and config resolution is explicitly serialized to stop different rig lookups
  from corrupting each other

This is one of the clearest "deep engine smell" comments in the repo.

`loader.go` says it directly:

- `resolveConfigMu serializes agent config resolution across all callers`
- because `ResolveRoleAgentConfig` and `ResolveAgentConfig` load rig-specific
  agents into a **global registry**
- and concurrent calls for different rigs would otherwise **corrupt each
  other's lookups**

That is not a generic concurrency precaution.
It is an architectural admission.

The underlying mechanism in `agents.go` is:

- `globalRegistry *AgentRegistry`
- `loadedPaths map[string]bool`
- `registryInitialized bool`
- `LoadAgentRegistry()` and `LoadRigAgentRegistry()` both merge data into that
  one global map
- registry files are cached by path, so once a path is loaded, later calls do
  not reload it

This creates several deep consequences.

1. **Resolution is ambient and history-dependent**

When a rig-level `settings/agents.json` is loaded, its agent definitions are
merged into the same global map used by:

- `GetAgentPresetByName`
- `ResolveProcessNames`
- `ResolveACPConfig`
- preset existence checks

So part of the runtime boundary is not just "what does this rig say?".
It is also:

- what registry files has this process already loaded?
- in what order?

That is expensive statefulness for something as fundamental as runtime
selection.

2. **Rig-local registry overrides are not truly rig-local inside the process**

Because registry entries are keyed only by agent name in a single merged map:

- `globalRegistry.Agents[name] = preset`

two different rig registries that define the same agent name are not isolated
by namespace inside the process.

Whoever loads later wins in the shared merged map.

That does not automatically mean every call will behave wrongly, because:

- inline `townSettings.Agents` and `rigSettings.Agents` are checked directly in
  several lookup paths

But it does mean the preset/registry layer itself is not cleanly scoped per
town or per rig.

So the agent system has two different design styles living together:

- direct per-rig/per-town inline config
- ambient global preset registry

That is another form of dual truth.

3. **Config changes are not naturally reloadable in-process**

The `loadedPaths[path]` cache means:

- once a registry file path has been loaded, it is not re-read again in the
  same process

unless test-only reset logic clears the registry state.

This is a subtle but important architectural signal:

- config lookup is optimized like global singleton state
- not modeled like a fresh scoped resolution step

That makes hot-reload and "what config am I actually using right now?" harder
than they should be.

4. **Tests need dedicated reset hooks because the config layer is not naturally isolated**

`agents.go` contains:

- `ResetRegistryForTesting()`
- `RegisterAgentForTesting()`

That is normal in moderation.

But in this repo it lines up with another strong signal:

- [#3248](https://github.com/gastownhall/gastown/issues/3248) explicitly calls
  out data races from `t.Parallel()` in tests that modify package-level globals

That is important because it confirms the smell is not theoretical.
The config layer really does have package-global state significant enough to
show up in tests and diagnostics.

5. **The config layer now pays a serialization tax because it cannot trust its own resolution boundaries**

The system already pays a broad runtime serialization tax elsewhere.
Here it pays a smaller but telling one:

- all agent config resolution goes through `resolveConfigMu`

That avoids concurrent corruption.
But it also means the architecture never got to the cleaner state where:

- agent resolution is just pure lookup against a scoped configuration object
- and two roles resolving in parallel cannot interfere

This is a subtle but deep architectural weakness because config lookup is one of
the last places you want ambient mutable state.

6. **This also amplifies the earlier Claude-first and diagnostics drift problems**

Because the registry layer is ambient:

- role managers already have to defend against Claude-shaped role TOML defaults
- diagnostics already had to bypass runtime resolution to avoid silent Claude
  fallback
- and now the registry layer itself is another place where scoped truth is not
  fully preserved

So these findings are not separate.
They stack:

- Claude-shaped defaults
- non-sovereign agent abstraction
- global mutable registry

Together they explain why non-Claude parity keeps feeling expensive even though
the project has a good preset system on paper.

The key architectural lesson is:

- a runtime registry is most powerful when it is **scoped, explicit, reloadable,
  and side-effect-free**
- in `Gastown`, part of that layer is instead **merged, cached, ambient, and
  process-history-dependent**

That does not ruin the whole system.
But it is exactly the kind of deep design debt that keeps leaking into role
managers, CI behavior, and non-Claude parity work.

Sources:
- `/tmp/gastown-latest/internal/config/agents.go`
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/doctor/hooks_sync_check.go`
- [#3248](https://github.com/gastownhall/gastown/issues/3248)

### 4.22 RuntimeConfig inheritance is shallower than the contract suggests

Another deep config-layer problem appears when you compare the public comments,
the merge helpers, and the tests:

- the configuration model *sounds* like custom agents can "override or extend"
  built-in presets
- but nested runtime blocks often behave closer to **replace-on-presence** than
  true patch-merge inheritance

This matters because it means a partial custom runtime config can silently drop
behavior that the preset would otherwise provide:

- hooks provider metadata
- readiness detection
- process-name matching
- instruction-file defaults
- session identity env vars
- ACP metadata

The most revealing signals are in the code and tests themselves.

1. **The type comments promise extension semantics**

`TownSettings.Agents` is documented as:

- "custom agent configurations or overrides"
- values "override or extend the built-in presets"

That reads like field-wise inheritance.

2. **But `fillRuntimeDefaults()` only auto-fills nested blocks when the entire block is nil**

The implementation is explicit:

- if `result.Hooks == nil`, fill hook defaults from the preset
- if `result.Tmux == nil`, fill tmux defaults from the preset
- if `result.Session == nil`, fill session defaults from the preset
- if `result.Instructions == nil`, fill instruction defaults from the preset

But if a nested block is present at all, then:

- it is deep-copied as-is
- zero values inside it are preserved
- preset nested defaults are **not** filled into the missing fields

That means the effective rule is not:

- "merge this nested block with the preset"

It is closer to:

- "presence of the nested block means the caller owns the whole block"

3. **The tests intentionally codify this behavior**

`loader_test.go` has a direct test:

- `"partial nested struct is copied without defaults"`

The example is especially revealing:

- custom `RuntimeConfig` for `opencode`
- `Tmux` only sets `ProcessNames`
- `ReadyPromptPrefix` and `ReadyDelayMs` are left empty
- the test explicitly expects them to remain zero instead of inheriting preset
  readiness defaults

So this is not an accident.
It is a real merge semantic.

4. **The generic merge helper is also shallower than the surrounding comments imply**

`MergeWithPreset()` only merges:

- `Command`
- `Args`

and ignores the richer nested runtime capabilities entirely.

That is another sign the model is not deeply inheritance-oriented even though
the higher-level docs sound like it is.

5. **This creates a subtle schema-contract drift**

The contract a reader would reasonably infer is:

- define a custom agent
- override the parts you care about
- inherit the rest from the base preset

But the actual safe rule is stricter:

- if you touch a nested runtime block, you may need to define that block
  comprehensively, not partially

That is a meaningful architectural difference.

Why this matters operationally:

- custom agents can accidentally lose hook behavior
- readiness detection can degrade from prompt-aware to zero/default timing
- provider-specific instruction-file expectations can drift
- diagnostics become harder because the effective config is not a simple
  extension of the visible preset

And this combines badly with earlier findings:

- Claude-shaped defaults still exist
- the agent abstraction is not yet sovereign
- the registry layer is partly global and ambient

So config customization can become one more place where the user thinks they are
making a surgical override, but the engine interprets it as a broader semantic
replacement than expected.

This also helps explain why provider-specific settings and template bugs can be
so slippery:

- [#3000](https://github.com/gastownhall/gastown/issues/3000) shows permission
  behavior depending on more than just the visible startup flag surface
- [#3139](https://github.com/gastownhall/gastown/issues/3139) shows Gemini
  instruction-file behavior drifting from what the provider actually expects
- [#3648](https://github.com/gastownhall/gastown/issues/3648) shows hooks and
  doctor disagreeing on the right effective settings contract

Those issues are not direct proof of this merge rule by themselves.
But they are exactly the kind of downstream ambiguity that gets more expensive
when config inheritance is shallower than the API comments suggest.

The architectural lesson is:

- if presets are meant to be the base contract, nested runtime config should
  usually behave like a **deep patch**, not "whole-block replacement on presence"
- otherwise custom-agent extensibility remains powerful, but also surprisingly
  fragile

Sources:
- `/tmp/gastown-latest/internal/config/types.go`
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/config/loader_test.go`
- `/tmp/gastown-latest/internal/config/agents.go`
- [#3000](https://github.com/gastownhall/gastown/issues/3000)
- [#3139](https://github.com/gastownhall/gastown/issues/3139)
- [#3648](https://github.com/gastownhall/gastown/issues/3648)

### 4.23 Generated settings do not have one authoritative convergence contract

Another deep seam shows up when you compare:

- startup-time installation
- explicit hooks sync
- doctor validation
- and the actual generated settings files

The problem is not just "a template bug".
The deeper problem is that Gastown does not always appear to have **one
authoritative definition** of what a managed runtime settings file should be.

Instead, it has several partially-overlapping mechanisms:

- `InstallForRole()` for startup-time provisioning
- `SyncForRole()` for explicit template sync
- `ComputeExpected()` / `ComputeExpectedTemplate()` for validation-time expected state
- `claude-settings` doctor checks with their own semantic expectations
- heuristic upgrade logic like `needsUpgrade()`

Each of these pieces is locally understandable.
The architectural problem is that they do not always converge on the same
answer.

There are two especially strong signals.

1. **`needsUpgrade()` is heuristic, not versioned**

In `hooks/installer.go`, startup-time provisioning decides whether to overwrite
an existing file using:

- `needsUpgrade(existing)`

And the current heuristic is very simple:

- if the file contains `export PATH=`, then overwrite it

That is a dangerously weak ownership/version contract for generated files.

Why:

- it is pattern-based, not version-based
- it reasons from file content heuristics, not an explicit manifest or schema marker
- if the current template still contains the same pattern, the generator can
  classify its own output as stale

That is not theoretical.
The issue trail shows users hitting exactly this class of problem.

In [#3000](https://github.com/gastownhall/gastown/issues/3000), a contributor
laid out the failure mode very clearly:

- `needsUpgrade()` was keying on `export PATH=`
- current templates also still contained `export PATH=`
- so `EnsureSettingsForRole()` could keep overwriting files on every session start

Even if that specific report mixes user analysis with evolving code, the deeper
lesson stands:

- generated settings are being treated as managed artifacts
- but the ownership contract is still heuristic enough to self-trigger

That is fragile architecture.

2. **`doctor` and `hooks sync` can disagree on the same target and never converge**

Issue [#3648](https://github.com/gastownhall/gastown/issues/3648) is especially
revealing because it is not about user misunderstanding.
It is a direct convergence failure between two first-party subsystems.

The reported behavior is:

- `gt hooks sync` says polecat settings are in sync
- `gt doctor` says the same files are stale and "missing Stop hook"
- `gt doctor --fix` deletes them
- regeneration recreates byte-identical files
- `gt doctor` fails again immediately

That is not just a bad check.
It means:

- one subsystem's "expected generated state"
- is not the same as another subsystem's "expected generated state"

In other words, there is no single authoritative convergence contract.

And the concrete mismatch is highly instructive:

- the regenerated polecat file contained a Stop hook
- but the doctor check did not recognize that hook shape as satisfying its own
  expectation

So the disagreement was not "file exists vs missing file".
It was deeper:

- **semantic disagreement about what counts as the correct managed hook**

3. **Claude settings are not just hooks, and that increases the ownership problem**

`hooks/config.go` preserves unknown fields in `settings.json`.
That is good in isolation.

But it also means the system is juggling two competing goals:

- preserve user/unknown settings
- keep managed sections converged

At the same time:

- `claude_settings_check.go` inspects the file semantically
- startup provisioning may rewrite it heuristically
- sync paths may compare it structurally

This is exactly the sort of environment where "managed subset of a broader user
config file" becomes expensive unless there is a very crisp ownership model.

4. **The generated-file contract is spread across multiple packages, not one manifest-driven owner**

The relevant truth is currently spread across:

- `internal/hooks/installer.go`
- `internal/hooks/config.go`
- `internal/doctor/hooks_sync_check.go`
- `internal/doctor/claude_settings_check.go`

That is already enough to create drift.

And the repo's own tests show that backward-compatibility behavior is a major
concern:

- `ComputeExpectedBackfillsSessionStart`
- preserving on-disk Stop hooks
- default-overrides layering
- template equality normalization

All of that is thoughtful.
But it is also evidence that the project is already paying a significant
**convergence tax** around generated settings.

5. **This is another place where Gastown behaves like a repair-driven system**

If one subsystem can say:

- "no changes pending"

while another says:

- "stale, delete and recreate"

and the recreate step lands back on the same bytes that still fail validation,
then the system has crossed from "messy templates" into:

- validator/generator split-brain

That is a much deeper architectural category.

The key lesson is:

- generated runtime settings need a **single authoritative owner**
- with a crisp version/convergence contract
- and validator/fixer paths that share the same definition of correctness

Gastown is not fully there yet.

Instead, its settings layer still looks like a negotiated truce between:

- startup-safe non-clobber behavior
- explicit sync behavior
- backward-compatible merge behavior
- and doctor-time semantic validation

That is powerful, but it is also exactly how systems end up with persistent
"never converges to green" classes of bug.

Sources:
- `/tmp/gastown-latest/internal/hooks/installer.go`
- `/tmp/gastown-latest/internal/hooks/config.go`
- `/tmp/gastown-latest/internal/doctor/hooks_sync_check.go`
- `/tmp/gastown-latest/internal/doctor/claude_settings_check.go`
- [#3000](https://github.com/gastownhall/gastown/issues/3000)
- [#3648](https://github.com/gastownhall/gastown/issues/3648)

### 4.24 Settings ownership is scoped to the role parent, while execution is scoped to the worker/session

One more deep structural problem becomes clear when you line up:

- `RoleSettingsDir()`
- `StartSession()`
- polecat session startup
- `DiscoverTargets()`
- and the tests/comments around shared `.claude/settings.json`

The system's chosen unit of ownership for provider settings is often:

- **the role parent directory**

not:

- the individual worker
- the individual worktree
- or the individual session

For example:

- crew workers share `rig/crew/.claude/settings.json`
- polecats share `rig/polecats/.claude/settings.json`
- witness and refinery also use parent-level role settings

The code is explicit about this:

- `RoleSettingsDir("polecat", rigPath)` returns `rig/polecats`
- `StartSession()` resolves `settingsDir` from `RoleSettingsDir()` and passes it
  to `EnsureSettingsForRole()`
- `hooks/config.go` comments say "one shared settings file in the crew parent
  directory" and "one shared settings file in the polecats parent directory"
- polecat tests explicitly assert that settings live in the shared parent
  directory, not inside the worktree

At first glance this looks like an implementation detail.
It is not.
It is a scope decision.

And for this kind of system, it is a very consequential one.

Why it becomes expensive:

1. **execution identity is worker-scoped, but provider settings are role-scoped**

Polecats and crew workers have:

- different names
- different worktrees
- different hooked work
- potentially different agent overrides
- different lifecycle timing

But they can still share one provider settings file at the role parent.

That means the file boundary is coarser than the execution boundary.

2. **the shared file is not just a static template**

This would be less dangerous if the file were pure immutable boilerplate.
But it is not.

The settings surface is live enough that Gastown:

- preserves unknown fields
- writes managed hooks into it
- validates semantic contents like SessionStart and Stop hooks
- disables/enables plugin entries
- treats onboarding/permission-related values as operationally relevant

So this is not a harmless shared constant file.
It is a shared mutable control artifact.

That changes the whole meaning of the design.

3. **this turns provider-local state into shared role-level state**

Once a provider treats the settings file as meaningful runtime input, then a
role-shared settings file becomes an implicit shared control plane for all
workers of that role.

That means one worker's or one repair path's settings churn can affect:

- all polecats in the rig
- all crew workers in the rig

even if only one session was actually the source of the problem.

4. **the issue tracker already shows the operational cost**

The clearest direct example is:

- [#3500](https://github.com/gastownhall/gastown/issues/3500) simultaneous
  polecat spawns corrupt shared settings and multiple sessions die during startup

That is not just a race.
It is a symptom that the ownership unit is too coarse.

The other issues line up with the same seam:

- [#3000](https://github.com/gastownhall/gastown/issues/3000) shows onboarding
  / permission behavior mediated by the effective per-role settings surface
- [#3648](https://github.com/gastownhall/gastown/issues/3648) shows the shared
  polecats settings target becoming a validator/generator disagreement point

5. **the architecture is effectively using role-scoped config to stand in for worker-scoped runtime contract**

That shortcut is understandable:

- it reduces file count
- it fits Claude's `--settings` model
- it keeps generated config out of customer worktrees

But the deeper cost is that:

- worker lifecycle is per worker
- work isolation is per worktree
- failure modes are per session
- yet the config surface sits one level higher

So the system creates a scope inversion:

- fine-grained execution
- coarse-grained settings ownership

6. **this also compounds the earlier generated-settings convergence problem**

Because the same shared settings file is now:

- the generated artifact
- the validated artifact
- the preserved-unknown-fields artifact
- the startup input for multiple workers

the blast radius of settings drift is naturally larger.

That is why this seam feels deeper than a single race:

- it is not just "multiple writers hit one file"
- it is that the **file itself represents the wrong ownership boundary**

The lesson is not that shared settings are always wrong.
The lesson is narrower:

- if the settings file participates in live runtime behavior, provider state,
  or semantic validation
- then its scope should usually align with the unit of execution that can fail,
  restart, and diverge independently

In `Gastown`, that alignment is often missing.

So the honest architectural verdict is:

- the shared role-settings model is practical
- but for a multi-worker orchestrator it is too coarse
- and it turns settings into another place where local worker issues can
  fan out into role-wide state problems

Sources:
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/session/lifecycle.go`
- `/tmp/gastown-latest/internal/polecat/session_manager.go`
- `/tmp/gastown-latest/internal/hooks/config.go`
- `/tmp/gastown-latest/internal/runtime/runtime.go`
- `/tmp/gastown-latest/internal/polecat/manager_test.go`
- [#3500](https://github.com/gastownhall/gastown/issues/3500)
- [#3000](https://github.com/gastownhall/gastown/issues/3000)
- [#3648](https://github.com/gastownhall/gastown/issues/3648)

### 4.25 Startup and respawn semantics are assembled as shell-string choreography across multiple env planes

One more deep seam shows up when you line up:

- `BuildStartupCommand()`
- `BuildStartupCommandWithAgentOverride()`
- `PrependEnv()`
- `AgentEnv()`
- polecat startup and handoff code
- and the design docs around `factory-worker-api`

The important thing is not simply that Gastown uses shell commands.

The deeper issue is that **worker launch itself is not represented as one
structured launch spec**.

Instead, launch semantics are assembled across:

- a shell command string
- inline environment injection
- tmux session-table environment
- role/agent config resolution
- and role-specific compensating fallback code

That makes startup itself into another hidden orchestration substrate.

#### Why this is deeper than "string building is ugly"

1. **the canonical startup artifact is a shell string, not argv + env + policy**

The core startup helpers literally synthesize a string command:

- `BuildStartupCommand()` returns `exec env VAR=... wrapper ... agent ...`
- `BuildStartupCommandWithAgentOverride()` does the same for override paths
- `RuntimeConfig.BuildCommand()` is documented as a shell-interpreted command
  for tmux `SendKeys` / `respawn-pane`

So the launch contract is not modeled as:

- executable path
- args vector
- env map
- wrapper chain
- readiness contract
- restart policy

It is modeled as a final shell string plus side-channel session env.

That matters because correctness then depends on:

- quoting
- string ordering
- wrapper placement
- shell behavior
- idempotent flag insertion
- and OS-specific escape paths

2. **environment delivery is explicitly split across multiple propagation planes**

Their own design inventory says the current system uses three env propagation
mechanisms:

- `tmux.SetEnvironment()`
- `config.PrependEnv()`
- `config.EnvForExecCommand()`

And `factory-worker-api.md` explicitly lists this whole stack as something the
new worker API is meant to replace.

That is already a strong admission from the project itself:

- the current launch contract is too spread out

3. **the code openly compensates for different readers looking at different env planes**

This is the sharpest evidence.

`BuildStartupCommand()` exports `GT_AGENT` and `GT_PROCESS_NAMES` in the
process environment so liveness detection can work.

But polecat startup still has to separately write `GT_AGENT` into tmux session
environment, with a comment explaining why:

- `BuildStartupCommand` sets `GT_AGENT` in process env via `exec env`
- but `tmux show-environment` reads the session table, not process env
- so default startup would otherwise leave tmux-side liveness checks blind

That is not a tiny workaround.
It means one runtime fact:

- "which agent is actually running"

must be delivered twice because different subsystems consume different truth
planes.

The handoff path shows the same pattern:

- it first tries `os.LookupEnv("GT_AGENT")`
- then falls back to `tmux.GetEnvironment(...)`
- with a comment saying `exec env` vars may not propagate through all runtimes

That is a textbook sign that launch semantics are fragmented.

4. **handoff and respawn reconstruct launch semantics by hand**

`handoff.go` is especially revealing.

For a self-handoff or respawn-style transition, it rebuilds the runtime launch
flow by hand:

- resolves current agent
- re-derives runtime command
- string-rewrites `claude` to inject `--continue`
- rebuilds an env map
- preserves `GT_AGENT` / `GT_PROCESS_NAMES`
- prepends exports with `PrependEnv()`
- prefixes with `cd ... &&`
- emits a new shell command string

That means restart semantics are not just:

- "reuse the structured launch spec"

They are:

- "reassemble enough of the launch string correctly again"

This raises the compatibility tax any time:

- a new runtime is added
- startup flags change
- provider-specific settings behavior changes
- env propagation rules change

5. **the test surface itself shows recurring launch-contract drift**

The loader tests spend a lot of energy asserting startup-string details:

- `exec env` must appear
- wrapper ordering must be right
- `--settings` must appear for Claude on the correct paths
- `--settings` must not double-add
- `--agent` override must still preserve correct settings injection

The explicit GH#3153 tests are especially telling:

- agent override had skipped the `--settings` flag
- polecats launched with `--agent` then lost hook firing

That is not just a role-config bug.
It is launch-contract fragility:

- provider semantics depended on one flag
- that flag lived inside startup-string assembly
- and one resolution path silently missed it

6. **the project's own future design points away from this model**

The strongest final evidence is in the design docs.

`factory-worker-api.md` proposes a structured worker API that would replace:

- `AgentEnv()`
- tmux `SetEnvironment`
- `PrependEnv`
- keychain/account swapping glue
- credential passthrough allowlists

That is exactly what a project writes when it has learned the current launch
plane is too implicit and too shell-shaped.

#### The deeper architectural lesson

Using shell commands is not automatically wrong.

The problem is narrower:

- if the worker launch contract is represented as a shell macro
- and important state is split between process env and session env
- and respawn/handoff paths must reconstruct launch behavior manually

then startup semantics become another hidden state machine.

That produces a specific tax:

- launch bugs look like config bugs
- config bugs look like runtime bugs
- liveness bugs look like env propagation bugs
- provider support grows by adding exceptions to command assembly paths

So the honest verdict here is:

- Gastown's launch surface is powerful
- but it is too implicit, too string-built, and too multi-plane
- and the project is already showing signs that it knows this needs to be
  replaced by a cleaner worker API

Sources:
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/config/env.go`
- `/tmp/gastown-latest/internal/config/types.go`
- `/tmp/gastown-latest/internal/polecat/session_manager.go`
- `/tmp/gastown-latest/internal/cmd/handoff.go`
- `/tmp/gastown-latest/docs/design/agent-api-inventory.md`
- `/tmp/gastown-latest/docs/design/factory-worker-api.md`
- `/tmp/gastown-latest/internal/config/loader_test.go`
- [#3000](https://github.com/gastownhall/gastown/issues/3000)

### 4.26 Provider/account identity is mediated by filesystem and keychain indirection, not one first-class runtime contract

Another deep seam appears once you line up:

- `ResolveAccountConfigDir()`
- `account switch`
- quota rotation
- session resume symlinking
- keychain token swapping
- and `quota.json` active swap tracking

This part of Gastown is clever.
But it is also a strong sign that provider identity is not modeled as one
authoritative runtime object.

Instead, Claude account identity is reconstructed from several different things:

- a config-dir path
- a global `~/.claude` symlink
- a macOS Keychain service entry
- `.claude.json` metadata
- `GT_QUOTA_ACCOUNT` in env
- session transcript files under `projects/...`
- and `mayor/quota.json` swap state

That is a lot of moving parts for one concept:

- "which account is this worker really using right now?"

#### Where the code makes this explicit

1. **accounts are modeled as config-dir indirection**

`AccountsConfig` is not a rich provider/session identity model.
It is basically:

- handle
- email
- description
- `config_dir`

And `ResolveAccountConfigDir()` chooses a config dir by:

- `GT_ACCOUNT`
- `--account`
- default account in `accounts.json`

So the first identity layer is already:

- "the selected account is whatever config dir path won resolution"

2. **global account switching mutates `~/.claude` via symlink**

`gt account switch` does not just update config state.
It rewires the user's global Claude home:

- backs up or relocates the current `~/.claude`
- removes the existing symlink if present
- creates a new symlink from `~/.claude` to the target account config dir

That is operationally pragmatic.
But architecturally it means account identity is still partly represented by a
global filesystem alias, not just by a worker-scoped launch contract.

3. **quota rotation preserves context by mutating credentials in place**

This is the sharpest evidence.

The quota system explicitly avoids changing `CLAUDE_CONFIG_DIR` when it wants
to preserve `/resume`.

Instead it:

- reads the target config dir's keychain token
- overwrites it with the source account's token
- swaps `oauthAccount` in `.claude.json`
- keeps the same config dir
- sets `GT_QUOTA_ACCOUNT` so scanners know which account's token is actually active

That means config-dir identity and effective-auth identity can diverge by design.

The code says this very plainly:

- keep the same config dir so `/resume` works
- use `GT_QUOTA_ACCOUNT` because the config dir still maps to the old account

This is an extremely revealing architectural compromise.

It means the runtime cannot rely on one plain statement like:

- "session X is using account Y"

without consulting multiple side channels.

4. **resume across accounts depends on symlinked session transcripts**

`seance.go` shows another part of the same problem.

To make Claude resume a session that lives under a different account config dir,
Gastown:

- finds the source session file
- symlinks that JSONL into the target account's `projects/...`
- may also update or synthesize the target `sessions-index.json`

So transcript continuity is also being bridged by filesystem indirection.

Again, this is clever and practical.
But it reinforces the same pattern:

- provider/session identity is not transported as a clean runtime handle
- it is reconstructed by moving files, links, and metadata into the shape the
  Claude runtime expects

5. **the swap state itself becomes yet another persistence plane**

`QuotaState` has `ActiveSwaps`, keyed by target config dir and pointing to the
source account handle.

That means the system has to remember that:

- account A's config dir may currently contain account B's token

and later propagate fresh tokens accordingly.

So account identity is not only live state.
It is also historical mutation state that must be tracked and replayed.

6. **the daemon still reaches this through CLI boundaries**

Even here, the daemon does not own a clean in-process credential rotation API.
`quota_dog.go` shells out to:

- `gt quota rotate --json`

which then performs:

- planning
- keychain swap
- transcript relinking
- session restart

So this identity plane is also threaded through the same CLI-as-RPC boundary
seen elsewhere.

#### Why this matters architecturally

This is not mainly a complaint about macOS Keychain.

The deeper issue is that one core runtime fact:

- "the provider/account identity of a worker"

is represented across too many substrates at once:

- config path
- filesystem symlink
- keychain entry
- `.claude.json`
- env override
- quota state
- transcript symlink

That creates a very specific class of tax:

- scanners need `GT_QUOTA_ACCOUNT` because config dir is no longer enough
- resume needs file relinking because transcript ownership follows config dir layout
- token refresh needs `ActiveSwaps` because the live credential may no longer
  match the original config dir owner
- portability suffers because the deepest rotation path is `darwin` keychain-specific

This seam is a little different from the earlier ones:

- the issue tracker evidence is weaker here than for `Beads` or `tmux`
- but the code and design direction are already strong evidence that this is a
  deep architectural compromise, not just an implementation detail

The honest verdict is:

- Gastown has a very inventive answer to "how do we preserve Claude context while
  rotating accounts?"
- but the answer works by creating a sidecar identity system made of
  keychain mutation, config-dir indirection, env overrides, and transcript relinking

That is powerful.
It is also expensive.

Sources:
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/config/types.go`
- `/tmp/gastown-latest/internal/cmd/account.go`
- `/tmp/gastown-latest/internal/cmd/quota.go`
- `/tmp/gastown-latest/internal/quota/executor.go`
- `/tmp/gastown-latest/internal/quota/rotate.go`
- `/tmp/gastown-latest/internal/quota/keychain.go`
- `/tmp/gastown-latest/internal/cmd/seance.go`
- `/tmp/gastown-latest/internal/daemon/quota_dog.go`
- [#232](https://github.com/gastownhall/gastown/issues/232)

### 4.27 Runtime capability semantics are partly inferred from provider and command shape, not declared as one stable contract

Another deep architectural seam becomes visible when you line up:

- `normalizeRuntimeConfig()`
- `BuildCommandWithPrompt()`
- `RuntimeConfigSupportsACP()`
- startup fallback logic in `runtime.go`
- and the docs for custom ACP-enabled agents

The main issue is not that Gastown has presets.
Presets are fine.

The deeper issue is that a lot of runtime behavior is **not represented as one
explicit capability contract**.

Instead, it is inferred from a mixture of:

- `provider`
- `command`
- preset lookup
- basename checks
- nullable nested config
- and runtime helper rewrites

That makes capability semantics more ambient than they should be.

#### What the code is actually doing

1. **normalization auto-fills many behaviors from `provider` defaults**

`normalizeRuntimeConfig()` auto-derives all of these from `provider`:

- command
- args
- prompt mode
- session ID env var
- config-dir env var
- hooks provider / dir / settings file
- hook informational flag
- process names
- ready prompt prefix
- ready delay
- instructions filename

So a lot of what looks like explicit runtime behavior is actually:

- "whatever the current provider preset says"

2. **ACP support can be inherited by command matching, not explicit declaration**

`RuntimeConfigSupportsACP()` and `GetACPConfigFromRuntime()` use explicit `rc.ACP`
if present.

But if it is not present, they fall back to:

- `ResolveACPConfig("", rc.Command)`

The docs say this directly too:

- a custom agent with `"command": "opencode"` automatically inherits ACP support
  from the opencode preset

That means ACP capability is not only a declared property.
It can be implied by command shape.

3. **prompt-delivery semantics also depend on command-name special cases**

`BuildCommandWithPrompt()` does not only consult `PromptMode`.

It also switches behavior based on the command basename:

- `opencode` gets `--prompt`
- `copilot` gets `-i`
- `gemini` gets `-i`
- everything else gets positional prompt

So prompt semantics are partly:

- declarative (`PromptMode`)

and partly:

- imperative special cases keyed off command name

4. **startup fallback logic reduces runtime behavior to a heuristic matrix**

`GetStartupFallbackInfo()` computes startup behavior from just:

- does this runtime effectively have executable hooks?
- does this runtime accept prompt args?

That sounds reasonable, but the implementation relies on inferred semantics:

- hooks are considered present only if provider is non-empty/non-none and
  `Informational` is false
- prompt support is considered present if `PromptMode != "none"`

Then helper code like `RuntimeConfigWithMinDelay()` mutates the effective
readiness behavior further by:

- forcing a minimum delay
- clearing `ReadyPromptPrefix`

So even readiness behavior is not purely declarative.
It can be rewritten by fallback helpers to get a desired startup path.

5. **custom agents inherit more than one kind of hidden behavior**

Because presets feed multiple default families, a custom runtime can inherit:

- hook installation style
- readiness semantics
- instructions filename
- session-ID env naming
- account config-dir env naming
- ACP support

without declaring all of that directly in its own config.

That is convenient.
But it also means a custom runtime's actual behavior is only fully knowable after:

- preset lookup
- command matching
- normalization
- and sometimes runtime fallback transformation

#### Why this is an architectural problem

Again, the problem is not "presets bad".

The problem is that **capabilities are not fully first-class**.

A healthier contract would let you answer, directly and structurally:

- can this runtime accept a startup prompt?
- can it auto-run hooks?
- how is readiness detected?
- how is ACP invoked?
- where does session identity come from?
- how is config/account selection conveyed?

In Gastown, the answer is often:

- "it depends on provider defaults"
- "unless the command matches a known preset"
- "unless the runtime helper forces a delay path"
- "unless hooks are informational"

That creates a specific kind of drift risk:

- changing a command can change capabilities
- changing a preset can silently change custom agents
- capability reasoning gets split across config, presets, and helper code
- runtime behavior becomes harder to reason about statically

So the honest verdict here is:

- Gastown has a rich runtime abstraction
- but the capability layer under it is still partly inferred and heuristic
- and that makes the system more flexible than a rigid schema, but also more
  fragile and more prone to semantic drift

Sources:
- `/tmp/gastown-latest/internal/config/types.go`
- `/tmp/gastown-latest/internal/config/agents.go`
- `/tmp/gastown-latest/internal/runtime/runtime.go`
- `/tmp/gastown-latest/docs/reference.md`
- `/tmp/gastown-latest/internal/config/agents_test.go`
- `/tmp/gastown-latest/internal/runtime/runtime_test.go`

### 4.28 The runtime capability model is split across two schemas, and custom agents only get the poorer one

There is an even deeper version of the previous problem.

Gastown does not just infer some capabilities from presets.
It also splits capability expression across **two different config models**:

- `RuntimeConfig`
- `AgentPresetInfo`

And the public custom-agent surface mostly exposes only the first one.

#### Why this matters

Town and rig settings define custom agents as:

- `Agents map[string]*RuntimeConfig`

not:

- `Agents map[string]*AgentPresetInfo`

So the user-facing custom-agent contract is `RuntimeConfig`.

But a lot of live runtime behavior in Gastown depends on fields that exist only
on `AgentPresetInfo`, not on `RuntimeConfig`.

That means a custom agent can look fully configured and still be unable to
declare some behaviors that the engine actually cares about.

#### What exists only in the preset schema

`AgentPresetInfo` carries fields such as:

- `ResumeFlag`
- `ContinueFlag`
- `ResumeStyle`
- `SupportsForkSession`
- `EmitsPermissionWarning`
- `EscapeCancelsRequest`
- `SupportsHooks`
- `NonInteractive`

But `RuntimeConfig` does not expose those.

`RuntimeConfig` gives you:

- provider
- command
- args
- env
- prompt mode
- session
- hooks
- tmux readiness
- instructions
- ACP
- exec wrapper

That is substantial, but it is not the full runtime contract.

#### Where the split leaks into actual behavior

1. **resume support is preset-only**

`crew/manager.go` builds resume arguments from preset fields:

- `ResumeFlag`
- `ResumeStyle`
- `ContinueFlag`

So whether a runtime can resume sessions is not fully expressible in
`RuntimeConfig`.

2. **fork-session support is preset-only**

`seance.go` resolves an agent that supports `--fork-session` by scanning presets
for `SupportsForkSession`.

A custom runtime defined only via `RuntimeConfig` cannot cleanly advertise that
capability through the same path.

3. **startup warning behavior is preset-only**

`crew/manager.go` checks `preset.EmitsPermissionWarning` to decide whether to
wait for startup and auto-accept dialogs.

So a custom runtime that emits a dangerous-mode warning cannot express that in
`RuntimeConfig` alone.

4. **nudge safety behavior is preset-only**

`nudge.go` and `nudge_poller.go` check `preset.EscapeCancelsRequest` to decide
whether sending Escape is destructive.

Again, that is a real runtime behavior, but it lives outside the public
`RuntimeConfig` schema.

#### Why this is deeper than a missing field or two

This means Gastown's extensibility model is structurally split:

- one schema for what users can configure
- another schema for what the engine actually knows how to reason about

And the engine keeps consulting the richer internal one for important behavior.

So even if you provide a rich custom `RuntimeConfig`, the system may still need:

- a built-in preset
- or a registry entry in the richer preset model
- or an inference path by agent name / command

before some behaviors become first-class.

That creates a specific tax:

- custom runtime support is never quite as sovereign as it looks
- some capabilities can only be added by editing internal registry code
- extensibility is partly declarative and partly registry-coded
- "works as a custom runtime" and "works as a first-class agent" are not the same thing

The honest verdict is:

- Gastown's runtime abstraction is broader than most competitors
- but its customization model is still not fully unified
- because the engine's richest capability schema is not the same schema exposed
  through everyday custom-agent config

Sources:
- `/tmp/gastown-latest/internal/config/types.go`
- `/tmp/gastown-latest/internal/config/agents.go`
- `/tmp/gastown-latest/internal/crew/manager.go`
- `/tmp/gastown-latest/internal/cmd/seance.go`
- `/tmp/gastown-latest/internal/cmd/nudge.go`
- `/tmp/gastown-latest/internal/cmd/nudge_poller.go`

### 4.29 Runtime defaulting semantics are inconsistent, and zero values do not mean the same thing everywhere

There is an even deeper problem underneath the runtime config layer:

- the same partial `RuntimeConfig` can be interpreted differently depending on
  which helper path processes it

This is not just a merge nuance.
It is a schema-contract problem.

#### The two different defaulting engines

Gastown currently has at least two materially different defaulting paths:

1. `fillRuntimeDefaults()`
2. `normalizeRuntimeConfig()`

They do not behave the same way.

##### `fillRuntimeDefaults()` is mostly **nil-struct-based**

The loader path uses `fillRuntimeDefaults()` for custom agent configs.

Its behavior is:

- if a nested struct is `nil`, fill it from preset
- if a nested struct exists, deep-copy it and mostly preserve its zero values

The tests are explicit about this:

- `"partial nested struct is copied without defaults"`
- a partial `Tmux` config with only `ProcessNames` keeps `ReadyDelayMs == 0`

So in that path:

- `0` can mean "left unfilled"
- `false` can remain false simply because the field existed on the copied struct

##### `normalizeRuntimeConfig()` is **zero-value-based**

But `normalizeRuntimeConfig()` does something different:

- `if rc.Hooks.Provider == ""` → default it
- `if !rc.Hooks.Informational` → maybe default it
- `if rc.Tmux.ReadyPromptPrefix == ""` → default it
- `if rc.Tmux.ReadyDelayMs == 0` → default it

So in that path:

- `0` often means "missing, fill default"
- `false` can mean "missing, maybe fill default"

Those are not the same semantics.

#### Why this is deeper than it looks

It means the runtime schema does not have one crisp tri-state model for many fields.

For some settings, the system cannot cleanly distinguish between:

- omitted
- explicitly false
- explicitly zero
- intentionally empty string

And worse, the answer can depend on which code path processed the config.

That creates a subtle but real category of drift:

- custom config loaded through one path may preserve a zero value
- the same runtime later normalized through another path may replace that zero with a default

So the same config object is not guaranteed to mean the same thing everywhere.

#### The codebase already knows this class of problem is real

The strongest proof is that another subsystem already solved it differently.

`MergeQueueConfig` uses `*bool` pointer fields specifically so it can preserve:

- omitted
- explicit false
- explicit true

The tests say this directly:

- omitted booleans should deserialize to `nil`, not false
- explicit false should be respected

So the maintainers already understand the problem.

The runtime config layer just has not been made equally precise.

#### Why this matters for architecture

When a multi-agent orchestrator reaches this level of complexity, vague defaulting
semantics are expensive because they blur the boundary between:

- runtime capability declaration
- inheritance
- user override
- and later normalization

That makes reasoning harder in exactly the wrong place:

- agent startup
- readiness
- hooks
- prompt delivery
- session/account integration

The honest verdict is:

- Gastown has rich runtime configuration
- but the type/default semantics under that configuration are still inconsistent
- and that means some runtime intent is not represented as precisely as the
  rest of the engine would benefit from

Sources:
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/config/types.go`
- `/tmp/gastown-latest/internal/config/loader_test.go`
- `/tmp/gastown-latest/internal/config/types_test.go`

### 4.30 Runtime identity is lossy: alias, provider, command, preset, and process names are not one stable object

There is one more deep seam under Gastown's runtime abstraction:

- the system does not carry one authoritative runtime identity object
- instead it keeps translating between several overlapping notions:
  - configured alias from `role_agents` / `worker_agents`
  - provider name
  - command binary
  - built-in preset name
  - process-name set used for liveness detection

Those are related, but they are not the same thing.
And in Gastown they can collapse into each other in ways that lose meaning.

#### The code shows the identity loss directly

The clearest smoking gun is `inferAgentName()`:

- if `Provider` is set, identity becomes `Provider`
- else if `Command` is set, identity becomes `Command`
- else it becomes `"claude"`

That is not a precise identity model.
It is a lossy fallback.

At the same time, other parts of the system are forced to preserve a separate
alias-like notion through `RuntimeConfig.ResolvedAgent`, which exists purely as
a runtime-only field so startup code can export `GT_AGENT` for liveness and
session bookkeeping.

That means the type system is already telling us something:

- `provider`
- `command`
- and `resolved configured name`

are not interchangeable, but the engine still has several places that treat
them as if they were close enough.

#### Different subsystems want different identities

This shows up repeatedly:

- `ResolveRoleAgentConfig()` and `ResolveWorkerAgentConfig()` try to preserve
  the configured alias via `ResolvedAgent = agentName`
- `BuildStartupCommand` needs that alias so it can export `GT_AGENT`
- `polecat/session_manager.go` has to **compensate** by writing `GT_AGENT`
  into the tmux session table when there was no explicit `--agent` override,
  because process env alone is not enough for later consumers
- `ResolveProcessNames()` has to reconcile the alias and the actual binary,
  because a custom `"codex"` agent may really run `"opencode"` and built-in
  process-name lookup would otherwise be wrong
- `tmux.resolveSessionProcessNames()` prefers `GT_PROCESS_NAMES` and only then
  falls back to `GT_AGENT`, because `GT_AGENT` alone is not precise enough for
  custom or shadowing agents

This is a very specific architectural smell:

- one subsystem wants a configured alias
- another wants a concrete binary
- another wants preset capability lookup
- another wants stable liveness matchers
- and the translation between them is not fully invertible

#### Real bugs already come out of this seam

The issue tracker shows that this is not theoretical.

- [#3218](https://github.com/gastownhall/gastown/issues/3218) shows witness
  ignoring `role_agents` model config and launching with the bare default
  Claude command from role TOML. That means the configured identity is not
  authoritative enough to survive contact with the startup path.
- [#3248](https://github.com/gastownhall/gastown/issues/3248) shows
  `doctor hooks-sync` silently skipping non-Claude template agents in CI
  because `ResolveRoleAgentConfig` fell back to Claude when the configured
  binary was not in `PATH`.
- [#3033](https://github.com/gastownhall/gastown/issues/3033) shows Gemini
  crew sessions surfacing identity-collision and context-injection problems.
  That is not caused only by identity mapping, but it is a strong signal that
  non-Claude runtimes pay extra tax when runtime identity is reconstructed
  indirectly instead of carried as one authoritative object.

The `hooks_sync.go` code now contains an explicit comment acknowledging this:

- use `ResolveRoleAgentName`, not `ResolveRoleAgentConfig`
- because config resolution can fall back to Claude and silently hide the
  configured non-Claude target

That is a very revealing comment.
It means the project already distinguishes between:

- the **configured runtime identity**
- and the **currently resolvable runtime command**

but the distinction is not enforced universally.

#### Why this matters more than it first appears

When identity is lossy, several subtle architectural costs appear:

- custom-agent parity becomes fragile
- diagnostics can "helpfully" collapse back to Claude and hide the real config
- liveness detection must be patched with extra env like `GT_PROCESS_NAMES`
- startup logic must preserve `ResolvedAgent` by hand so later layers can still
  recover the intended identity
- role TOMLs and other legacy start paths can accidentally bypass the resolved
  runtime contract and reopen provider-specific defaults

This is especially expensive in a multi-runtime orchestrator, because runtime
identity is not just a label. It is also the handle for:

- capability lookup
- hook installation
- session/account semantics
- process matching
- startup-dialog behavior
- and model/provider-specific lifecycle rules

If those all derive from slightly different identity projections, the system
starts accumulating compensating glue instead of gaining a clean runtime layer.

That is exactly what the code already shows:

- runtime-only `ResolvedAgent`
- `GT_AGENT` as a compensator
- `GT_PROCESS_NAMES` as another compensator
- command-based preset matching as another compensator
- role-TOML start-command exceptions as another compensator
- hooks-sync using name resolution specifically to avoid config-resolution
  fallback drift

The deep lesson is:

- Gastown has a serious runtime abstraction
- but its identity model is still not crisp enough to carry alias, provider,
  command, preset, and liveness identity as one stable first-class contract

That is another reason non-Claude support can look broader in the registry than
it feels in the engine.

Sources:
- `/tmp/gastown-latest/internal/config/loader.go`
- `/tmp/gastown-latest/internal/config/types.go`
- `/tmp/gastown-latest/internal/config/agents.go`
- `/tmp/gastown-latest/internal/polecat/session_manager.go`
- `/tmp/gastown-latest/internal/tmux/tmux.go`
- `/tmp/gastown-latest/internal/crew/manager.go`
- `/tmp/gastown-latest/internal/cmd/hooks_sync.go`

### 4.31 Role definitions are a second runtime-config plane, so orchestration policy and launch semantics are not cleanly separated

There is one more deep fault line underneath Gastown's runtime layer:

- role definitions are not just orchestration metadata
- they also carry concrete startup commands
- which means launch semantics do not belong to only one config system

This is deeper than "a bad default in one TOML".
It means the project has two overlapping sources for runtime startup truth:

1. the declarative runtime-config / agent-resolution system
2. role TOMLs with `start_command`

#### The built-in role definitions hardcode Claude startup

The current built-in role TOMLs for:

- `witness`
- `deacon`
- `mayor`
- `refinery`
- and other core roles

all include:

- `start_command = "exec claude --dangerously-skip-permissions"`

So even before role-agent resolution runs, the role definition itself is already
embedding a concrete provider-shaped launch command.

That is a strong signal that role definitions are doing two jobs at once:

- describing orchestration behavior
- and describing runtime launch mechanics

Those are related, but they are not the same responsibility.

#### The code now contains explicit escape hatches around this split

The project already knows this is a problem.
The code says so in several places.

In `witness/manager.go`:

- if the resolved agent is non-Claude, skip the TOML `start_command`
- because the built-in role TOMLs hardcode `exec claude ...`
- and fall through to `BuildStartupCommandFromConfig`

In `daemon/lifecycle.go`:

- the daemon has the same bypass logic
- built-in TOML `start_command` is used only in narrow cases
- otherwise it falls through to the runtime-config startup path so non-Claude
  agents and model-specific Claude configs are not lost

In `loader.go`:

- `HasExplicitRoleAgent()` exists specifically to distinguish:
  - "no explicit role_agents entry, use default role behavior"
  - from "role_agents explicitly selected another agent/model"
- because once an explicit mapping exists, the TOML `start_command` should not
  be trusted as the authoritative startup source anymore

This is a classic architectural smell:

- the code is not just consuming a clean config model
- it is actively arbitrating between two config planes

#### The issue tracker already shows the real failure mode

- [#3218](https://github.com/gastownhall/gastown/issues/3218) is the clearest
  example: witness ignored `role_agents` model config and launched with the
  bare default Claude command from role TOML instead of the resolved model-aware
  startup command

The most important part is not just the bug itself.
It is what the bug proves:

- role-specific launch metadata can bypass the declarative runtime contract
- so runtime identity and capability resolution are not truly authoritative

#### Why this matters architecturally

When role definitions carry concrete launch commands, several costs appear:

- runtime abstraction stops being sovereign
- provider/model selection can be overridden by legacy role-specific launch paths
- adding new runtimes requires auditing role definitions, not just runtime config
- startup correctness depends on remembering which path is authoritative for
  each role and each agent class
- role config starts mixing orchestration policy with transport/provider policy

This also interacts badly with the other deep seams already found:

- lossy runtime identity
- Claude-shaped defaults
- command-inferred capabilities
- split capability schemas
- shell-string launch choreography

Because once role definitions can inject provider-specific start commands,
every later layer must ask:

- did this runtime come through the resolved config path?
- or through a role TOML path?
- and if both exist, which one wins for this role, this agent, and this fallback case?

That is exactly the kind of cross-cutting ambiguity that turns startup into a
compensating system rather than a single authoritative contract.

The deep lesson is:

- role definitions should describe role behavior
- runtime config should describe how the worker is launched
- Gastown currently lets role definitions partially do both
- and the engine is already paying for that with bypass logic and role-specific
  exceptions

Sources:
- `/tmp/gastown-latest/internal/config/roles/witness.toml`
- `/tmp/gastown-latest/internal/config/roles/deacon.toml`
- `/tmp/gastown-latest/internal/config/roles/mayor.toml`
- `/tmp/gastown-latest/internal/config/roles/refinery.toml`
- `/tmp/gastown-latest/internal/witness/manager.go`
- `/tmp/gastown-latest/internal/daemon/lifecycle.go`
- `/tmp/gastown-latest/internal/config/loader.go`

### 4.32 The new role-config system is not yet sovereign: it is richer than the runtime wiring that actually consumes it

There is an even deeper issue under the role-config layer:

- the new `RoleDefinition` schema looks like a real first-class config system
- but the live runtime only consumes part of it
- and some important behavior still comes from other config planes entirely

So the project has not just split config ownership.
It also has a **schema-to-runtime gap**.

#### The role config model is richer than what the runtime actually uses

`config.RoleDefinition` contains:

- session patterns
- work dir
- `start_command`
- env
- health thresholds
- `nudge`
- `prompt_template`

At first glance, that looks like a clean replacement for the old role-bead
system.

But the actual call sites are much thinner than that.

The only real `LoadRoleDefinition()` consumers in the live code are:

- `witness/manager.go`
- `daemon/lifecycle.go`
- `cmd/role.go`

And the runtime consumers do not keep the full `RoleDefinition`.
They immediately **downcast** it into the older `beads.RoleConfig` shape.

That adapter currently carries only:

- `SessionPattern`
- `WorkDirPattern`
- `NeedsPreSync`
- `StartCommand`
- `EnvVars`

It drops the rest of the richer role schema on the floor.

That is a strong sign that the new role-config system is not yet the
authoritative runtime contract.
It is still partly an adapter feeding older runtime expectations.

#### Several live behavior planes still come from elsewhere

The missing pieces are not imaginary.
They are visibly sourced from other systems:

- deacon ping thresholds and consecutive-failure policy come from
  `config/operational.go` and `deacon/stuck.go`, not from `RoleDefinition`
- witness hung-session logic still derives from `constants.HungSessionThreshold`
  in `witness/handlers.go`
- doctor's patrol stuck fallback still uses its own
  `DefaultStuckThreshold` in `doctor/patrol_check.go`
- `Nudge` and `PromptTemplate` exist in `RoleDefinition`, but the actual role
  startup flow builds prompts and beacons through session/runtime/template code,
  not through a role-config object that is threaded end-to-end

So even though `gt role` can display:

- health settings
- nudge text
- prompt template

the main runtime paths are not consuming that full contract.

#### Why this matters architecturally

This creates a deceptive kind of complexity:

- the schema suggests one cohesive role-config model
- the runtime still behaves as if several older config planes remain primary

That means users and maintainers can reasonably believe:

- "this role field is part of the runtime contract"

when in reality it may be:

- display-only in some paths
- adapter-only in others
- or superseded by operational config/constants somewhere else

This is one of the most expensive forms of architectural drift:

- not because the code is obviously wrong
- but because the schema surface and the effective control surface are no
  longer the same thing

The deeper smell is that the migration is only partially complete:

- the new role config exists
- the old legacy-shaped consumer model still exists
- and operational thresholds still live in a third place

That gives Gastown not just split truth, but **split meaning**.

#### The project already exposes the mismatch in plain sight

You can see the asymmetry directly:

- `cmd role` prints the whole `RoleDefinition`, including health and prompts
- `daemon/lifecycle.go` and `witness/manager.go` only convert a subset into
  `beads.RoleConfig`
- other live threshold logic keeps reading constants or operational config

So the config layer is, in part, ahead of the execution layer.

That is an understandable migration state.
But architecturally it means the role-config system is not yet sovereign enough
to be treated as one clean runtime source of truth.

The deep lesson is:

- a richer schema is not the same as a richer contract
- until the runtime consumes that schema end-to-end, the orchestrator still
  pays for multiple overlapping meaning planes

Sources:
- `/tmp/gastown-latest/internal/config/roles.go`
- `/tmp/gastown-latest/internal/daemon/lifecycle.go`
- `/tmp/gastown-latest/internal/witness/manager.go`
- `/tmp/gastown-latest/internal/cmd/role.go`
- `/tmp/gastown-latest/internal/config/operational.go`
- `/tmp/gastown-latest/internal/deacon/stuck.go`
- `/tmp/gastown-latest/internal/witness/handlers.go`
- `/tmp/gastown-latest/internal/doctor/patrol_check.go`

### 4.33 A unified session lifecycle exists, but the most complex roles still bypass it

There is another deep convergence problem in Gastown's startup architecture:

- the codebase already has a generic `session.StartSession()` abstraction
- but several of the most complex and failure-prone runtime paths still do not
  use it

This matters because startup is one of Gastown's hottest seams.
If the shared lifecycle is not authoritative there, fixes keep reappearing in
role-specific managers instead of collapsing into one substrate.

#### The abstraction exists and explicitly claims to unify the startup pattern

`session.StartSession()` says, in plain text, that it replaces the common
startup choreography previously duplicated across:

- polecat
- mayor
- boot
- deacon
- witness
- refinery
- crew
- dog

And the helper really does bundle a lot of the right steps:

- resolve runtime config
- ensure settings/plugins
- build startup command
- create tmux session
- set env vars
- apply theme
- wait for readiness
- accept startup dialogs
- set pane id
- track PID

That is the right architectural direction.

#### But the adoption is only partial

Actual call sites tell a different story.

`StartSession()` is currently used by:

- `mayor/manager.go`
- `boot/boot.go`
- `dog/session_manager.go`

But the heavier role paths still run bespoke startup flows:

- `witness/manager.go`
- `deacon/manager.go`
- `refinery/manager.go`
- `crew/manager.go`
- `polecat/session_manager.go`

Those manual paths all redo slightly different combinations of:

- `NewSessionWithCommand`
- env setup
- `GT_RUN` / `GT_PANE_ID`
- readiness waits
- startup dialog handling
- PID tracking
- nudge poller setup
- role-specific fallback logic

That means the project has a shared lifecycle helper, but not yet a shared
startup contract across the roles that generate the most lifecycle bugs.

#### Why this is deeper than normal duplication

This is not just "some code could be refactored".

The duplicated paths are exactly where Gastown's hardest runtime seams live:

- witness startup
- deacon resilience
- refinery worktree/startup behavior
- polecat liveness identity and process matching
- crew session startup and env propagation

So partial adoption has a high architectural price:

- bug fixes land in one role manager but not others
- one path may use `WaitForRuntimeReady` while another uses `WaitForCommand`
- one path may use `MergeRuntimeLivenessEnv`, another may patch `GT_AGENT`
  manually
- one path may set remain-on-exit or auto-respawn at a different time
- one path may honor role/runtime config differently from another

This is exactly the kind of partial convergence that creates a false sense of
abstraction maturity:

- there is a shared helper
- but the hardest runtime cases still sit outside it

#### The code already shows the asymmetry

The contrast is sharp:

- `mayor`, `boot`, and `dog` are started through `session.StartSession()`
- `witness`, `deacon`, `refinery`, `crew`, and `polecat` still hand-stitch
  their own startup choreography

And those manual paths are visibly rich with bug-history comments and local
compensations:

- startup race comments
- env inheritance workarounds
- explicit `GT_AGENT` / `GT_PROCESS_NAMES` handling
- custom wait strategies
- custom startup dialog decisions
- per-role nudge poller handling

That strongly suggests the startup substrate has not really converged, even if
the codebase now contains a helper that could theoretically centralize it.

#### Why this matters for architecture quality

When a generic startup lifecycle exists but core roles bypass it, the project
ends up with:

- one abstraction layer that looks authoritative
- and a second reality where the important cases still live elsewhere

That creates two problems:

1. maintainers cannot trust that "session startup behavior" lives in one place
2. future fixes still have to be audited across several managers

This is another version of the same pattern seen elsewhere in Gastown:

- the architecture often has the *right idea*
- but the most expensive runtime paths still sit on older, more local logic

The deep lesson is:

- partial convergence is not enough in an orchestrator
- especially not around startup, liveness, and recovery
- if the most complex workers bypass the shared lifecycle, the system still
  pays the multi-path tax even after the abstraction exists

Sources:
- `/tmp/gastown-latest/internal/session/lifecycle.go`
- `/tmp/gastown-latest/internal/mayor/manager.go`
- `/tmp/gastown-latest/internal/boot/boot.go`
- `/tmp/gastown-latest/internal/dog/session_manager.go`
- `/tmp/gastown-latest/internal/witness/manager.go`
- `/tmp/gastown-latest/internal/deacon/manager.go`
- `/tmp/gastown-latest/internal/refinery/manager.go`
- `/tmp/gastown-latest/internal/crew/manager.go`
- `/tmp/gastown-latest/internal/polecat/session_manager.go`

### 4.34 The tmux/env transport contract is fragmented: initial shell, session env, respawn path, and liveness state are populated by different mechanisms

There is an even lower-level startup seam under the session lifecycle:

- Gastown does not have one authoritative transport for startup environment and
  runtime identity
- instead it uses several partially overlapping mechanisms depending on the
  role and code path

This is not just an implementation detail.
It affects:

- what the initial shell sees
- what `tmux show-environment` sees
- what respawned processes inherit
- and what later liveness/recovery logic believes the runtime identity is

#### There are multiple active env-delivery paths

Today Gastown uses a mix of:

1. `config.PrependEnv(...)` into the shell command string
2. `tmux new-session -e KEY=VALUE ...` via `NewSessionWithCommandAndEnv`
3. `tmux set-environment` after session creation
4. direct global env cleanup like `tmux set-environment -g -u CLAUDECODE`

And those are not equivalent.

The code comments are explicit about why:

- `tmux set-environment` only affects future panes/windows, not the shell that
  already started
- `exec env ...` affects the launched process, but not automatically the tmux
  session table that later diagnostics and respawn logic read
- `-e` flags set env before the initial shell starts, which is why crew startup
  needed a dedicated `NewSessionWithCommandAndEnv` path

That means the same logical fact, like:

- `GT_ROLE`
- `GT_AGENT`
- `GT_PROCESS_NAMES`
- `GT_RUN`
- `CLAUDE_CONFIG_DIR`
- `CLAUDECODE`

may need to be written more than once through different channels depending on
which later consumer needs to see it.

#### The code already contains transport-specific compensators

Examples:

- `session.StartSession()` prepends env into the command string, then also
  writes env into the tmux session table with `SetEnvironment`
- `crew/manager.go` uses `NewSessionWithCommandAndEnv(...)` specifically so the
  initial shell gets the correct env before startup, because `SetEnvironment`
  after creation was not enough
- `polecat/session_manager.go` still manually writes `GT_AGENT`,
  `GT_PROCESS_NAMES`, `GT_RUN`, `GT_PANE_ID`, and other fields into the tmux
  session after launch
- `tmux.NewSessionWithCommand()` explicitly clears `CLAUDECODE` from the tmux
  global environment as defense-in-depth before creating sessions

This is a telltale architecture sign:

- the system is not just setting environment
- it is reconciling several env scopes with different timing and visibility

#### The issue tracker shows real failures caused by this split

- [#1289](https://github.com/gastownhall/gastown/issues/1289) shows crew shell
  inheriting the parent's `GT_ROLE` instead of the session-level env, so
  `gt prime --hook` injected mayor context into a crew worker
- [#1666](https://github.com/gastownhall/gastown/issues/1666) shows
  `CLAUDECODE=1` leaking through tmux global environment into new polecat
  sessions, triggering nested-session detection and killing startup immediately

Those are not cosmetic bugs.
They show that the transport semantics of environment delivery are part of the
control plane.

#### Why this is architecturally expensive

Once startup/env transport is fragmented like this, every role startup path has
to reason about at least four different consumers:

- the initial shell
- the launched agent process
- tmux session metadata readers
- respawned/restarted processes

And because not all of them read the same source, the code starts accumulating:

- extra exports in command strings
- extra `SetEnvironment` calls
- role-specific startup APIs
- global env sanitizers
- session-table-only liveness fields
- and command-string-only prompt/setup fields

That makes the startup substrate more brittle than it looks, because the
logical runtime contract is not carried once through one mechanism.
It is reconstructed across several transport layers.

This is especially bad in Gastown because startup is already one of the most
sensitive parts of the system:

- role identity
- runtime identity
- liveness detection
- account/config-dir selection
- hook activation
- startup dialogs
- nested-session avoidance

all depend on these early env paths converging correctly.

The deep lesson is:

- if the orchestrator cannot say "this is the one transport that defines the
  startup env and runtime identity contract"
- then the tmux/process boundary itself becomes another source of drift

Gastown is already paying that price.

Sources:
- `/tmp/gastown-latest/internal/tmux/tmux.go`
- `/tmp/gastown-latest/internal/session/lifecycle.go`
- `/tmp/gastown-latest/internal/config/env.go`
- `/tmp/gastown-latest/internal/crew/manager.go`
- `/tmp/gastown-latest/internal/polecat/session_manager.go`
- `/tmp/gastown-latest/internal/cmd/crew_at.go`
- `/tmp/gastown-latest/internal/cmd/polecat_spawn.go`
- [#1289](https://github.com/gastownhall/gastown/issues/1289)
- [#1666](https://github.com/gastownhall/gastown/issues/1666)

### 5. Repair tooling has become part of the architecture

`gt doctor --fix` is not just a convenience layer. It acts as a recovery mechanism for multiple structural problems.

That is useful, but it also means the project expects self-healing and repair because broken intermediate states are common enough to justify whole subsystems around them.

Worse, the repair layer can itself create damage:
- [#885](https://github.com/gastownhall/gastown/issues/885) `gt doctor --fix` writes artifacts into external git worktrees and pollutes repos

Source:
- `/tmp/gastown-latest/internal/doctor/rig_check.go`

To be fair to current `main`, this exact boundary has improved:

- the priming subsystem now explicitly documents that worktree `CLAUDE.md` files
  belong to the customer's repo
- stale intermediate instruction files are removed instead of recreated
- the town-root identity anchor is treated as the only durable `CLAUDE.md`

That is a real correction in architectural direction.

But the deeper lesson remains:

- boundary safety was not originally enforced by the architecture itself
- it had to be rediscovered through bug reports, cleanup code, and doctor logic

Sources:
- `/tmp/gastown-latest/internal/doctor/priming_check.go`
- [#885](https://github.com/gastownhall/gastown/issues/885)

### 5.5 Config-contract drift is another recurring class of problem

Another useful deep finding is that multiple subsystems can drift on what
"correct settings" means.

Recent example:

- issue `#3648` reports `gt doctor` and `gt hooks sync` disagreeing about what
  a valid polecat Claude settings file should contain

The specifics are evolving quickly:

- current `main` templates now use `{{GT_BIN}}` and a `Stop` hook of
  `costs record &`, which is closer to what doctor expects
- but the issue is still useful because it shows how easily template
  generation, doctor checks, and startup installers can drift apart

The current code still shows why this class of bug can recur:

- `needsUpgrade()` in `hooks/installer.go` is heuristic content detection,
  not a versioned contract
- doctor validates semantic patterns
- startup paths provision files opportunistically

That is survivable, but brittle. It is another example of several partially
independent truths about runtime state.

Sources:
- `/tmp/gastown-latest/internal/hooks/installer.go`
- `/tmp/gastown-latest/internal/hooks/templates/claude/settings-autonomous.json`
- `/tmp/gastown-latest/internal/doctor/claude_settings_check.go`
- [#3648](https://github.com/gastownhall/gastown/issues/3648)

### 6. Boundary pollution between orchestrator and external repos

This is one of the most serious product mistakes from a user-trust perspective.

If the orchestrator writes its own artifacts into external code worktrees, it crosses the line from "manage agent work" into "mutate someone else's repository shape".

The `doctor --fix` issue is especially bad because it can overwrite or create files inside external repos.

Source:
- [#885](https://github.com/gastownhall/gastown/issues/885)

This is not a low-level bug. It is a bad boundary decision.

### 7. Convoy / cross-store orchestration adds another layer of routing pain

Convoys are conceptually cool. They enable tracked cross-rig orchestration. But in practice they amplify cross-store resolution complexity.

The code already contains special resolver logic just to find issues across stores by prefix.

And issues suggest convoy flows can:
- fail hot
- poll too aggressively
- cause CPU spikes
- get stranded on schema or routing mismatches

Sources:
- `/tmp/gastown-latest/internal/convoy/operations.go`
- `/tmp/gastown-latest/internal/convoy/multi_store.go`
- [#3117](https://github.com/gastownhall/gastown/issues/3117)

Convoys are a strength conceptually, but operationally expensive in the current substrate.

Going deeper into the current code makes the shape of that cost clearer:

- convoy tracking itself is elegant
- but cross-store resolution is fundamentally prefix-routed
- store lookup silently falls through on missing stores or query errors
- completion, feeding, and dependency checks still rely on several stitched
  sources of truth: HQ convoy bead, rig issue stores, dependency metadata
  snapshots, and route-derived store names

That means the convoy idea is not the problem. The cost comes from trying to
make a cross-database workflow feel native on top of prefix-routing and
best-effort resolution.

One especially useful companion example is `#3587`:

- a gate can be closed by one operation
- waking the parked worker is a separate operation
- if the Deacon dies between them, the parked work never resumes

That is another sign that orchestration continuity is sometimes split across
multiple non-atomic steps with recovery logic layered afterward.

Sources:
- `/tmp/gastown-latest/internal/convoy/multi_store.go`
- `/tmp/gastown-latest/internal/convoy/operations.go`
- [#3587](https://github.com/gastownhall/gastown/issues/3587)

### 7.5 Convoy, gates, and parked work form a second orchestration engine inside the first one

Going one level deeper, convoy is not just "batch tracking".

It has become a second orchestration layer with its own:

- tracked-issue graph
- staged vs open convoy lifecycle
- ready-vs-blocked selection logic
- cross-store dependency resolution
- parked-rig suppression
- gate-close and wake choreography
- stranded-convoy patrol
- dog-based re-feed mechanism
- per-convoy cooldown state persisted to JSON

That does not make the feature bad. In fact, this is one of the places where
Gastown is conceptually strongest.

But it is also where the architecture becomes visibly expensive.

The current flow spreads transition logic across several layers:

- `convoy/operations.go` finds tracked issues, refreshes their status, checks
  dependencies, resolves rig by prefix, and dispatches via `gt sling`
- `convoy/multi_store.go` resolves cross-rig issue state by prefix-routed store
  selection
- `deacon/feed_stranded.go` separately discovers stranded convoys, persists
  cooldown state in `deacon/feed-stranded-state.json`, and dispatches dogs to
  re-feed them
- `cmd/convoy.go` has its own stranded scan and staged/open lifecycle logic
- gate clearing and worker wake-up are split across separate command paths

So convoy is no longer one feature. It is effectively an orchestrator inside
the orchestrator.

The strongest evidence is `#3587`:

- `bd gate check` closes a gate
- `gt gate wake <id>` is a separate later step
- if the Deacon dies between those steps, parked work can stay stuck forever
- `gt prime` does not currently self-heal by checking parked work on startup
- the parked state exists, but startup recovery does not consume it

That is a very useful architectural lesson:

- the problem is not just "a recovery bug"
- the problem is that a logically single transition is implemented as several
  non-atomic operations across multiple layers

There is a second cost here as well: idle polling tax.

Issue discussions around convoy and deacon wake show that:

- convoy polling can keep checking blocked work with no meaningful progress
- the patrol model can generate repeated empty sessions and subprocess bursts
- contributors are explicitly pushing toward `emit-event` / `await-event`
  because polling overhead is already material in both cost and system load

The quantitative signals are especially revealing:

- `#3597` reports that just `5` blocked convoys were enough to produce about
  `25` `bd` subprocess calls every `30s`, indefinitely, with zero chance of
  progress until upstream work changed
- `#2067` includes real-world idle-cost data from a user setup where
  eventless polling created `131` sessions in `1` hour with zero useful work
  and contributed to about `7.18B` cache-read tokens over `3` days
- `#3117` shows the same pattern on the dashboard side: once convoy fetch gets
  into a bad retry shape, Dolt subprocess churn and CPU usage can become a
  product-level problem rather than a local implementation detail

The repo already has event primitives:

- `molecule_emit_event.go`
- `molecule_await_event.go`
- `channelevents/channelevents.go`

That makes the current convoy/deacon shape even more revealing:

- the product already knows how to model file-based wake events
- but convoy recovery still depends heavily on periodic polling, separate
  subprocesses, and local cooldown state

So the deeper architectural reading is:

- convoy is one of Gastown's coolest ideas
- convoy is also where the system most clearly shows "workflow power outrunning
  substrate simplicity"

Representative issues:

- [#3587](https://github.com/gastownhall/gastown/issues/3587) parked work never
  recovers if Deacon dies between gate close and wake
- [#3597](https://github.com/gastownhall/gastown/issues/3597) convoy polling
  has no backoff for blocked items
- [#2067](https://github.com/gastownhall/gastown/issues/2067) contributors
  propose event-driven deacon wake because fixed polling scales badly
- [#3117](https://github.com/gastownhall/gastown/issues/3117) convoy dashboard
  failure loop can hammer Dolt and CPU when fetches fail hot

Sources:
- `/tmp/gastown-latest/internal/convoy/operations.go`
- `/tmp/gastown-latest/internal/convoy/multi_store.go`
- `/tmp/gastown-latest/internal/deacon/feed_stranded.go`
- `/tmp/gastown-latest/internal/cmd/convoy.go`
- `/tmp/gastown-latest/internal/cmd/prime.go`
- `/tmp/gastown-latest/internal/cmd/molecule_emit_event.go`
- `/tmp/gastown-latest/internal/cmd/molecule_await_event.go`
- `/tmp/gastown-latest/internal/channelevents/channelevents.go`

### 8. Wisps are a powerful idea with a high operational tax

Wisps are conceptually strong:
- ephemeral workflow instances
- cheap patrol and polecat work representation
- ability to avoid persistent row explosion through root-only wisps
- promotion path when ephemeral state proves valuable

That is elegant on paper.

But wisps also introduce a lot of lifecycle complexity:
- root-only vs poured wisps
- hook persistence and `hook_bead` correctness
- cleanup wisps
- swarm wisps
- orphaned molecule detection
- reaper patrols
- promotion/compaction rules

There are enough related issues to call this a fault line, not just a feature:
- orphaned wisps after rollback
- missing `hook_bead`
- stale `hook_bead`
- concurrent hook persistence races
- cleanup dedup races
- reaper assumptions

The project is carrying a lot of logic simply to keep ephemeral workflow state from drifting into orphaned garbage.

Sources:
- `/tmp/gastown-latest/docs/concepts/molecules.md`
- `/tmp/gastown-latest/internal/witness/handlers.go`
- `/tmp/gastown-latest/internal/daemon/wisp_reaper.go`
- [#2641](https://github.com/gastownhall/gastown/issues/2641)
- [#3350](https://github.com/gastownhall/gastown/issues/3350)
- [#2384](https://github.com/gastownhall/gastown/issues/2384)

Two deeper patterns stand out here:

1. **Wisps absorb transition complexity**

When lifecycle edges are not fully atomic, wisps tend to become the place where
half-finished workflow state lands:

- sling rollback can burn the parent relation but leave the wisp open
- cleanup tracking needs separate cleanup wisps
- restart races need create-then-dedup cleanup wisps
- hook migration leaves confusion about which field is authoritative

That makes wisps useful, but also turns them into a catch-basin for incomplete
or compensating workflow state.

2. **Ephemeral state needs a real garbage-collection product**

The daemon has a whole `wisp_reaper` patrol with:

- age windows
- purge windows
- alert thresholds
- plugin receipt cleanup
- mail cleanup
- stale issue closure
- fallback inline execution if dog dispatch fails

That is not "cleanup as polish". It is evidence that ephemeral workflow state
is heavy enough to require its own operational subsystem.

Sources:
- `/tmp/gastown-latest/internal/daemon/wisp_reaper.go`
- `/tmp/gastown-latest/internal/witness/handlers.go`
- [#3350](https://github.com/gastownhall/gastown/issues/3350)
- [#2641](https://github.com/gastownhall/gastown/issues/2641)

### 8.5 The witness is smart, but it is also a compensation engine

The zombie/wisp/polecat recovery path is a good place to be very fair to the
project.

What is genuinely strong:

- the witness does not just kill workers blindly
- there is nuanced zombie classification
- restart-first is smarter than immediate nuke
- cleanup wisps and pending-MR checks are trying to preserve work

What is architecturally expensive:

- the witness must reason across tmux session liveness, heartbeat freshness,
  done-intent age, hook bead state, MR state, cleanup status, cleanup wisps,
  ACP veto, and concurrent patrol races
- dirty-state handling uses create-then-dedup interlocks and deterministic
  winner selection
- many code paths contain explicit TOCTOU guards to avoid stepping on their own
  recovery actions

This is sophisticated engineering.

It is also strong evidence that recovery truth is derived from too many
partially independent signals.

So the witness is not merely a patrol agent. It is effectively a compensation
engine for the worker substrate.

Source:
- `/tmp/gastown-latest/internal/witness/handlers.go`

### 9. The daemon is a centralized recovery brain and a complexity concentrator

This is one of the clearest deeper findings.

The daemon heartbeat is not a small watchdog. It is a giant multi-domain orchestration loop that:
- manages Dolt
- spawns Boot
- checks Deacon
- ensures Witnesses
- ensures Refineries
- ensures Mayor
- handles Dogs
- processes lifecycle requests
- checks GUPP violations
- checks orphaned work
- checks polecat session health
- reaps idle polecats
- cleans orphaned processes
- prunes stale branches
- dispatches queued work
- rotates logs

That makes the daemon extremely important, but also means:
- many failures converge into one orchestrator brain
- invariants from multiple subsystems can interact in surprising ways
- recovery logic becomes harder to reason about compositionally

I would not call this sloppy. The comments are thoughtful. But I would call it a sign that too many responsibilities are still meeting in one place.

Sources:
- `/tmp/gastown-latest/internal/daemon/daemon.go`
- [#2041](https://github.com/gastownhall/gastown/issues/2041)
- [#3587](https://github.com/gastownhall/gastown/issues/3587)
- [#3416](https://github.com/gastownhall/gastown/issues/3416)

The newer code makes this even more obvious than the older issues do.

On top of the core heartbeat, the daemon now also runs separate tickers for:

- Dolt health
- Dolt remotes push
- Dolt backup
- JSONL git backup
- wisp reaper
- doctor dog
- compactor dog
- checkpoint dog
- scheduled maintenance
- main-branch test runner
- quota dog

So the daemon is no longer just "restart dead agents". It is an operational
kernel for storage, recovery, cleanup, maintenance, testing, quota rotation,
and workflow dispatch.

That is powerful. It is also a clear sign that the product's operational center
of gravity is highly concentrated.

### 10. Handoff continuity is still too model-dependent

Issue `#1996` is important because it shows the system can lose continuity if auto-generated handoff summaries are weak or empty.

That means the continuity chain is not deterministic enough yet.

Source:
- [#1996](https://github.com/gastownhall/gastown/issues/1996)

### 11. Crash observability is incomplete in exactly the wrong places

If a worker subprocess crashes and the feed does not emit a durable crash event, the operator model becomes misleading.

Source:
- [#2534](https://github.com/gastownhall/gastown/issues/2534)

This is especially painful in a system that already has rich orchestration concepts. The more advanced the engine, the more dangerous silent failure becomes.

## What The Issue Discussions Reveal

Looking at issue comments matters because titles alone can exaggerate. In
Gastown's case, the comments mostly confirm that the architectural concerns are
real and already visible to contributors.

### 1. The community is explicitly arguing that Beads is carrying the wrong kind of truth

Issue `#764` is the clearest example. The discussion does not just propose small
patches. It proposes:

- a maildir-like storage model instead of one conflict-heavy issue log
- explicit town identity and registry rather than ambient path/session identity
- petition/ratify flows and append-only audit instead of convention-only control

That is very revealing. It means the contributors themselves increasingly see
the problem as structural, not cosmetic.

### 2. People are converging on side-channel delivery because tmux input is not fixable enough

Issue `#1216` is equally telling.

The discussion explicitly says:

- retry-with-backoff only fixes cold-start loss
- input collision and mid-task interruption remain unresolved
- the right move is likely to stop sending full payloads through the tmux input
  buffer and instead persist the payload elsewhere, using only a small trigger

This is exactly the kind of comment that tells you the current transport is at
its limit.

### 3. Contributors are asking for atomic registration and explicit recovery commands

Issue `#2922` is not framed as "add another retry". The comments call for:

- atomic registration only after initialization succeeds
- a dedicated rig-init/repair recovery command
- clearer separation between standalone `bd init` semantics and Gastown's
  server-backed rig model

That strongly supports the argument that init and registration are not currently
based on a solid atomic state machine.

### 4. Windows issue `#3538` is useful because it exposes what is really coupled

The Windows issue is not just a platform complaint. It reveals what the system
is actually built on:

- tmux session semantics
- Unix process groups and shell idioms
- CLI compatibility assumptions
- Beads version tight-coupling
- daemon cleanup relying on Unix-like process behavior

In other words, Windows is a stress-test that reveals how much of the control
plane is still embodied in shell/runtime assumptions rather than portable
worker contracts.

An important nuance after looking deeper:

- this is not only a tmux problem
- it is tmux plus shell commands, process groups, CLI wrapper assumptions,
  ldflags/build expectations, and version coupling with embedded Beads

So Windows is useful analytically because it compresses many hidden couplings
into one impossible environment.

### 5. Even when fixes exist, they often expose missing wiring between layers

Issue `#3031` is a good example.

The immediate bug is a startup-nudge retry interrupting Claude mid-processing.
But the deeper observation from the discussion is that:

- config infrastructure for the relevant delay already existed
- the runtime path was still wired to a hardcoded constant

That is a classic symptom of a system where the conceptual layering is better
than the actual connective tissue between layers.

### 6. Boundary mistakes are recognized by contributors as product-level trust violations

Issue `#885` is not just filed as clutter. It is correctly framed as:

- data loss risk
- external repo pollution
- an orchestrator writing its own internal artifacts into someone else's codebase

That framing is important. It means the community already treats this as a
boundary violation, not just a messy bug.

### 7. Recent commit churn confirms these are active fault lines

After deepening the clone history, the churn since `2026-02-01` is revealing:

- `internal/daemon/daemon.go` - `79` commits
- `internal/doltserver/doltserver.go` - `74`
- `internal/witness/handlers.go` - `47`
- `internal/rig/manager.go` - `41`
- `internal/tmux/tmux.go` - `40`
- `internal/polecat/session_manager.go` - `15`
- `internal/hooks/installer.go` - `8`

This is not inherently bad. A fast-moving project can be healthy.

But when the same files are also:

- the largest hot files
- the most issue-dense areas
- the places with the most compensation logic

then the simplest explanation is that these are active architectural seams
under pressure.

Recent commit subjects reinforce this:

- `fix(rig): make gt rig add atomic`
- `fix: repair PROJECT IDENTITY MISMATCH after crash or rig addition`
- `fix: stop EnsureAllMetadata oscillating when two DBs map to same rig`
- `fix(witness): distinguish bead lookup failure from closed/reaped in zombie detection`
- `fix(polecat): use IsIdle instead of IsAtPrompt in startup nudge verify`
- `fix(tmux): replace timing-based Enter delivery with verification-based retry`
- `feat: Implement Agent Client Protocol (ACP)`

That reads like a project actively stabilizing known fault lines.

It is also worth noticing that these are often high-quality fixes, not random
thrash. Recent PRs show solid local engineering:

- `#3543` moved `SaveRigsConfig` into `AddRig` to reduce partial registration
- `#3518` forced explicit server connections for Dolt DDL instead of relying on
  embedded-mode auto-detection
- `#2586` serialized Dolt boot and synced port files to stop orphan embedded
  servers
- `#2613` removed destructive PID-file behavior from a startup readiness check
- `#3492` auto-checks out a fresh branch when a persistent polecat would
  otherwise start on `main`

This matters for the overall judgment:

- Gastown's maintainers are clearly capable of precise, thoughtful fixes
- but those fixes repeatedly target the same small set of fault lines
- so the system is improving, while still paying interest on the same base
  architectural debts

### 8. The most expensive pain shows up in the richest features

This is maybe the most useful meta-observation from the deeper pass.

Gastown's pain is not concentrated in a trivial todo list or a simple worker
spawn path. It is concentrated in its most ambitious orchestration features:

- convoy tracking across stores
- parked work and gate wake
- persistent polecats with recycled sessions
- cleanup wisps and merge-ready handoff
- zombie recovery with ACP veto and dirty-state tracking
- ephemeral workflow GC

That matters because it means the architecture does not mainly fail at the
edges. It gets expensive exactly where the product is most differentiated.

So the lesson is:

- the ambitious features are worth studying
- but they need a substrate that makes multi-step orchestration transitions
  atomic, queryable, and recoverable without so much compensating machinery

### 9. Recent hook-state churn is a concrete example of architectural wobble

One especially useful lens is the short commit trail around `hook_bead` after
March 2026.

In a small window, the codebase went through:

1. remove agent-bead hook slot writes entirely
2. restore slot writes because startup / hook visibility broke
3. stop trusting the restored slot because it was stale
4. add explicit stale-slot clearing on `done`
5. add daemon-side fallback queries because stale slot state still caused bad
   lifecycle decisions
6. add per-assignee flocking because concurrent hook persistence on the same
   target still raced

That sequence matters because it is not random bug traffic. It shows a system
trying to migrate a core invariant while multiple live subsystems still depend
on the legacy representation.

This is what "architectural wobble" looks like in practice:

- one migration is logically correct
- the surrounding system is not ready for it
- the project temporarily reintroduces old behavior to restore product flow
- then it incrementally peels that behavior back while adding compensators

That does not mean the team is confused.

It means the cost of changing a truth boundary in Gastown is very high because
too many components observe that boundary indirectly.

## The Most Important Good Ideas vs The Most Important Bad Decisions

### Best ideas

1. **Typed mail as a first-class protocol**
   - This is one of Gastown's best decisions. It makes orchestration legible.
2. **Worktree-first worker isolation**
   - Fast, practical, and very well matched to coding agents.
3. **Separate transient scheduler state from work state**
   - The sling-context bead model is genuinely smart.
4. **Persistent identity, ephemeral session, persistent sandbox**
   - This model is strong and gives the system real recovery leverage.
5. **Recovery as part of the product, not an afterthought**
   - Witness/Deacon/Boot are conceptually serious.
6. **Self-awareness about weak seams**
   - `factory-worker-api.md` is one of the best signals in the repo.

### Worst decisions

1. **Using Beads + Dolt + routes + metadata as the runtime substrate for too much operational truth**
   - This is the biggest architectural cost center.
2. **Letting tmux remain part of the control plane instead of strictly an operator surface**
   - This drives too many transport and portability problems.
3. **Allowing identity to be derived from multiple partially-overlapping sources**
   - rig name, prefix, database name, metadata, routes, redirects
4. **Putting repair logic on the critical path often enough that it becomes architectural**
   - useful, but a sign of unstable base invariants
5. **Writing orchestrator artifacts into external repos/worktrees**
   - this is a trust boundary failure
6. **Letting daemon heartbeat become a giant recovery brain**
   - powerful, but too responsibility-dense
7. **Letting truth migrations stay half-live across multiple subsystems**
   - `hook_bead` is the clearest example of a compatibility tax turning into architecture
8. **Letting core runtime primitives change contract across table, type, and state model**
   - the agent-bead story shows how expensive this becomes once lifecycle code depends on it
9. **Letting advanced orchestration transitions span store lookups, subprocesses, local JSON state, and patrol loops**
   - convoy / gate / parked-work continuity is the clearest example of a workflow becoming harder to reason about than the base engine
10. **Letting startup invariants be owned by different layers for different roles**
   - witness/refinery vs polecat agent-bead ownership is the clearest signal that worker lifecycle does not have one authoritative contract owner
11. **Letting health and liveness truth be inferred from too many partially-overlapping signals**
   - tmux, heartbeats, bead state, hook state, activity timestamps, and labels together create a very expensive recovery semantics
12. **Letting registry initialization decide control-plane socket identity**
   - town detection, prefix registry, and tmux server selection are coupled tightly enough that migration and cross-socket edge cases become architectural concerns

## Updated Verdict

After going deeper into the issue discussions and the hottest lifecycle code, my
view is a bit sharper:

- Gastown is **not** mainly a story of careless engineering
- Gastown is a story of **excellent orchestration ideas built on top of several
  overly expensive base primitives**

That distinction matters because it changes how you learn from it.

What to admire:

- its role model
- its mail model
- its worktree model
- its separation between worker identity, session, and sandbox
- its refusal to pretend failures do not happen

What to avoid:

- making transport depend on shared terminal input
- making routing/metadata/store identity the source of truth for runtime
- letting repair tools become normal lifecycle steps
- letting your orchestrator leak its own internals into user repositories
- centralizing too much recovery logic into one giant daemon brain
- letting source-of-truth migrations linger half-complete across daemon,
  witness, startup, and stop-hook code

The deepest pattern is this:

- strong conceptual architecture
- weaker substrate architecture
- strong incident response / hardening culture
- expensive compensation architecture

That combination produces a project that is:

- unusually rich in orchestration ideas
- often impressive in edge-case handling
- but too often forced to repair, dedup, route, re-resolve, or infer state that
  should have had a cleaner authoritative home

Updated summary scores:

- orchestration imagination: **9.4/10**
- runtime substrate quality: **5.6/10**
- recoverability mindset: **7.5/10**
- platform portability: **4.3/10**
- architecture overall: **7.2/10**

## What Is Systemic vs What Is Incidental

### Systemic problems

These come from deep architectural choices:

1. **Beads + Dolt + routes + metadata as runtime substrate**
2. **tmux/prompt injection as transport/control plane**
3. **too many critical identities inferred from path, prefix, or environment**
4. **repair and doctor logic compensating for unstable base invariants**
5. **cross-store orchestration built on prefix-routing complexity**
6. **daemon heartbeat as centralized recovery brain for too many domains**
7. **ephemeral workflow state model that needs significant cleanup and dedup machinery**
8. **unfinished truth-boundary migrations that leave old and new invariants alive at once**
9. **core runtime objects whose storage contract is not stable enough over time**
10. **advanced workflow transitions whose correctness depends on several non-atomic steps across different layers**
11. **worker lifecycle invariants that are not enforced uniformly across role startup paths**
12. **health/recovery semantics that depend on combining multiple inconsistent truth sources**
13. **control-plane identity that depends too heavily on ambient registry/town initialization**
14. **core orchestration paths that still rely heavily on CLI/subprocess calls as an internal RPC boundary**
15. **some patrol and workflow correctness still depends too much on prompt/template compliance instead of hard engine enforcement**
16. **the workflow engine itself branches across too many execution modes and attachment semantics**
17. **too much runtime metadata lives in description parsing and other stringly-typed side channels**
18. **operational memory is spread across too many file-backed shadow-state stores**
19. **critical lifecycle operations like sling, spawn, reuse, and recovery are implemented as compensating sagas across too many different state planes**
20. **worker bootstrap and instruction delivery are spread across too many overlapping channels instead of one authoritative startup contract**
21. **completion is overloaded into a policy-heavy imperative macro instead of a narrow lifecycle primitive**
22. **too much engine behavior is discovery-first and patrol-reconciled instead of being completed by one authoritative owner**
23. **the agent/provider abstraction is not yet sovereign, so role managers, diagnostics, and fallback logic can still collapse back to Claude-first assumptions**
24. **part of the agent-registry/config layer is process-global mutable state, so resolution is ambient and must be serialized instead of being a pure scoped lookup**
25. **runtime-config inheritance is shallower than the schema/comments suggest, so partial overrides can silently erase preset capabilities instead of patching them**
26. **generated settings/hooks do not yet have one authoritative convergence contract, so installer, sync, and doctor logic can disagree and fail to converge**
27. **provider settings are often owned at the role-parent level while execution is owned at the worker/session level, so config scope is coarser than failure scope**
28. **startup, respawn, and handoff semantics are assembled as shell-string choreography across multiple env planes instead of one structured launch contract**
29. **provider/account identity is mediated by config-dir indirection, keychain mutation, env overrides, and transcript relinking instead of one first-class runtime credential contract**
30. **runtime capabilities such as hooks, prompt delivery, readiness, ACP, and session semantics are partly inferred from provider defaults and command matching instead of being fully declared as one explicit capability contract**
31. **the richest runtime capability schema lives in the internal preset registry, while public custom-agent config exposes a poorer RuntimeConfig schema, so extensibility is structurally split**
32. **runtime defaulting semantics are not unified, so omitted values and explicit zero/false values can mean different things depending on which helper path interprets the config**
33. **runtime identity is too lossy, because configured alias, provider, command, preset, and process-match identity are translated through several fallbacks instead of one authoritative runtime identity contract**
34. **role definitions still carry concrete provider-shaped startup commands, so orchestration policy and runtime launch semantics are split across two overlapping config planes**
35. **the new role-config system is richer than the runtime wiring that consumes it, so schema surface and effective control surface are not yet the same thing**
36. **a unified session lifecycle exists, but several of the most complex startup paths still bypass it, so startup correctness is not owned by one authoritative substrate**
37. **the tmux startup/env transport itself is fragmented across command-prepended env, tmux -e flags, post-start SetEnvironment, and global env sanitization, so initial shell state, session metadata, and respawn inheritance do not come from one authoritative mechanism**

These will keep generating new issue shapes until the substrate changes.

### Incidental or more local problems

These are serious, but not the root architecture by themselves:

1. shared settings file corruption under concurrent polecat spawn
2. some CPU polling loops and backoff mistakes
3. specific startup timing thresholds
4. provider-specific permissions defaults
5. version drift between embedded Beads and standalone Beads

These are fixable without changing the entire system model.

## Where the Codebase Shows Maturity

To be fair, Gastown is not careless code. It has real maturity signals:

- large test surface
- strong design docs
- many explicit comments tied to prior bugs
- fallback logic and backoffs in multiple critical paths
- clear efforts to centralize config and role semantics
- unusually deep tests in the hottest subsystems:
  - `internal/daemon` about `289` test functions
  - `internal/doltserver` about `204`
  - `internal/witness` about `157`
  - `internal/tmux` about `137`
  - `internal/polecat` about `118`
  - `internal/mail` about `116`
  - `internal/acp` about `41`

There is a real engineering culture here.

The problem is not that they are unserious.
The problem is that they are serious enough to have pushed the current substrate beyond the comfort zone it can reliably support.

## Honest Verdict

Gastown is a **strong competitor in ideas** and a **mixed competitor in architecture execution**.

### What I would call truly strong

- role-based orchestration model
- explicit mail / handoff protocol
- worktree-first worker model
- scheduler state separation
- serious recovery model
- ambition to support multi-provider and headless futures

### What I would call truly weak

- runtime truth spread across Beads, Dolt, routes, metadata, env, and tmux
- path/prefix/database identity complexity
- control-plane dependence on terminal transport
- repair-driven architecture
- lingering dual-truth migrations in hook and lifecycle state
- unstable long-term contract for agent-bead storage / discovery / state
- fragmented ownership of startup invariants across `AddRig`, role `Start()`, daemon, and doctor flows
- no single authoritative health/liveness model for workers
- registry, prefix, and tmux-socket identity coupled tightly enough to create split-brain and migration-specific control-plane failures
- convoy / gate / parked-work choreography that spans too many layers and cannot be reasoned about as one atomic workflow
- internal control-plane flows that still depend heavily on `gt` / `bd` / `tmux` / `dolt` shell-outs instead of stable in-process boundaries
- patrol and startup semantics that still lean too heavily on textual formula/prompt discipline
- workflow semantics that branch across root-only vs poured, formula vs molecule, and `gt sling` vs `gt formula run` paths
- structured runtime metadata that is still tunneled through description parsing and string conventions
- cooldowns, health counters, feed memory, respawn counts, and other control data scattered across JSON side stores
- lifecycle operations such as sling, spawn, reuse, and rollback that act more like multi-substrate sagas than tight atomic transitions
- startup truth distributed across beacons, hooks, `gt prime`, `PRIME.md`, `CLAUDE.local.md`, nudges, wrappers, and doctor checks
- `gt done` carrying too much policy surface: completion, merge strategy, source-issue closure, recovery checkpoints, repo hygiene, and idle transition all at once
- patrol and polling layers that often finish or reinterpret transitions after the fact instead of just observing a clean authoritative state change
- agent presets and role-agent config that are conceptually strong, but still not authoritative enough to stop role TOMLs, doctor checks, and fallback resolution from reopening Claude-shaped assumptions
- a registry/config layer that still relies on global merged state, path-caching, and mutex serialization where a pure per-scope runtime lookup would be healthier
- a runtime config model where nested blocks often behave like replacement rather than deep inheritance, making custom-agent extension more fragile than the comments imply
- generated runtime settings whose ownership/versioning/convergence semantics are still split across installer, sync, and doctor layers instead of one crisp source of truth
- shared role-level settings files for independently failing workers, which creates a scope inversion between config ownership and execution ownership
- launch and respawn logic that still depends on string-built shell commands plus duplicated env delivery through both process env and tmux session env
- provider/account identity that can diverge between config dir, keychain token, `.claude.json`, `GT_QUOTA_ACCOUNT`, and transcript location, creating a sidecar credential/identity plane
- runtime capability semantics that are partly preset-inherited and command-inferred, so custom agents can gain or lose behavior through normalization and helper logic rather than one crisp declaration
- custom-agent extensibility that is only partial, because some live engine behaviors are representable only in the richer internal preset schema and not in user-facing RuntimeConfig
- runtime type/default semantics that are not precise enough to cleanly distinguish omitted from explicit zero/false across all interpretation paths
- runtime identity that can collapse from configured alias into provider, command, or Claude fallback depending on which layer resolved it, forcing extra compensators like `ResolvedAgent`, `GT_AGENT`, and `GT_PROCESS_NAMES`
- role definitions that still embed concrete `exec claude ...` startup behavior, forcing witness/daemon/runtime code to special-case when role TOML should be ignored in favor of resolved runtime config
- a new role-config subsystem whose schema includes health, nudge, and prompt fields, but whose live runtime consumers still downcast it to a smaller legacy-shaped config while other thresholds remain owned by operational config and constants
- a shared session-start abstraction that exists on paper, while witness/deacon/refinery/crew/polecat still keep bespoke startup flows and therefore continue to pay multi-path lifecycle tax
- a tmux/env transport model where initial-shell env, session-table env, and respawn inheritance are populated through different mechanisms, forcing repeated compensators around `GT_ROLE`, `GT_AGENT`, `GT_PROCESS_NAMES`, `CLAUDE_CONFIG_DIR`, and `CLAUDECODE`
- tendency to write orchestrator artifacts into worktrees or global locations
- oversized daemon responsibility concentration
- expensive lifecycle bookkeeping around ephemeral wisps and cleanup state

### My independent rating

| Area | Score |
|---|---:|
| Multi-agent orchestration ideas | 9.4 |
| Coding-agent workflow imagination | 9.0 |
| Engine substrate correctness | 5.6 |
| Operational predictability | 6.1 |
| Cross-platform architecture | 4.2 |
| Recoverability | 7.4 |
| Overall architecture quality | 7.2 |

If I had to summarize Gastown in one line:

> Gastown is one of the most original multi-agent coding orchestrators out there, but it pays a very high architectural tax for building advanced coordination on top of a substrate that is too fragile and too implicit.

## Deeper Summary in Plain Language

The deeper I look, the more I think this:

- Gastown's **best ideas are real**
- Gastown's **pain is not random**
- the team is **already trying to evolve away from some of its old choices**
- but the current architecture still has a few generator-faults that keep producing bugs:
  - Beads/Dolt identity and routing
  - tmux as transport
  - daemon as central recovery brain
  - wisps as powerful but costly ephemeral state

So my strongest updated judgment is:

> Gastown is a very smart competitor whose architecture is simultaneously impressive and overburdened. Its strengths come from its orchestration model; its weaknesses come from the substrate and the amount of repair logic now required to keep that model standing.
