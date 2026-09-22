# GoClaw Scheduler and Admission

## Core claim

The scheduler core is good.
The end-to-end admission shell around it is weaker.

## What is good

### 1. Queue core is real engineering

Scheduler internals are better than average:

- lanes
- per-session queues
- interrupt/followup/queue semantics
- bounded queue behavior
- cancellation support
- adaptive throttling

### 2. Tests are decent for the core

Compared with other seams, the scheduler itself has relatively better targeted testing.

## What is weak

### 1. The scheduler is not the whole admission model

Messages still pass through multiple layers before they reach the queue core:

- bus ingress
- optional debounce
- callsite-specific publish behavior
- session shaping
- scheduler queue
- lane capacity

So "scheduler works" does not mean "admission works".

### 2. QoS is implicit

Different callsites use different publish behaviors:

- some block
- some try-publish and may drop

That means message importance is not modeled centrally.
It is encoded indirectly in which helper a developer used.

### 3. Debouncer is a hidden routing seam

The inbound debouncer key is coarser than the full routing model.

That means merges can happen before the system reaches the richer route space.

### 4. Visible concurrency is softer than it looks

The system may advertise one concurrency story on the surface, while adaptive throttling silently reduces actual parallelism under pressure.

### 5. Delivery guarantees are weaker at team side-effects

Some of the more orchestration-sensitive edges still rely on:

- publish after state change
- best-effort bus paths
- stale recovery later

instead of stronger delivery guarantees now.

## Best one-line summary

Strong inner scheduler, weaker outer admission shell.

## Practical lesson

Do not judge a scheduler only by queue primitives.
Judge:

- ingress
- debouncing
- routing
- publish semantics
- retry guarantees
- fairness
- cancellation

as one system.
