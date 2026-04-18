# Cross-Repo And Project Root Boundaries

## What is good

### 1. The project root override is now real

`🎯 9   🛡️ 8   🧠 3`

Current `main` does wire the global `--project <path>` flag into `setProjectRootOverride()` in `src/index.ts`, and `resolveProjectRoot()` in `src/config.ts` respects it.

That is important because it means the project has already moved beyond the earlier "documented but not wired" gap.

### 2. Worktree canonicalization is thoughtful

`🎯 9   🛡️ 8   🧠 4`

`resolveProjectRoot()` explicitly tries to map worktrees back to the canonical repo root so agent state does not silently split per worktree.

That is a good design choice.

### 3. The intended hierarchy is explicit

`🎯 9   🛡️ 8   🧠 4`

`src/commands/orchestrator.ts` is especially revealing.

Its startup contract says:
- orchestrator starts per-repo coordinators
- work should flow through repo-local coordinators
- orchestrator should not behave like one giant implicit coordinator

Architecturally, that is the right direction.

## What is still weak

### 1. Repo-local truth is still the real truth

`🎯 10   🛡️ 9   🧠 5`

Issue `#105` is still the deepest pressure signal here.

Even with `--project`, the underlying model is still:
- repo-local `.overstory/`
- repo-local `mail.db`
- repo-local `sessions.db`
- repo-local merge and event state

That means multi-repo orchestration needs real federation, not just root override.

### 2. Product story outran federation closure

`🎯 9   🛡️ 8   🧠 5`

The system clearly wants to support:
- parent workspace orchestration
- sub-repo leads
- sub-repo dashboards
- cross-repo coordination

But the clean federation contract is still evolving.

The strongest direction in the issue thread is:
- keep mail local per repo
- move cross-repo coordination up to orchestrator <-> coordinator boundaries

That is much better than pretending there is one magical shared root.

### 3. The workaround pattern is too revealing

`🎯 9   🛡️ 8   🧠 4`

The fact that users needed `/dispatch`-style skills and explicit `cd` discipline is itself an architectural signal.

It means the runtime model is not yet self-sealing enough for this use case.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal this:
- explicit root override
- explicit canonicalization of worktrees back to the main repo
- explicit hierarchy between ecosystem orchestrator and repo-local coordinators

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban this:
- magical cross-repo coordination without a first-class federation model

## Architect takeaway

**The right lesson from `overstory` is not "one global state store", but "explicit federation beats implicit shared-root behavior".**
