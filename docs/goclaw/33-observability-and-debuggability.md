# GoClaw Observability and Debuggability

## Core observation

GoClaw is better than average at collecting runtime signals.
It is weaker at turning all of those signals into one coherent debugging truth.

That distinction matters.

## 1. What they do well

### Internal tracing is a real subsystem

This is not cosmetic tracing.

Good signals:

- explicit collector
- trace rows and span rows
- buffered async flushing
- aggregate updates
- status broadcasting
- retention and pruning
- optional exporter abstraction

Architect lesson:

- tracing is strongest when it is part of the runtime design, not a log wrapper

### Status broadcasting is a strong idea

Trace status is pushed immediately after successful status writes.
This is a good pattern because:

- it reduces polling pressure
- it gives operators low-latency visibility
- it treats status as an event worth broadcasting immediately

Architect lesson:

- important lifecycle changes should have a low-latency path, not wait behind generic flush cadence

### Changelog and docs preserve debugging knowledge

GoClaw documents incidents and fixes with architectural context surprisingly well.

That is a strong engineering culture signal.

Architect lesson:

- debugging memory should live in docs and changelog, not only in maintainer heads

## 2. Where observability gets weaker

### Tracing is strong, but not fully sealed

The collector itself is thoughtful, but even there you can see a useful warning sign:

- stale trace recovery is intentionally disabled in `Start()`
- the code comments explain why: current recovery heuristic could kill legitimate long runs

This is honest engineering.
But it also means:

- some failure recovery gaps are consciously accepted
- observability and lifecycle truth are not fully closed in this seam yet

Architect lesson:

- it is better to document a deliberate gap than to pretend a dangerous recovery path is safe

### More signal does not automatically mean better debugging

GoClaw has:

- tracing
- bus events
- websocket events
- audit tables
- UI panels

But these do not always reconstruct the same truth.

That means operators may have:

- enough data
- but not one authoritative debugging path

Architect lesson:

- the value of observability is not how many signals exist
- it is how clearly they converge on one explanation

### Audit and UI visibility still have holes

Issue `#433` about team audit logs not being viewable is revealing.
The backend may know things.
The product still fails if operators cannot inspect them well.

Issue `#762` about traces UI also matters:

- even when tracing exists
- poor surfacing weakens the practical value of observability

Architect lesson:

- debugging is a product surface, not only a backend feature

## 3. Strong patterns worth stealing

- explicit tracing collector
- exporter abstraction
- immediate status broadcast for important lifecycle changes
- documented debug caveats
- treating observability as a real subsystem

## 4. Dangerous patterns to avoid

- multiple signal systems that do not converge cleanly
- assuming raw traces automatically make operators effective
- audit visibility existing in storage but not in operator workflows
- tracing that looks stronger than its recovery semantics really are

## 5. External observability pressure is itself a signal

Issue `#611` asking for LangSmith export is not just a feature request.
It reveals something deeper:

- operators want a stronger debugging surface than the native product currently gives them

That is an architectural signal:

- when users ask for external observability, the internal one may be rich but not convenient enough

## The distilled lesson

GoClaw shows a mature instinct:

- collect the right signals

But it also shows an important limit:

- signals are not enough without one coherent debugging truth and a strong operator-facing surface.
