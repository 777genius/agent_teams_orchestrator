# Gastown Systemic Fault Lines

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file is the shortest exhaustive list of the structural problems that keep
reappearing in different issue shapes.

These are not one-off bugs.
They are recurring generators of new bugs.

## Full systemic list

1. Beads is asked to carry too much operational truth.
2. Dolt, routes, prefixes, and metadata form an unstable identity substrate.
3. Rig init is still a repair chain, not one clean atomic state machine.
4. tmux is still too central to the control plane.
5. Shared mutable runtime files create race conditions.
6. Hooked startup has a blind spot when the canonical path fails silently.
7. Hook-state migration stayed dual-truth for too long.
8. Agent beads lacked a stable storage contract for too long.
9. Worker lifecycle invariants are not enforced uniformly across role startup paths.
10. Health and liveness truth depends on combining multiple competing signals.
11. Control-plane identity depends too much on ambient town/registry initialization.
12. Core orchestration paths still rely too much on CLI/subprocess calls as internal RPC.
13. Patrol and workflow integrity still depends too much on prompt/template compliance.
14. The workflow engine branches across too many execution modes and attachment semantics.
15. Too much runtime metadata lives in descriptions and string parsing.
16. Operational memory is scattered across file-backed shadow-state stores.
17. Critical lifecycle operations are implemented as compensating sagas.
18. Worker bootstrap and instruction delivery are a distributed contract.
19. Completion is overloaded into a policy-heavy imperative macro.
20. Too much engine behavior is observer-first and patrol-reconciled.
21. The agent/provider abstraction is not yet sovereign and stays Claude-shaped at key seams.
22. The agent-registry layer is process-global mutable state.
23. Runtime config inheritance is shallower than the contract suggests.
24. Generated settings do not have one authoritative convergence contract.
25. Settings ownership is scoped to the role parent while execution is scoped to the worker/session.
26. Startup and respawn semantics are assembled as shell-string choreography across multiple env planes.
27. Provider/account identity is mediated by config-dir, keychain, env, and transcript indirection.
28. Runtime capabilities are partly inferred from provider and command shape.
29. The runtime capability model is split across internal presets and public config.
30. Runtime defaulting semantics are inconsistent.
31. Runtime identity is lossy: alias, provider, command, preset, and process-match identity are not one stable object.
32. Role definitions are a second runtime-config plane.
33. The new role-config system is richer than the runtime wiring that consumes it.
34. A unified session lifecycle exists, but several core roles bypass it.
35. The tmux startup/env transport itself is fragmented.
36. Boundary pollution with external repos still happens.
37. The daemon is a centralized recovery brain and complexity concentrator.

## Highest-priority faults

If you only remember five:

1. Too many truth planes
2. Too much tmux coupling
3. Too much CLI/subprocess orchestration
4. Too much partial migration / dual-truth compatibility
5. Too many startup/runtime contracts that are not authoritative

## How to use this file

Open:

- [`03-substrate-and-state.md`](./03-substrate-and-state.md) for faults `1-12`, `15-16`, `36-37`
- [`04-startup-and-runtime-contracts.md`](./04-startup-and-runtime-contracts.md) for faults `18`, `21-35`
- [`05-workflow-and-recovery.md`](./05-workflow-and-recovery.md) for faults `13-20` and convoy/wisps/daemon costs
