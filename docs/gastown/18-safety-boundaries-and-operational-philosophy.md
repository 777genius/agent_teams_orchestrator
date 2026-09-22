# Gastown Safety, Boundaries, and Operational Philosophy

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file focuses on the part of Gastown that matters most for trust:

- how it thinks about safety
- how it handles destructive boundaries
- where its operational philosophy is strong
- where that philosophy still fails to become hard protection

## Executive summary

Gastown understands many of the right safety ideas:

- fail closed
- preserve work
- veto cleanup when uncertain
- keep worker identity separate from ephemeral processes
- prefer explicit source-of-truth rules

But the system still struggles to turn those ideas into a consistently safe
runtime because boundaries remain too implicit in several critical places.

## 1. Strong safety instincts

### A. Cleanup vetoes are the right kind of safety primitive

Gastown has a healthy instinct that cleanup should be vetoable when the system
is not sure it is safe to destroy or reset something.

Examples:

- ACP session active -> veto cleanup
- stale PID cleanup is explicit, not hidden inside liveness checks
- persistent polecat design tries to preserve sandbox instead of reflexively
  nuking it

Architect rating: `🎯 9.1   🛡️ 8.9   🧠 4`

### B. Fail-closed thinking appears in the right places

Good instincts show up in:

- proxy command validation
- sandbox boundary design
- some schedule/startup checks
- worktree integrity checks

This is one of the better parts of Gastown's philosophy.

Architect rating: `🎯 9.2   🛡️ 9.1   🧠 4`

### C. "Preserve the sandbox" is a strong trust-building idea

The persistent polecat model respects a crucial operational truth:

- users fear silent destruction more than they fear some extra cleanup work

Defaulting toward preserved worktrees and explicit `nuke` is the correct
direction.

Architect rating: `🎯 9.3   🛡️ 8.8   🧠 5`

### D. Source-repo isolation is the right kind of product rule

One of Gastown's better public instincts is:

- keep runtime state and generated settings out of customer source repos
- use the mayor clone and runtime directories as the real orchestration surface
- treat source-repo cleanliness as part of trust, not as cosmetic hygiene

This is the right direction for any tool that edits code but also carries its
own durable metadata and operational files.

Architect rating: `🎯 9.1   🛡️ 8.9   🧠 4`

### E. Consent boundaries are part of operational safety

One of the most important recent product-trust lessons is that an orchestrator
must make upstream-facing or self-improving work explicit.

Issue `#3649` is useful here because it highlights a deeper boundary:

- whose repository is being changed
- whose credits are being spent
- whose GitHub identity is acting
- whose goals the system is currently serving

That is not merely UX disclosure.

It is an operational-safety boundary. If the answer is ambiguous, the system is
already too implicit.

Architect rating: `🎯 9.6   🛡️ 9.4   🧠 4`

## 2. Where safety breaks down

### A. Repo boundary ambiguity is still too soft

Issues:

- `#716`
- `#824`
- `#885`

These are not small bugs.

They reveal that:

- cwd and repo targeting are not strict enough
- nested repo layouts can confuse agents
- destructive or sync-related behavior can cross the wrong boundary

This is the biggest trust-risk seam in the product.

Architect warning: `🎯 10   🛡️ 9.7   🧠 6`

### B. Some destructive flows still rely too much on interpretation

Completion, cleanup, and sync behavior still involve a lot of contextual
interpretation:

- which repo is intended
- which branch lifecycle applies
- whether merge/push actually completed cleanly
- whether cleanup is safe now or later

That makes safety policy more implicit than it should be.

Architect warning: `🎯 9.7   🛡️ 9.3   🧠 7`

### C. Observer-first recovery can hide unsafe ambiguity

Patrol and reconciliation are strong as safety nets, but expensive when they
also become the normal path for recognizing lifecycle truth.

The danger is not only performance.

The danger is delayed or misclassified safety decisions.

Architect warning: `🎯 9.4   🛡️ 9.0   🧠 6`

## 3. Good operational philosophy to keep

### Preserve by default, destroy explicitly

This is one of Gastown's best instincts.

Good rule:

- successful work should usually transition to reusable idle state
- destructive cleanup should require explicit confidence or explicit command

### Separate observation from decision where possible

Gastown often tries to do this:

- Go transports facts
- agents or higher layers interpret what matters

This is healthy when combined with strong invariants.

### Name the source of truth

Their repeated "source of truth" language is valuable.

Systems become safer when every critical fact has one clearly named owner.

### Keep safety checks explicit

The best parts of the code avoid hidden side effects in "is active?" style
queries and make cleanup a distinct action.

That is a good operational habit.

## 4. Bad operational philosophy to avoid

### Do not let safety depend on cwd folklore

An orchestrator that can edit code or run git commands should never rely on the
agent "probably being in the right repo".

Workspace identity must be explicit.

### Do not let destructive actions target inferred workspaces

If the target workspace is ambiguous, the correct action is to block, not guess.

### Do not mix preserved-work philosophy with ambiguous truth planes

Persistent sandboxes are good.

But preserved work only builds trust if:

- identity is unambiguous
- completion is unambiguous
- cleanup ownership is unambiguous

Otherwise preserved state becomes another ambiguity surface.

### Do not let safety policy live partly in docs and partly in runtime folklore

Gastown's docs often state the right safety intent.

The runtime does not always enforce it uniformly.

That gap is what creates trust-breaking bugs.

### Do not let self-improvement or upstream contribution ride on user identity by default

If a system can:

- spend the operator's model credits
- use the operator's GitHub account
- open or update upstream PRs

then any self-improvement or upstream-facing workflow must be explicit opt-in
with visible scope.

Otherwise the orchestrator crosses a product-trust boundary even if the code
path is technically valid.

## 5. Architect-level safety rules inspired by Gastown

These are the best safety rules to carry forward:

- Explicit workspace identity beats cwd inference
- Destructive actions must fail closed on ambiguity
- Cleanup checks and cleanup actions must be separate
- Session death must not imply worker death
- Preserve work by default when uncertain
- Keep runtime metadata and generated settings out of customer source repos by default
- Route destructive authority through a small number of explicit contracts
- Keep security and sandbox rules at the transport boundary, not only in prompts
- Use explicit allowlists and capability contracts
- Treat consent over credits, GitHub identity, and upstream actions as a hard boundary

## 6. What Gastown proves

Gastown proves two things at once:

1. A serious orchestration system must think deeply about safety, preservation,
   and cleanup.
2. If boundary rules are not made explicit in the substrate, even good safety
   philosophy will leak into expensive, inconsistent behavior.

## Final takeaway

Gastown's safety philosophy is often better than its safety substrate.

That makes it a very good project to learn from if you want:

- the right instincts
- but not the wrong implementation shortcuts
