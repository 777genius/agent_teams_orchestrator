# Gastown Ops, Upgrades, Version Skew, and Observability

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file focuses on one operational truth:

an orchestrator can have strong ideas and still be expensive in real life if it
is hard to install, hard to upgrade, hard to observe, and easy to run in the
wrong binary/config/version combination.

## 1. Upgrade and install are a real architectural concern

Gastown's issue trail shows that install and upgrade are not just docs polish.

They are part of the product's operational architecture.

Key issues:

- `#3416` - upgrade UX still fragile
- `#3077` - source install shadowed by Homebrew
- `#873` - binary name `gt` collides with other tools
- `#3533` - `gt`/`bd` version skew rejects workspaces
- `#20` - fresh install integration test still needed
- `#3626` - install method support messaging drifted across platforms
- `#3502` - build assets pinned a toolchain below dependency minimums

## 2. Strong lesson: version skew must be a first-class design concern

`#3533` is especially important.

It shows:

- `gt 1.0.0` embeds old beads `0.63.3`
- standalone `bd 1.0.0` stamps newer metadata
- daemon then rejects the workspace

This is a classic orchestrator lesson:

- if multiple binaries touch the same durable state, version compatibility must
  be designed explicitly

Architect rating: `🎯 9.8   🛡️ 9.4   🧠 6`

## 3. Strong lesson: active binary identity must be observable

`#3077` and `#3416` show a practical but deep problem:

- users can believe they upgraded
- but still run a stale binary through PATH shadowing

This is not cosmetic.

If the active binary is ambiguous, then:

- bug reports become confusing
- repair logic becomes misleading
- compatibility reasoning breaks

Architect rating: `🎯 9.6   🛡️ 9.1   🧠 4`

## 4. Strong lesson: install channels must have one authoritative story

`#3416` shows channel drift:

- GitHub release
- Homebrew stable
- npm package
- source install

If they disagree on what "latest" means, the product develops release ambiguity.

Architect rating: `🎯 9.3   🛡️ 8.9   🧠 4`

## 5. Bad practice to avoid: binary shadowing as an acceptable norm

Gastown shows how dangerous this is:

- old binary can remain active
- doctor may not warn loudly enough
- user thinks they are testing new behavior but they are not

Bad pattern:

- "the shell will probably resolve the right one"

Correct pattern:

- explicit active-binary detection
- explicit shadowing warnings
- authoritative upgrade path

## 5.1. Install methods need an exact platform support matrix

Issue `#3626` shows a quieter but important operational failure:

- Linux users hit a macOS-specific warning path
- the product looked unsupported or confused before first use

This teaches:

- every install/build method needs an exact platform support story
- runtime guards should explain the specific unsupported combination, not route
  unrelated platform messaging through a generic failure path

Architect rating: `🎯 9.0   🛡️ 8.8   🧠 3`

## 5.2. Build assets must move with dependency toolchain minimums

Issue `#3502` shows another boring but real architecture lesson:

- a Dockerfile pinned a Go version lower than what the dependency graph now
  required
- contributor and operator environments became unbuildable even though the
  source itself was otherwise valid

This teaches:

- Dockerfiles, bootstrap images, and local build recipes are part of the
  product's executable contract
- toolchain minimums need one maintained source of truth

Architect rating: `🎯 8.9   🛡️ 8.7   🧠 3`

## 5.3. Hidden prerequisites and naming rules should fail at first run, not later

Issue `#3516` exposes a quieter but important operational rule:

- rig naming constraints were undocumented
- `dolt` was effectively required before the quickstart would really work

This teaches:

- the first-run path should validate required binaries and naming rules before
  deeper workflow setup begins
- operator trust drops quickly when setup succeeds just far enough to fail
  cryptically

Architect rating: `🎯 8.8   🛡️ 8.7   🧠 2`

## 5.4. Release notes and package names are part of the install contract

Issue `#3651` adds a blunt but important lesson:

- a release page pointed users at the wrong npm package name

This teaches:

- official release text must be tested with the same seriousness as the binary
- if the announced install command is wrong, the product fails before any
  runtime quality can matter

Architect rating: `🎯 8.8   🛡️ 8.7   🧠 2`

## 5.5. Upgrade migrations must clean up legacy transport resources automatically

Issue `#3570` shows a classic upgrade hazard:

- a new tmux socket naming strategy left the old socket's sessions alive
- daemon restart then created duplicate control-plane agents on the new socket

This teaches:

- upgrade code must explicitly reap or migrate legacy transport namespaces
- compatibility cleanup cannot live only behind a manual `down` path

Architect rating: `🎯 9.5   🛡️ 9.2   🧠 5`

## 6. Observability thinking is stronger than shipped observability

Gastown does think seriously about observability:

- OTel architecture docs exist
- issue `#1141` shows runtime observability is understood as a first-class need
- agent work context attribution gaps are explicitly documented

This is good strategic awareness.

Architect rating: `🎯 8.9   🛡️ 8.4   🧠 6`

## 7. But current observability still has important blind spots

From `otel-architecture.md`, notable gaps remain:

- generic polecat work context attribution
- agent instantiation anchoring
- molecule lifecycle visibility
- bead creation tracing
- Dolt server health exposure
- scheduler dispatch visibility
- witness and deacon internal health loops

That means the team understands the need, but the observability substrate is not
fully there yet.

Architect rating: `🎯 9.1   🛡️ 8.8   🧠 6`

## 8. Large-repo economics are part of architecture, not optimization garnish

Issues `#1059` and `#1790` highlight a very practical but deep lesson:

- clone topology
- bare-repo reuse
- mayor clone strategy
- partial clone shape
- sparse materialization policy

all directly affect whether the orchestrator is viable on very large repos.

This is not just a speed concern.

It affects:

- onboarding cost
- disk footprint
- worker startup time
- whether parallel workers are even affordable

Architect rating: `🎯 9.4   🛡️ 9.0   🧠 5`

## 9. Communication-backend failure is also an observability and control problem

Issue `#3623` adds one more critical lesson:

- the outage did not only slow queries
- it also blinded coordination paths like mail and bead closure
- that changed agent behavior quality, not just dashboard latency

This matters because:

- shared-state failure can silently become decision-quality failure
- an orchestrator needs visibility not only into backend health, but also into
  whether workers are still safely coordinated

Architect rating: `🎯 9.5   🛡️ 9.2   🧠 5`

Issue `#3375` adds a closely related telemetry lesson:

- storing only USD throws away the raw token counts needed by flat-rate users,
  quota analysis, and later cost-aware scheduling

Issue `#3589` adds an observability-budget lesson:

- dashboard latency budgets are part of the product contract
- if inbox or status paths have unrealistic timeout assumptions, the UI reports
  false failures even when the backend is only slower than expected

Issue `#3396` adds a sharper observability-economics lesson:

- a dashboard can become the hottest workload in the system if it polls through
  subprocess fans and fresh backend connections

This means:

- status channels must be cheaper than the workload they observe
- change detection should prefer pooled, incremental, or file-backed signals
  over repeated full-fanout queries

Issue `#3573` adds a daemon-lifecycle lesson:

- long-lived backend logs need explicit rotation and retention policy
- if the process keeps the file descriptor open, safe rotation is part of the
  runtime contract

Issue `#3572` adds a cleanup lesson:

- orphaned backend processes are not just wasted RAM
- cleanup must prove non-ownership before killing a stateful service

## 10. Best practices to take from this angle

- treat install/upgrade as part of system architecture
- version compatibility across binaries must be explicit
- active binary identity should be observable and verifiable
- release channels need one authoritative contract
- install/build methods need an explicit supported-platform matrix
- observability should include work attribution, not only raw process events
- preserve raw usage telemetry such as token counts alongside normalized cost views
- budget dashboard and API status paths against measured backend latency
- internal watchdog state should be externally visible enough for debugging
- treat clone strategy, materialization policy, and large-repo mode as first-class design
- optimize object reuse before adding more worker parallelism
- expose coordination-backend health as a control-plane signal, not only an
  infra metric
- version build assets and bootstrap images with real dependency toolchain floors
- validate hidden prerequisites and naming constraints during first run
- test official release/install text against the real package identity
- clean up legacy transport namespaces during upgrade, not only during shutdown
- make dashboards and status APIs cheaper than the systems they observe
- give long-lived backend logs an explicit retention and rotation policy
- require ownership-aware cleanup before reaping orphan infrastructure processes

## 11. Bad practices to avoid from this angle

- shared state touched by multiple binaries without strict compatibility rules
- ambiguous PATH-based binary selection
- multiple release channels with unclear authority
- "doctor says green" while the active binary or version context is still wrong
- support messages that do not identify the exact broken platform/method combination
- observability that can see mechanics but not work context
- discarding raw telemetry once one derived cost number has been computed
- using tight dashboard timeouts that are lower than normal backend latency
- full-clone assumptions baked so deeply that enterprise-scale repos become impractical
- treating repository economics as a later perf pass instead of a worker-model concern
- treating backend outage as mere performance degradation when it actually
  changes autonomous behavior quality
- letting Dockerfiles or build images drift below the dependency toolchain floor

## Final takeaway

Gastown teaches an important lesson many orchestration projects miss:

the system is not just the runtime.

It is also:

- the upgrade path
- the binary identity story
- the compatibility contract
- the observability and debugging surface

Ignoring those makes a smart orchestrator feel unreliable in practice.
