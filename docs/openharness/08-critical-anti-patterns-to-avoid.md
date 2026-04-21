# OpenHarness Critical Anti-Patterns to Avoid

## Core warning

OpenHarness is interesting enough that it can teach the wrong lessons if copied too literally.

The biggest anti-patterns are not in its best primitives.
They are in its unfinished contracts.

## 1. Dual truth during migration

The clearest example:

- `TeamRegistry`
- `TeamLifecycleManager`

When old and new team truth both remain alive, the project starts paying drift tax immediately.

Rule:

- once the new contract exists, kill the old one aggressively

## 2. Prompt or env vars pretending to be hard orchestration contracts

Coordinator mode currently depends heavily on:

- env flag
- prompt framing
- worker convention

That is not enough for a strong execution contract.

Rule:

- orchestration mode must be enforced structurally, not only narrated

## 3. File-based control planes that quietly become the real substrate

Mailbox and file-based permission sync are useful.

The risk is when they stop being:

- a deliberate local protocol

and become:

- the accidental long-term transport and truth system

Rule:

- if file protocols stay, keep them narrow and explicit

## 4. Soft safety surfaces

The Docker sandbox issue is the archetype:

- policy is configurable
- runtime does not really honor the policy contents

Rule:

- unsupported safety policy must fail closed, not degrade silently

## 5. Provider-specific assumptions in orchestration paths

Built-in subagents with hard-coded Anthropic-friendly model aliases are exactly the kind of hidden coupling that later poisons provider portability.

Rule:

- built-ins should inherit provider contract, not override it with dialect assumptions

## 6. Personalization without hard secret boundaries

Extracting local environment facts is useful.
Persisting raw exported secret values into future prompts is not.

Rule:

- never let local personalization become a prompt-side secret replay channel

## 7. Partially closed "good ideas"

The in-process backend has a good core design, but still contains stub behavior when no real query context is provided.

Rule:

- unfinished nice abstractions should be treated as immature until the fallback path is equally real
