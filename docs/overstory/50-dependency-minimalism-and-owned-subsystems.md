# Dependency Minimalism and Owned Subsystems

`overstory` has a surprisingly thin dependency surface for a system this ambitious.

Current `package.json`:
- runtime dependencies: `3`
- dev dependencies: `4`

Runtime deps:
- `@os-eco/mulch-cli`
- `chalk`
- `commander`

Dev deps:
- `@biomejs/biome`
- `@types/bun`
- `@types/js-yaml`
- `typescript`

## Why this is interesting

For a multi-agent orchestration CLI, this is unusually restrained.

It means:
- less supply-chain risk
- less framework gravity
- more direct ownership of core subsystems
- easier reading of real architectural logic

This is one reason `overstory` is so useful as a competitor study.
A lot of the important behavior is actually in the repo, not hidden in a deep library stack.

## What is good

- Strong ownership of real core logic
- Fewer hidden semantics from third-party orchestration frameworks
- Easier to reason about control-plane behavior
- Better long-term chance of keeping subsystem boundaries honest

## The cost

⚠️ Dependency minimalism does not mean architectural cheapness.

It often means the project must own:
- runtime adapters
- watchdog logic
- consistency tooling
- merge mechanics
- session and event stores
- compatibility handling

So the tradeoff is:
- lower external complexity
- higher internal subsystem maintenance burden

## Best lesson to steal

Steal:
- minimal dependencies on the orchestration hot path
- direct ownership of critical control-plane code
- resisting framework-shaped architecture drift

Avoid:
- using minimal dependencies as an excuse to build every subsystem ad hoc
- mistaking low dependency count for low maintenance cost
- letting bespoke subsystems accumulate without equally strong contract discipline
