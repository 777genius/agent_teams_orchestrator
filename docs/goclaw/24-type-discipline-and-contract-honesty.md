# GoClaw Type Discipline and Contract Honesty

## Core observation

One of the deepest lessons from GoClaw is about contract honesty.

A system becomes expensive when:

- names stop matching semantics
- labels stop matching enforcement
- types stop matching meaning
- interfaces hide real coupling

GoClaw has several strong examples of this problem.

## 1. `UserID` is no longer one thing

The name says "user".
The runtime uses it as:

- shared group scope
- actor-derived identity
- chat fallback
- origin-carried envelope value

This is semantic overload.

Architect lesson:

- one field name should map to one stable concept
- async boundaries make overloaded names especially dangerous

## 2. `RunKind` sounds stronger than it is

The name suggests a real execution contract.
In practice:

- tools sometimes see it
- tracing/UI sometimes see it
- wrappers add extra meaning through other flags

That means `RunKind` is not contract-honest.

Architect lesson:

- if a concept is called a "mode", it should really constrain behavior

## 3. `store.Hooks any` is a useful red flag

This line is a small but important smell:

- `Hooks any` to avoid an import cycle

It is pragmatic.
It also means the architecture has hit a boundary where package structure no longer matches dependency intent cleanly.

That does not make the feature bad.
It does mean the seam is under structural pressure.

Architect lesson:

- if you need `any` to carry a subsystem through a central container, you should re-check your layering

## 4. Sentinel UUIDs are powerful but costly

GoClaw uses sentinel IDs in several places, especially around tenant/global concepts.

This can be a reasonable technique.
But it raises the contract cost:

- special-case logic
- extra validation
- more drift risk between "nil", "sentinel", and "real" values

Architect lesson:

- sentinel values are fine only when tightly bounded
- do not let them become silent semantic carriers across many packages

## 5. Backward-compat names linger in live paths

Examples include:

- deprecated aliases
- legacy session formats
- old config fields
- soft bridges

This keeps migrations smoother.
It also weakens contract honesty because the current model has to keep speaking in old dialects.

## 6. Generic maps weaken strong domains

The codebase often has strong domain objects in some places and `map[string]any` patch/update paths in others.

This creates two worlds:

- explicit lifecycle world
- generic patch world

That is dangerous because it can make production behavior weaker than domain vocabulary suggests.

## 7. Context as semantic transport is powerful and risky

Context is used for:

- tenant
- user
- sender
- role
- agent
- workspace
- session
- tool routing
- run kind

Context is a fine transport for execution-local data.
It becomes risky when it carries core business meaning that must survive async path variation.

Architect lesson:

- use context for transport
- do not make it the only authoritative semantic envelope

## 8. Comments often reveal the real contract

GoClaw comments are frequently more honest than the names.

Examples:

- "backward compat"
- "bypass"
- "not yet active"
- "legacy"
- "safety net"

This is useful because the maintainers are not hiding the complexity.
It is also a signal that contract debt is real.

## Contract-honesty scorecard

Strong:

- task statuses
- lifecycle method names
- hook store model
- many docs about identity traps

Weak:

- `UserID`
- `RunKind`
- some update paths
- some auth defaults
- some extension-surface narratives

## What to steal

- explicit docs around dangerous semantic fields
- honest comments about trap zones
- strong domain names for lifecycle states

## What to avoid

- letting one field carry multiple principals
- letting one label pretend to be a contract
- using `any` and generic maps at central boundaries too freely

## The distilled lesson

A mature orchestrator should be semantically strict:

- names mean one thing
- modes mean one thing
- fields mean one thing
- contracts are readable from types, not only from comments
