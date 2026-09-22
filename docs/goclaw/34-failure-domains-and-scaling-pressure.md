# GoClaw Failure Domains and Scaling Pressure

## Core observation

GoClaw's strongest scaling idea is:

- one serious engine reused across many surfaces

Its biggest failure-domain risk is:

- too many layers can fail independently before the operator sees one clear truth

## 1. Healthy scaling instincts

### Scheduler is explicit

This is good architecture.

It means:

- concurrency is not hidden in random goroutines
- fairness and backpressure are named concerns
- load behavior has a dedicated home

Architect lesson:

- scaling starts with an explicit concurrency model

### Recovery loops absorb some operational failure

TaskTicker is a good example of healthy failure-domain design:

- stale task recovery
- stale review recovery
- orphaned blocked fix
- followup handling

That is a mature pattern:

- do not assume agents always finish cleanly

### Tenanting is a scaling primitive

Multi-tenant design is one of their stronger long-term scaling moves.
It makes isolation an explicit axis instead of a later patch.

Architect lesson:

- if isolation matters, model it early

## 2. Weak failure-domain seams

### Stop semantics are not fully sealed

Issue `#789` is very telling:

- user stops a run
- background tool exec keeps going
- practical side effects can survive beyond visible run lifetime

This means the system can separate:

- orchestration stop
- process stop
- resource stop

Architect lesson:

- run cancellation is not real until side effects stop too

### Some queues drop rather than degrade gracefully

Both eventbus and message bus have drop behavior under pressure.
That is not automatically wrong.

But it means scaling semantics are partly:

- bounded by capacity
- protected by drop policies
- not always guaranteed end-to-end

Architect lesson:

- bounded queues are good
- but dropped work must be explicitly treated as part of the contract

### Broad ingress multiplies failure surfaces

The same engine is fed by:

- HTTP
- WS
- channels
- cron
- subagent announce
- teammate announce
- dashboard actions

That gives product leverage.
It also means:

- more routing layers
- more identity transport
- more delivery semantics
- more ways for one edge path to diverge

Architect lesson:

- scaling ingress count without one canonical execution envelope creates hidden failure domains

## 3. Operational scaling pressure visible in issues

Useful signals:

- `#506` - team flow can get stuck
- `#677` - scheduler race/flaky behavior under CI race conditions
- `#628` - noisy timeout errors on Telegram path
- `#934` - deployment/update path confusion
- `#312` and `#95` - onboarding and infra prerequisites already feel heavy for new operators

These issues tell an architect something important:

- scaling pressure is not only throughput
- it is also operator complexity and recovery clarity

## 4. Strong practices worth stealing

- explicit scheduler
- explicit recovery worker
- accepting that stuck state is normal and must be repaired
- tenanting as a first-class scaling axis

## 5. Dangerous practices to avoid

- cancellation that stops orchestration truth but not real side effects
- too many independent failure domains between ingress and execution
- broad deployment/update modes that confuse operators
- relying on drop behavior without one authoritative degraded-mode story

## The distilled lesson

GoClaw scales best where:

- concurrency, recovery, and isolation are explicit

It becomes expensive where:

- broad ingress and side-effectful execution create too many partially independent failure domains.
