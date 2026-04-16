# OpenHarness ohmo, Autopilot, And Growth Pressure

## Why this seam matters

OpenHarness is no longer only a CLI harness.

It is already growing:

- `ohmo`
- channel bus and gateway
- bridge sessions
- autopilot
- dashboard surfaces
- remote admin

This makes it more interesting.
It also raises the maintenance tax quickly.

## 1. ohmo is a real second product surface

`ohmo/gateway/bridge.py` and `ohmo/gateway/runtime.py` are not toy experiments.

They include:

- session-key routing
- inbound bus consumption
- per-session runtime pooling
- interruption on new inbound messages
- `/stop`
- `/restart`
- progress updates
- restore of prior sessions from workspace storage

That is real architectural ambition.

## 2. Session runtime pooling is a strong idea

`OhmoSessionRuntimePool` keeps one runtime bundle per chat/thread session.

That gives:

- continuity
- reuse
- interruptability
- workspace-bound provider profiles
- saved snapshots

This is one of the most interesting new parts of the project.

## 3. Autopilot already adds a second orchestration layer

`autopilot/service.py` brings:

- intake queues
- scoring
- policies
- worktree-backed execution
- verification and repair loops
- release/merge policy

This is ambitious and interesting.
It is also where hidden control-plane complexity can start growing fast.

## 4. Surface growth is happening faster than contract cooling

Git churn already shows hot areas around:

- README
- CLI
- settings
- UI runtime
- query engine
- ohmo runtime

That is a strong sign that the product surface is expanding rapidly while core contracts are still being hardened.

## 5. Hidden control planes are the main risk here

When you combine:

- prompt assembly
- provider profiles
- gateway config
- autopilot policy
- effort/passes
- compaction thresholds
- permission modes
- restart conventions

you start getting a second control plane made of hints, settings, and side channels.

That is manageable only if the real hard contract underneath stays small and clear.

## Main architect conclusion

`ohmo` and `autopilot` are strategically important because they show where OpenHarness is trying to go.

They also show the main future risk:

- product breadth can outrun contract closure

This makes OpenHarness exciting to watch and dangerous to copy literally.
