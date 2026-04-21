# Maintenance Hotspots And Dogfooding Pressure

## What the hot files say

Recent churn shows concentration in:
- `src/index.ts`
- `src/commands/sling.ts`
- `src/commands/coordinator.ts`
- `src/config.ts`
- `src/commands/dashboard.ts`
- `src/commands/log.ts`
- `src/merge/resolver.ts`

These are not random.
They are the real seams:
- entrypoint routing
- spawn path
- orchestration hierarchy
- config/default policy
- observability
- merge semantics

## Self-hosting pressure

The repo itself also shows heavy churn in:
- `.mulch/expertise/*.jsonl`
- `.beads/issues.jsonl`
- `.seeds/issues.jsonl`
- `.overstory/*`

That means the project is partly living inside its own coordination model.

This is a double-edged sword:
- good because it produces real-world pain early
- risky because it can normalize local complexity and os-eco pollution

## Architect takeaway

`🎯 10   🛡️ 9   🧠 4`

**`overstory` is dogfooding hard enough that the hot spots are meaningful architecture telemetry. The warning is that self-hosted runtime artifacts can also distort what complexity starts feeling "normal".**
