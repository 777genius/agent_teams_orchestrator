# Gastown Substrate and State Planes

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file covers the deepest substrate problems:

- Beads
- Dolt
- routing
- metadata
- agent beads
- health/liveness truth
- registry and tmux socket identity
- CLI as internal RPC
- repair tooling
- shadow-state files

## Main conclusion

Gastown's strongest ideas sit on top of a substrate that is too fragmented.

The real problem is not any single technology.
It is that runtime truth is spread across too many layers:

- Beads rows
- Dolt databases
- routing prefixes
- metadata files
- tmux session reality
- env variables
- description-parsed state
- JSON shadow-state files

## 1. Beads is carrying too much truth

Beads is not just a work ledger in Gastown.
It also ends up carrying parts of:

- worker state
- hook state
- workflow attachment state
- convoy state
- identity state
- lifecycle state

That makes Beads much more than a durable work model.
It becomes part of the runtime substrate.

That is too much pressure for one layer.

## 2. Dolt + routes + metadata form an expensive identity plane

Gastown's control plane repeatedly depends on:

- which DB belongs to which rig
- which prefix maps to which store
- which metadata says a rig is registered
- whether route files and DB prefixes match

This creates split-brain and repair-heavy failure modes.

## 3. Rig init is still repair-heavy

Rig initialization still looks more like:

- initialize
- patch
- re-check
- repair mismatches

than one atomic authoritative registration flow.

That is why issues around partial init, route drift, and identity mismatch keep
reappearing.

## 4. Agent beads were not a stable primitive

Agent beads changed along multiple dimensions:

- where they live
- how they are typed
- where state is written

That made core runtime objects unstable over time.

This mattered because so many subsystems depended on them:

- witness
- daemon
- idle detection
- persistent polecats
- doctor

## 5. Health and liveness truth is fragmented

Gastown does not have one authoritative answer to:

- is an agent alive
- is it idle
- is it stuck
- is it orphaned

Instead it composes answers from:

- tmux session existence
- pane process checks
- tmux activity time
- heartbeat JSON
- bead status
- hook markers
- work assignment
- labels

That creates a large reconciliation burden.

## 6. Registry and tmux socket identity are too coupled

Town identity, rig prefix identity, agent registry loading, and tmux socket
selection are more entangled than they should be.

The code already contains many compensators:

- fallback `rigs.json`
- socket shims
- split-brain cleanup
- legacy socket cleanup

Those are useful, but they are also evidence of a brittle contract.

## 7. CLI/subprocess is acting like internal RPC

Gastown does not just integrate with CLIs.
Large parts of the orchestrator talk to themselves through:

- `gt`
- `bd`
- `tmux`
- `dolt`

as if those were internal control-plane APIs.

This produces:

- non-atomicity tax
- polling tax
- extra process churn
- extra parsing fragility
- env/cwd/path sensitivity

## 8. File-backed shadow state is another plane of truth

Important control data lives in separate files like:

- heartbeat JSON
- health-check state
- feed-stranded state
- redispatch state
- pause files
- respawn counts
- namepool state
- dashboard Dolt state

This is not just caching.
These files participate in actual control-plane decisions.

## 9. Repair tooling is part of the architecture

`gt doctor --fix` is not only a convenience tool.
It is a normal operational recovery path.

That means intermediate broken states are expected often enough that an entire
repair subsystem became part of the design.

## 10. Boundary pollution is real

Gastown has already had cases where recovery or repair logic wrote artifacts
into external worktrees or crossed repo boundaries incorrectly.

That is a product trust problem, not just an internal bug.

## Key issues to remember

- `#764` - Beads as fragile operational substrate
- `#2922` - partial init / non-atomic rig setup
- `#2405` - rogue Dolt server
- `#3222` - metadata ping-pong
- `#3562` - duplicate DBs / invisible beads
- `#3598` - daemon assumes agent beads exist
- `#761` - one town could kill another town's services
- `#3042` - multi-town collision regression
- `#3570` - dual agents on legacy/new sockets
- `#1760` - dashboard created `55+` concurrent `bd` processes
- `#3117` - convoy failure loop hammered Dolt and CPU
- `#3597` - blocked convoys generated repeated `bd` subprocess churn
- `#885` - `doctor --fix` polluted external worktrees

## Retrieval hint

Open this file when the question is:

- "what is wrong with their foundation?"
- "why is their runtime fragile?"
- "why do issues keep recurring around state/recovery?"
