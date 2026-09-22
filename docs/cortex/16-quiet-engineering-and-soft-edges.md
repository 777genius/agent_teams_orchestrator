# Quiet Engineering And Soft Edges

## Why this matters

Some of the most useful lessons in Cortex are not in the headline features.

They are in the smaller engineering decisions that reveal taste and limits.

## Quietly good decisions

### Tool execution isolation

`Cortex.Tool.Executor` runs tools in isolated supervised tasks with:

- timeout
- brutal kill on timeout
- clean error tuples

That is good local engineering taste.

### Shell tool argument separation

`Cortex.Tool.Shell` uses `System.cmd/3` with argument lists rather than shell interpolation.

That is the correct default.

### Command allowlist

The shell tool is allowlist-based and caps output size.

That is much better than "run any shell command and hope for the best".

### ETS pending task registry with caller monitoring

`Provider.External.PendingTasks` is a good example of a small focused subsystem:

- one purpose
- explicit cleanup
- monitored lifecycle

## Soft edges and risks

### Tool shell timeout is partly split across layers

The shell tool itself says `timeout_ms` is advisory and real timeout enforcement belongs to the executor.

That is not terrible, but it is a split contract.

### Tool registry is in-memory and last-write-wins

`Tool.Registry` is simple and practical, but:

- state is in-memory only
- restart loses registrations
- overwrite is silent except for a warning

Good enough for early phase, not strong enough for a richer extension ecosystem.

### Local failure detection uses OS checks

Mesh failure detection calling `kill -0` on os pids is pragmatic.

It is also a reminder that some of the distributed story still rests on local process heuristics.

### Messaging still has two worlds

Cortex has:

- in-process router/mailbox model
- file inbox/outbox bridge for real `claude -p` workers

That duality is understandable.
It is also a sign the runtime contract is not fully unified.

## Architect lesson

Cortex often shows good engineering taste in the small.

The main risk is not sloppy code.
The main risk is that these smaller pragmatic shims stay alive too long and become permanent architecture.
