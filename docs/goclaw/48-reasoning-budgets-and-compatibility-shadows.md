# GoClaw Reasoning Budgets and Compatibility Shadows

## Why this file exists

GoClaw has a more thoughtful reasoning-control layer than most competitors.
But it also shows how quickly a clean capability model can become shadowed by rollback compatibility and approximated budgets.

This file captures both sides.

## 1. Provider-owned reasoning defaults are a good design

This is the right direction.

Instead of one flat per-agent flag, GoClaw lets providers own reusable defaults through:

- `settings.reasoning_defaults`

Agents can then:

- inherit provider defaults
- or define custom overrides

Architect lesson:

- capability defaults should live with the capability owner, not be copied into every consumer

## 2. Reasoning control is capability-aware for known models

This is one of the better non-obvious engineering decisions in the repo.

For known GPT-5 / Codex-style models, GoClaw resolves:

- requested effort
- effective effort
- fallback policy
- whether provider default was used

That is much better than blindly passing through a user-selected value.

Architect lesson:

- high-level reasoning controls should resolve to a concrete runtime decision before the request leaves the system

## 3. Fallback policy is explicit instead of magical

They expose clear fallback behaviors:

- `downgrade`
- `off`
- `provider_default`

That is good contract design.

Architect lesson:

- unsupported capability requests should degrade through explicit policy, not hidden provider quirks

## 4. They defend against known reasoning-leak models

The `StripThinking` path for models that leak reasoning even when effort is `off` is a strong local pattern.

That is quiet but important engineering taste.

Architect lesson:

- if a provider violates the ideal contract, defend the user-facing surface explicitly

## 5. ReserveTokens is a healthy safety-buffer pattern

GoClaw subtracts a configurable reserve from history budget so pruning happens slightly before the hard edge.

That is a solid pattern.

Architect lesson:

- context systems should compact before the cliff, not on the cliff

## 6. Prompt budgeting is tied to measured token pressure

This is good.

Examples:

- skill inline threshold
- skill description truncation
- lower inline/search switching threshold
- mode-specific prompt size control

Architect lesson:

- token pressure should be treated as an engineering budget, not as incidental model trivia

## 7. Legacy `thinking_level` creates a compatibility shadow

⚠️ This is the major warning.

GoClaw now has a cleaner reasoning model.
But it still carries the older coarse `thinking_level` shim for rollback compatibility.

That means two vocabularies coexist:

- the newer reasoning config
- the legacy thinking-level surface

Architect lesson:

- compatibility shims should have a clear death plan, or they become a second policy language

## 8. Unknown-model behavior is pragmatic but semantically soft

When a model is unknown:

- explicit non-`auto` effort may pass through
- `auto` may leave provider-default behavior untouched

That is operationally useful.
But it also means the UI/control surface can look more certain than the real capability knowledge behind it.

Architect lesson:

- if model capability knowledge is partial, product surfaces should reflect that uncertainty

## 9. Budgeting still depends on estimation, not perfect truth

This is normal.
But it matters.

GoClaw relies on:

- estimated token counters
- thresholds
- truncation heuristics
- compression heuristics

These are acceptable.
But they should be treated as heuristic control, not exact contract truth.

Architect lesson:

- heuristics should shape performance, not define correctness

## 10. Reasoning control can quietly become another hidden control plane

Together, these knobs create a subtle second policy layer:

- provider defaults
- agent override mode
- fallback policy
- legacy shim
- reserve tokens
- inline/search prompt thresholds

Each one is defensible.
Together they raise contract complexity.

Architect lesson:

- reasoning policy and prompt-budget policy should remain visible, typed, and explainable

## The distilled lesson

GoClaw shows a strong pattern here:

- capability-aware reasoning control is much better than a dumb on/off toggle

But it also shows the main risk:

- once compatibility shims and heuristic budgets pile up, the system starts to grow a shadow policy layer beside the main runtime contract
