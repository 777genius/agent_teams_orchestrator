# GoClaw Best Practices by Architect Role

## Why this file exists

Different architects care about different truths.

This file translates the GoClaw study into role-specific lessons.

## 1. As a domain architect

### Take

- explicit task lifecycle
- explicit status vocabulary
- repair workflows as domain logic
- domain actions stronger than generic patching

### Reject

- hidden state transitions
- generic patch maps in important state flows
- domain truth split across storage and UI projection hacks

## 2. As a runtime architect

### Take

- scheduler as a subsystem
- stale recovery workers
- post-turn reconciliation
- cancellation and draining as named concepts

### Reject

- soft run modes
- path-specific execution envelopes
- cancellation that does not fully stop side effects

## 3. As a contract architect

### Take

- typed store contracts
- version-busted configuration caches
- explicit event vocabularies
- changelog as contract history

### Reject

- overloaded semantic fields like `UserID`
- one concept spread across context, metadata, request, and UI payload
- `any`-typed seams in core-adjacent contracts

## 4. As a security architect

### Take

- hook security posture
- tenant-bound credentials
- explicit SSRF thinking
- negative cache caps for auth-related paths

### Reject

- permissive defaults in auth entry paths
- auth checks split across router, handler, and store
- compatibility exceptions that survive too long in security-sensitive seams

## 5. As a platform architect

### Take

- one shared engine reused across many surfaces
- hooks as a serious extension surface
- skills as managed assets
- tenanting as a platform primitive

### Reject

- product surfaces whose runtime path is not truly first-class
- extension points advertised before end-to-end closure
- platform breadth growing faster than contract maturity

## 6. As an operations architect

### Take

- dirty schema detection
- tracked data hooks
- repair loops for stale state
- explicit recovery messaging

### Reject

- setup paths that teach operators architecture only through failure
- deployment flows that mix operator and developer concerns
- observability that exists in storage but not in practical workflows

## 7. As a frontend architect

### Take

- task board as first-class coordination plane
- low-latency status events for important lifecycle changes

### Reject

- multiple client truth models for one domain
- each screen inventing its own convergence logic
- UI state that is richer or looser than backend truth

## 8. As a chief architect

### The single biggest thing to copy

- durable orchestration core

### The single biggest thing to ban

- distributed semantic transport through wrappers and metadata

## The distilled lesson

GoClaw is useful because it shows both sides clearly:

- what a strong orchestration center looks like
- what happens when the surrounding contracts are not equally strict
