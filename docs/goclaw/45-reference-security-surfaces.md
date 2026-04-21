# GoClaw Reference Security Surfaces

## Why this file exists

GoClaw's overall authorization model is weaker than it should be.

But that does not mean every security-adjacent subsystem is weak.
This file captures the local security surfaces that are actually worth studying as positive references.

## 1. Hook command handler has good default posture

The command hook handler does several things right:

- edition policy is rechecked at dispatch time
- command comes from admin-configured hook data, not arbitrary event input
- event payload is passed on stdin as JSON
- environment is isolated by default
- only explicit `allowed_env_vars` are forwarded

That is a good pattern:

- dangerous extensibility
- but with default isolation

Architect lesson:

- programmable hooks should start from zero ambient authority and add only explicit capabilities

## 2. Hook HTTP handler is one of the strongest local security designs in the repo

This path combines multiple good practices:

- SSRF validation before request construction
- pinned-IP dialing to resist DNS rebinding
- no redirects
- encrypted auth headers at rest
- 5xx retry-once behavior, but no retry on 4xx
- 1 MiB response cap

This is a strong example of:

- safe outbound network capability
- without pretending that "HTTP callback" is harmless just because it is admin-configured

Architect lesson:

- any outbound network hook is a security boundary, not just an integration feature

## 3. ACP tool bridge is a good small policy surface

The ACP tool bridge uses a surprisingly clean permission model:

- `approve-all`
- `approve-reads`
- `deny-all`

This is not enough for the whole product.
But it is a good local policy expression:

- small
- understandable
- tied to actual capability classes

Architect lesson:

- when exposing remote agent power, prefer a tiny set of named capability modes over a large option matrix

## 4. But permission-mode defaults still need strict review

The good part of ACP permission modes has a caveat:

- unknown modes fall through to approve

That is a local example of a recurring GoClaw risk:

- a good concept
- weakened by permissive default behavior

Architect lesson:

- if you use named permission modes, unknown values should fail closed

## 5. Package and runtime surfaces show good "blast radius" thinking

The package management endpoints are notable because they treat package install as dangerous system power.

Protections include:

- role gating
- master-scope gating
- per-user rate limiting
- repo allowlist for GitHub release browsing
- 404 instead of 403 to avoid allowlist enumeration

Architect lesson:

- system mutation surfaces should be reviewed by blast radius, not by how small the handler looks

## 6. GitHub installer is a useful example of constrained external intake

The GitHub installer has several good intake controls:

- strict spec parsing for `github:owner/repo[@tag]`
- org allowlist
- asset selection by OS/arch
- host allowlist for downloads
- ELF validation
- atomic manifest save
- serialized final disk-write phase

Architect lesson:

- third-party binary intake should be explicitly constrained at every layer: identifier, source, asset type, platform, and write phase

## 7. Security-positive allowlists appear in several good places

Good local allowlist usage appears in:

- hook env pass-through
- GitHub org/download host restrictions
- browser and file-fetch host restrictions
- bootstrap context file allowlists for slim modes

This is worth stealing, with one warning:

- allowlists are excellent when used to shrink power
- they are dangerous when empty means "effectively unrestricted" without strong operator clarity

Architect lesson:

- allowlists work best when their empty/default behavior is explicit and easy to audit

## 8. Protective friction is stronger when tied to capability class

GoClaw is strongest when friction matches capability class:

- hooks → timeouts, budgets, circuit breaker
- packages → scope + rate limit
- shell/exec → deny patterns + approval
- HTTP hooks → SSRF-hardened client

That is a reusable review rule.

Architect lesson:

- every dangerous capability class should have its own friction model, not one generic "security layer"

## The distilled lesson

GoClaw's overall security boundary discipline is mixed.
But several local security surfaces are worth copying as references:

- hook command env allowlist
- SSRF-safe outbound HTTP
- small named permission modes
- blast-radius-aware package gating
- constrained third-party binary intake

Just keep the core warning in mind:

- local security quality does not remove the need for one hard global authorization contract
