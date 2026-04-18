# GoClaw Providers and Runtime Boundaries

## Core claim

Provider integration is one of the more fragile seams in GoClaw because failure normalization is inconsistent.

## Main problem

The orchestrator is strongest when it receives a real error.
It becomes weaker when provider adapters turn failure into:

- weird finish reasons
- empty output
- apparently valid completion

## Why this matters

Failover, cooldown, retry, and task failure semantics depend on detecting real failure.

If adapters hide failure, the orchestrator may:

- treat failure as success
- finalize bad output
- auto-complete or not retry correctly

## Specific weak pattern

### 1. Failover only reacts to true errors

If the adapter returns something that is semantically bad but not a hard error, the higher runtime often does not react strongly enough.

### 2. Silent-failure-to-success seams exist

This is especially dangerous because it poisons the engine's view of reality:

- provider failed
- runtime thinks it got a result
- orchestration state advances anyway

### 3. Provider adapters are broad surfaces

The provider layer is large and active.
That does not make it bad, but it raises the chance of normalization drift.

## Simplest summary

The task engine is only as truthful as the run outcome it is handed.
Some provider seams make that outcome less reliable than it should be.

## Practical lesson

In a stronger architecture:

- every provider failure must normalize into one authoritative failure channel
- "finish reason says error" must not be weaker than a real error
- the engine must never have to guess whether a run really failed
