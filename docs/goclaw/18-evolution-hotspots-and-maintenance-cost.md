# GoClaw Evolution Hotspots and Maintenance Cost

## Why this matters

Architects should not judge a system only by static design.
You also need to ask:

- where does the code churn?
- where do fixes keep landing?
- which seams stay hot over time?

Hot seams are expensive seams.

## High-churn files since 2025-01-01

Top hotspots from `git log --since=2025-01-01 --name-only`:

- `cmd/gateway.go` - `159`
- `internal/agent/loop.go` - `136`
- `cmd/gateway_managed.go` - `75`
- `internal/agent/resolver.go` - `72`
- `internal/agent/loop_history.go` - `67`
- `internal/agent/loop_types.go` - `65`
- `internal/agent/systemprompt.go` - `64`
- `internal/gateway/server.go` - `46`
- `internal/tools/context_keys.go` - `32`
- `internal/store/team_store.go` - `32`
- `internal/tools/team_tasks_tool.go` - `28`
- `internal/tools/team_tasks_mutations.go` - `25`
- `internal/store/context.go` - `25`
- `internal/tools/team_tool_dispatch.go` - `22`
- `internal/agent/loop_context.go` - `21`

## What this says about the architecture

### 1. Gateway and agent loop are the real pressure points

The hottest parts are not just the task store.
They are the places where:

- ingress becomes runtime context
- runtime context becomes agent execution
- agent execution becomes tool access
- tool access becomes orchestration side effects

That aligns with the issue pattern.

### 2. Prompt/system context is part of the architecture, not just UX text

`systemprompt.go`, `loop_history.go`, and related files are hot.
That means orchestration semantics are partly carried by prompt and context assembly.

This increases maintenance cost because prompt plumbing becomes correctness plumbing.

### 3. Identity/context is a live seam, not a solved one

`context_keys.go`, `store/context.go`, and `loop_context.go` being hot confirms that identity propagation is still expensive.

### 4. Teams are important, but not the hottest seam

The team task files are active, but they are not hotter than gateway/loop/resolver.

This reinforces the earlier conclusion:

- core task engine is relatively stronger
- outer shell around it remains more expensive

## Good evolution signals

### 1. Maintainers do real hardening work

The churn is not random.
Many changes are:

- bug-driven
- accompanied by tests
- reflected in docs or changelog notes

That is healthier than silent code churn.

### 2. Hot seams are at least visible

Because the issues, changelog, and commit trail line up, the system is readable as an evolving architecture.

This is useful for competitor analysis.

## Risk signals

### 1. Patch-train around the same seam

The same seam gets multiple sequential fixes:

- sender propagation
- role propagation
- dashboard path propagation
- local key propagation
- provider failure propagation

That means the seam is not sealed by one canonical contract.

### 2. Broad platform surface multiplies hot spots

GoClaw is not just an engine.
It is also:

- web UI
- desktop
- channels
- providers
- hooks
- teams
- cron
- traces

Every unresolved seam now has more paths to travel through.

### 3. Dual-store cost

PostgreSQL and SQLite support is powerful.
It also increases:

- contract-drift risk
- test-matrix complexity
- helper-layer pressure

## What to steal

- hotspot-aware architecture reviews
- issue-driven hardening with visible changelog memory
- explicit attention to evolving seams instead of pretending the model is finished

## What to avoid

- growing product breadth faster than contracts cool down
- letting gateway/prompt/context seams stay chronically hot
- accepting patch-train as the normal way to close correctness gaps

## The distilled lesson

GoClaw is maintained by people who are clearly pushing the product forward.

That is good.

But the history also shows that some of the most expensive seams are still expensive.
A great competitor study should learn not only from what they built, but from where they keep paying maintenance tax.
