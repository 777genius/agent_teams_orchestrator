# Gastown Public Contract and Ecosystem Surface

Date: 2026-04-16  
Studied revision: `bdbe8c4b`  
External surface checked: `docs.gastownhall.ai`

This file looks at Gastown from a different angle:

- what the project promises publicly
- what mental model it exports to users and integrators
- where that public contract is strong
- where it diverges from the runtime we see in code and issues

## Why this angle matters

For a system like Gastown, official docs are not just marketing.

They are part of the architecture because they shape:

- operator expectations
- prompt/formula assumptions
- integration boundaries
- ecosystem extensions
- support burden

If the public model is wrong or stale, the system pays cognitive tax even when
parts of the code are technically fixed.

## 1. Where Gastown's public doctrine is genuinely strong

### A. Operational state as events plus cached labels

Official docs:

- `https://docs.gastownhall.ai/design/operational-state/`

This is one of the strongest public ideas they expose:

- events are immutable audit trail
- labels are current-state cache

That is a very good doctrine.

Why it matters:

- it separates audit truth from query convenience
- it gives operators a clean mental model
- it avoids confusing "fast lookup" with "authoritative history"

Architectural value: `🎯 9.5   🛡️ 9.1   🧠 4`

### B. Property layers and precedence as first-class design

Official docs:

- `https://docs.gastownhall.ai/design/property-layers/`

This is another strong public concept:

- different layers exist for different scopes
- precedence is explicit
- local transient override is not the same thing as synced durable config

That is excellent systems thinking.

Architectural value: `🎯 9.2   🛡️ 8.9   🧠 4`

### C. Official reference already teaches source-repo isolation as a product rule

Official docs:

- `https://docs.gastownhall.ai/reference/`

The reference explicitly tries to keep:

- settings out of git clones
- CLAUDE.md mostly out of source repos
- sparse checkout used to avoid context-file leakage

That is the right instinct.

Architectural value: `🎯 9.1   🛡️ 8.8   🧠 4`

### D. Progressive integration tiers are an unusually good public ecosystem contract

The provider-integration guide exports a very mature external story:

- Tier 0: zero integration
- Tier 1: preset registration
- Tier 2: hooks
- Tier 3: deep integration

That is a strong public contract because it says:

- you can participate partially
- deeper integration is optional
- the system has a path from loose coupling to richer coupling

This is one of the cleanest parts of Gastown's public ecosystem surface.

Architectural value: `🎯 9.4   🛡️ 9.0   🧠 4`

### E. Public identity and attribution doctrine is unusually strong

The identity, overview, and reference docs export a better-than-average public
contract around attribution:

- `BD_ACTOR` is stable and parseable
- the same identity flows through git, beads, and events
- executor and owner are separated deliberately
- attribution is treated as a feature, not as logging garnish

That is a strong product idea because it makes:

- auditability
- debugging
- model comparison
- future cost/quality attribution

part of the public architecture.

Architectural value: `🎯 9.4   🛡️ 8.9   🧠 4`

### F. MVGT is a very strong anti-lock-in public contract

The MVGT guide exports a rare and valuable ecosystem promise:

- participation should be possible through the shared protocol and schema
- full runtime adoption should be optional

That is a strong public systems idea because it says:

- the product is not the only valid participant
- protocol matters more than brand monopoly
- integration can be incremental instead of all-or-nothing

Architectural value: `🎯 9.5   🛡️ 9.0   🧠 6`

### G. The yearbook rule is an unusually crisp public trust rule

The Wasteland and MVGT materials do something unusually good for reputation
systems:

- they make "no self-stamping" explicit
- they connect trust growth to validated completions and external stamps

That creates a stronger public trust model than vague "reputation" language.

Architectural value: `🎯 9.3   🛡️ 9.0   🧠 3`

## 2. Where the public model is externally useful but internally expensive

### A. Rich vocabulary is useful, but high-cognitive-load

Publicly, Gastown offers a very rich conceptual vocabulary:

- polecat
- witness
- refinery
- deacon
- convoy
- wisp
- molecule
- formula
- HOP
- Wasteland
- MVGT

This is not automatically bad.

It gives the project a powerful language for orchestration.

But it also means:

- public docs have to carry more conceptual load
- new users need to learn a mini operating system
- architectural changes become expensive because language is part of the API

Architectural value: `🎯 9.0   🛡️ 8.4   🧠 6`

### B. The ecosystem surface is ambitious and future-facing

Publicly they are already thinking in terms of:

- formulas as reusable workflow artifacts
- federation / Wasteland
- minimal participation via MVGT
- plugin execution
- sandbox-required work metadata

This is strategically strong.

But it also raises the bar:

- public promises now extend beyond one local CLI
- protocol stability matters more
- schema drift becomes more expensive

Architectural value: `🎯 9.1   🛡️ 8.6   🧠 7`

### C. Publicly, they already frame quality and attribution as product primitives

`why-these-features.md` does something many projects never do:

- it explains why attribution, history, validation, and cross-project evidence
  matter as first-class product concepts

That gives Gastown a stronger public architectural story than a simple
"multi-agent coding tool" framing.

Architectural value: `🎯 9.0   🛡️ 8.6   🧠 5`

### D. Source-repo isolation is publicly framed as a product promise, not just implementation detail

The public reference and bootstrap guidance repeatedly emphasize:

- keep generated runtime state out of customer repos
- use clean mayor/rig runtime structure instead of polluting source trees
- treat migration away from legacy sparse-checkout hacks as correctness work

That is good public architecture language because it makes cleanliness and
boundary discipline part of the product contract.

Architectural value: `🎯 9.2   🛡️ 8.9   🧠 4`

### E. "Visibility, not surveillance" is a genuinely strong framing move

`why-these-features.md` makes an unusually good product-level point:

- the ledger is about visibility
- not about surveillance theater

That matters because it frames attribution, evidence, and validation as normal
engineering-system observability rather than social scoring for its own sake.

Architectural value: `🎯 9.0   🛡️ 8.7   🧠 4`

### F. Trace interoperability is public architecture once external tools can consume it

Issue `#1697` is a strong reminder that trace export is not just an internal
debugging choice.

Once a project considers external schemas for AI-native IDE interoperability:

- trace shape becomes ecosystem surface
- emitted metadata becomes contract, not convenience
- future migration cost becomes part of the design today

That is a useful public-architecture lesson even if the integration is still
only a proposal.

Architectural value: `🎯 9.0   🛡️ 8.7   🧠 5`

## 3. Where the public contract clearly drifts from current reality

### A. Official docs still present the old self-cleaning polecat model

Official doc:

- `https://docs.gastownhall.ai/concepts/polecat-lifecycle/`

Publicly, this page still says:

- there is no idle state
- `gt done` means gone
- polecat self-nukes

But in current runtime/code we already see a competing newer truth:

- persistent polecat model
- `done -> idle`
- sandbox preserved for reuse
- witness avoids automatic nuke in many flows

Why this matters:

- external readers learn the wrong lifecycle model
- prompts and operator intuition get trained on stale semantics
- support and design discussion now start from a bad baseline

Architectural risk: `🎯 10   🛡️ 9.5   🧠 5`

### B. Public reference normalizes shared settings scope that has already shown race pain

Official reference still describes:

- shared settings per `crew`
- shared settings per `polecats`

That is consistent with docs.

But issue `#3500` shows why this is operationally dangerous:

- independently starting workers writing shared role-scoped settings can corrupt
  startup state

So the public shape is coherent, but the execution scope is too coarse.

Architectural risk: `🎯 9.7   🛡️ 9.2   🧠 5`

### C. Public docs portray `doctor --fix` as healthy repair path, but issue trail shows convergence cost

Official docs and reference present:

- `gt doctor --fix`
- `gt hooks sync`
- repair/update flows

as normal maintenance tools.

That is fine in principle.

But issue history and local code show:

- some fix loops are non-trivial
- some boundaries were previously unsafe
- some repair paths are still compensating for deeper substrate problems

So the public contract is cleaner than the actual repair burden.

Architectural risk: `🎯 9.3   🛡️ 8.8   🧠 4`

### F. Public identity doctrine is stronger than some runtime launch boundaries

Publicly, Gastown teaches:

- identity is explicit
- attribution is durable
- agents should not infer identity from ambient context

But issue `#3006` shows that launch-context leakage can still contaminate
service identity and misattribute daemon-originated actions.

That means the public model is architecturally stronger than some live startup
paths.

Architectural risk: `🎯 9.7   🛡️ 9.2   🧠 4`

### G. Public evidence and trust model is stronger than current local attribution instrumentation

The Wasteland and MVGT story is very good:

- evidence URLs
- validated completions
- stamps
- trust progression

But the OTel design docs also admit local attribution gaps, including missing
generic polecat work context between prime calls.

So the public trust/evidence model is ahead of the current local telemetry and
cost-attribution reality.

Architectural risk: `🎯 9.2   🛡️ 8.7   🧠 5`

### H. Public trust also depends on whose goals shipped defaults are serving

Issue `#3649` highlights an important public-contract lesson:

- even technically valid workflows can break trust if upstream-facing behavior
  is not explicit enough
- operators need to know when their credits, GitHub identity, and local agents
  are being used for the maintainer's goals rather than their own

That makes consent and disclosure part of the public architecture, not merely a
README footnote.

Architectural risk: `🎯 9.6   🛡️ 9.4   🧠 4`

## 4. What this teaches us as architects

### Best public-facing practices worth stealing

- teach explicit state doctrine publicly
- document precedence rules, not only commands
- make source-repo isolation an explicit product promise
- expose minimal protocol participation as a first-class concept
- expose identity and attribution as public product primitives
- expose verification and trust as durable data, not only review ceremony
- make source-repo isolation and runtime-directory cleanliness explicit product rules
- make consent boundaries around credits, identities, and upstream actions explicit
- treat trace and evidence schemas as public ecosystem contracts once third parties may rely on them
- make the mental model part of the product, not just the code

### Public-facing anti-patterns to avoid

- promising one lifecycle model while runtime has already moved to another
- publishing shared config scope that is broader than real execution safety
- letting support commands look convergent when they are still compensating for
  deeper substrate ambiguity
- treating trace/export format as incidental after external tools may already depend on it
- expanding ecosystem promises faster than protocol/runtime contracts stabilize

## 5. Deep takeaway

Gastown's public surface is interesting because it shows both:

- unusually strong systems thinking
- and the cost of exporting a powerful but moving mental model

The strongest lesson here is:

- public docs are part of the orchestrator's architecture

If they drift, your product is effectively running:

- one runtime
- two mental models
- and several support rituals

That is expensive.

## Final takeaway

Gastown is valuable not only for its runtime ideas, but for showing how public
architecture language becomes part of the system itself.

Steal:

- explicit public doctrines
- state vocabulary
- protocol-minded docs
- ecosystem participation concepts

Avoid:

- stale public lifecycle stories
- public config models that hide race-prone execution reality
- exporting more conceptual surface than the substrate can quietly support
