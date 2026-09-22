# OpenHarness Compared with GoClaw and Our Stack

## Short verdict

- `GoClaw` is still stronger as a durable orchestration engine
- our stack is still stronger as a coding cockpit / IDE-like operator surface
- `OpenHarness` is the most interesting new local-first swarm entrant

## OpenHarness vs GoClaw

### Where GoClaw is stronger

- durable task lifecycle
- store-backed orchestration truth
- recovery and review semantics
- scheduler maturity
- autonomous engine behavior

### Where OpenHarness is more interesting

- local-first swarm ergonomics
- explicit worktree isolation
- headless worker separation
- direct focus on local coding-agent execution

### Simplest comparison

- GoClaw = stronger engine
- OpenHarness = fresher local harness ideas

## OpenHarness vs our stack

### Where we are stronger

- IDE-like control surface
- review and operator workflow
- coding cockpit depth
- human-in-the-loop ergonomics

### Where OpenHarness is interesting for us

- worktree isolation pattern
- simple mailbox protocol
- headless worker split
- atomic-write + lock hardening discipline
- early long-session continuity work

### Where we should be careful

OpenHarness can tempt us to over-copy:

- file-based transport
- prompt/env-driven coordinator semantics
- dual models during migration

Those are exactly the parts we should study and then avoid.

## Strategic place in the competitor map

If you force a one-line placement:

- `GoClaw` = strongest mature-ish orchestration core
- our stack = strongest coding cockpit
- `OpenHarness` = strongest young local-first harness to watch

That makes OpenHarness strategically important even though it is less mature than GoClaw.
