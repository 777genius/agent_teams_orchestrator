# GoClaw Operator-Facing Honesty and Product Drift

## Why this file exists

GoClaw often has stronger internal engineering than its operator-facing contract suggests.

This file focuses on the gap between:

- what the product appears to promise
- what the runtime actually requires

That gap is expensive.
It generates onboarding pain, issue churn, and trust erosion.

## 1. PostgreSQL is architecture, not setup trivia

Issues `#95` and `#312` make this very clear:

- PostgreSQL is not a small setup detail
- it is part of the product's real substrate
- Docker often hides that reality better than native install does

This matters because the product can sound simple while the architecture still has real operational weight.

Architect lesson:

- if the system depends on a heavy substrate, document that dependency as architecture, not as a footnote in setup

## 2. Docker paths and native paths are not morally equivalent

Issue `#320` is a strong example.
It shows that:

- skill seeding
- runtime package availability
- writable runtime directories
- dependency scanning

can all behave differently inside the official image than users expect from the docs or UI.

Architect lesson:

- if Docker and native installs have different runtime capabilities, the product must say so explicitly and early

## 3. Update flows are part of the product contract

Issue `#934` is a useful signal:

- `make up` sounded like a normal update path
- in reality it rebuilt from local source and could override a freshly pulled image

This is a classic example of operator-facing dishonesty by accident:

- the command name is simple
- the actual semantics are more complex

Architect lesson:

- commands that operators treat as lifecycle primitives must have extremely clear semantics

## 4. Good backend logic can still fail at the human boundary

Issue `#862` is small but important.

The underlying upload logic is not trivial and has some good properties.
But the user-facing error was misleading.

That matters because operators do not debug internal structure first.
They debug the product surface they are given.

Architect lesson:

- precise, contract-honest error messages are part of system design, not polish

## 5. Config semantics should not require insider knowledge

Issue `#198` shows this clearly:

- `GOCLAW_GATEWAY_TOKEN`
- `GOCLAW_OWNER_IDS`

are understandable once you know the system deeply.
They are much less obvious from a fresh operator perspective.

That is a design smell because:

- the config surface is acting like an exposed slice of the internal auth model

Architect lesson:

- operator config should describe intention cleanly, not leak hidden architectural layering

## 6. Product docs can be too optimistic about maturity

GoClaw's docs are often good.
But there are places where docs and product story are ahead of runtime closure.

Recurring examples across the study:

- custom tools surface
- some reviewer vocabulary
- some security/default narratives
- some update/setup paths

Architect lesson:

- docs should be treated as part of the contract and reviewed with the same strictness as code paths

## 7. Product drift is especially expensive in platform software

Platform products are not judged only by code quality.
They are judged by whether operators can:

- install them
- update them
- predict what commands do
- understand errors
- reason about scope and permissions

When these things drift, the system feels less mature than the internal code sometimes deserves.

Architect lesson:

- platform maturity is partly code, partly operator-facing honesty

## 8. The real danger: internal strength can mask external confusion

GoClaw has strong areas:

- hooks
- task core
- recovery
- secure direct exec

That internal strength can make it easy to underestimate:

- setup pain
- role/scope confusion
- update-flow surprises
- environment-specific capability drift

Architect lesson:

- strong internals do not cancel out weak operator truth

## The distilled lesson

The operator-facing contract must be honest about:

- substrate requirements
- environment differences
- scope/role semantics
- lifecycle/update semantics
- user-visible failure meaning

GoClaw is a useful warning:

- a system can be technically strong
- and still feel unreliable if the product surface is less honest than the underlying architecture
