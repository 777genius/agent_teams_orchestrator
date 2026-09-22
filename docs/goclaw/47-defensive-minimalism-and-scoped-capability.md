# GoClaw Defensive Minimalism and Scoped Capability

## Why this file exists

Some of GoClaw's most reusable ideas are not in the task engine itself.
They live in how the system tries to shrink prompt surface, tool surface, and context surface when full power is not needed.

This file captures the good patterns and the hidden risks in that layer.

## 1. Prompt mode is treated as a real runtime lever

This is a good decision.

GoClaw has explicit prompt modes:

- `full`
- `task`
- `minimal`
- `none`

And those modes influence more than cosmetic prompt copy:

- section inclusion
- context-file allowlists
- memory verbosity
- tool guidance density
- preview rendering

Architect lesson:

- prompt size reduction should be a first-class runtime concern, not random trimming

## 2. Context files are filtered by mode, not just by session type

This is stronger than the usual "subagents get a smaller prompt" approach.

They use explicit file allowlists:

- `task` keeps `AGENTS_TASK.md`, `TOOLS.md`, `CAPABILITIES.md`, `SOUL.md`, `IDENTITY.md`
- `minimal` keeps `AGENTS_CORE.md`, `CAPABILITIES.md`
- `none` keeps only `TOOLS.md`

That is a very good pattern because it narrows not only tokens but semantic authority.

Architect lesson:

- reduced modes should trim both prompt length and semantic surface area

## 3. Open-agent bootstrap is guarded by a hard tool allowlist

This is one of the better local enforcement decisions in the codebase.

During open-agent bootstrap:

- only `write_file` and its alias remain available
- the restriction applies to actual tool definitions, not just prompt instructions

That is much better than "please don't use other tools" prose.

Architect lesson:

- onboarding modes should narrow real capability, not only narrative guidance

## 4. Channel-aware tool filtering keeps prompt and runtime closer together

GoClaw filters channel-specific tools out of the visible tool surface when the current channel type does not support them.

That is a good contract-honesty move.

Architect lesson:

- the tool list shown to the model should match the tool definitions it can actually call

## 5. Prompt budgeting is treated as measurable engineering

This is a strong sign of maturity.

The team did not only talk about "reduce context length".
They shipped targeted reductions:

- skill description truncation
- lower inline-skills threshold
- shorter tool descriptions
- compacted boilerplate sections
- removal of accidental team context from member-only non-team sessions

Issue `#613` is a good example of issue-driven prompt optimization instead of theory-first tweaking.

Architect lesson:

- prompt cost should be profiled and optimized like any other hot runtime path

## 6. Prompt preview is a useful operator-facing diagnostic surface

The preview system is a good idea.

It helps answer:

- what prompt the agent roughly gets
- what tools are visible
- how mode changes affect context

Architect lesson:

- if prompts are part of runtime behavior, operators need a way to inspect them

## 7. Unknown mode handling still fails open

⚠️ This is the important warning.

`ModeAllowlist("unknown")` returns `nil`, which means "full".
The test suite explicitly locks this in.

That means the same subsystem that tries to enforce defensive minimalism still widens back to the largest surface on unknown input.

Architect lesson:

- minimization layers should fail closed toward a smaller surface, not a larger one

## 8. Predefined-agent bootstrap is softer than open-agent bootstrap

This is a mixed decision.

For predefined agents:

- BOOTSTRAP guidance is softened
- full tool surface remains available
- correctness depends more on prompt obedience than on hard narrowing

That may be good product UX.
But it is weaker as a capability boundary.

Architect lesson:

- when one mode is hard-enforced and a neighboring mode is only prompt-guided, review them as different trust classes

## 9. Preview is useful, but not the full runtime truth

The preview builder intentionally skips some runtime-only realities:

- full policy engine behavior
- provider/runtime state
- full ingress context
- some live tool gating

That is acceptable if the product presents preview as approximate.
It is dangerous if preview starts to be treated as authoritative runtime truth.

Architect lesson:

- diagnostic preview surfaces must be explicitly labeled as approximations when they are not full contract renderers

## 10. Budget surfaces can become a hidden second control plane

GoClaw now has several soft budget surfaces:

- prompt mode
- inline-vs-search thresholds
- ReserveTokens pruning buffer
- compacted sections
- bootstrap tool narrowing

These are good individually.
The risk is when too much system behavior starts depending on budget heuristics rather than typed domain rules.

Architect lesson:

- budget controls should constrain the system, not secretly define it

## The distilled lesson

GoClaw has a genuinely useful pattern here:

- defensive minimalism should be explicit, mode-aware, and partially hard-enforced

But it also shows an important rake:

- if reduced modes still fail open to broader power, the minimization layer becomes only partially trustworthy
