# Evolution Hotspots And Lessons

## Pressure signals

Current public issue count sampled during this research:
- `86` total issues
- `15` open
- `71` closed

Open-label pressure is concentrated around:
- `area:runtimes`
- `area:infrastructure`
- `area:initialization`
- `area:agent-lifecycle`
- `area:coordination`

That already tells you where the real cost lives.

## Hot files since 2026-01-01

Most frequently changed tracked files in the main architectural surface:
- `src/index.ts`
- `src/commands/sling.ts`
- `README.md`
- `src/types.ts`
- `src/commands/coordinator.ts`
- `CLAUDE.md`
- `src/config.ts`
- `src/commands/dashboard.ts`
- `src/agents/overlay.ts`
- `src/worktree/tmux.ts`
- `src/watchdog/daemon.ts`
- `src/merge/resolver.ts`
- `src/runtimes/registry.ts`
- `src/runtimes/sapling.ts`

## What this means

### 1. Entry and substrate are where the real heat is

`🎯 10   🛡️ 9   🧠 4`

The hottest zones are not just "business logic".

They are:
- entrypoint / routing
- spawn and lifecycle
- substrate management
- runtime selection
- docs and contracts

That is exactly what you would expect from a system whose value lives in orchestration seams.

### 2. The project tests its hardest seams heavily

`🎯 9   🛡️ 9   🧠 3`

Large test surfaces exist around:
- `coordinator`
- `hooks-deployer`
- `watchdog`
- `merge/resolver`
- `tmux`

This is a good sign.

It means the maintainers know where the danger really is.

### 3. Documentation churn is part of architectural work

`🎯 8   🛡️ 8   🧠 2`

High churn in `README.md` and `CLAUDE.md` is not accidental.

In this repo, docs are part of the control plane.

That is both a strength and a warning:
- strength because the model is being clarified
- warning because docs are needed to keep the system legible

## Best practice to steal

`🎯 9   🛡️ 9   🧠 3`

Steal this:
- put tests and design attention on the hot seams, not only on pretty inner abstractions

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban this:
- letting the hottest seams accumulate silent drift while only the stable inner abstractions get care

## Architect takeaway

**`overstory` teaches that the real maintenance burden in an orchestration system lives at the seams: spawn, lifecycle, routing, substrate, and docs.**
