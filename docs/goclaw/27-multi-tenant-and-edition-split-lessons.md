# GoClaw Multi-Tenant and Edition-Split Lessons

## Core observation

GoClaw is shaped by two powerful structural choices:

- multi-tenant architecture
- edition split (PostgreSQL standard vs SQLite desktop/lite)

These choices create major product leverage.
They also create real architecture tax.

## 1. Multi-tenant design - what they got right

### Tenant as a first-class concept

Tenant is not an afterthought in GoClaw.
It appears in:

- stores
- auth helpers
- channel instances
- API keys
- dashboard behavior
- per-tenant overrides

This is a strong product architecture decision.

### Tenant-bound API keys

This is a particularly good idea.

It gives:

- safer SaaS integration
- simpler backend integration
- less per-request ambiguity

### Per-tenant override model

Builtin tools, skills, providers, and more can vary per tenant.
That is a real platform capability.

## 2. Multi-tenant design - where the tax appears

### Master tenant compatibility

The fixed `MasterTenantID` and related compatibility behaviors are useful.
They also create a dual mental model:

- real tenant world
- compatibility/default world

This adds branching pressure across the codebase.

### Owner bypass and scope complexity

System owners, admin roles, membership checks, tenant hints, and system-level API keys create a rich model.
They also increase the risk that one path will enforce a weaker subset of the rules.

### Background worker context injection

The system has to be explicit about re-injecting tenant context into workers.
That is correct, but it shows the architecture cost of strong multi-tenancy across async boundaries.

## 3. Edition split - what they got right

### Product reach

Supporting both PostgreSQL standard and SQLite/lite significantly increases the product's addressable use cases:

- server/self-hosted
- desktop/lightweight
- personal/single-tenant

That is strategically smart.

### Parity as a maturity signal

When a subsystem exists cleanly in both PG and SQLite, it is often a good sign that the subsystem is genuinely integrated.

Hooks are a good example.

## 4. Edition split - where the tax appears

### Contract drift risk

As soon as the same conceptual subsystem has:

- PG implementation
- SQLite implementation
- docs
- tests
- product surfaces

the risk of contract drift rises sharply.

### Uneven surface maturity

Some features are stronger under this parity pressure.
Others disappear or drift.

That makes edition split a good diagnostic tool:

- if a feature survives both editions well, it is probably real
- if it does not, it may be narratively broader than operationally mature

### Build-tag and dependency complexity

Edition split often creates:

- duplicated factories
- import constraints
- more compatibility shims
- more test matrix burden

## 5. Architect lesson from both choices together

Multi-tenancy and edition split are both force multipliers.

They multiply:

- product value
- integration options
- maintenance burden
- seam complexity

This is not a reason to avoid them.
It is a reason to be much stricter about contracts.

## What to steal

- tenant as first-class domain concept
- tenant-bound API keys
- per-tenant override model
- using edition parity as a feature-maturity test

## What to avoid

- compatibility-default tenant logic leaking too deeply into hot paths
- owner bypasses becoming a hidden second auth system
- introducing edition split before core contracts are sharp enough

## The distilled lesson

GoClaw proves that multi-tenancy and edition split can create a very strong product.

It also proves that those two choices demand more contract discipline, not less.
