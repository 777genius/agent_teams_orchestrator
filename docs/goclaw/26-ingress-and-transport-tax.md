# GoClaw Ingress and Transport Tax

## Core observation

One of GoClaw's biggest architectural strengths is also one of its biggest costs:

- one engine
- many ingress paths

This is product-powerful.
It is also where many boundary bugs are born.

## The ingress set

GoClaw accepts work through many routes:

- HTTP REST
- WebSocket RPC
- browser pairing
- Telegram / Discord / Slack / WhatsApp / Feishu and others
- cron
- subagent announce
- teammate dispatch
- dashboard-triggered actions

Every new ingress path must answer the same questions:

- who is the actor?
- what is the scope?
- what is the sender?
- what is the tenant?
- what session does this belong to?
- what run mode is this?
- what side effects are allowed?

If those answers are not packaged once, each ingress path must reconstruct them.

That is transport tax.

## Where GoClaw handles this well

### 1. Shared orchestration center

Despite many transports, the system usually tries to converge on one core:

- agent loop
- scheduler
- task store
- tracing

This is the right strategic instinct.

### 2. Tenant injection as common concept

Tenant scoping exists across:

- HTTP
- WS
- channel instances
- background workers

That shared concept is useful even where enforcement is uneven.

## Where the tax becomes expensive

### 1. Different auth and role paths

HTTP, WS, browser pairing, channels, and owner-system paths do not all enter with the same semantics.

That increases drift risk.

### 2. Different run envelopes

Subagent, teammate, notification, delegate, and channel ingress do not all carry the same runtime envelope.

That is where mode and identity bugs multiply.

### 3. Different truth reconstruction layers

The backend may be right, but event and UI projections depend on which transport/event path delivered the state.

### 4. Different session semantics

Session keys, routing metadata, local keys, and origin session values create additional path dependence.

## Practical competitor lesson

Every new ingress path should be assumed to multiply:

- identity bugs
- permission bugs
- routing bugs
- observability drift
- UI truth drift

unless one canonical execution envelope sits below all transports.

## Healthy way to do multi-ingress architecture

The right pattern is:

1. ingress-specific parsing
2. canonical execution envelope
3. engine/runtime
4. canonical events or projections

GoClaw often gets:

1. ingress-specific parsing
2. partial metadata + context + wrapper reconstruction
3. engine/runtime
4. multiple event/projection paths

That is why the core stays strong while the shell gets expensive.

## What to steal

- one engine serving many transports
- channel instances carrying tenant ownership
- shared scheduler/core under different entry points

## What to avoid

- adding a new transport without extending one canonical execution envelope
- letting transport-specific metadata become part of business meaning
- transport-specific fixes that do not close the underlying contract

## The distilled lesson

GoClaw shows that multi-ingress architecture is valuable, but only if transport diversity is absorbed into one strict runtime contract.

Otherwise every new entry point becomes another correctness tax surface.
