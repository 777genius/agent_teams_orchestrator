# GoClaw Auth, Policy, and Access

## Core claim

GoClaw has a powerful permission model, but weak boundary discipline around that model.

## What is good

- there is a real policy layer
- tenant scoping exists
- role concepts exist
- sender-sensitive permission paths exist
- there are targeted hardening fixes in some important seams

## What is weak

### 1. Policy is too opaque

The system is powerful enough that it becomes hard to explain:

- who can do what
- why a request was blocked
- which layer made the decision

### 2. Viewer-default behavior is too broad

A meaningful part of the public method surface still falls back to coarse default classification more than it should.

### 3. WS path is mostly coarse-grained

Websocket enforcement leans heavily on role checks.
The finer scope model is not equally central in the hottest path.

### 4. Human access is spread across layers

Access control is not packaged into one mandatory boundary.
Instead it is split across:

- router
- handlers
- store filtering

That is risky, because forgetting one layer can still expose behavior.

### 5. Store mostly enforces tenant scope, not full human/team access

Tenant isolation is stronger than team-user authorization discipline.

### 6. Fail-open habits still appear

The codebase still shows availability-first permissiveness in places that should be stricter.

## Simplest summary

The permission model is more powerful than the enforcement story is clean.

## Practical lesson

Good authorization needs:

- one typed decision boundary
- one clear subject model
- one clear resource model
- one clear fallback model

not:

- router check here
- handler check there
- store assumption somewhere else
