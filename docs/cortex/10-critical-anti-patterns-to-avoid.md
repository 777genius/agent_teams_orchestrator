# Critical Anti Patterns To Avoid

## 1. File-first orchestration truth for too much of the system

This is Cortex’s biggest architectural risk.

When the operational truth depends on:

- `state.json`
- `registry.json`
- logs
- outbox and inbox files
- findings files

the system becomes more reconstructive than authoritative.

That is acceptable early.
It should not be your final engine model.

## 2. Derived DB instead of primary durable engine

If the DB is mostly:

- run history
- team projections
- event logs

then the system still lacks a calm persisted center.

Do not let projections become the excuse for not building a true state engine.

## 3. Subscriber-written event history

`EventSink` subscribes to PubSub and then persists events.

That is useful, but it means event history is derived, not atomic.

Do not confuse:

- "we persist events"

with:

- "events are our authoritative transactional truth"

## 4. Poll-based bridges for core semantics

Outbox watchers, file inboxes, findings polling, workspace sync:

these are practical tools, but if too much of the engine depends on them, you are paying a hidden consistency tax.

## 5. Breadth outrunning proof

Cortex already has:

- DAG
- mesh
- gossip
- gateway
- sidecar
- Docker
- K8s
- LiveView
- telemetry

That is impressive.
It is also dangerous for a repo this young.

## 6. Story stronger than operational proof

Internal docs and summaries are strong.

That is good.

But if docs start sounding more complete than the runtime evidence, treat that as a red flag during design review.

## 7. Recovery by artifact reconstruction as a permanent strategy

Using logs and workspace artifacts for reconciliation is clever.

But it should stay:

- a healing layer

not become:

- the primary truth model
