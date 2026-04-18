# Orchestration Engine And Truth Model

## The good part

The DAG engine itself is clean.

`lib/cortex/orchestration/dag.ex` uses a straightforward Kahn-style topological tiering model:

- explicit dependency graph
- deterministic tier construction
- explicit cycle and unknown-dependency errors

This is boring in a good way.

## The bigger picture

The orchestration API in `lib/cortex/orchestration/runner.ex` and `runner/executor.ex` is also stronger than a toy:

- start run
- continue run
- resume run
- reconcile run
- approve and reject gates

So there is real run lifecycle thinking here.

## The real center of gravity

The main truth still lives in workspace files under `.cortex/`:

- `state.json`
- `registry.json`
- `results/<team>.json`
- raw team logs
- messages directories

`lib/cortex/orchestration/workspace.ex` makes that explicit.

This is the most important Cortex architectural fact.

## Why this matters

The DB is present, but the durable engine does not feel DB-first.

Instead:

- workspace files are the operational truth for the run
- DB tracks runs, team runs, event logs, and gates
- outcomes update workspace and DB as two separate paths

That is weaker than a truly unified persisted engine.

## Concrete signal

`Runner.Outcomes` explicitly separates:

1. workspace state update
2. DB state update

This is workable, but it means there are already multiple truths to keep in sync.

## Verdict on the engine

### What is strong

- config loading and validation
- DAG tiering
- lifecycle surface
- explicit run/gate abstractions

### What is weaker

- authoritative truth model
- atomicity between workspace, DB, and event log
- central invariant enforcement

## Bottom line

Cortex has a more interesting orchestration engine than its traction suggests.

But it does not yet have a platform-grade durable orchestration core in the `goclaw` sense.

It is better described as:

- a strong workspace-driven orchestrator
- with DB-backed projections and history

not:

- a single durable engine with one primary authoritative state machine
