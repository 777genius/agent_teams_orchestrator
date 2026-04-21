# GoClaw Tests, History, and Issues

## Core claim

History and issue flow both confirm the same story:

- the task core is relatively stable
- the hot seams are identity, gateway, routing, prompt/runtime glue, and UI/event projection

## Hot files

The hottest files since 2025 are concentrated around:

- gateway entry
- loop internals
- resolver
- prompt wiring
- context
- runtime routing

That is a strong sign that the main architectural pressure is not the state machine itself.

## Test density pattern

The package-level pattern is uneven:

- scheduler: relatively healthy
- providers: a lot of tests because the surface is broad
- store: thin for how semantically important it is
- gateway: thinner than ideal for a seam-heavy subsystem

## Important test asymmetry

There are targeted tests for:

- notification mutation blocking
- sender/permission integration
- role bypass rules

But there is no equally strong first-class contract suite for:

- announce semantics
- delegate semantics
- one unified execution-mode model

That matters.
It means the most mature tests often validate symptoms and outcomes, not one canonical contract.

## Important issue clusters

High-signal clusters include:

- queue pressure / starvation
- actor vs scope identity
- local key / routing metadata drift
- team UI/event desync
- provider failure semantics
- workspace edge cases
- permission/auth boundary issues

## Important issues

- `#266`
  - queue pressure and architecture redesign signal
- `#877`
  - completion events lose `local_key`, topic routing breaks
- `#884`
  - Claude CLI error semantics are lossy
- `#888`
  - Codex failure semantics can look like success
- `#915`
  - sender/actor/scope confusion in group file-writer permissions

## Important history pattern

The April 2026 patch train is especially revealing:

- sender propagation
- then dashboard propagation
- then role propagation

That is a classic sign of distributed correctness:

- seam is patched path by path
- not sealed once by one tighter contract

## Best one-line summary

GoClaw's history does not show a weak team.
It shows a strong team spending a lot of effort hardening a seam that is structurally expensive.
