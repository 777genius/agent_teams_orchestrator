# GoClaw Summary

## One-line verdict

GoClaw has a strong orchestration engine, but too much correctness on the boundary layers is distributed across context, metadata, event buses, wrappers, and path-specific conventions.

## What is genuinely strong

- Durable task lifecycle with explicit statuses:
  - `pending`, `in_progress`, `completed`, `blocked`, `failed`, `in_review`, `cancelled`, `stale`
- Recovery built into runtime:
  - stale handling
  - orphaned blocked repair
  - followups
  - post-turn compensation
- Scheduler as a real subsystem:
  - lanes
  - per-session queues
  - queue/followup/interrupt semantics
  - adaptive throttling
- Task engine lives in a real store, not in runtime guesswork

## What is weak

- Identity and context propagation
- Execution mode semantics
- Event/UI truth coherence
- Auth and policy boundary discipline
- Provider failure normalization
- Some delivery guarantees around dispatch and eventing

## The simplest mental model

GoClaw is like a factory with:

- a good machine core
- complicated wiring between departments

The machine core is the task engine.
The wiring is:

- actor/scope/sender propagation
- `RunKind`
- event payloads
- task metadata
- UI projections
- policy checks

The center is strong.
The seams are expensive.

## Strongest areas

1. Task lifecycle engine
2. Recovery ticker and stale handling
3. Store-backed orchestration model
4. Scheduler internals
5. Post-turn compensation

## Weakest areas

1. Distributed identity propagation
2. Soft execution modes
3. Split truth between durable state, events, and UI
4. Permission model spread across router, handler, and store
5. Adapter-level failure semantics for providers

## Best short summary

GoClaw is strong where truth stays inside explicit store-backed lifecycle methods.

GoClaw gets weaker the moment truth has to travel through:

- context
- metadata
- ingress wrappers
- buses
- UI projections
