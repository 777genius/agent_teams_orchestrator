# Gastown Concurrency and Integrity Lessons

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file isolates one of the most valuable architect-level lessons from
Gastown:

- some local subsystems already use mature integrity patterns
- but several global seams still violate those same patterns

That contrast is extremely useful.

## Why this angle matters

Gastown's problems are not only "conceptual complexity" or "tool coupling".

A big part of the real operational pain comes from concurrency and integrity:

- concurrent startup
- concurrent config writes
- torn reads
- restart gaps
- stale-lock handling
- read paths that still create write-side pressure

These are architecture concerns, not implementation trivia.

## 1. Where Gastown is locally doing the right thing

### A. Atomic writes in some stateful subsystems

There are places where Gastown already uses the right pattern:

- `dog` state save uses atomic write via `util.AtomicWriteJSON`
- scheduler capacity state uses `temp + rename`

Why this is good:

- readers never see zero-byte or truncated files
- concurrent save paths are less likely to corrupt runtime state
- it makes state files tolerable as persistence artifacts

Relevant code:

- `/tmp/gastown-latest/internal/dog/manager.go`
- `/tmp/gastown-latest/internal/scheduler/capacity/state.go`

Lesson to steal:

- any shared JSON or state file should default to `temp -> fsync/close -> rename`
- atomic write should be the boring default, not the special case

Signal rating: `🎯 9.8   🛡️ 9.3   🧠 3`

### B. Per-entity locks in some managers

`crew` uses per-worker file locks for `Add`, `Remove`, `Rename`, `Start`.

Relevant code:

- `/tmp/gastown-latest/internal/crew/manager.go`

Why this is good:

- ownership is scoped to the execution unit
- concurrent mutations on the same worker are serialized
- lock scope matches the thing being mutated

Lesson to steal:

- lock at the unit of ownership
- do not use one coarse global lock if the true contention unit is per worker

Signal rating: `🎯 9.5   🛡️ 9.0   🧠 4`

### C. Fail-closed thinking is present in some integrity-sensitive edges

Gastown has good instincts around fail-closed behavior in several places:

- proxy pkt-line parsing tests reject truncated input
- hook integrity violations are explicitly being pushed toward hard-stop behavior

Relevant evidence:

- `/tmp/gastown-latest/internal/proxy/git_test.go`
- issue `#2026`

Lesson to steal:

- corrupted execution metadata should stop orchestration deterministically
- integrity errors should not quietly degrade into "best effort"

Signal rating: `🎯 9.7   🛡️ 9.2   🧠 5`

## 2. Where Gastown still pays a heavy concurrency/integrity tax

### A. Shared settings file across concurrent polecats

Issue:

- `#3500`

What happened:

- multiple polecats in one rig shared the same `polecats/.claude/settings.json`
- each startup path used `os.WriteFile`
- `O_TRUNC` + concurrent writes produced corrupted JSON
- several polecats died during startup

Why this is architecturally bad:

- config ownership scope is wider than execution scope
- worker startup depends on a shared mutable file
- integrity depends on timing, not contract

Architectural lesson:

- if workers start independently, their mutable startup config must not live in
  one shared role-scoped file

Risk rating: `🎯 10   🛡️ 9.7   🧠 5`

### B. Non-atomic writes to central registry/config files

Issue:

- `#3464`

What happened:

- `SaveRigsConfig` used `os.WriteFile`
- concurrent readers could observe zero-byte or truncated `rigs.json`
- daemon behavior could see parse errors or empty rig lists

Why this matters:

- central registry/config is authority material
- torn reads at that layer become system-wide confusion

Architectural lesson:

- all authoritative config/state writes must be atomic
- never treat truncating direct write as acceptable for shared authority files

Risk rating: `🎯 9.9   🛡️ 9.6   🧠 3`

### C. Startup lock semantics are weaker than startup reality

Issue:

- `#3195`

What happened:

- Dolt startup lock waited only ~3s before assuming staleness
- real startup could take far longer
- waiting processes removed the lock and spawned their own competing servers
- result: thundering herd, port fights, DB lock fights, no healthy server

Why this matters:

- "stale after fixed timeout" is unsafe when actual startup time varies with
  workload
- health-based ownership is stronger than timeout-based guessing

Architectural lesson:

- never remove a lock just because a short timer expired
- verify whether the guarded service actually succeeded or is still starting
- lock waiting must be sized by real startup physics, not optimism

Risk rating: `🎯 10   🛡️ 9.6   🧠 6`

### D. Restart is not atomic against auto-spawn behavior

Issue:

- `#2690`

What happened:

- `gt dolt restart` stopped the canonical server
- before the new one came up, other processes auto-spawned rogue Dolt servers
- rogues could grab the port in the restart gap

Why this matters:

- restart is really a distributed coordination event
- if other actors can observe the gap and spawn alternatives, restart is not a
  narrow operation anymore

Architectural lesson:

- restart windows need explicit quiesce or reservation semantics
- shared infrastructure services must have one clear owner during restart

Risk rating: `🎯 9.8   🛡️ 9.4   🧠 6`

### E. Read-only polling still causes write-side pressure

Issues:

- `#3596`
- `#2618`

What happened:

- daemon and dashboard paths spawned large numbers of `bd` subprocesses
- even read-only checks could trigger expensive commit/connect behavior
- idle towns still paid heavy connection churn and CPU tax

Why this matters:

- read paths should stay cheap and side-effect-light
- if reads behave like writes operationally, observability and patrol loops
  become dangerous under scale

Architectural lesson:

- classify read vs write paths strictly
- keep auto-commit or mutation semantics off read-only monitoring paths
- polling systems must be designed as cost-sensitive infrastructure, not just
  convenient loops

Risk rating: `🎯 9.7   🛡️ 9.2   🧠 5`

## 3. Deep architect takeaway

Gastown shows both sides of the lesson:

- locally mature patterns exist
- globally, they are not applied consistently enough

That means the right lesson is not:

- "Gastown doesn't understand integrity"

The right lesson is:

- "Gastown understands it, but the project shape lets too many older or broader
  seams escape those rules"

## 4. Best practices worth stealing

- atomic write by default for authoritative JSON/state files
- per-entity locks where ownership is truly per worker or per unit
- fail-closed integrity checks on hook/worktree/control metadata
- startup health checks before declaring locks stale
- explicit read/write classification for background infrastructure calls
- restart as a coordinated state transition, not stop-then-start folklore

## 5. Critical bad practices to ban

- shared mutable startup config across concurrently starting workers
- direct truncating writes to authority files
- fixed short stale-lock deadlines for variable-length startup
- restart gaps that other subsystems can race into
- read-side observability loops that secretly produce write-side churn
- allowing corrupted integrity state to degrade into best-effort continuation

## Final takeaway

Gastown is useful here because it shows something subtle:

the team already knows many correct integrity patterns.

But the system still pays real pain wherever:

- ownership scope is too wide
- authority files are not written atomically
- startup/restart is not truly serialized
- monitoring paths are not operationally cheap

That is exactly the kind of lesson worth carrying into a new orchestrator.
