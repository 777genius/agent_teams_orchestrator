# Gastown Architectural Lessons

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file is the fastest architect-oriented summary of Gastown:

- what is genuinely strong and worth adapting
- what is systemically dangerous and should not be copied
- why those lessons matter for a new orchestrator

## Executive summary

Gastown is strong where it models agent work as a real coordination problem, not
just "one prompt plus some tools".

Gastown is weak where it lets too much runtime truth leak across too many
substrates and transports.

The deepest lesson is this:

> bold orchestration primitives are valuable, but they become expensive very
> quickly when startup, identity, liveness, recovery, and workflow truth do not
> share one small set of authoritative contracts.

## Best practices worth adapting

### 1. Make inter-agent communication first-class

Gastown is right that multi-agent systems should not treat communication as an
accidental side effect of logs or a shared task board.

What is good:

- explicit mail
- inbox semantics
- direct addressing
- handoff as a real operation, not a prompt convention

Why this matters:

- easier recovery
- easier human inspection
- less ambiguity than "look at context and guess"

### 2. Treat worker isolation as a core coding primitive

Gastown's worktree-first instinct is strong.

Why it is good:

- reduces workspace collisions
- makes ownership clearer
- allows better review and cleanup
- aligns with how coding agents actually fail

### 3. Model roles with operational meaning

Gastown does not reduce every actor to "another agent with a different prompt".

That instinct is correct.

Useful lesson:

- distinguish roles by responsibility, authority, and lifecycle
- do not distinguish roles only by branding or naming

### 4. Separate durable intent from cheap realtime nudges

One of Gastown's best ideas is the distinction between:

- durable mail or work truth
- cheap realtime nudge or attention signal

That separation is correct even though their implementation remains expensive.

### 5. Design for stall, drift, and crash from day one

Gastown's recovery mindset is serious.

Useful lesson:

- assume workers will die
- assume startup can half-succeed
- assume identity can drift
- assume cleanup will be needed

### 6. Make worker handoff and continuation a first-class problem

Gastown thinks deeply about:

- predecessor state
- resume markers
- cooldown
- handoff loops
- task continuation

This is unusually strong for a coding-swarm project.

### 7. Build real workflow primitives, not only chat workflows

Convoys, staged launch, waves, and dependency-aware feeding show good product
thinking even when the implementation is costly.

The valuable lesson is not "copy convoys exactly".

The lesson is:

- serious orchestration needs its own workflow vocabulary

### 8. Keep operator intent visible

Even when their runtime gets too complicated, Gastown keeps a strong sense of
what the operator is trying to do:

- sling work
- hand off work
- resume work
- recover work
- inspect work

That operator-centered thinking is worth keeping.

### 9. Invest in design docs for hard seams

Gastown has valuable design documents around mail, worker APIs, convoys, and
agent integration pain.

Useful lesson:

- document fault lines, not only happy paths

### 10. Be willing to admit old seams are wrong

ACP, factory worker API work, and repeated attempts to escape tmux-first startup
show healthy engineering honesty.

That is a best practice too:

- do not defend weak seams just because they are already shipped

## Critical bad practices to avoid

### 1. Do not let runtime truth sprawl across too many planes

Gastown repeatedly pays for truth being split across:

- Beads and Dolt
- tmux and process reality
- metadata and descriptions
- JSON shadow-state files
- prompts and formulas
- routes and registry state

This is the single biggest architectural warning.

### 2. Do not make an interactive terminal substrate part of the control plane

tmux is acceptable as:

- operator UX
- inspection surface

tmux is dangerous as:

- lifecycle authority
- delivery mechanism
- liveness substrate
- identity carrier

Issue pressure and recent fixes strongly show this.

### 3. Do not use your own CLI as your main internal RPC fabric

Gastown shells out to `gt`, `bd`, `tmux`, and `dolt` heavily inside core
runtime logic.

That creates:

- non-atomic transitions
- polling tax
- parse tax
- environment drift
- correctness depending on shell behavior

### 4. Do not spread startup truth across many delivery channels

Gastown startup truth is fragmented across:

- role TOML
- runtime config
- env injection
- hooks
- priming
- nudges
- startup templates
- tmux environment

That makes silent mis-starts much harder to reason about.

### 5. Do not let runtime identity be lossy

Alias, provider, command, preset, resolved agent, process name, and env-exported
identity should not be competing representations.

They should collapse into one explicit runtime identity object.

### 6. Do not keep important orchestration semantics in freeform text

Gastown stores or derives too much behavior from descriptions and string
metadata.

That is dangerous for:

- migrations
- concurrency
- recovery
- reasoning about invariants

### 7. Do not half-adopt good abstractions

Gastown often creates the right abstraction and then keeps the hardest paths on
legacy bespoke flows.

Examples include:

- unified session lifecycle not owning the hardest roles
- richer role config not fully driving runtime behavior
- new startup truth not fully replacing old hook-centric truth

### 8. Do not let shared config live at a coarser scope than execution

Per-role shared settings for workers that fail independently create cross-worker
blast radius.

That is a concurrency smell.

### 9. Do not make recovery depend on observer-first discovery for too many transitions

Patrol and observer loops are good as safety nets.

They become expensive when they are also the main way the system notices that a
transition happened.

### 10. Do not let policy-heavy macros own narrow lifecycle transitions

Gastown's `gt done` is not just completion. It is also:

- merge policy
- MR policy
- cleanup policy
- convoy policy
- witness handoff
- state repair

That makes one command a pressure concentrator.

### 11. Do not infer runtime capabilities from provider or command names when they should be explicit

If ACP support, prompt mode, resume style, or startup path can only be known
after normalization and helper logic, then the capability model is too implicit.

### 12. Do not mix orchestration policy files with concrete launch mechanics

Role definitions should not also be a competing place to define literal startup
commands that can bypass runtime resolution.

### 13. Do not rely on process-global mutable config state

Gastown's agent registry layer still pays for global mutable resolution state.

That is especially dangerous in a system that wants:

- multiple rigs
- multiple agents
- multiple runtimes
- test isolation

### 14. Do not keep generated-config convergence rules in several owners

If install, sync, validation, and doctor each define correctness differently,
you will get fix loops and false green states.

### 15. Do not keep the platform interactive-session-first if you want headless and sandboxed workers later

Gastown's own issue trail shows that headless, read-only, or fire-and-forget
workers are much harder once the platform assumes:

- a long-lived pane
- an interactive session
- a `gt hook` ceremony
- tmux-backed lifecycle

## Best ideas to steal first

### Typed mailbox and explicit handoff

Why to steal:

- high leverage
- clean mental model
- works for both humans and agents

Adoption rating: `🎯 9.7   🛡️ 9.0   🧠 5`

### Worktree-first worker isolation

Why to steal:

- natural fit for coding swarms
- reduces accidental interference

Adoption rating: `🎯 9.4   🛡️ 8.9   🧠 6`

### Durable work truth plus cheap nudge channel

Why to steal:

- avoids overloading chat or logs
- improves recovery semantics

Adoption rating: `🎯 9.1   🛡️ 8.8   🧠 5`

### Recovery as a first-class design concern

Why to steal:

- prevents naive happy-path architecture
- forces state-machine thinking early

Adoption rating: `🎯 9.5   🛡️ 8.6   🧠 6`

### Role model with real responsibilities

Why to steal:

- reduces prompt theater
- improves orchestration clarity

Adoption rating: `🎯 8.8   🛡️ 8.3   🧠 6`

## Most dangerous mistakes to avoid first

### Multi-plane truth

Why it is critical:

- the hardest class of bugs becomes normal
- repair logic keeps growing forever

Avoidance importance: `🎯 10   🛡️ 9.7   🧠 8`

### tmux as a control-plane dependency

Why it is critical:

- portability suffers
- headless workers become second-class
- liveness and startup get tangled

Avoidance importance: `🎯 10   🛡️ 9.6   🧠 6`

### CLI and subprocess orchestration as internal RPC

Why it is critical:

- expensive
- fragile
- hard to reason about atomically

Avoidance importance: `🎯 9.8   🛡️ 9.4   🧠 5`

### Split startup and identity contracts

Why it is critical:

- causes silent misconfiguration
- makes every new runtime more expensive

Avoidance importance: `🎯 9.8   🛡️ 9.4   🧠 7`

### Interactive-session-first engine shape

Why it is critical:

- weak fit for future sandboxed review agents
- weak fit for short-lived headless workers

Avoidance importance: `🎯 9.5   🛡️ 9.1   🧠 6`

## Architect's bottom line

Study Gastown for:

- orchestration imagination
- coding-swarm workflow vocabulary
- mailbox and handoff design
- worktree isolation
- serious recovery posture

Do not copy Gastown as a substrate reference.

The right way to learn from it is:

- copy the conceptual primitives
- simplify the truth model
- centralize startup and identity
- keep runtime capabilities explicit
- keep operator UX separate from control-plane authority
