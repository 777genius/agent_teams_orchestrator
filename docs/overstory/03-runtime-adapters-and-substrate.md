# Runtime Adapters And Substrate

## Strongest architectural idea in overstory

The single most interesting design in `overstory` is the `AgentRuntime` interface in `src/runtimes/types.ts`.

This is not cosmetic. It cleanly separates:
- spawn
- readiness
- config deployment
- transcript parsing
- environment routing
- optional headless mode
- optional RPC connection

That is a serious architectural seam.

## What is good here

### 1. Runtime abstraction is real

The registry in `src/runtimes/registry.ts` keeps the engine from importing CLIs directly everywhere.

That makes `overstory` much more future-facing than most swarm tools.

### 2. Sapling is a reference path, not just another adapter

`SaplingRuntime` is the most important runtime file architecturally:
- `headless = true`
- `buildDirectSpawn()`
- `parseEvents()`
- `connect()`

This is the best evidence of their intended future:

**less tmux, more headless / RPC / structured runtime control**

### 3. Codex and Pi are thought through

Even when not fully battle-tested, the design around `Codex` and `Pi` is coherent:
- Codex as OS-sandbox-aware headless/CLI path
- Pi as richer runtime with extension / RPC-friendly direction

### 4. Headless spawn infrastructure is explicit

`src/worktree/process.ts` is simple but good:
- direct spawn
- optional file redirect
- explicit backpressure avoidance

That is quiet engineering taste.

## Where reality is weaker than the story

### 1. Adapter maturity is uneven

Not all adapters are equally real.

`OpenCodeRuntime` still contains explicit stub language:
- instruction path unverified
- `detectReady()` stubbed
- transcript parsing unverified

That matters because issue `#140` is closed while current main still shows a stubbed adapter surface. That is a concrete capability-drift signal.

### 2. Runtime parity is not solved

Some runtimes have:
- hooks
- transcript parsing
- readiness heuristics
- stronger safety controls

Others do not.

So the abstraction is good, but the actual contract is heterogeneous.

### 3. tmux is still too central

The project wants a runtime-agnostic future, but current substrate is still heavily shaped by:
- tmux session lifecycle
- pane capture
- send-keys delivery
- shell init timing
- path/export assumptions

Open issues `#142`, `#141`, `#85`, and older tmux issues show this is not theoretical.

## Architect conclusion

**Take the runtime interface seriously. Do not copy the current substrate dependence.**

That is the correct separation of lessons.
