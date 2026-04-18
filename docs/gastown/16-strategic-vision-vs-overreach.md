# Gastown Strategic Vision vs Overreach

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file evaluates Gastown's long-horizon design thinking:

- where the vision is genuinely strong
- where the vision becomes too broad or too early for the current substrate

## Why this file matters

Gastown is unusual because it is not only building a local orchestrator.

It is also imagining:

- federation
- shared formula ecosystems
- skill and reputation ledgers
- cross-town interoperability

That makes it important to separate:

- good long-term direction
- premature architectural expansion

## 1. Strong strategic instincts

### A. Workflow artifacts should be shareable and layered

The formula-resolution and Mol Mall documents contain a very strong core idea:

- workflows should have clear precedence
- local, town, and system layers should be explicit
- project workflows should not be hidden inside the binary forever

This is a good long-term design instinct.

Architect rating: `🎯 9.1   🛡️ 8.7   🧠 6`

### B. Federation thinking is real, not hand-wavy

The HOP and Wasteland docs are ambitious, but they are not random buzzwords.

There is a genuine attempt to think about:

- portable identity
- portable work evidence
- cross-instance references
- external validation and trust
- sharable workflows and skill derivation

As long-term product thinking, this is unusually bold and thoughtful.

Architect rating: `🎯 8.8   🛡️ 8.0   🧠 8`

### C. Property-layer reasoning is strong

`property-layers.md` shows a very healthy configuration instinct:

- different config classes need different precedence semantics
- additive and replacement behaviors should be chosen intentionally
- event truth vs label cache should be explicit

This is the kind of quiet design thinking many systems never develop.

Architect rating: `🎯 9.3   🛡️ 9.0   🧠 5`

### D. Plugin system thinking is better than average

The plugin design is not implemented, but the core ideas are strong:

- dispatch plugins to dogs, not to the deacon inline
- keep plugin execution observable
- keep plugin state on the ledger, not in arbitrary shadow files
- digest high-volume run noise into summaries

Architect rating: `🎯 8.9   🛡️ 8.4   🧠 6`

### E. Formula resolution is conceptually cleaner than current runtime config

Their formula-resolution document is a good example of explicit resolution order:

- project
- town
- system

That is a cleaner model than several other config areas in the repo.

Architect rating: `🎯 8.8   🛡️ 8.6   🧠 5`

### F. "Don't converge" is one of their smartest strategic ideas

Their internal framework survey lands on a very strong conclusion:

- do not converge toward conversation-as-control-plane just because the rest of
  the ecosystem does
- borrow ergonomics from other frameworks
- do not borrow their core control architecture if your differentiator is the
  process model

This is one of the sharpest strategic insights anywhere in the Gastown
materials.

Architect rating: `🎯 9.6   🛡️ 9.0   🧠 6`

### G. Quality gates as data is a strong strategic instinct

`why-these-features.md` repeatedly treats:

- validation
- review
- quality signals
- attribution

as durable structured data, not just ephemeral process ceremony.

That is strategically strong because it turns quality from convention into a
queryable substrate.

Architect rating: `🎯 9.1   🛡️ 8.8   🧠 5`

### H. Portable reputation is a bold but coherent strategic idea

The Wasteland, identity, and CV materials point to a strong long-horizon idea:

- work evidence should accumulate into portable reputation
- reputation should travel across towns and ecosystems
- capability should emerge from completed and validated work

That is a genuinely differentiated strategic move.

Architect rating: `🎯 9.0   🛡️ 8.4   🧠 7`

## 2. Where the vision overreaches

### A. Federation is ahead of substrate maturity

HOP, Wasteland, Mol Mall, and skill derivation are interesting.

But the current local engine still pays for:

- fragmented truth
- weak portability
- startup/env complexity
- expensive observer and polling loops

That makes federation a strategic overreach *for now*.

Architect warning: `🎯 9.7   🛡️ 9.4   🧠 8`

### B. Formula and plugin ecosystem ambition is ahead of convergence discipline

It is one thing to imagine:

- formula registries
- plugin ecosystems
- town vs rig vs system layering

It is another thing to keep config convergence clean locally.

Gastown still struggles with:

- generated settings convergence
- config precedence consistency
- partial schema adoption
- competing config planes

So the ecosystem vision is stronger than the current config substrate.

Architect warning: `🎯 9.4   🛡️ 9.0   🧠 7`

### C. HOP/CV/reputation language can inflate conceptual load

There are places where the strategic language risks outrunning the practical
product surface.

That does not make it useless.

But it does mean:

- some concepts are very expensive for contributors to hold in working memory
- some docs describe a bigger universe than the runtime can currently support

Architect warning: `🎯 9.0   🛡️ 8.7   🧠 6`

### D. Too many "future-ready" layers can become present-day maintenance tax

Gastown often designs with future federation, future skill derivation, future
distribution, future role specialization, and future plugin ecosystems in mind.

That creates two risks:

- abstractions get broader before they are quieter
- local correctness becomes harder to stabilize

Architect warning: `🎯 9.3   🛡️ 8.9   🧠 7`

### E. "Don't converge" can itself become overreach if the local process model stays too expensive

The anti-convergence insight is excellent.

But it only works if the local process model really remains a strength.

If the local process model is still paying too much for:

- fragmented truth
- startup tax
- tmux coupling
- observer-heavy recovery

then "don't converge" risks becoming identity-defense instead of architectural
clarity.

Architect warning: `🎯 9.2   🛡️ 8.8   🧠 6`

## 3. What to borrow from the strategy

- explicit precedence rules for layered workflow/config artifacts
- shareable workflow artifacts instead of hidden magic built into the engine
- durable evidence model for completions and reviews
- external validation as a meaningful concept
- plugin execution as observable work, not hidden cron glue
- future compatibility thinking for agent-agnostic runtimes
- quality gates and validation as structured data
- do not blindly converge to conversation-as-control-plane
- portable reputation and CV surfaces derived from evidence, not self-report

## 4. What not to borrow from the strategy

- federation complexity before local contracts are quiet
- reputation/skill economy concepts before core execution is stable
- too many new nouns before the operator model is simple
- ecosystem surfaces that outpace config convergence and runtime wiring
- anti-convergence as a slogan if the alternative architecture is still too loud

## Final architect takeaway

Gastown's strategic vision is stronger than its local substrate.

That is unusual and valuable.

The right lesson is:

- keep the long-term courage
- reduce the present-day ambition
- make local contracts quiet before building the cross-town universe on top
