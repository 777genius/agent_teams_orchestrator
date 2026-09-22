# GoClaw Subtle Risks and Anti-Patterns

## Why this file exists

Some of GoClaw's most dangerous mistakes are not loud architectural disasters.
They are subtle patterns that can look reasonable in local code review.

This file captures those patterns.

## 1. Strong docs can hide weak runtime closure

This is one of the easiest traps to miss.

GoClaw often has:

- good docs
- good changelog notes
- good design intent

But some runtime surfaces still lag behind that intent.

Examples:

- custom tools docs/runtime drift
- reviewer vocabulary ahead of full enforcement
- security narrative stronger than some default behaviors

Architect lesson:

- never let documentation quality be mistaken for contract maturity

## 2. Import-cycle workarounds in core-adjacent seams are warning signs

Example:

- `store.Stores.Hooks any`

This is not catastrophic by itself.
But it is exactly the kind of compromise that tends to spread if left unexamined.

Architect lesson:

- core-adjacent `any` seams are usually telling you where package boundaries are wrong

## 3. Drop-on-full behavior is acceptable only when made explicit

GoClaw drops:

- events in `eventbus` when the queue is full
- spans in tracing when the buffer is full
- some bus messages on non-blocking publish paths

Bounded queues are fine.
The subtle risk is when the system treats dropped work as an implementation detail instead of part of the contract.

Architect lesson:

- if something may drop under pressure, that fact belongs in the subsystem contract

## 4. Compatibility defaults create slow-moving architectural debt

The dangerous pattern is not compatibility itself.
It is long-lived compatibility in hot paths:

- no token -> full-access mode
- owner/admin bypass branches
- old identifier fallbacks
- legacy session or config bridges

Each local exception seems small.
Together they become architectural texture.

Architect lesson:

- every compatibility branch should have an expiry plan

## 5. Too many local caches create system-wide honesty problems

GoClaw has many good local caches.
The subtle risk is that:

- each one is locally justified
- the whole product ends up with several freshness models

That creates:

- stale behavior
- invalidation drift
- debugging ambiguity

Architect lesson:

- local cache quality does not guarantee global freshness coherence

## 6. Write-behind and best-effort surfaces are dangerous near user truth

Some surfaces are best-effort or delayed:

- session save paths have historically produced stale persistence issues
- denormalized counts and UI-facing projections can lag
- retry queues and broadcaster paths are not always unified with durable state

The subtle risk:

- the backend is "mostly right"
- but the user-visible truth is still wrong enough to erode trust

Architect lesson:

- best-effort is acceptable only when the product contract does not promise immediacy

## 7. Security posture can be undermined by availability shortcuts

GoClaw has some good security work.
The subtle risk is where availability-first or compatibility-first defaults weaken it:

- no token full-access mode
- some fail-open cache behavior
- some bypass or fallback branches

Architect lesson:

- availability shortcuts should be allowed only where the domain truth is non-authoritative

## 8. Sophisticated systems can still be semantically under-typed

One of the hardest risks to notice:

- the system can look advanced
- and still rely on too many `string` fields and metadata conventions for core meaning

Examples:

- `UserID`
- `RunKind`
- event payloads carrying typed meaning in loosely structured form

Architect lesson:

- complexity is not maturity
- complexity without tighter contracts is usually just expensive flexibility

## 9. Better observability does not guarantee better operability

GoClaw has rich traces and events.
But operators still ask for more usable observability surfaces.

That means:

- raw signal quantity is not enough
- debugging coherence still matters

Architect lesson:

- every observability subsystem should be judged by how fast an operator can explain a failure

## 10. Broad ambition can normalize hidden costs

When a system does many things well enough, teams can get used to:

- more ingress paths
- more wrappers
- more metadata
- more invalidation paths
- more compatibility logic

This normalizes maintenance tax.

Architect lesson:

- broad product ambition should increase discipline, not relax it

## The distilled lesson

GoClaw's subtle risks are dangerous because they often look like reasonable local tradeoffs.

Treat the following as review alarms:

- docs stronger than runtime closure
- `any` in core-adjacent seams
- silent drop behavior
- long-lived compatibility branches
- too many freshness models
- sophisticated but semantically under-typed contracts
