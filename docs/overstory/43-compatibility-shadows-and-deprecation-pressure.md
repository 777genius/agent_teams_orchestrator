# Compatibility Shadows And Deprecation Pressure

## What is strong

### 1. Deprecations are named, not hidden

`🎯 9   🛡️ 8   🧠 3`

The repo explicitly marks:
- deprecated supervisor path
- deprecated config keys
- deprecated command flags

This is much healthier than silent drift.

### 2. Compatibility bridges are often tested

`🎯 8   🛡️ 8   🧠 3`

There are explicit compat tests around:
- sessions migration
- config migration
- old command behaviors

That is good maintenance discipline.

## What is weak

### 1. Compatibility shadows are still widespread

`🎯 10   🛡️ 9   🧠 5`

The current tree still contains many signals of long compatibility tails:
- deprecated watchdog keys
- deprecated tracker keys
- deprecated supervisor command
- legacy log paths
- fallback semantics in cleanup, dashboard, log, triage, config

This is not alarming by itself.
It becomes architectural pressure when too many old dialects remain alive at once.

### 2. Fallbacks can silently become the real contract

`🎯 9   🛡️ 8   🧠 4`

If enough compatibility behavior accumulates, operators and tests begin relying on it as normal behavior.

### 3. Growth makes these shadows more expensive

`🎯 9   🛡️ 8   🧠 4`

The wider the runtime and command surface gets, the more expensive old compatibility paths become.

## Architect takeaway

**`overstory` handles deprecations more honestly than most competitors. The risk is not hidden deprecation. The risk is letting too many compatibility shadows remain active across a widening control plane.**
