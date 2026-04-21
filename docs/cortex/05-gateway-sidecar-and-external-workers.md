# Gateway Sidecar And External Workers

## Why this subsystem matters

The external worker path is one of Cortex’s most interesting positive signals.

There is a real architecture here:

- gateway registry
- protocol validation
- gRPC server
- pending task tracking
- sidecar and agent-worker
- external provider that dispatches through the gateway

This is much more than "later we will add remote execution".

## Strong decisions

### Protocol boundary

`Cortex.Gateway.Protocol` is a clean pure layer:

- parse JSON
- validate message type and version
- return typed structs

That is good contract discipline.

### Registry

`Gateway.Registry` tracks:

- connected agents
- transport type
- capabilities
- heartbeat and load
- lookup by capability and push pid

That is a serious control-plane instinct.

### PendingTasks

`Provider.External.PendingTasks` uses ETS for blocked waiters.

Good traits:

- simple and focused
- caller monitoring
- cleanup on caller death
- avoids pushing every result through the registry GenServer

This is good local engineering taste.

## Main weakness

The external provider is still a fairly simple blocking request/response pattern:

- register pending task
- push task request
- wait on receive
- timeout if nothing returns

That is fine for an MVP, but it is not yet a rich distributed execution contract.

Examples of what is missing relative to a stronger platform engine:

- durable task handoff state
- richer retry semantics
- reconnect-aware in-flight recovery
- stronger store-backed continuation of remote work

## Sidecar reality

The Go `agent-worker` is practical and useful:

- polls the sidecar
- runs `claude -p`
- streams NDJSON
- posts results back

That makes the external path real.

But it is still basically:

- worker loop
- CLI execution
- sidecar HTTP/gRPC bridge

not:

- a deep autonomous runtime with durable work queues and recovery semantics

## Bottom line

This subsystem is more real than the repo’s small public footprint suggests.

It is worth stealing as:

- gateway pattern
- typed protocol boundary
- ETS-backed pending result routing

It should not be mistaken for:

- a fully mature distributed worker engine
