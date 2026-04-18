# GoClaw Docs and Product Drift

## Core observation

GoClaw has unusually good documentation for a project in this space.

That is a real strength.

But the docs are sometimes stronger than the runtime contract they describe.
As a result, you can read the docs and think the system is more closed, more symmetric, and more uniform than it really is.

## What GoClaw documents well

### 1. Architecture intent

`docs/00-architecture-overview.md` gives a real module map.
That is already better than many competitors.

### 2. Dangerous seams

`docs/agent-identity-conventions.md` is excellent.
It explicitly documents trap zones, dual identities, and review rules.

This is a strong engineering habit.

### 3. Team orchestration model

`docs/11-agent-teams.md` explains task lifecycle, blocked tasks, escalation, review, and auto-completion clearly.

That makes the intended architecture easy to study.

### 4. Changelog quality

`docs/17-changelog.md` often explains not just "what changed" but why the seam was dangerous.

That is a useful signal of serious maintainers.

## Where drift shows up

### 1. Feature docs ahead of shipped reality

Issue `#498` is a strong example:

- docs referenced a custom tools API
- runtime never actually shipped that path
- maintainers later confirmed the table had been dropped as dead code

This is classic product drift:
the architecture story ran ahead of the integrated product.

### 2. Config docs vs real config surface

Issue `#740` shows documentation listing config sections that do not exist as top-level fields in `internal/config/config.go`.

This is a smaller example, but it matters:
config docs are often treated as truth by operators.

### 3. Reviewer vocabulary ahead of runtime enforcement

The teams docs describe review-oriented lifecycle concepts well.
But the docs themselves also note that some reviewer restrictions are not yet active and guards are commented out.

This is important:

- the vocabulary is mature
- enforcement is less mature

### 4. Security narrative vs backward-compat defaults

The security and auth docs openly describe backward-compat modes such as:

- no gateway token -> permissive dev mode
- empty allowed origins -> allow all

This honesty is good.
But architecturally it still means the runtime has permissive defaults in sensitive seams.

## Why this matters to a competitor study

If you study only the docs, you will overestimate:

- contract sharpness
- mode symmetry
- API completeness
- runtime closure

If you study only the code, you will miss:

- intended boundaries
- trap-zone awareness
- how maintainers themselves think about the model

The right method is:

- docs for intent
- code for truth
- issues for stress points
- tests for actual defended invariants

## What to steal

### 1. Dangerous-seam documentation

If a seam is known to be hard, document it explicitly.
GoClaw does this very well with agent identity conventions.

### 2. Real architecture overview docs

A module map and component diagram are worth having.
They reduce cargo-cult understanding inside the team.

### 3. Changelog as architecture memory

A good changelog helps future maintainers understand why a seam was hardened.

## What to avoid

### 1. Shipping docs for a feature before its runtime contract is real

That produces false confidence and support debt.

### 2. Naming a contract stronger than its enforcement

Examples:

- mature-looking mode names with soft runtime enforcement
- reviewer vocabulary before reviewer rules are hard
- API references for paths that are not actually implemented

### 3. Letting breadth outpace closure

The broader the platform gets, the more dangerous doc drift becomes.

## The distilled lesson

GoClaw proves that good docs are valuable, but also that docs cannot substitute for one hardened execution contract.

Trust documentation as design intent.
Do not trust it as the final proof of runtime truth.
