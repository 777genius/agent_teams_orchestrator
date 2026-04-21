# Command Surface And Control-Plane Breadth

## What is strong

### 1. The control plane is explicit

`🎯 9   🛡️ 8   🧠 4`

`CLAUDE.md` and `src/index.ts` make the surface area visible:
- many commands
- distinct responsibilities
- dedicated flows for coordinator, orchestrator, dashboard, replay, metrics, doctor, watch, merge, group, run

That is better than hiding orchestration behind a handful of magical prompts.

### 2. Separate commands reflect separate subsystems

`🎯 8   🛡️ 8   🧠 4`

The command set mirrors the architecture:
- lifecycle
- coordination
- health
- replay / observability
- cleanup
- merge
- tracker / groups

That is a good sign because it means the system has real operational surfaces.

## What is weak

### 1. The command surface is already a platform

`🎯 10   🛡️ 9   🧠 5`

A very wide command surface means the project is already more than a simple swarm helper.

That is powerful, but it carries cost:
- more entrypoints
- more compatibility burden
- more operator knowledge required
- more hidden coupling between subcommands

### 2. Breadth can outpace contract closure

`🎯 9   🛡️ 8   🧠 5`

When the control plane widens, it becomes easier for:
- lifecycle semantics
- cleanup behavior
- run semantics
- dashboard freshness

to diverge slightly from each other.

## Best practice to steal

`🎯 8   🛡️ 8   🧠 4`

Steal:
- explicit operational command surfaces for real subsystems

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 5`

Ban:
- expanding command breadth faster than the contracts between those commands are stabilized

## Architect takeaway

**`overstory` is already a control-plane product, not just a spawn script. That is a strength, but it also means breadth management is now a core architectural concern.**
