# Test Surface And Confidence Map

## What is strong

### 1. The repo has real test investment

`🎯 9   🛡️ 8   🧠 3`

This is not demo-level coverage.

Signals from the current tree:
- many command tests
- strong runtime tests
- watchdog tests
- hooks deployer tests
- merge tests

That is meaningful engineering effort.

### 2. The hottest pain points are often tested

`🎯 9   🛡️ 8   🧠 4`

That is one of the best signs in the repo.

The team tends to add tests around:
- runtime adapters
- coordinator behavior
- hooks / guards
- watchdog logic
- lifecycle flows

### 3. PR verification culture looks serious

`🎯 8   🛡️ 8   🧠 3`

Merged PRs often list:
- typed tests
- targeted command tests
- biome checks

That is good maintenance discipline.

## What is weak

### 1. Confidence is not uniform across all subsystems

`🎯 10   🛡️ 9   🧠 4`

The repo has better test density in:
- commands
- runtimes
- watchdog

than in some deeper authority seams between:
- stores
- orchestration semantics
- cross-repo boundaries
- mixed-runtime parity

### 2. Large orchestration files still carry hidden integration risk

`🎯 9   🛡️ 8   🧠 5`

Even with many tests, very large files like:
- `coordinator.ts`
- `sling.ts`
- `dashboard.ts`

still imply integration complexity.

### 3. Future/headless parity remains a moving target

`🎯 8   🛡️ 8   🧠 4`

The more runtimes the project supports, the harder it is for test confidence to remain equal across adapters.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 3`

Steal:
- test the actual pain seams, not just helper functions

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- assuming a good total test count means equal confidence across all orchestration truths and runtime paths

## Architect takeaway

**`overstory` has real test culture. The correct reading is not “fully safe”, but “they are putting tests where the real pain is”.**
