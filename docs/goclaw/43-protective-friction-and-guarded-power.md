# GoClaw Protective Friction and Guarded Power

## Why this file exists

Some of GoClaw's better ideas are not about orchestration flow.
They are about how dangerous power is exposed.

This file looks at places where the system applies useful friction:

- rate limits
- scope guards
- allowlists
- permission modes
- SSRF-safe outbound hooks

These patterns are worth stealing because they protect shared infrastructure and high-risk capabilities.

## 1. Package management is guarded better than many admin surfaces

The package endpoints have several good controls:

- read paths allow viewer+
- install/uninstall require admin
- install/uninstall also require master scope
- per-user write rate limiting exists
- GitHub release browsing has its own separate rate limiter
- org allowlist mismatches return `404`, not `403`, to avoid enumeration

This is a good example of recognizing that:

- package install is not just a convenience action
- it is a supply-chain and availability boundary

Architect lesson:

- dangerous admin surfaces should have both role checks and scope checks

## 2. Shared upstream quotas are treated as an architectural concern

The GitHub releases picker and package write paths use explicit per-key token-bucket limiters.

Important details:

- keying prefers authenticated identity over user-supplied header
- stale limiter entries are evicted without background goroutine leakage
- read and write endpoints have different budgets

This is a quietly strong decision.

Architect lesson:

- any product surface that fronts a shared upstream quota deserves its own limiter and its own contract

## 3. SSRF hardening in hook HTTP handlers is genuinely strong

The HTTP hook path is one of the better security-minded subsystems:

- validates URL scheme
- rejects loopback, private, link-local, multicast, unspecified ranges
- resolves host once and pins the IP
- re-checks pinned IP at dial time
- disables redirects
- decrypts auth headers only at send time
- retries once on 5xx, but not on 4xx

This is not perfect overall platform security.
But it is strong local design.

Issue `#673` is important here.
It shows the classic tradeoff:

- strict SSRF posture is good
- but local-provider workflows can make a globally safe rule too rigid

Architect lesson:

- security controls should be strict, but the exception model must be explicit and capability-aware

## 4. Permission modes are a useful pattern when they stay honest

GoClaw uses permission modes in several places:

- ACP bridge: `approve-all`, `approve-reads`, `deny-all`
- exec approval: `full`, `allowlist`, `deny`

This is a good pattern because it gives operators a small, understandable policy surface instead of dozens of booleans.

Architect lesson:

- guarded power is easier to reason about when policy is expressed as a small number of named modes

## 5. But unknown or legacy values must not silently widen access

The useful side of permission modes only holds if:

- unknown values fail closed
- compatibility branches do not widen behavior

This is where GoClaw becomes less trustworthy in other seams.

Architect lesson:

- mode-based control is only strong when invalid or legacy modes narrow behavior, not widen it

## 6. Protective friction is good when it blocks dangerous work, not normal use

Some good examples:

- package installs require approval or stronger scope
- GitHub-backed package browsing is rate limited
- webhook HTTP calls are SSRF-hardened
- direct exec avoids shell

The bad version of the same idea appears when friction lands in the wrong place:

- setup friction around PostgreSQL and Docker
- local-provider setup blocked by too-rigid SSRF assumptions before exception handling improved

Architect lesson:

- put friction at dangerous power boundaries, not at ordinary setup boundaries

## 7. One of the best hidden patterns: protect the blast radius, not only the endpoint

What GoClaw sometimes gets right:

- install/uninstall are restricted because they can affect the whole server
- hook HTTP is hardened because admins can configure it, which still makes it dangerous
- per-user or per-tenant limits are added where a single actor could hog shared resources

That is good system thinking.

Architect lesson:

- review power surfaces by blast radius, not by how "small" the endpoint looks

## The distilled lesson

Steal these patterns:

- master-scope guards on global mutations
- separate limiters for shared-upstream surfaces
- SSRF-safe HTTP clients with pinned-IP dialing
- small named permission modes for dangerous capabilities

Keep this warning in mind:

- protective friction is only good when it sits at the real danger boundary
- if it drifts into ordinary workflows, it becomes product pain instead of platform safety
