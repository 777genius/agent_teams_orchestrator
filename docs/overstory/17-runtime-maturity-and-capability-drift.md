# Runtime Maturity And Capability Drift

## The good news

### 1. The registry is clean

`🎯 9   🛡️ 9   🧠 3`

`src/runtimes/registry.ts` is disciplined.

It centralizes runtime resolution and keeps the rest of the system from importing adapter classes ad hoc.

That is exactly the right structural move.

### 2. The interface is ambitious in the right places

`🎯 10   🛡️ 9   🧠 5`

The runtime surface is not just spawn flags.

It includes room for:
- config deployment
- transcript parsing
- direct spawn
- event parsing
- RPC connections

That is why `overstory` is so interesting architecturally.

## The real maturity picture

### Stable references

`🎯 10   🛡️ 9   🧠 2`

- `ClaudeRuntime` is a stable interactive baseline
- `SaplingRuntime` is a stable headless reference

That two-point reference model is actually smart.

### Experimental majority

`🎯 9   🛡️ 8   🧠 3`

Most other runtimes are still marked experimental:
- Aider
- Amp
- Codex
- Copilot
- Cursor
- Gemini
- Goose
- OpenCode
- Pi

That is honest, but it also means the practical capability envelope is uneven.

### The sharpest drift signal

`🎯 10   🛡️ 9   🧠 3`

`OpenCodeRuntime` is the cleanest example of capability drift:
- issue `#140` is closed
- current adapter still says instruction path unverified
- `detectReady()` is stubbed
- `parseTranscript()` returns `null`
- transcript dir is unknown

This is exactly the kind of drift an architect should track hard.

## Deeper risk

### One interface can hide unequal guarantees

`🎯 10   🛡️ 9   🧠 5`

A uniform interface is good.

But operators and even the codebase itself can start to assume:
- runtime A and runtime B are equivalent enough

when in reality they differ materially in:
- hook support
- transcript quality
- readiness certainty
- headless maturity
- lifecycle control
- mail semantics

### Prompt-role contracts magnify this

`🎯 9   🛡️ 8   🧠 4`

Issue `#134` is especially important here:
- reviewer identity softness
- mixed-runtime awareness gaps
- builder / lead protocol timing gaps

This means runtime heterogeneity and role heterogeneity are interacting, not independent.

## Best practice to steal

`🎯 10   🛡️ 9   🧠 4`

Steal this:
- one adapter seam
- explicit stability labeling
- one or two reference runtimes that prove the architecture

## Anti-pattern to ban

`🎯 10   🛡️ 9   🧠 5`

Ban this:
- product language that implies capability symmetry when the adapters are still operationally very different

## Architect takeaway

**The adapter seam is one of `overstory`'s best ideas. The trap is forgetting that interface shape and capability closure are not the same thing.**
