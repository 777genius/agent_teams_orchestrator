# GoClaw Hooks as a Reference Subsystem

## Why this file exists

Most of this study focuses on GoClaw's weak seams.

This file is the opposite:

hooks are one of the best examples of how they build a new subsystem well.

## Core observation

Hooks are one of the rare areas where:

- domain model
- docs
- security model
- runtime enforcement
- audit
- tests
- edition semantics

mostly agree with each other.

That makes hooks worth studying as a positive reference.

## 1. The subsystem has a real contract

Hooks are not "some callbacks".

They have:

- explicit events
- explicit handler types
- explicit scopes
- explicit store contract
- explicit audit path
- explicit edition gating

This is what first-class extensibility looks like.

Architect lesson:

- extensibility should be a typed subsystem, not a pile of execution shortcuts

## 2. Events are explicit

The hook events are named and modeled:

- `session_start`
- `user_prompt_submit`
- `pre_tool_use`
- `post_tool_use`
- `stop`
- `subagent_start`
- `subagent_stop`

This is much better than "fire arbitrary callbacks around the loop".

Architect lesson:

- event vocabularies should be explicit and finite

## 3. Security is treated as part of the design

Hooks include real security posture:

- edition gating for command hooks
- SSRF protections for HTTP hooks
- encrypted secrets for auth headers
- fail-closed behavior on blocking paths
- circuit breaker
- budget layer for prompt hooks

This is unusually mature for an extensibility surface.

Architect lesson:

- extension points must be designed as attack surfaces from day one

## 4. Operational honesty is strong

They also did several product-grade things right:

- dry-run semantics
- audit table
- observability notes
- troubleshooting docs
- known limitations section

This is important.

A good subsystem is not only one that works.
It is one that explains itself operationally.

## 5. Version-busted cache is a good pattern

Prompt hook decisions use a cache keyed by hook identity and version.

That is a strong choice because:

- edits invalidate decisions automatically
- repeated identical calls are cheap
- the cache contract is honest

Architect lesson:

- version-busting is much better than vague TTL-only freshness for security-sensitive behavior

## 6. Edition parity is a maturity signal

Hooks look serious because they cross the usual maturity checks:

- PostgreSQL support
- SQLite support
- docs
- tests
- RPC/UI path

This is a useful heuristic:

- if a subsystem exists only in one storage mode or one transport, it is probably not fully real yet

## 7. The one smell inside hooks

There is still a notable blemish:

- `store.Stores` keeps `Hooks any` to avoid an import cycle

That is not a fatal problem, but it is a layering smell.

Architect lesson:

- even strong subsystems can leak one bad dependency seam
- do not ignore those seams just because the subsystem is otherwise good

## 8. Why hooks matter strategically

Hooks show that GoClaw can build a subsystem the right way when it chooses to:

- small enough vocabulary
- strong contract
- real enforcement
- real docs
- real ops posture

That makes hooks useful not only as code inspiration, but as proof of what "good" looks like inside this codebase.

## 9. What to steal

- typed extensibility contract
- explicit lifecycle vocabulary
- fail-closed security posture
- dry-run mode
- audit trail
- budget and circuit-breaker thinking
- docs that include troubleshooting and limitations

## 10. What not to copy blindly

- the `Hooks any` import-cycle workaround
- assuming every other extension surface in GoClaw is as mature as hooks

## The distilled lesson

Hooks are one of the best positive reference implementations in GoClaw.

If you want one subsystem to imitate, choose hooks much sooner than modes, auth seams, or UI sync.
