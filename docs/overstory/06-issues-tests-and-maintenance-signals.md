# Issues, Tests, And Maintenance Signals

## High-signal open issues

### `#105` Coordinator cannot manage sub-directory agents from parent root

This is the most important issue architecturally.

It exposes:
- repo-local `mail.db` truth
- weak cross-repo routing closure
- docs / CLI / runtime drift around `--project`

### `#131` Functional review failure

This is the most important issue about role correctness.

It shows:
- reviewer contract is too soft
- lead gate is too weak
- coordinator assumes a quality pipeline that may not actually exist

### `#103` Merge / staging scope ambiguity

This issue reveals the gap between:
- explicit merge resolver logic
- actual agent git behavior
- state-sync timing

It is a boundary-discipline issue, not just a merge bug.

### `#141` Windows path boundary mismatch

This is a pure substrate warning:
- bash hooks
- Windows path format
- POSIX path format
- Git Bash

A strong example of how hook-based control can become OS-format sensitive.

### `#142` Containerized tmux PID retrieval failure

Another substrate warning:
- tmux socket assumptions
- `/tmp` namespace differences
- containerized environments

### `#132` MCP child processes survive session end

This is a real process-lifecycle hole.

### `#95` Aggressive defaults

This is a product-architecture signal:
- `maxConcurrent: 25`
- `shellInitDelayMs: 0`

Both are too optimistic for many real users.

### `#3` Sandbox strategy is unresolved

This matters because it confirms current security is still heavily hook-level for many runtimes.

## Test signals

Good signals:
- `113` test files across `src`/`docs`
- large, substantive subsystem tests
- strong test investment in coordinator, hooks, watchdog, merge, runtime adapters

Hot files by size:
- `src/commands/coordinator.test.ts`
- `src/agents/hooks-deployer.test.ts`
- `src/watchdog/daemon.test.ts`
- `src/merge/resolver.test.ts`
- `src/worktree/tmux.test.ts`

That suggests they test real operational seams, not just tiny pure functions.

## Maintenance signals

Interesting churn since `2026-01-01`:
- heavy changes in `src/index.ts`
- `src/commands/sling.ts`
- `src/commands/coordinator.ts`
- `src/types.ts`
- `src/config.ts`

Unusual signal:
- top churn also includes `.mulch`, `.seeds`, `.beads`, `.overstory` files committed in the repo itself

This suggests they self-host the system heavily and let runtime-state artifacts become part of normal development flow. That is useful and risky.

## Architect conclusion

The project is well exercised, but the issues consistently cluster around:
- substrate assumptions
- cross-root coordination
- role-contract softness
- operational defaults

That pattern is coherent, and therefore trustworthy as an architectural signal.
