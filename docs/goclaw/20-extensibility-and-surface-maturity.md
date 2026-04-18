# GoClaw Extensibility and Surface Maturity

## Core observation

GoClaw is not one extensibility system.
It has several extension surfaces with very different maturity levels.

This matters because broad platforms often look uniformly extensible from the outside, but are not.

## Maturity ranking

### High maturity

- hooks
- skills
- providers as pluggable classes
- MCP integration

### Medium maturity

- built-in tools configuration
- agent/team orchestration surfaces exposed to UI/API
- OAuth/provider routing surfaces

### Low maturity or drift-prone

- custom tools story
- some docs-described APIs
- some UI/admin surfaces that are ahead of deeper closure

## 1. Hooks - the strongest extensibility surface

Hooks look like a real subsystem, not a half-feature.

Signals:

- explicit `HookStore`
- PostgreSQL and SQLite implementations
- dedicated RPC methods
- dry-run semantics
- audit log
- SSRF-hardened HTTP handler
- edition gating
- circuit breaker
- budget layer
- docs with real operational guidance

This is a strong example of how extensibility should look:

- typed domain model
- explicit lifecycle events
- runtime enforcement
- store-backed config
- security model
- auditability

Architect lesson:

- if you expose extensibility, make it a product-grade subsystem, not a thin callback hack

## 2. Skills - mature enough to trust

The skills system also looks relatively mature.

Strengths:

- hashing and change detection
- startup seeding
- dependency scanning
- activation and status
- some runtime checking
- hot reload support

This is a good pattern because it treats skills as managed assets, not just loose files.

Weakness:

- broad feature surface means dependency and runtime behavior can still get operationally noisy

Still, this is one of their stronger extension stories.

## 3. Providers - broad, useful, but adapter-sensitive

Provider integration is architecturally ambitious and product-useful.

Good:

- broad provider support
- OAuth providers
- routing and failover ideas
- reasoning policy model

Weak:

- adapter quality is uneven
- failure normalization is not equally strong across providers
- broad provider surface increases silent-seam risk

Lesson:

- provider breadth is valuable
- but provider breadth should never outrun one authoritative run-outcome contract

## 4. MCP - strategically strong

MCP support is a smart strategic choice.

Why:

- it makes the platform more composable
- it avoids reinventing every tool integration
- it fits the "gateway" product identity well

The lesson here is not about code only.
It is about platform positioning:

- integrate good external ecosystems instead of hardcoding everything yourself

## 5. Custom tools - the cautionary counterexample

This is the best example of surface immaturity and drift.

Evidence:

- docs still reference custom tools HTTP paths
- issue `#498` reports missing API
- maintainers state the table and feature path had been dead code and were removed
- current store factory no longer exposes a `CustomToolStore`

This is a very important lesson:

- a platform can look extensible on paper
- while one extension surface is not actually integrated into the real runtime

Architect takeaway:

- if an extension surface is not wired end-to-end, do not market it as real
- remove or quarantine dead extensibility paths aggressively

## 6. Builtins vs user-defined surfaces

GoClaw shows a useful distinction:

- builtin systems like hooks can be seeded, versioned, and protected
- user-facing extensibility must still obey tenant scope, auth, and audit rules

This is a good lesson:

- extensibility should have provenance
- builtin and user-defined extensions should not be treated as identical trust tiers

## 7. Dual-store parity as maturity signal

A strong extensibility surface in GoClaw often has both:

- PostgreSQL implementation
- SQLite implementation

Hooks passing this test is a signal of maturity.

Custom tools failing this test is a signal of lower real integration.

## 8. Surface maturity heuristic

When judging whether a GoClaw surface is real, ask:

1. Is there a typed store contract?
2. Is it implemented in both PG and SQLite?
3. Is there a documented security model?
4. Is there dedicated test coverage?
5. Is the UI/API path actually wired?
6. Is there operational/audit support?

The more "yes" answers, the more first-class the surface is.

## What to steal

- hooks as a real extensibility subsystem
- skills as managed assets, not random files
- builtin vs user-defined trust tiers
- maturity heuristics for extension surfaces

## What to avoid

- advertising extension points that are not wired end-to-end
- letting one surface stay in docs while its runtime path is dead
- broad provider support without hard outcome normalization

## The distilled lesson

GoClaw teaches a very important platform rule:

Not every extension surface deserves equal trust.

Treat extensibility maturity as an architectural property, not a marketing label.
