# OTP Runtime And Supervision

## What is genuinely strong

`lib/cortex/application.ex` is one of the best parts of Cortex.

The supervision tree is not pretending:

- PubSub
- registries for agents, runners, and mailboxes
- DynamicSupervisor for agents
- Task supervisor for tools
- messaging router and supervisor
- workspace lock
- gateway supervisor
- external supervisor
- orchestration task supervisor
- repo and event sink
- telemetry and Prometheus
- Phoenix endpoint

This gives Cortex real runtime texture. It does not feel like a CLI wrapper that later learned the word orchestration.

## Why this matters

Many competitors build agent orchestration as:

- one loop
- some subprocesses
- a board on top

Cortex instead starts from:

- processes
- registries
- supervision
- explicit subsystems

That is a better instinct if the product goal is real concurrent orchestration.

## Strong decisions

- `Cortex.Agent.Server` as a real GenServer, not a bag of helpers
- separate registries for different runtime roles
- explicit `Gateway.Supervisor` and `ExternalSupervisor`
- clear isolation between provider layer and spawn backend layer
- process model first, UI second

## Limits

Strong OTP taste does not automatically make the overall engine durable.

What Cortex has:

- solid process architecture
- good subsystem separation

What Cortex still lacks:

- a similarly strong durable state model at the center

So the runtime shell is stronger than the persistence core.

## Bottom line

Architecturally, Cortex is one of the more serious competitors because it thinks in OTP processes and supervisors, not only in commands and scripts.

But its runtime discipline currently outpaces its truth-model discipline.
