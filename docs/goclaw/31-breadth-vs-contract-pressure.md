# GoClaw Breadth vs Contract Pressure

## Core observation

GoClaw's biggest architectural strength and biggest architectural risk come from the same choice:

- one engine serving many product surfaces

This gives huge leverage.
It also creates enormous contract pressure.

## 1. What "breadth" means here

GoClaw is not only:

- agents
- chat
- teams

It is also:

- HTTP API
- WebSocket gateway
- browser pairing
- dashboard
- cron
- heartbeat
- channels
- providers
- hooks
- skills
- packages/runtime
- multi-tenant config
- trace UI
- desktop/lite variants

Every one of those surfaces asks the core contract to do more work.

## 2. Breadth is not bad by itself

This is important:

product breadth is not a flaw.

Some of GoClaw's strongest decisions depend on breadth:

- task board as shared coordination plane
- multi-tenant engine
- hooks
- broad provider reach
- channel integrations

The real problem starts when breadth outruns contract closure.

## 3. Signs that breadth is pressuring the contract

### Sign A. More metadata hops

When one contract is not strong enough, the system starts adding:

- `origin_*`
- `local_key`
- `peer_kind`
- trace ancestry
- synthetic sender markers

That is breadth pressure showing up as semantic transport.

### Sign B. More compatibility dialects

When many surfaces must keep working, the code accumulates:

- legacy session keys
- fallback routing
- bypass markers
- deprecated config bridges
- permissive defaults

That is breadth pressure showing up as long-lived compatibility seams.

### Sign C. More local projections

When many UIs and transports need state quickly, each surface starts building its own projection:

- board
- chat panel
- task detail
- websocket events
- cache invalidation listeners

That is breadth pressure showing up as split truth.

## 4. A useful architect distinction

Some breadth is supported by first-class contracts.
Some breadth is supported by wrapper glue.

### Breadth supported by strong contracts

- task lifecycle
- hooks
- some tenanting primitives
- some scheduler semantics

### Breadth supported by weaker glue

- execution modes
- identity propagation
- UI truth coherence
- some auth paths
- some provider failure paths

Architect lesson:

- breadth is only healthy when each added surface reuses a strong existing contract

## 5. Product pressure explains many issue classes

Several issue families make more sense through this lens:

- `#312` - onboarding pain because ops surface is now part of the architecture
- `#498` - docs promise wider extensibility than the real runtime delivers
- `#683` - mutation and cache invalidation drift under product surface growth
- `#760` - UI/platform edge mismatch on timezone semantics
- `#877` / `#915` - routing and identity seams strained by many ingress paths
- `#934` - consumer update path and developer build path not cleanly separated

These are not random bugs.
They are pressure symptoms.

## 6. What to steal

- ambition to build one serious engine under several product surfaces
- willingness to make tenanting and hooks first-class
- explicit coordination planes instead of hiding everything inside chats

## 7. What to avoid

- adding new surfaces before the execution contract is closed
- marketing surfaces whose runtime path is not first-class yet
- letting each surface improvise its own truth, mode, or identity transport
- leaving breadth-dependent compatibility glue alive forever

## 8. The top-architect rule

Breadth is good when:

- new surfaces reuse one contract

Breadth becomes dangerous when:

- new surfaces need new exceptions
- new metadata hops
- new bypass rules
- new local projections

That is where GoClaw starts paying real tax.

## The distilled lesson

GoClaw proves that broad product ambition can sit on a strong core.

It also proves that if breadth grows faster than contract discipline, the architecture begins charging interest on every new feature.
