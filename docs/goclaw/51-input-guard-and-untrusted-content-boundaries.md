# GoClaw Input Guard and Untrusted Content Boundaries

## Why this file exists

GoClaw has a thoughtful but easy-to-misread safety layer around prompt injection and untrusted content.

Some parts are genuinely good.
Some parts are softer than the product language might suggest.

This file captures that distinction.

## 1. InputGuard is a real subsystem, not a random regex helper

This is a positive sign.

GoClaw has:

- a dedicated `InputGuard`
- named patterns
- tests
- configurable actions

That is better than scattering prompt-injection regexes across the runtime.

Architect lesson:

- even lightweight injection detection should live in one named subsystem

## 2. The guard is configurable, which is good operationally

The action can be:

- `log`
- `warn`
- `block`
- `off`

That is useful because different deployments may want different tradeoffs.

Architect lesson:

- safety posture should be configurable when the false-positive/false-negative tradeoff is real

## 3. By default, this is detection-first, not hard prevention

⚠️ This is the key truth.

The default action is `warn`.
That means:

- injection-like input is detected
- logged
- but not blocked

This is a valid product choice.
But it is not the same thing as a hard guardrail.

Architect lesson:

- do not describe detection-first regex scanning as if it were a strict security boundary

## 4. Invalid action values fall back to `warn`

This is pragmatic.
But it is another example of soft defaulting.

It is safer than falling to `off`.
Still, it means the policy surface is forgiving rather than strictly rejected.

Architect lesson:

- policy parsing should make soft fallback behavior very explicit to operators

## 5. They scan not only user input, but also some untrusted external outputs

This is one of the better design decisions in this layer.

GoClaw scans:

- user input
- some `web_fetch` / `web_search` results

When suspicious patterns appear in external content, it prepends a security warning rather than silently passing the content through.

Architect lesson:

- injection defense should not stop at the user input boundary if external tools can feed the model

## 6. MCP content is explicitly wrapped as untrusted

This is good engineering taste.

GoClaw wraps MCP tool output as external/untrusted content and sanitizes marker-like strings to reduce prompt-injection risk from third-party servers.

That is a strong local pattern.

Architect lesson:

- external integration results should carry trust semantics explicitly, not just raw text

## 7. Web-fetch conversion also includes hidden-content awareness

Another good local decision:

- hidden HTML elements are skipped
- web-fetch temp content is marker-sanitized before write

This shows the team understands that prompt injection can hide in rendered or transformed content, not only in obvious visible text.

Architect lesson:

- untrusted content boundaries should survive format conversion, not only raw transport

## 8. The main weakness: the guard is regex-based and narrow by nature

⚠️ This is the fundamental limitation.

The built-in pattern set is useful, but still narrow:

- ignore-previous-instructions style phrases
- role override phrases
- system tag markers
- instruction-injection markers
- null bytes
- delimiter-escape markers

That means the subsystem is:

- a useful tripwire
- not a complete semantic injection defense

Architect lesson:

- regex guards are good tripwires, bad foundations for total safety claims

## 9. This is a good example of "local strength, global softness"

The layer has several strengths:

- named subsystem
- tests
- configurable policy
- web result scanning
- MCP untrusted wrapping

But the larger contract is still softer than it first appears:

- default is warn
- some flows prepend warnings rather than block
- docs can present "guard" language more strongly than runtime enforcement really is

Architect lesson:

- if the runtime mainly warns and annotates, product language should say that honestly

## 10. The reusable lesson

The best thing to steal here is not the exact regex list.

It is the layered safety mindset:

- detect risky input centrally
- annotate untrusted external outputs
- preserve trust boundaries across transport and format conversion

And the main thing to avoid is:

- calling a warning-oriented detection layer a hard guarantee

## The distilled lesson

GoClaw has a decent lightweight safety layer for prompt-injection tripwires and untrusted content marking.

That is worth copying.

But it should be copied honestly:

- as a useful boundary-supporting layer
- not as the primary security contract of the orchestrator
