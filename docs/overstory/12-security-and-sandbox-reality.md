# Security And Sandbox Reality

## What is good

### 1. Hook-level guard design is thoughtful

`🎯 9   🛡️ 8   🧠 5`

`src/agents/hooks-deployer.ts` is not sloppy glue.

It implements:
- path-boundary guards
- dangerous bash blocking
- native team tool blocking
- capability-sensitive write restrictions
- quality-gate-aware safe prefixes

This is real engineering work, not theater.

### 2. Security is capability-aware

`🎯 8   🛡️ 8   🧠 4`

The project does not treat all agents equally.

Examples:
- read-only roles are explicitly modeled
- coordination roles get narrow `git add` / `git commit` exemptions
- implementation roles get path-boundary write logic

That is the right shape of thinking.

### 3. Sapling points toward stronger enforcement

`🎯 8   🛡️ 8   🧠 5`

`SaplingRuntime` is especially interesting because it pushes toward:
- headless execution
- structured guards
- explicit event streams
- less dependence on interactive shells

That is a better long-term security posture than TUI scraping.

## What is weak

### 1. There is no uniform OS-level sandbox today

`🎯 10   🛡️ 9   🧠 5`

Issue `#3` is the key signal.

Seatbelt was removed because it conflicted with:
- `tmux` socket access
- Bun internals
- temp directory access
- SQLite WAL behavior

So current security depends heavily on hook-level controls rather than a hard process sandbox.

### 2. Boundary enforcement is substrate-sensitive

`🎯 10   🛡️ 8   🧠 4`

Issue `#141` shows how path-boundary security can break on Windows path normalization.

That is a major lesson:
- if your security boundary depends on shell path format conventions
- then the boundary is only as strong as that substrate normalization layer

### 3. Container / socket assumptions leak into runtime trust

`🎯 9   🛡️ 8   🧠 4`

Issue `#142` is not just a `tmux` bug.

It shows that the control plane assumes:
- a certain `/tmp` behavior
- certain socket visibility rules
- certain host/container path semantics

That is operational fragility and security fragility at the same time.

### 4. Security posture is runtime-dependent

`🎯 9   🛡️ 8   🧠 5`

The adapter abstraction is elegant, but the security closure is not uniform:
- some runtimes have strong native sandbox ideas
- some rely on overlays and hooks
- some are still experimental or partially stubbed

If the product presents them as morally similar, the operator gets a false sense of safety.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal this:
- capability-sensitive narrowing
- explicit guard generation
- tool-level defense in depth

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban this:
- pretending hook guards equal a hard sandbox
- letting path formatting quirks decide whether the security model works

## Architect takeaway

**`overstory` has good application-level guard taste, but it does not yet have one uniform hard isolation story.**
