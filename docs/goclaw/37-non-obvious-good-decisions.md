# GoClaw Non-Obvious Good Decisions

## Why this file exists

This file captures the parts of GoClaw that are easy to miss if you only focus on the major orchestration subsystems.

These are not always the headline features.
But they are often the kinds of engineering decisions worth stealing.

## 1. Credentialed exec uses direct-exec mode instead of shell tricks

This is a strong decision.

The `credentialed_exec` path does several things right:

- parses the binary and args without using a shell
- blocks shell operators in the original command string
- distinguishes quoted vs unquoted operator usage
- verifies resolved binary path against config when configured
- supports per-binary deny patterns
- injects secrets only into the child environment

Architect lesson:

- when privileged execution is needed, avoid shell interpretation entirely
- "secure exec" should be a different execution mode, not a shell with more checks

## 2. Shell hardening is more thoughtful than average

Their shell tool has several nice defensive moves:

- Unicode normalization before deny matching
- zero-width character stripping
- deny groups instead of one flat deny list
- always-on path denials
- exemptions evaluated per argument, not per whole string

That last point is especially good.
It avoids the classic "one safe path in a long dangerous command accidentally whitelists everything" trap.

Architect lesson:

- command safety needs normalization and token-aware reasoning, not only regexes

## 3. Identity conventions are documented as a first-class seam

The `agent-identity-conventions.md` document is one of the strongest culture signals in the whole repo.

Why it matters:

- it turns hidden conventions into explicit team knowledge
- it gives review rules, trap zones, tests, and migration context
- it treats identity confusion as a design seam, not a random bug class

Architect lesson:

- when a seam becomes expensive, write an internal design law document for it

## 4. API key auth has several mature details

The API key system is stronger than many self-hosted tools:

- constant-time token comparison for gateway token
- SHA-256 hash storage for API keys
- negative cache with a cap against token spraying
- tenant-bound key model
- last-used tracking updated asynchronously

Architect lesson:

- auth performance and auth abuse resistance should be designed together

## 5. Skills versioning is more disciplined than it first appears

The skills system contains several good engineering habits:

- advisory lock around version creation
- `ON CONFLICT ... DO UPDATE`
- content hashing
- loader `BumpVersion()`
- watcher debounce

This is a nice example of combining:

- correctness
- operator convenience
- low-friction hot reload

Architect lesson:

- managed assets need versioning, not just file watching

## 6. Hooks budget and circuit-breaker thinking is genuinely strong

The hooks subsystem does not stop at "run extra logic".
It includes:

- per-hook timeout
- chain wall-time budget
- per-turn invocation cap
- tenant monthly token budget
- circuit breaker with auto-disable
- dedup key for audit writes

Architect lesson:

- any programmable extension system eventually needs cost control and self-protection

## 7. Publish-time observers are a smart transitional tool

The `eventbus` validation around non-UUID `AgentID` is a good pattern.

It does not hard-break the system immediately.
It adds:

- a runtime observer
- warnings
- a path toward stricter future typing

Architect lesson:

- when lifting a contract in a live system, runtime observers can be an excellent bridge

## 8. They sometimes choose honest gaps over fake certainty

A very valuable signal:

- stale trace recovery is intentionally disabled because the current heuristic would kill legitimate long-running jobs

That is good engineering honesty.

Architect lesson:

- if the safe solution is not ready, it is better to document a gap than to ship a dangerous fake fix

## 9. They treat "dangerous seams" as product concerns, not only code concerns

This appears in:

- changelog entries with architectural context
- troubleshooting sections
- limitations sections
- docs for security and identity trap zones

Architect lesson:

- users and operators need dangerous seam documentation too, not just maintainers

## 10. Importantly good because they reveal taste

The strongest hidden positive signal in GoClaw is not one file.
It is taste:

- when they make a subsystem first-class, they often add limits, audit, docs, and tests

That is worth copying.

## The distilled lesson

Some of GoClaw's best ideas are not the biggest ones.

Steal the taste behind:

- direct-exec for privileged flows
- normalized shell safety
- versioned assets
- budgeted extensions
- observer-driven hardening
- design-law documents for expensive seams
