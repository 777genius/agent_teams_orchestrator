# GoClaw Identity and Context

## Core claim

GoClaw does not have a naive identity model.
It has a sophisticated identity model that is weakly encapsulated.

That is more dangerous.

## What they understand correctly

They clearly understand that these are not the same thing:

- actor
- sender
- scope
- tenant
- session identity
- chat/thread routing identity

This is a real strength in architectural awareness.

## Why it is still weak

That knowledge is not packaged into one tight contract.
It is spread across:

- store context
- tool context
- run request fields
- task metadata
- event payloads
- ingress wrappers

## The three identity lanes

The cleanest way to read their model is:

- **scope lane**
  - who this conversation or task is scoped to
- **audit lane**
  - who really did the action
- **permission lane**
  - whose permissions should be checked

These are all useful distinctions.
The problem is that they are not carried through one canonical envelope.

## `UserID` semantic drift

One of the strongest warning signs is that `UserID` no longer has one stable meaning.

Depending on the path, it can mean:

- group scope
- actor-derived identity
- chat fallback
- carried origin value from an earlier phase

Once a field keeps its name but not its semantic stability, future bugs become much easier to create.

## Distributed propagation problem

The code shows this seam is systemic:

- many calls to `TenantIDFromContext(...)`
- many calls to `WithTenantID(...)`
- many calls to raw `UserIDFromContext(...)`
- far fewer actor-aware callsites

The architecture already knows it needs actor/sender/scope distinction.
The weakness is that too much correctness depends on each wrapper remembering the right subset.

## Key issue cluster

This seam explains the family of bugs around:

- `#557`
- `#560`
- `#734`
- `#915`

These are not isolated bugs.
They are variations of one class:

- one path forgot one critical identity fragment

## Practical lesson

Do not carry identity through:

- a bag of context values
- ad hoc metadata
- path-specific fixes

Package it in one typed envelope that all boundaries must preserve.
