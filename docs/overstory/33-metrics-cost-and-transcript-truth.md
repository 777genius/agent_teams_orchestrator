# Metrics, Cost, And Transcript Truth

## What is strong

### 1. Metrics are a real subsystem

`🎯 9   🛡️ 8   🧠 4`

`src/metrics/store.ts` is solid quiet engineering:
- SQLite-backed
- session metrics
- token snapshots
- run-scoped queries
- purge semantics

This is more serious than a lot of competitors.

### 2. Pricing is runtime-agnostic at the interface level

`🎯 8   🛡️ 8   🧠 3`

`src/metrics/pricing.ts` separates pricing logic from transcript parsing.
That is the right direction.

### 3. Running agents can be observed incrementally

`🎯 8   🛡️ 8   🧠 4`

Token snapshots for active agents are useful.
They make the system less dependent on end-of-session accounting only.

## What is weak

### 1. Cost truth is only as good as runtime transcript maturity

`🎯 10   🛡️ 9   🧠 5`

This is the main caveat.

The metrics model is good.
But transcript/cost truth is still uneven because runtime maturity is uneven:
- Claude path is stronger
- other adapters may have incomplete parsing
- some runtimes still have unknown transcript locations or null parsers

So the metrics subsystem is better than the weakest adapter, but still limited by adapter parity.

### 2. Pricing tables are explicit but manually curated

`🎯 8   🛡️ 7   🧠 3`

This is practical, but it means pricing accuracy ages with model churn unless actively maintained.

### 3. Snapshot truth and transcript truth are related but different

`🎯 8   🛡️ 8   🧠 4`

Snapshots are great for live observation.
Transcripts are stronger for final accounting.
If runtimes differ in transcript quality, then live and final truth can drift.

## Best practice to steal

`🎯 9   🛡️ 8   🧠 4`

Steal:
- metrics as a first-class subsystem
- separate live token snapshots from final session accounting

## Anti-pattern to ban

`🎯 9   🛡️ 8   🧠 4`

Ban:
- assuming a strong metrics store automatically means strong cost truth across uneven runtime adapters

## Architect takeaway

**`overstory` has a real metrics subsystem, but its cost truth is ultimately bounded by runtime transcript parity. The lesson is to keep accounting architecture honest about adapter maturity.**
