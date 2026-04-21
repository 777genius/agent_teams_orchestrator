# GoClaw Security vs Availability Tradeoffs

## Core observation

GoClaw repeatedly chooses availability and backward compatibility over strict contract closure in some boundary seams.

This is not accidental.
It is a design posture.

## Why this matters

As an architect, you should distinguish between:

- resilience inside the orchestration core
- permissiveness at boundary layers

GoClaw is good at the first and uneven at the second.

## 1. Good resilience choices

These are healthy availability choices:

- stale recovery
- retry and followup flows
- session/task repair
- post-turn reconciliation
- nil-safe no-op fallback for optional hook dispatcher wiring

These preserve service usefulness without weakening core semantics too much.

## 2. Riskier availability choices

These are more dangerous:

- no gateway token -> backward-compat full access
- empty CORS config -> allow all
- pairing-check failures with fail-open comments
- no permission store -> allow all in heartbeat path
- some context file permission paths described as fail-open

These increase operability and upgrade smoothness, but they also weaken boundary sharpness.

## 3. Why the difference matters

Not all fail-open behavior is equal.

Fail-open in:

- caching
- observability
- optional enrichment

can be reasonable.

Fail-open in:

- auth
- permission checks
- workspace boundaries
- system-triggered execution paths

is much more dangerous.

## 4. Security posture lesson from issues

Issue `#866` matters because it describes a plausible exploit chain based on:

- degraded authentication
- permissive method classification
- heartbeat execution surfaces

Even if not every step is fully proven in the issue, the architectural plausibility is the warning sign.

## 5. The strongest security lesson

You can have:

- rich RBAC
- API keys
- tenant isolation
- scoped access

and still be weak if:

- defaults are permissive
- auth is split across layers
- one runtime path skips the strongest boundary

Security posture is not the presence of features.
It is the quality of the default contract.

## 6. Good practices worth stealing

- constant-time token comparison
- sender-aware group permission thinking
- SSRF hardening in HTTP handlers
- audit logging with encrypted detail
- edition gating for risky handlers

These are real strengths.

## 7. Dangerous habits to avoid

- backward-compat full-access mode in production-capable systems
- "viewer by default" method classification
- local handler checks compensating for weak central auth closure
- treating synthetic identities as harmless if they can still cross permission-sensitive paths

## 8. The architecture lesson

Availability-first is not wrong.

But it must be applied selectively:

- repair the core aggressively
- keep the boundary strict

GoClaw sometimes repairs both the core and the boundary with the same permissive instinct.
That is where risk appears.

## The distilled lesson

Use availability-first thinking for recovery and repair.

Do not use it as the default answer for identity, auth, and permission seams.
