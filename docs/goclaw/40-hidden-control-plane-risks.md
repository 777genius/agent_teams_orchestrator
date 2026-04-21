# GoClaw Hidden Control-Plane Risks

## Why this file exists

A system can have one explicit orchestration engine and still accumulate a second, quieter control plane made of:

- budgets
- nudges
- hints
- guard shims
- compatibility branches
- per-surface conventions

GoClaw shows signs of that risk.

## Core observation

GoClaw's strongest logic is explicit and persisted.
Its riskiest logic increasingly lives in soft guidance and distributed control shims around the core.

This does not make the system bad.
But it is a warning.

## 1. Hint systems can become a shadow runtime

The model steering system includes:

- budget nudges
- skill-evolution nudges
- team progress nudges
- output truncation hints
- sandbox hints
- channel formatting hints

Many of these are useful.
The risk is architectural:

- if enough important behavior depends on injected hints,
- the real control plane starts moving out of the explicit state machine and into prompt-time steering

Architect lesson:

- hints are helpful
- hints must not carry core correctness

## 2. Too many budgets can create policy fog

GoClaw contains several budget concepts:

- iteration budgets
- hook chain budgets
- per-hook timeouts
- tenant hook token budgets
- context truncation budgets
- thinking budgets

Each is reasonable in isolation.
Together, they can become difficult to reason about.

Architect lesson:

- budgets should be few, named clearly, and tied to a small number of contract layers

## 3. Best-effort workers can quietly hide quality problems

Example:

- KG dedup worker logs and returns nil on failure

That may be the right availability tradeoff.
But it also means:

- data quality can degrade silently
- operators may not feel the issue until later

Architect lesson:

- non-fatal async workers still need visible health signals and clear degradation semantics

## 4. Restore and operational modes can become semantic complexity

Restore supports:

- `upsert`
- `replace`
- `new`

This is a good explicit API.
It is also a warning:

- operational semantics become another control plane
- every mode has different safety assumptions and data consequences

Architect lesson:

- explicit operational intent is good
- too many operational modes still increase cognitive load

## 5. Compatibility branches can become behavior routers

Examples across the system:

- no token mode
- owner bypasses
- legacy session formats
- old config bridges
- old identity fallbacks

This means parts of the system are not controlled only by domain state.
They are also controlled by compatibility history.

Architect lesson:

- historical compatibility should not become an invisible behavior router

## 6. Guidance systems are strongest when they stay non-authoritative

The model steering layer is interesting and sometimes useful.
It becomes dangerous only when:

- the team starts relying on hints to enforce behavior that should have been encoded structurally

Examples of structural concerns that should not live in hints:

- permissions
- routing identity
- side-effect boundaries
- lifecycle closure

Architect lesson:

- use hints to improve behavior
- never use hints to carry correctness

## 7. Broad platform features create pressure to add soft control

As features grow, there is pressure to add:

- one more guard
- one more hint
- one more fallback
- one more bypass
- one more compatibility shim

This is how hidden control planes form.

Architect lesson:

- every soft control added to the system should be reviewed as architectural debt, not just feature polish

## 8. The review alarm

You should stop and re-evaluate when a system starts needing:

- many nudges
- many budgets
- many synthetic identities
- many side-band metadata keys
- many compatibility branches

Those are signs that the visible core contract may not be carrying enough meaning anymore.

## The distilled lesson

GoClaw's explicit engine is strong.

The hidden risk is the gradual formation of a second control plane made of:

- prompts
- hints
- budgets
- wrappers
- compatibility branches

That second control plane is exactly what a new orchestrator should avoid.
