# Engine Core

## What the core is

The real orchestration center is not one daemon. It is the combination of:
- `src/commands/sling.ts`
- `src/commands/coordinator.ts`
- `src/mail/store.ts`
- `src/merge/queue.ts`
- `src/sessions/store.ts`
- `src/events/store.ts`
- `src/watchdog/health.ts`

This gives `overstory` a **local durable-enough control plane** for one repository.

## Strong decisions

### 1. Explicit local state stores

Each important concern has a concrete store:
- `mail.db`
- `merge-queue.db`
- `sessions.db`
- `events.db`

That is much better than hiding coordination inside transient chat history.

### 2. WAL-mode SQLite everywhere

`bun:sqlite` + WAL + busy timeout is a very pragmatic choice for a local orchestrator.

This gives:
- simple deployment
- good enough concurrency
- inspectable state
- cheap local durability

### 3. ZFC health principle

`src/watchdog/health.ts` is one of the strongest architectural ideas in the repo:

- observable state beats recorded state
- tmux / pid liveness outranks stale recorded lifecycle
- headless agents are treated differently from tmux agents

That is a real systems-thinking signal.

### 4. Worktree-first execution

Builders do not normally run in the canonical worktree. That is a major risk reduction compared to naive swarm tools.

## Weak decisions

### 1. Engine truth is still too repo-local

The core coordination assumption is effectively:

- one repo
- one `.overstory/`
- one mail root
- one current run

As soon as orchestration crosses repo boundaries, the model starts to stretch.

### 2. Too much engine behavior depends on prompt-contract compliance

The stores are explicit, but many role-to-role guarantees are still social rather than hard:
- reviewer actually doing functional review
- lead actually enforcing review rigor
- coordinator actually refusing premature merge

That is weaker than a true durable policy layer.

### 3. Run truth still leaks through compatibility files

`current-run.txt` still appears as a compatibility anchor across the command surface. This is useful, but it is also a sign that store truth is not the only truth.

## Bottom line

The engine is **real and respectable**, but not as closed and durable as `goclaw`.

It is best described as:

**a strong local orchestration core with repo-bound durability, not a fully sealed orchestration engine.**
