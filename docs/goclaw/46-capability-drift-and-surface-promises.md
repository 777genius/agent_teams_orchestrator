# GoClaw Capability Drift and Surface Promises

## Why this file exists

Some of GoClaw's most useful negative lessons are not about code structure.
They are about product surfaces that imply more maturity or capability than the runtime actually guarantees.

This is a different kind of architecture problem:

- the system grows
- surfaces multiply
- promises drift

## 1. A surface is mature only if runtime, docs, and environment all agree

This is one of the clearest laws from the GoClaw study.

A surface is not truly mature just because it has:

- an API route
- a UI page
- a docs section

It is mature only if:

- runtime closure exists
- environment assumptions are handled
- errors are honest
- update and install semantics are predictable

Architect lesson:

- product surface maturity is a three-way contract: runtime, docs, environment

## 2. Custom tools are a good example of surface promise drift

Issue `#498` is small but revealing:

- docs and references imply a custom tools surface
- the route is missing on the live branch

This is not just a docs bug.
It is a maturity signal.

Architect lesson:

- do not market or document a surface as normal if it still behaves like a partial experiment

## 3. Runtime & Packages is a high-ambition surface with high semantic tax

Issues `#493` and `#900` show something important:

- the team wants a conversational and update-aware package surface
- the current surface already spans apk, pip, npm, GitHub binaries, runtime detection, and package UX

That is a lot of platform responsibility for one feature area.

Architect lesson:

- capability-rich surfaces should be treated as mini-products with their own contract discipline, not as one more admin page

## 4. Environment-dependent capabilities must be explicit

Issue `#320` is the clearest example:

- bundled skills
- Python/Node runtimes
- writable runtime directories
- dependency scanner behavior

can all vary across environments.

Issue `#722` reinforces the same theme on the browser side:

- browser automation capability depends on container image behavior and extension support

Architect lesson:

- if a capability depends on image flavor, host environment, or sidecar behavior, that dependency must be part of the user-facing contract

## 5. "Full" versus "slim" is product architecture, not packaging trivia

GoClaw already has capability differences across:

- minimal images
- full images
- lite vs standard edition
- Docker vs native behavior

This is not automatically bad.
But it becomes dangerous when the product surface does not make those differences obvious.

Architect lesson:

- image/edition capability matrices need to be explicit early, or users will infer capabilities from the richest surface they see

## 6. Even good capability gating can drift if defaults are too soft

Examples from the codebase:

- unknown prompt modes default to full
- some permission modes default to approve
- some compatibility paths preserve older semantics in new surfaces

Each one feels reasonable locally.
Together they create capability drift:

- the surface looks constrained
- the fallback is broader than expected

Architect lesson:

- capability surfaces should degrade toward smaller power, not larger power

## 7. Protective friction must not be confused with capability clarity

GoClaw often adds:

- allowlists
- rate limits
- approval layers
- edition checks

Those are good.
But they do not automatically answer:

- can this feature really work in this environment
- what exactly is supported here
- what happens on update, reinstall, or partial failure

Architect lesson:

- friction controls abuse; they do not replace capability truth

## 8. Platform products pay heavily for surface overstatement

When a product surface feels richer than it really is, users experience:

- setup confusion
- missing endpoints
- misclassified errors
- update surprises
- environment-specific breakage

That is not just UX pain.
It becomes architecture tax because teams must keep patching the mismatch.

Architect lesson:

- over-promised surfaces create the same kind of maintenance debt as under-typed runtime contracts

## 9. The strongest rule: do not let the richest environment define the product story

One recurring GoClaw risk is that the richest environment:

- full Docker image
- full edition
- local dev install
- maintainer mental model

can implicitly define the public story.

Then users hit:

- slim images
- native installs
- missing runtimes
- missing routes
- sidecar/browser incompatibilities

Architect lesson:

- define the product story from the most constrained supported environment, not from the richest one

## The distilled lesson

GoClaw is a strong warning that surface promises must be reviewed like contracts.

Watch for these smells:

- docs stronger than runtime
- UI stronger than environment
- route names stronger than implementation
- update/install commands stronger than their actual semantics
- rich environments quietly defining the public story
