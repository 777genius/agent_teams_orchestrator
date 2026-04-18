# GoClaw Critical Anti-Patterns to Avoid

## Core principle

GoClaw's most dangerous problems are not "bad code".
They are anti-patterns that make future hardening expensive.

## 1. Distributed correctness through propagation chains

This is the biggest red flag.

If correctness depends on carrying the right subset of:

- sender
- actor
- role
- session
- local key
- trace parent
- run mode

through many wrappers, the system will keep needing propagation patches.

Red-flag sign:

- commit history looks like sender -> role -> dashboard -> deferred path -> routing

## 2. Modes as labels instead of contracts

If `announce`, `delegate`, and `notification` do not deterministically define:

- identity
- tools
- persistence
- tracing
- side effects

then they are not real modes.
They are labels.

That is dangerous because teams start trusting names that do not enforce semantics.

## 3. Split truth between durable state, events, and UI

If backend truth, event truth, and UI truth are all separately reconstructed, stale behavior becomes systemic.

This is one of the most expensive anti-patterns in orchestration products.

## 4. Permission checks smeared across layers

If router, handler, and store all partially own authorization, forgetting one check becomes easy.

This is especially bad for:

- team membership
- RBAC
- cross-session access
- group sender-sensitive behavior

## 5. Availability-first fail-open in sensitive seams

Fail-open can be reasonable in low-risk areas.

It is dangerous when it touches:

- permissions
- workspace boundaries
- identity restoration
- execution-sensitive paths

## 6. Generic patch side channels around strong lifecycle APIs

If the domain has explicit lifecycle methods, do not bypass them with weak generic patch helpers for critical behavior.

That produces contract drift between:

- runtime
- production store
- mocks
- tests

## 7. Subscriber-derived audit as if it were first-class truth

Audit is useful.
Audit that is produced later by subscribers is not the same as canonical event truth.

Do not confuse the two.

## 8. Implicit QoS via helper choice

If reliability depends on whether a callsite used one helper or another, the system does not really have an admission contract.

That is a hidden anti-pattern.

## 9. Provider adapters that can soften failure

If an adapter can turn:

- hard failure

into:

- strange success
- empty completion
- bad finish reason

then the entire orchestrator above it becomes less trustworthy.

## 10. Growing a gravity-well package

When one package slowly absorbs:

- domain meaning
- helper logic
- conventions
- cross-cutting context rules

it becomes expensive to reason about and hard to untangle.

## 11. Patching symptoms harder than sealing contracts

Tests that prove:

- this sender is denied
- this role bypasses
- this path keeps local_key

are good.

But if there is still no test that proves:

- one canonical execution contract

then the architecture is still symptom-driven.

## 12. Letting product breadth outrun seam maturity

GoClaw grew broad quickly:

- channels
- providers
- teams
- traces
- approvals
- dashboard

That creates real product value, but it also amplifies every weak seam.

## 13. Letting docs promise a stronger contract than runtime enforces

This is a quieter anti-pattern, but still expensive.

Examples include:

- documented APIs that are not actually wired
- reviewer or approval vocabulary that is ahead of hard enforcement
- config docs that do not match runtime structure exactly

This creates support debt and false confidence.

## 14. Using prompt plumbing as hidden architecture

When system prompt assembly, orchestration mode injection, and context-file selection become part of the correctness path, the runtime gets harder to reason about.

Prompt plumbing should support architecture, not secretly carry it.

## 15. Keeping chronic hot spots hot while adding new breadth

If gateway, loop, resolver, system prompt, and context plumbing remain some of the hottest files in the repo, the platform is still paying high tax on its outer shell.

Adding more breadth before cooling those seams is risky.

## The most critical anti-patterns

If I had to highlight the top 5 red flags:

1. Distributed correctness via propagation chains
2. Modes as labels, not contracts
3. Split truth across backend/event/UI
4. Auth spread across multiple partial boundaries
5. Patch-train hardening instead of packaging the seam
