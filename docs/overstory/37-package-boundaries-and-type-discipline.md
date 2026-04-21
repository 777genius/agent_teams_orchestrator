# Package Boundaries And Type Discipline

## What is strong

### 1. TypeScript discipline is real

`🎯 9   🛡️ 8   🧠 4`

`overstory` is not loose TypeScript.

Signals:
- strict mode
- `noUncheckedIndexedAccess`
- very little casual `any`
- explicit interfaces for stores, runtimes, config, mail, sessions, runs

This matters because orchestration code gets dangerous quickly without hard type boundaries.

### 2. Adapter and store interfaces are explicit

`🎯 9   🛡️ 8   🧠 4`

Good seams include:
- `AgentRuntime`
- `SessionStore`
- `MailStore`
- `MetricsStore`
- tracker interfaces

These are the kinds of boundaries that keep a multi-subsystem CLI from collapsing into incidental coupling.

### 3. Manifest and config validation are serious enough

`🎯 8   🛡️ 8   🧠 3`

`manifest.ts` and `config.ts` show good defensive taste:
- validation before casting
- explicit supported capability set
- typed config objects

## What is weak

### 1. `src/types.ts` is a gravity well

`🎯 10   🛡️ 9   🧠 5`

`src/types.ts` is large and central.
That is practical, but it also means:
- many packages couple through one shared semantic hub
- changes ripple broadly
- domain separation can soften over time

This is a classic growth smell in TypeScript CLI codebases.

### 2. Commands are large and become integration hubs

`🎯 9   🛡️ 8   🧠 5`

Some of the biggest files are:
- `src/commands/coordinator.ts`
- `src/commands/sling.ts`
- `src/commands/dashboard.ts`
- `src/config.ts`

That means important boundaries are being managed through a few large orchestration files.

### 3. Package boundaries are better than average, but not fully domain-sliced

`🎯 8   🛡️ 8   🧠 4`

The repo is modular.
But it is still primarily organized as a serious CLI application, not a deeply isolated domain kernel with thin adapters.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- strict typing around runtime/store/config seams

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 5`

Ban:
- allowing one central types module and a few very large command files to silently become the semantic gravity center of the whole system

## Architect takeaway

**`overstory` has better type discipline than most competitors. The warning is that its semantic center of gravity is starting to collect in `types.ts` and a handful of large orchestration commands.**
