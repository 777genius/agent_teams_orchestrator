# Gastown Layered Control and Strategic Overreach

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file isolates one of Gastown's most interesting architectural properties:

- it has a genuinely strong layered control model
- but it also risks overreaching by turning every control concern into another
  role, protocol, or subsystem

That makes it both inspiring and dangerous.

## 1. What Gastown gets very right

### A. Mechanical control vs reasoning control

Gastown does not treat every orchestration problem as "just ask the agent".

It explicitly separates:

- mechanical runtime supervision
- reasoning-based triage
- long-running orchestration work

The most visible public example is the watchdog chain:

- daemon
- Boot
- Deacon
- witnesses and refineries

Relevant docs:

- `/tmp/gastown-latest/docs/design/dog-infrastructure.md`
- `/tmp/gastown-latest/docs/design/dog-execution-model.md`

Why this is strong:

- some things really are mechanical
- some things really do require judgment
- forcing both into one loop usually creates bad systems

Architectural value: `🎯 9.4   🛡️ 8.8   🧠 6`

### B. Imperative Go for reliability-critical background tasks

One very mature instinct in `dog-execution-model.md`:

- reliability-critical dogs should stay imperative Go
- plugin/agent dispatch should be reserved for opportunistic or higher-level
  tasks

That is excellent doctrine.

It avoids a common mistake:

- moving critical maintenance into agent-interpreted workflows just because
  workflows are more flexible

Architectural value: `🎯 9.5   🛡️ 9.0   🧠 4`

### C. Strong systems ambition: protocol and federation thinking

Gastown is not content with just being a local CLI.

The project thinks in terms of:

- work ledger
- attributed agent history
- federation
- cross-workspace references
- minimal participation surface via MVGT

Relevant docs:

- `/tmp/gastown-latest/docs/why-these-features.md`
- `/tmp/gastown-latest/docs/design/federation.md`
- `/tmp/gastown-latest/docs/guides/mvgt-integration.md`

This is strategically strong.

Architectural value: `🎯 9.2   🛡️ 8.6   🧠 7`

## 2. Where this layered model starts hurting them

### A. Every new control role adds another identity seam

Issues:

- `#3223`
- `#3148`
- `#3638`

What these show:

- dogs can start but not know who they are
- boot patrol can escalate nonsense when idle should be silent
- daemon can detect stale deacon but not complete restart

This is the core risk of layered control:

- every layer needs correct identity
- correct lifecycle ownership
- correct escalation semantics
- correct interaction rules with adjacent layers

If the substrate is already noisy, more layers multiply seams faster than they
increase reliability.

Architectural risk: `🎯 9.7   🛡️ 9.2   🧠 6`

### B. Rich hierarchy can become role theater if boundaries are not strict

On paper, Boot, Deacon, Dogs, Witnesses, Refineries all have clean jobs.

In practice, if:

- startup is fragmented
- identity is lossy
- mail routing is brittle
- recovery is observer-first

then roles stop being clean abstractions and become:

- additional routing overhead
- additional failure modes
- additional docs and prompt burden

This is where sophisticated orchestration turns into over-architecture.

Architectural risk: `🎯 9.4   🛡️ 8.8   🧠 7`

### C. Strategy outruns substrate

Gastown's strategic direction is broad:

- plugin system
- dogs
- federation
- HOP
- Wasteland
- evidence and attribution
- observability-aware orchestration

The issue is not that these ideas are bad.

The issue is:

- the local substrate is still loud
- startup/restart/boundary rules are still expensive
- control layers still have identity and routing bugs

So the project keeps building upward while still paying local control tax.

Architectural risk: `🎯 9.6   🛡️ 9.0   🧠 7`

## 3. Best practices worth stealing

### Steal these hard

- separate mechanical supervision from reasoning supervision
- keep reliability-critical background work imperative, not agent-dependent
- make escalation a tracked first-class protocol, not ad-hoc chat
- think in terms of control plane vs work plane
- design for attributed work and future protocol participation

### Steal carefully

- multi-role orchestration hierarchy
- plugin-dispatched background work
- federation and ecosystem surface

These are worth taking only if:

- identity is first-class
- startup is authoritative
- routing is explicit
- the substrate is already quiet

## 4. Critical bad practices to avoid

- adding new control roles before identity/lifecycle contracts are tight
- using AI roles to paper over missing mechanical guarantees
- treating ambitious protocol surface as substitute for local runtime quality
- pushing critical background work into agent-dispatched paths too early
- allowing each control layer to invent its own naming, routing, or wake logic

## 5. Deep takeaway

Gastown is strongest when it says:

- different control problems deserve different kinds of machinery

That is a very good architectural instinct.

Gastown is weakest when it lets that instinct expand into:

- more roles
- more layers
- more protocols
- more subsystems

before the lower-level contracts become quiet and authoritative.

## Final takeaway

The lesson is not:

- "many roles are bad"

The lesson is:

- layered control is powerful only when each layer has a very clear contract and
  sits on a calm substrate

Gastown proves the first half brilliantly.

It is still paying for the second half.
