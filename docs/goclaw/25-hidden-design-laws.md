# GoClaw Hidden Design Laws

## Why this file exists

Good competitor study should identify not only code structure, but the hidden laws the system keeps obeying.

These laws are not always written down.
They appear through repeated design choices.

## Law 1. The platform protects the core more than the perimeter

Repeated pattern:

- task state machine is explicit
- recovery is explicit
- lifecycle methods are explicit

But:

- auth edges are softer
- mode edges are softer
- UI truth is softer

This means the design priority is:

- preserve the orchestration center
- tolerate more complexity at the shell

## Law 2. Backward compatibility is treated as product policy, not just migration detail

You see this everywhere:

- no gateway token -> permissive mode
- deprecated tenant fields
- legacy session formats
- legacy config bridges
- old reasoning shims
- old file token healing

This is a real design law:

- do not break working installs easily

The cost is that clean contracts stay mixed with compatibility dialects for longer.

## Law 3. Metadata is used as a semantic patch cable

When the clean contract is missing, the system often adds metadata keys:

- `origin_sender_id`
- `origin_role`
- `origin_session_key`
- `local_key`
- `peer_kind`
- trace ancestry

This is not random.
It is a hidden law:

- if a seam is broken, bridge it with metadata first

That keeps the product moving, but increases distributed correctness.

## Law 4. Product breadth is accepted even before all seams cool down

GoClaw continues to add:

- hooks
- providers
- channels
- runtime/packages
- teams
- UI features

while some core seams remain hot.

This reveals another law:

- platform momentum is prioritized over waiting for full closure

That is strategically understandable, but architecturally expensive.

## Law 5. Durable state wins arguments over prompt-only behavior

This is one of their good laws.

When GoClaw is strongest, it prefers:

- store rows
- lifecycle methods
- retry/recovery workers

over:

- prompt-only orchestration
- UI-only truth
- local runtime guesswork

This is exactly why the task engine is strong.

## Law 6. The system tolerates heterogeneous ingress

GoClaw accepts many entry paths:

- HTTP
- WS
- browser pairing
- channels
- cron
- delegate
- subagent
- team dispatch

The hidden law is:

- one engine should serve many ingress forms

This gives strong product leverage.
It also creates huge boundary tax.

## Law 7. Safety nets are preferred over brittle idealism

Examples:

- stale recovery
- post-turn repair
- validation observers
- retry loops
- repair comments in code

This is a healthy law when aimed at durable state.
It becomes unhealthy when used to carry semantic meaning that should have been explicit.

## Law 8. The team documents trap zones instead of pretending they do not exist

This is one of the best hidden laws in the codebase.

The maintainers often:

- write changelog notes with architectural context
- add docs for dangerous identity seams
- keep regression tests around incidents

This is not accidental.
It is a strong engineering culture signal.

## What to steal from these laws

- durable state beats prompt soup
- safety nets around state are good
- dangerous seams should be documented
- cross-ingress engines are powerful when the contract is strong

## What to avoid from these laws

- metadata as patch cable for core semantics
- product breadth before seam maturity
- compatibility layers that stay alive too long in hot paths

## The distilled lesson

GoClaw's hidden laws explain why the project is both impressive and expensive:

- strong center
- broad ambition
- high tolerance for compatibility
- high reliance on metadata bridges at the edges
