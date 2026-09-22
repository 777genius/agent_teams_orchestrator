# GoClaw Reusable Patterns Beyond the Core

## Why this file exists

This file captures reusable patterns that are not the obvious "task engine" answers.

These are the kinds of ideas that can improve a new orchestrator even if you never copy GoClaw's overall architecture.

## 1. Budgeted bootstrap truncation

The bootstrap truncation logic is simple but tasteful:

- per-file cap
- global cap
- minimum remaining budget threshold
- head/tail split instead of naive hard cut
- marker describing truncation

Architect lesson:

- context injection should be budget-aware and explain what was omitted

This is a good pattern for:

- bootstrap files
- long task context
- large audit histories
- operator summaries

## 2. Bounded dedup with explicit cleanup

Several channel integrations use:

- dedup maps
- TTL windows
- periodic cleanup

This is mundane, but strong engineering.
It shows a useful discipline:

- if you add dedup memory, also add eviction and tests

Architect lesson:

- every dedup structure needs a memory lifecycle

## 3. Idempotent create/update paths

GoClaw uses `ON CONFLICT DO UPDATE` or `DO NOTHING` in several useful places:

- skills
- restore flows
- grants
- some config-style records

This is not glamorous.
But it is the right shape for systems that must survive retries, reconnects, and repeated admin actions.

Architect lesson:

- idempotency is a first-class platform feature, not a convenience

## 4. Advisory locking around version creation

The skill system uses advisory locks around version allocation.

That is a good pattern when:

- multiple writers can race
- versioning matters
- duplicate creation would be expensive or confusing

Architect lesson:

- if version numbers have semantic meaning, guard allocation explicitly

## 5. Security as structured denial groups

The shell deny system is not just "one long regex file".
It groups risk patterns into categories.

That is a good design because:

- policy becomes explainable
- overrides can be scoped
- tests can target groups

Architect lesson:

- dangerous-operation policy should be structured, not flat

## 6. Capability budgets as productized constraints

The hooks subsystem and model-steering system both show a useful idea:

- budgets are not only backend constraints
- budgets can be productized into warnings, nudges, and circuit breakers

That is a mature pattern when used carefully.

Architect lesson:

- budgets can be exposed as operator-friendly control surfaces, not only hard limits

## 7. Fail-fast + idempotent restore modes

The backup/restore layer contains a useful distinction:

- `upsert`
- `replace`
- `new`

This is a strong pattern in itself:

- restore intent is explicit
- destructive and non-destructive semantics are separated

Architect lesson:

- operational tools should expose intent explicitly, not hide it behind flags with ambiguous semantics

## 8. Runtime observers during contract migration

Using observers and warnings during contract hardening is a good pattern.

It is especially useful when:

- you want better contracts
- but cannot flip the whole system in one release

Architect lesson:

- staged hardening is healthier when the intermediate state is observable

## 9. Design-law documents for expensive seams

The identity conventions doc is not an accident.
It is a reusable practice:

- write one seam document
- state the rule
- list trap zones
- show tests
- explain migration status

Architect lesson:

- when a seam becomes expensive enough, document it like an internal protocol

## 10. The reusable taste

The most reusable thing here is not any one feature.
It is taste:

- bounded memory
- explicit budgets
- idempotent ops
- documented invariants
- version-aware caching

## The distilled lesson

Steal from GoClaw not only the obvious task engine ideas, but also the quieter platform habits:

- budget-aware truncation
- bounded dedup
- idempotent writes
- explicit restore intents
- observer-driven hardening
- seam documents
