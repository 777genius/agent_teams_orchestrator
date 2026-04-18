# Plugins And Extension Model

## One of the healthier surfaces in Paperclip

Compared with many neighboring seams, the plugin layer is relatively disciplined.

## What is good

### Capability model

`plugin-capability-validator.ts` is a real positive signal:

- operation -> capability mapping
- UI slot capability mapping
- manifest validation
- runtime assertion
- default reject for unknown operations

This is how extensibility should be shaped.

### Sandbox loader

`plugin-runtime-sandbox.ts` also shows good taste:

- VM context
- allow-listed module specifiers
- root confinement
- timeout
- no implicit `process`

This is not perfect isolation, but it is much better than casual host execution.

### External adapters

Paperclip's docs and package layout treat external adapters as a real extension surface, not only an internal hack.

## Weak seams

### 1. Route-level auth drift still appears

Issue `#3271` and `#1198` show the main weakness:

- capability model is good
- plugin tool route auth still made wrong assumptions about who should call it

So the extension contract is good, but the route closure around it is not perfect.

### 2. Sandbox is still not a full trust boundary

The VM loader is meaningful, but it is not equivalent to a container/runtime jail.

Architecturally:

- it is good protective friction
- it is not enough to justify careless host powers elsewhere

### 3. Plugin surface still inherits product breadth

As Paperclip grows broader, plugins risk becoming one more place where board/operator/agent assumptions can drift apart.

## Comparison to us

Paperclip is ahead of our current project in:

- extensibility contract maturity
- capability vocabulary
- plugin/operator boundary clarity

Our current project is ahead in:

- tight direct runtime control for local coding swarms

## Architect takeaway

Steal:

- explicit capability declarations
- runtime enforcement at the host boundary
- install-time manifest validation

Avoid:

- assuming the extension subsystem is safe just because capability metadata exists
- letting route-level auth drift undermine a good plugin model
