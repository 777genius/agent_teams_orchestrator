# OpenHarness Research Freeze And Coverage Map

Date: 2026-04-16
Studied revision: `78160047`
Studied branch: `main`

## Why this file exists

This file is the "research freeze" for the current OpenHarness study.

Its purpose is simple:

- make it obvious what has already been covered
- separate verified findings from softer interpretation
- prevent future duplication or accidental loss of key conclusions

## Coverage map

The current OpenHarness archive already covers:

- repo facts and traction
- runtime and core architecture
- multi-agent coordination
- state persistence and quiet engineering
- security and boundary honesty
- issue tracker and early maturity signals
- best practices to steal
- anti-patterns to avoid
- comparison vs GoClaw and our stack
- scorecard and main verdict
- strongest subsystems
- soft control-plane seams
- compaction and continuity
- provider surface and model contracts
- `ohmo` and autopilot growth pressure
- test history and maturity
- architect-role takeaways
- architect playbook
- compatibility shadows and fallback drift

## What is directly verified

The following findings are directly grounded in code, issue tracker, release notes, or test runs.

### Repo facts

- repo: `HKUDS/OpenHarness`
- created: `2026-04-01`
- studied local revision: `78160047`
- studied branch: `main`
- latest studied release: `v0.1.6`
- release date: `2026-04-10`
- stars at study time: `10008`
- forks at study time: `1703`

### Code-confirmed architectural strengths

- `swarm/worktree.py` is a real strong subsystem
- headless worker execution is real
- `services/compact/__init__.py` is a serious continuity subsystem
- atomic-write and file-lock hardening is present
- `contextvars` are used for in-process teammate isolation
- provider registry and OpenAI-compatible client are real subsystems
- `ohmo` runtime pooling is real

### Code-confirmed architectural weaknesses

- legacy in-memory `TeamRegistry` still coexists with persistent `TeamLifecycleManager`
- coordinator behavior still depends on `CLAUDE_CODE_COORDINATOR_MODE`
- permission sync still supports two protocols
- `BackgroundTaskManager` truth is still primarily in-memory
- Docker sandbox domain policy contents are not enforced in `docker_backend.py`
- personalization extraction still captures `export NAME=value`
- built-in agents still hard-code `model="haiku"` in some paths

### Issue-confirmed failure classes

- `#153` provider portability break in built-in agents
- `#150` Docker sandbox policy honesty gap
- `#149` personalization secret replay risk
- `#137` parallel tool failure integrity bug
- `#129` persistence corruption under crash/concurrency
- `#103` stale restore environment/system-prompt state
- `#97` subprocess/TUI raw-mode mismatch

### Test-confirmed signals

Direct targeted test runs performed in the studied clone:

- `109 passed in 5.75s`
- `9 passed, 9 deselected in 4.18s`

Important nuance:

- some controversial behavior is also normalized by tests
- Docker sandbox tests currently encode the bridge-network behavior
- personalization tests currently encode export extraction behavior

That makes these seams more important, not less.

## What is strong but still interpreted

These are high-confidence architectural interpretations, not just isolated facts:

- OpenHarness is already a serious young local-first swarm harness
- its strongest center is local execution plus continuity, not durable orchestration truth
- it is further along than a typical fresh AI shell
- it is still materially less closed than GoClaw as an orchestration engine

## What remains weaker-confidence

These areas are still worth treating with more caution:

- long-term scaling characteristics of file mailbox and permission sync
- how much `autopilot` becomes a second hidden control plane over time
- whether team/task truth will be unified quickly or stay dual for a long time
- whether provider neutrality in built-ins will close fast or become compatibility baggage

These are not unknown because nothing exists.
They are lower-confidence because the project is still moving quickly.

## The frozen main verdict

OpenHarness should currently be read as:

- a strong young local-first multi-agent harness
- with unusually good worktree and continuity ideas
- with above-average quiet engineering for its age
- but with soft coordinator contracts, dual truths, and policy-honesty gaps that are not yet closed

## The frozen steal list

- worktree isolation
- headless worker split from TUI
- atomic write plus lock discipline
- metadata allowlisting for persisted continuity state
- serious compaction and checkpoint carryover
- `contextvars`-based in-process isolation
- guarded remote admin surfaces

## The frozen ban list

- dual truth between old and new coordination models
- env-flag or prompt-only orchestration contracts
- file transport silently becoming durable control plane
- safety surfaces that overstate runtime enforcement
- built-ins that smuggle provider-specific defaults
- personalization that can replay secrets into later prompts
- compatibility shadows that linger too long

## How to use this freeze

If future OpenHarness research happens, update this file when:

- a current weakness is actually closed
- a current strength turns out to be weaker than expected
- new tests materially change confidence
- a major new subsystem changes the center of gravity

Until then, this file is the canonical "what has already been captured" reference.
