# Empirical Confidence and Reference Subsystems

This archive is primarily code-and-issue driven, but a targeted empirical pass was also run against `overstory`.

Executed on the current `main` clone at `590e729b332fecc449aa0abdb4ea608e43329fb0`:

```bash
bun test \
  src/watchdog/health.test.ts \
  src/watchdog/daemon.test.ts \
  src/doctor/consistency.test.ts \
  src/commands/doctor.test.ts \
  src/agents/checkpoint.test.ts \
  src/sessions/compat.test.ts \
  src/runtimes/sapling.test.ts
```

Result:
- `253` pass
- `0` fail
- `7` files

## Why this matters

This does not prove the whole architecture is closed.
It does increase confidence in a few specific subsystems that already looked strong in code review.

## Subsystems with stronger empirical backing

### 1. Watchdog / health

`src/watchdog/health.ts` and `src/watchdog/daemon.ts` are not just elegant by inspection.
They are also backed by a strong targeted test surface, including:
- ZFC reconciliation rules
- headless vs tmux lifecycle handling
- escalation levels
- triage behavior
- run completion nudges
- kill blast-radius fixes

This is one of the clearest reference-grade subsystems in the repo.

### 2. Doctor / consistency

`src/doctor/consistency.ts` is also stronger than a typical diagnostic layer.
The test surface exercises:
- orphaned worktrees
- orphaned tmux sessions
- dead pids
- missing worktrees
- missing tmux sessions
- reviewer-coverage checks

This reinforces the verdict that `doctor` is a serious operational subsystem, not cosmetic tooling.

### 3. Session compatibility / migration

`src/sessions/compat.test.ts` gives more confidence that the migration path from `sessions.json` to SQLite was treated carefully.

That is important because migration discipline is one of the quieter strengths of the repo.

### 4. Sapling runtime

`src/runtimes/sapling.test.ts` materially increases confidence in the headless future path:
- spawn command construction
- prompt deployment
- guards config
- env shaping
- transcript parsing
- direct connection JSON-RPC path

This is one reason `SaplingRuntime` stands out as the best "future-facing" adapter in the codebase.

## What this does not prove

⚠️ The empirical pass does not remove the biggest architectural warnings:
- tmux and shell substrate tax
- soft role closure
- cross-repo federation gap
- runtime parity drift across all adapters

It does prove that some subsystems are strong for reasons beyond style.

## Best lesson to steal

Steal:
- targeted high-signal test packs around watchdog, consistency, migration, and runtime adapters
- using empirical checks to validate which subsystems are truly reference-grade

Avoid:
- assuming whole-system maturity from a few strong test clusters
- letting one good adapter create an illusion of uniform adapter maturity
