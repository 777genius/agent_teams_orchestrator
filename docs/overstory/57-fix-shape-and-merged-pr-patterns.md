# Fix Shape and Merged PR Patterns

Looking at merged PRs is useful because it shows not just what the project wants to be, but how it actually evolves.

## Healthy fix shapes

### 1. Small, high-leverage substrate fixes

Examples:
- PR `#19` poll-based readiness instead of fixed sleep
- PR `#59` stale session cleanup and tmux failure mode distinction
- PR `#60` configurable shell init delay

These are good patterns because they:
- reduce substrate magic
- improve determinism
- preserve the existing architecture while making it less fragile

### 2. Runtime adapters landed incrementally

Examples:
- PR `#49` Codex runtime adapter
- PR `#61` Gemini adapter
- PR `#69` Codex startup compatibility
- PR `#77` Copilot runtime fixes
- PR `#104` Cursor adapter

This is a good evolution shape.
The project did not wait for one mythical "all runtimes complete" moment.

### 3. Operational truth got real investment

Examples:
- PR `#11` doctor catches Dolt / CGO backend failure
- PR `#125` reduce doctor false positives
- PR `#109` targeted coverage uplift

This shows the team is willing to harden operator trust, not just add orchestration features.

### 4. Command surface grows through explicit product moves

Example:
- PR `#126` adds orchestrator command surface

This is useful because it makes command-surface growth visible.
The project is not accidentally growing into a larger control plane.
It is doing so intentionally.

## More ambiguous fix shapes

### 1. Feature perception can outrun mainline maturity

Best example:
- closed PR `#140` for full `OpenCode` adapter and guard plugin

The proposal is detailed and promising.
It was not merged.
That means:
- the team may already know how to close the seam well
- but `main` still does not own that closure

This is a perfect example of why competitor analysis must follow `main`, not just issue headlines.

### 2. Budget compression can become architectural pressure valve

Example:
- PR `#127` compress coordinator/lead/worker roles for low agent budgets

This is a smart practical feature.
It is also a reminder that cost pressure can reshape orchestration topology.

That is fine as long as it stays:
- explicit
- bounded
- honest

It becomes dangerous if budget modes silently become the normal contract.

## Architect takeaway

The fix shape in `overstory` is generally healthy when:
- a sharp seam is narrowed
- operator truth improves
- runtime maturity is increased incrementally

It becomes risky when:
- support perception outruns `main`
- budget pressure starts reshaping core coordination semantics
