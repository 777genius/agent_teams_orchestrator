# GoClaw Run Context Consolidation and Carrier Drift

## Why this matters

One of the biggest architectural questions in an orchestrator is:

- where does the execution contract actually live?

If the answer is:

- partly in raw context keys
- partly in typed structs
- partly in fallback helpers
- partly in serialized metadata

then the system is still paying distributed-contract tax.

GoClaw is interesting here because it clearly **knows** this problem and is already trying to fix it.

## What they get right

### 1. `RunContext` is the right instinct

They introduced a typed `store.RunContext` that consolidates loop-injected data into one struct.

That is a strong architectural move.

It captures:

- identity
- tenant
- sender
- workspace
- team/task/delegation context
- tool settings
- sandbox config
- sharing flags

This is exactly the sort of move a mature system should make after suffering context sprawl.

### 2. The intent is explicit in code comments

Their own comments are architecturally honest here:

- replace many individual `context.WithValue` calls
- improve readability
- make it easier to add new scope fields
- give consumers one typed snapshot

That matters.

It means this is not accidental refactoring.
It is an explicit attempt to heal a seam.

### 3. Tool accessors can already fall back to `RunContext`

Many tool context accessors now do:

- explicit ctx key first
- `RunContext` fallback second

This makes subagent inheritance and detached execution easier without forcing every callsite to manually copy every field again.

As a transitional move, this is reasonable.

### 4. `RunContext` is broad enough to be useful

A weak typed envelope is not enough.

Here, the struct is broad enough to matter:

- workspace paths
- team IDs
- delegation IDs
- agent tool key
- tenant allowed paths
- builtin tool settings
- sharing flags

So this is not just cosmetic cleanup.

It is a real attempt at consolidating runtime truth.

## What is risky

### 1. Old carriers are still fully alive

This is the central warning.

Even after introducing `RunContext`, the runtime still actively injects many old carriers:

- `WithUserID`
- `WithSenderID`
- `WithToolWorkspace`
- `WithToolTeamWorkspace`
- `WithSharedMemory`
- `WithSharedKG`
- `WithSharedSessions`
- many tool-specific context keys

That means the system now has:

- a new consolidated carrier
- old individual carriers
- accessors that can read from both

This is a classic dual-carrier migration seam.

### 2. `RunContext` is built from legacy values, not the other way around

This is the deeper issue.

The code currently resolves many values using older helpers first, then packages the result into `RunContext`.

So architecturally:

- `RunContext` is becoming the typed snapshot
- but not yet the single source of truth

That means if old semantics drift, `RunContext` can inherit drift instead of eliminating it.

### 3. Different subsystems can still read different carriers

Some code paths read:

- raw ctx keys

Others read:

- `RunContext`

Others still read:

- accessors that silently choose between the two

This is convenient.
It is also dangerous because it becomes harder to prove:

- which carrier is authoritative
- whether a field was copied correctly
- whether a later mutation or omission matters

### 4. The pattern can silently extend context sprawl instead of ending it

If every new field gets:

- a raw ctx key
- a `RunContext` field
- a fallback accessor

then the migration is not reducing semantic surface.
It is duplicating it.

That is the architectural failure mode to watch.

## What to steal

- The decision to create one typed execution envelope
- The decision to serialize a broad runtime snapshot once per run
- Transitional helper patterns that let tools consume the new envelope incrementally

## What to avoid

- Leaving old and new carriers alive for too long
- Letting `RunContext` become a mirror instead of the authority
- Adding every new field to both the old and new contract indefinitely
- Making fallback accessors permanent architecture

## The distilled lesson

GoClaw shows a very important mid-migration lesson:

- the move toward a typed run envelope is correct
- but the migration is only successful if the old carrier model actually dies

So the real takeaway is:

- **steal the consolidation move**
- **avoid carrier duality becoming permanent**
