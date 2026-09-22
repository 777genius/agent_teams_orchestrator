# Runtime Maturity Matrix

## Strongest mature signals

### Claude

`🎯 8   🛡️ 8   🧠 3`

Claude is still the practical baseline.
It is not perfect, but it is the most battle-tested path.

### Sapling

`🎯 9   🛡️ 8   🧠 4`

Sapling is the strongest future-facing runtime:
- marked stable
- headless-oriented
- explicit event flow
- connection model

It is the clearest proof of the cleaner direction.

## Uneven middle

### Pi

`🎯 7   🛡️ 7   🧠 4`

Interesting and more advanced than many adapters, but still marked experimental.

### Codex / Copilot / Gemini / Cursor / Goose / Amp / Aider

`🎯 8   🛡️ 7   🧠 5`

Architecturally useful because the seam exists.
Operationally softer because:
- maturity differs
- transcript parity differs
- readiness certainty differs
- hooks / guard parity differs

## Softest edge

### OpenCode

`🎯 10   🛡️ 9   🧠 3`

This is the clearest capability-drift case:
- marked experimental
- explicit stubs
- explicit TODOs
- unverified instruction path
- null transcript parsing
- stub readiness

That makes it a very valuable warning signal.

## Architect takeaway

**`overstory`'s runtime seam is stronger than its runtime parity. Treat the interface as mature, and many concrete adapters as still on a maturity spectrum.**
