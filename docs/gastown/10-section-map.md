# Gastown Monolith-to-Module Map

This file maps the old monolithic deep dive
[`../gastown-deep-dive.md`](../gastown-deep-dive.md)
to the smaller files in this folder.

Use it when you need traceability from an old section number to the new split
layout.

## Summary and framing

- `Bottom Line`
- `The Main Takeaway`
- `High-Signal Facts`
- `Updated Verdict`
- `Honest Verdict`
- `Deeper Summary in Plain Language`

Now in:

- [`00-verdict.md`](./00-verdict.md)
- [`README.md`](./README.md)

## Good parts

- `What Gastown Does Very Well`
- `Best ideas`
- `What I would call truly strong`

Now in:

- [`01-strengths.md`](./01-strengths.md)
- [`07-what-to-steal.md`](./07-what-to-steal.md)

## Full structural problem inventory

- `The Biggest Architectural Problems`
- `Systemic problems`
- `What I would call truly weak`

Now in:

- [`02-systemic-fault-lines.md`](./02-systemic-fault-lines.md)

## Substrate and state sections

Grouped into:

- [`03-substrate-and-state.md`](./03-substrate-and-state.md)

Main monolith sections covered there:

- `1. Beads is asked to carry too much operational truth`
- `2. Dolt/routing/metadata identity is a systemic fault line`
- `2.5 The rig init pipeline is still a repair chain`
- `4. Shared mutable runtime files create race conditions`
- `4.7 Agent beads themselves did not have a stable storage contract`
- `4.9 Health and liveness truth is split across competing signals`
- `4.10 Identity, registry, and tmux socket selection are coupled`
- `4.11 The CLI and subprocess boundary behaves like an internal RPC layer`
- `4.15 Operational shadow state is scattered across local JSON files`
- `5. Repair tooling has become part of the architecture`
- `6. Boundary pollution between orchestrator and external repos`

## Startup and runtime contract sections

Grouped into:

- [`04-startup-and-runtime-contracts.md`](./04-startup-and-runtime-contracts.md)

Main monolith sections covered there:

- `4.5 Hooked startup still has an architectural blind spot`
- `4.17 Worker bootstrap and instruction delivery are a distributed contract`
- `4.20 The agent abstraction exists, but it is not sovereign`
- `4.21 The agent-registry layer is process-global mutable state`
- `4.22 RuntimeConfig inheritance is shallower than the contract suggests`
- `4.23 Generated settings do not have one authoritative convergence contract`
- `4.24 Settings ownership is scoped to the role parent`
- `4.25 Startup and respawn semantics are assembled as shell-string choreography`
- `4.26 Provider/account identity is mediated by filesystem and keychain indirection`
- `4.27 Runtime capability semantics are partly inferred`
- `4.28 The runtime capability model is split across two schemas`
- `4.29 Runtime defaulting semantics are inconsistent`
- `4.30 Runtime identity is lossy`
- `4.31 Role definitions are a second runtime-config plane`
- `4.32 The new role-config system is not yet sovereign`
- `4.33 A unified session lifecycle exists, but the most complex roles still bypass it`
- `4.34 The tmux/env transport contract is fragmented`

## Workflow and recovery sections

Grouped into:

- [`05-workflow-and-recovery.md`](./05-workflow-and-recovery.md)

Main monolith sections covered there:

- `4.12 Patrol and workflow integrity still depend too much on prompt/template semantics`
- `4.13 The workflow engine has a real semantic mode-explosion problem`
- `4.14 Too much runtime metadata is tunneled through descriptions and string parsing`
- `4.16 Critical lifecycle operations are compensating sagas`
- `4.18 Completion is encoded as an overloaded imperative macro`
- `4.19 The engine is still fundamentally observer-first`
- `7. Convoy / cross-store orchestration adds another layer of routing pain`
- `7.5 Convoy, gates, and parked work form a second orchestration engine`
- `8. Wisps are a powerful idea with a high operational tax`
- `8.5 The witness is smart, but it is also a compensation engine`
- `9. The daemon is a centralized recovery brain and a complexity concentrator`

## Issues and community-signal sections

Grouped into:

- [`06-issues-and-community-signals.md`](./06-issues-and-community-signals.md)

Main monolith sections covered there:

- `Issue Cluster Map`
- `What The Issue Discussions Reveal`
- the named issue references throughout the deep dive

## Maturity and fairness sections

Grouped into:

- [`09-hotspots-and-maturity.md`](./09-hotspots-and-maturity.md)

Main monolith sections covered there:

- `Architecture Heat Map`
- `Code-Level Compensation Signals`
- `Where the Codebase Shows Maturity`

## Lessons and reuse

Grouped into:

- [`07-what-to-steal.md`](./07-what-to-steal.md)
- [`08-what-not-to-copy.md`](./08-what-not-to-copy.md)
