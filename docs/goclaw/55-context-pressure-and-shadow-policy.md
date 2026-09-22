# GoClaw Context Pressure and Shadow Policy

## Why this matters

Context pressure is one of the places where an orchestrator either behaves like a real system or like a bag of heuristics.

The hard question is:

- when the prompt is getting too large, what actually happens?

GoClaw is useful here because it has a fairly serious answer:

- explicit pruning stage
- explicit thresholds
- explicit memory flush
- explicit compaction
- explicit abort if still over budget

That is better than most competitors.

But it also shows how quickly a good pressure-control subsystem can turn into a soft shadow policy layer if too many thresholds, buffers, and exceptions accumulate.

## What they get right

### 1. Context pressure is a first-class pipeline stage

This is one of the best decisions in the subsystem.

They do not treat compaction as:

- random helper logic
- a best-effort post-hook
- a provider-specific accident

Instead, pruning is an explicit pipeline stage with a defined result model.

That is worth stealing.

### 2. The pressure response is staged, not binary

They do not jump directly from "normal" to "summarize everything".

The flow is more mature:

- soft-trim long tool results first
- hard-clear them later if necessary
- run memory flush before compaction
- compact if still over budget
- abort the run if still over budget after compaction

That is good systems thinking.

### 3. Media results get special treatment

This is subtle but smart.

They explicitly give media tool outputs a larger trim budget because those outputs are expensive and not trivially reproducible.

That is a strong example of:

- not all context is equal

This is worth remembering.

### 4. Memory flush is treated as a real pre-compaction phase

This is one of the better quiet ideas in the system.

Before compaction, they give the agent a bounded chance to persist durable memories to disk.

That is much better than:

- truncating history and hoping nothing important is lost

It shows they understand compaction as a destructive operation that should be buffered by durable capture.

### 5. They added a safety buffer with `ReserveTokens`

This is another good systems choice.

Compaction does not wait until the exact hard limit.
They can reserve some headroom and compact earlier.

This is a pragmatic defense against:

- token counter drift
- provider over-delivery
- streaming mismatch

## What is risky

### 1. This subsystem already behaves like a shadow policy layer

This is the main warning.

Pressure behavior is currently shaped by many interacting controls:

- `softTrimRatio`
- `hardClearRatio`
- `keepLastAssistants`
- `minPrunableToolChars`
- per-media trim budgets
- `ReserveTokens`
- cache TTL gating
- memory flush settings
- compaction thresholds
- provider cache-control capabilities

Each one is locally reasonable.
Together they form a second policy language around the core runtime.

That is dangerous if it stops being legible.

### 2. Some parts are heuristic, not authoritative

Even when the subsystem is well engineered, parts of it are still heuristic:

- tail importance is regex-driven
- char-to-token fallback exists
- memory flush success can fall back to extractive heuristics
- cache-TTL behavior changes the pressure path conditionally

This is not automatically bad.
But it means the subsystem is only partly deterministic.

### 3. Memory flush is useful, but can oversell its own safety

Memory flush is a good pattern.
It is not a guarantee.

The runtime still allows:

- LLM failure
- NO_REPLY
- extractive fallback
- partial persistence
- non-fatal indexing failure

So this is a bounded best-effort durability layer, not a hard correctness guarantee.

That distinction matters.

### 4. Cache TTL introduces path-dependent pressure behavior

This is another subtle warning.

If provider cache control is available and TTL is still live:

- the system may preserve history longer
- skip soft prune
- fall through differently

This is smart optimization.
It is also another place where runtime behavior depends on a hidden combination of provider capability plus cache timing.

### 5. The docs can make the system sound cleaner than it is

The overall compaction story is well documented.
But the real runtime includes more nuance:

- provider-aware budget fallback
- inline stats and event emission
- compatibility between v2/v3 style paths
- flush fallback behavior
- per-tool exceptions

So this is another place where the runtime is more operationally textured than the neat conceptual diagram.

## What to steal

- Explicit pressure stage in the pipeline
- Multi-phase degradation instead of binary truncation
- Pre-compaction memory flush
- Early budget reserve instead of waiting for hard failure
- Special handling for expensive-to-recreate tool outputs

## What to avoid

- Letting too many thresholds and exceptions become unreadable shadow policy
- Treating heuristic flush or extraction as a hard guarantee
- Making cache timing quietly change core pressure semantics without strong observability
- Letting pressure-control logic become more complex than operators can reason about

## The distilled lesson

GoClaw shows a strong pattern here:

- context pressure should be managed as a real runtime subsystem

That is worth stealing.

But it also shows the danger:

- every helpful ratio, buffer, TTL, and fallback adds another soft rule

So the real lesson is:

- **steal the staged pressure-control model**
- **avoid turning pressure handling into a hidden policy jungle**
