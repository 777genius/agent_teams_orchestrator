# Workspace First Vs DB First

## The core distinction

To understand Cortex properly, you need to see that it is currently much more:

- workspace-first

than:

- DB-first

## Evidence

The run relies heavily on:

- `.cortex/state.json`
- `.cortex/registry.json`
- `.cortex/results/`
- `.cortex/logs/`
- `.cortex/messages/`
- `.cortex/knowledge/`

This is not incidental.
It is the operational center.

## What the DB does well

The DB stores:

- runs
- team runs
- gate decisions
- event logs

This gives Cortex:

- history
- UI support
- querying
- persistence of summaries and metadata

## But what the DB is not yet

It is not yet the single authoritative orchestration engine.

That distinction matters a lot.

Because when the center is workspace-first, you get:

- practical local transparency
- easy file inspection
- easier operator debugging

but also:

- more reconstruction
- more sync paths
- more projection drift
- weaker transactional authority

## Architect lesson

Workspace-first can be a legitimate phase.

It is often a good early move for:

- local-first systems
- operator visibility
- fast iteration

But it should not be confused with the final shape of a durable engine.

## Bottom line

Cortex’s current architecture makes most sense if you read it as:

- a sophisticated workspace-driven orchestration runtime

not:

- a fully DB-centered durable orchestration platform
