# OpenHarness Architect Playbook

## The shortest architect synthesis

OpenHarness is strongest where it uses:

- explicit local primitives
- inspectable file/process contracts
- boring hardening
- coding-oriented isolation

OpenHarness is weakest where it uses:

- env flags as semantics
- prompt obedience as contract
- dual truths during migration
- safety surfaces that are stronger in product story than in runtime

## What to steal

### 1. Headless worker split

Background workers should not pretend to be terminal UIs.

### 2. Worktree isolation

Treat isolated workspaces as a first-class coding primitive, not an afterthought.

### 3. Explicit local mailbox

Simple file protocols are a good starting point when the scope is deliberately local-first and inspectable.

### 4. Atomic write and lock discipline

Do boring persistence hardening early.

### 5. Serious compaction

Continuity across long sessions deserves a real subsystem.

### 6. `contextvars` isolation

For Python local runtimes, this is one of the cleanest ways to isolate per-worker state.

### 7. Provider registry and normalization

Provider support should have one source of truth.

## What to ban

### 1. Dual truth

If old and new coordination models both remain alive, the architecture is already paying drift tax.

### 2. Prompt-only orchestration contracts

Mode, role, and side-effect policy must be structural, not only narrated.

### 3. File substrate becoming accidental durable truth

A file protocol can be useful without being allowed to become the long-term authoritative engine.

### 4. Safety surfaces that overstate enforcement

Unsupported policy must fail closed or be rejected.

### 5. Provider dialect assumptions inside built-ins

The built-in orchestration surface must inherit provider truth, not override it with hidden assumptions.

### 6. Personalization without a secret boundary

Local memory is valuable.
Secret replay into future prompts is not.

## Five laws after studying OpenHarness

1. Separate worker runtime from operator UI early.
2. Isolation primitives should be explicit and local, not magical.
3. Crash-safe persistence is part of architecture, not cleanup work.
4. Long-session continuity should be designed deliberately, not improvised later.
5. Any soft carrier of semantics must be treated as suspect until closed by a hard contract.

## Final one-line verdict

OpenHarness is a strong young local-first harness and a weak template for durable orchestration closure.
