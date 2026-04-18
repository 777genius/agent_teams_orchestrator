# Gastown Strong Concepts Beneath The Mess

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file isolates the strongest conceptual ideas in Gastown even where the
implementation around them is expensive.

These are the ideas most worth learning from.

## 1. Identity, session, and sandbox are not the same thing

This is one of Gastown's best conceptual moves.

The polecat lifecycle docs clearly separate:

- **identity** - long-lived worker/persona/ledger lineage
- **session** - ephemeral model process or context window
- **sandbox** - persistent worktree/workspace

Why this is strong:

- avoids conflating "session died" with "worker died"
- makes worker reuse natural
- fits coding work much better than chat-thread thinking
- gives a clean mental model for restart, handoff, and recovery

Architect rating: `🎯 9.8   🛡️ 9.1   🧠 5`

## 2. Persistent polecats are a very strong coding-worker concept

Gastown's persistent polecat model is one of the most interesting ideas in the
whole codebase.

The core idea:

- worker finishes work
- session can die
- sandbox stays
- worker identity stays
- worker returns to idle instead of being destroyed

Why this is strong:

- reduces worktree churn
- preserves worker history and attribution
- makes reuse explicit
- matches real coding workflows better than throwaway agents

Architect rating: `🎯 9.5   🛡️ 8.8   🧠 6`

## 3. Done should mean idle, not death

Related to persistent polecats, Gastown pushes a strong idea:

- successful completion should often transition a worker to reusable idle state,
  not full destruction

That is especially good for:

- long-lived coding workers
- rigs with stable context
- repeated work against the same repository

Architect rating: `🎯 9.2   🛡️ 8.6   🧠 5`

## 4. Cleanup vetoes are a healthy safety primitive

Gastown has good instincts around cleanup interlocks:

- active ACP session vetoes cleanup
- stale PID cleanup is explicit, not hidden inside "is active?" checks
- cleanup and liveness checks are treated as different concerns

This is a strong principle even if the surrounding state model is fragmented.

Architect rating: `🎯 9.0   🛡️ 8.8   🧠 4`

## 5. Fail-closed thinking shows up in the right places

There are good examples where Gastown is very clearly trying to prefer safe
failure over silent unsafe behavior:

- proxy protocol validation
- authorization thinking
- sandbox boundaries
- schedule and startup checks

This is a mature instinct for an orchestrator with code execution powers.

Architect rating: `🎯 9.1   🛡️ 9.1   🧠 4`

## 6. "Agent decides, Go transports" contains a useful core idea

Their ZFC language is sometimes overextended, but the core insight is valuable:

- the engine should transport structured facts
- judgment should not be hidden in dozens of brittle hardcoded heuristics

The strong version of this idea is:

- transport facts
- keep policy explicit
- let the right layer decide

The weak version is:

- push too much judgment into prompts

So this is a principle worth adapting carefully, not copying literally.

Architect rating: `🎯 8.7   🛡️ 8.0   🧠 6`

## 7. Catalog is not truth

Gastown's docs explicitly say the registry is a catalog, not the source of
truth.

That is a very good rule for orchestrators.

It means:

- registries index things
- source-of-truth objects define runtime reality
- caches should not silently become control-plane authorities

Architect rating: `🎯 9.3   🛡️ 9.0   🧠 3`

## 8. Source-of-truth language matters

Gastown repeatedly tries to state which subsystem should be authoritative for
which fact:

- merge queue instead of branch grep
- route tables instead of ad-hoc guessing
- config as source of truth for some identities
- events over caches in some design docs

Even though they are inconsistent in execution, this way of thinking is good.

Architect rating: `🎯 8.9   🛡️ 8.5   🧠 4`

## 9. Pressure checks before spawn are a good operational instinct

They have moved toward pressure checks before agent spawns.

That reflects a healthy orchestration idea:

- spawning workers should consider local resource pressure
- the engine should not assume every spawn is free

Architect rating: `🎯 8.6   🛡️ 8.4   🧠 5`

## 10. Sandboxed execution is treated as a systems problem, not just a prompt trick

Between proxy-server and the headless/sandbox issue trail, Gastown shows a
strong instinct here:

- sandboxing is about boundary design
- not about politely asking the agent not to write files

That is exactly the right security posture.

Architect rating: `🎯 9.4   🛡️ 9.2   🧠 6`

## 11. Mechanical control and reasoning control are treated as different kinds of work

One of Gastown's strongest non-obvious ideas is that not every orchestration
decision belongs in the same layer.

The watchdog chain and dog docs show a serious attempt to distinguish:

- mechanical supervision
- reasoning-based triage
- long-running orchestration loops

That is a strong systems instinct.

Architect rating: `🎯 9.3   🛡️ 8.7   🧠 6`

## 12. Reliability-critical background work should stay imperative

`dog-execution-model.md` contains one of the most mature principles in the
repo:

- critical background work should stay imperative Go
- agent-interpreted/plugin-dispatched work should be reserved for less critical,
  more flexible tasks

This is exactly the kind of quiet boundary many orchestrators miss.

Architect rating: `🎯 9.5   🛡️ 9.0   🧠 4`

## 13. Property layers are a strong configuration concept

The property-layers document is better than it looks at first glance.

It shows real thought about:

- transient local override vs durable synced state
- additive vs replacement semantics
- explicit blocking of inheritance

That is a genuinely strong configuration model, even if the broader runtime is
not as quiet as the doctrine.

Architect rating: `🎯 9.1   🛡️ 8.8   🧠 5`

## 14. Self-managed completion is a better shape than witness-in-the-middle completion

The self-managed completion design is one of the strongest "future shape"
documents in the whole repo.

Its core idea is right:

- successful completion should not bottleneck on a patrol loop
- worker should self-transition to idle
- watchdogs should verify by exception, not own the happy path

That is a high-quality orchestration idea.

Architect rating: `🎯 9.4   🛡️ 8.9   🧠 6`

## 15. The work-ledger vision is stronger than a simple task board worldview

`why-these-features.md` shows something important:

Gastown is trying to be more than a task runner. It is trying to be a work
ledger with:

- attribution
- history
- routing potential
- validation
- cross-workspace references

That is strategically strong, even if the substrate is not yet calm enough to
carry all of it cheaply.

Architect rating: `🎯 9.0   🛡️ 8.4   🧠 7`

## 16. Mail is modeled as a real protocol, not just a chat transcript

The mail protocol docs are interesting because they treat inter-agent
coordination as:

- typed messages
- explicit routes
- handler expectations
- lifecycle semantics

That is stronger than a generic "shared inbox" idea.

Even though parts of the protocol now drift against newer runtime changes, the
core idea is still one of the best in the project:

- inter-agent coordination deserves a protocol, not just logs and ad-hoc chat

Architect rating: `🎯 9.4   🛡️ 8.8   🧠 5`

## 17. "Configuration, not compilation" is a very strong integration doctrine

The provider-integration guide contains a genuinely good boundary:

- external agent CLIs should be integrable through config tiers
- not through deep linking, SDK coupling, or compilation-time dependency

That is a strong ecosystem instinct.

Architect rating: `🎯 9.3   🛡️ 8.9   🧠 4`

## 18. Clean bootstrap over adopt is a subtle but excellent local-first lesson

The local rig bootstrap guide contains one of the strongest practical lessons in
the repo:

- prefer a fresh standard rig container
- do not trust hand-assembled inherited structure unless you really must

That is a very good rule for any orchestrator with durable workspace metadata.

Architect rating: `🎯 9.2   🛡️ 9.0   🧠 3`

## 19. "Do not adopt identity from files" is a better rule than it looks

This line appears in multiple places and is more important than it first seems:

- identity should come from injected authoritative runtime context
- not from cwd, filenames, directories, or beads discovered after startup

That is exactly the right instinct for preventing ambient-context corruption.

Architect rating: `🎯 9.6   🛡️ 9.2   🧠 3`

## 20. Universal attribution is a rare and powerful systems primitive

The identity docs and runtime env contract show a genuinely strong idea:

- every agent action carries a stable actor identity
- the same identity flows through git, beads, and event logs
- executor and owner are explicitly separated

That matters more than it first appears.

It gives the orchestrator:

- real auditability
- model and worker A/B comparison
- per-agent debugging
- a base for cost, quality, and skill attribution later

This is stronger than generic "session names" or "chat thread labels".

Architect rating: `🎯 9.4   🛡️ 8.9   🧠 4`

## 21. Verification over trust is the right shape for quality systems

Gastown's better docs consistently push an important idea:

- do not merely trust an agent saying "done"
- attach evidence
- record who validated
- let trust grow from reviewed work

The Wasteland and MVGT materials make this especially explicit through fields
like:

- `evidence_url`
- `validated_by`
- stamps
- trust levels

That is strategically strong because it turns quality from ceremony into data.

Architect rating: `🎯 9.3   🛡️ 8.8   🧠 5`

## 22. Minimum viable participation without full runtime adoption is an excellent ecosystem idea

MVGT is one of the most interesting ideas in the repo's wider vision:

- a system should be able to participate through a shared durable protocol
- it should not have to adopt the entire local orchestrator runtime first

That is a very good anti-lock-in principle.

It means:

- protocol matters more than product monopoly
- ecosystem participation can be incremental
- other orchestrators and CI systems can join without pretending to be Gastown

Architect rating: `🎯 9.5   🛡️ 9.0   🧠 7`

## 23. "Agents execute, humans own" is a surprisingly strong attribution doctrine

The identity docs make an important distinction:

- agent identity is executor attribution
- human or workspace owner remains the durable owner of the work

That is stronger than simply stamping everything with one bot name or one
human name.

It gives a cleaner model for:

- accountability
- audit
- ownership boundaries
- comparing executors without losing human responsibility

Architect rating: `🎯 9.2   🛡️ 8.9   🧠 4`

## 24. The yearbook rule is one of their best trust-system ideas

The Wasteland and MVGT materials contain a very crisp rule:

- you cannot stamp your own work

That seems obvious, but it is exactly the kind of rule many systems leave
implicit or social.

Making it explicit gives the trust system a much cleaner shape:

- reputation is attestational
- validation is socially external
- trust is earned from reviewed work, not self-report

Architect rating: `🎯 9.3   🛡️ 9.0   🧠 3`

## 25. CV and portable reputation are treated as product surface, not just analytics

One of the more unusual strengths in Gastown is that work history is not framed
as a hidden internal metric.

It is treated as a visible product concept:

- worker CVs
- work history
- capability-based routing
- portable reputation across towns and wastelands

That is strategically stronger than "we log some stats".

It means the system is trying to turn completed work into a durable,
queryable capability surface.

Architect rating: `🎯 9.2   🛡️ 8.6   🧠 6`

## 26. Large-repo economics are recognized as an architectural problem

The issue trail around large repos shows another mature instinct:

- clone shape
- mayor clone reuse
- sparse or partial materialization
- worktree startup cost

are not merely performance tweaks.

They are part of whether the orchestrator is viable at enterprise repo scale.

That is an important conceptual lesson:

- repository economics are part of the worker model
- not an afterthought for later optimization

Architect rating: `🎯 9.1   🛡️ 8.8   🧠 5`

## What this means in practice

The biggest conceptual strengths in Gastown are:

- worker identity separate from session
- persistent sandbox separate from process lifetime
- durable handoff and mailbox semantics
- fail-closed and cleanup-veto safety instincts
- explicit source-of-truth thinking
- transport-vs-policy separation
- layered control separation
- imperative core for reliability-critical background work
- property-layer thinking
- self-managed completion direction
- work-ledger and attribution vision
- mail as explicit protocol
- config-first provider integration
- clean bootstrap over adopt
- authoritative injected identity over ambient file inference
- universal attribution across git, beads, and events
- verification-over-trust quality thinking
- minimum viable protocol participation without full runtime adoption
- executor-vs-owner separation
- no-self-stamp trust discipline
- CV and portable reputation as explicit product surface
- large-repo economics as architecture, not mere optimization

## Final takeaway

Gastown's biggest danger is that its implementation can make you miss how good
some of its conceptual models actually are.

The correct lesson is:

- preserve the concepts
- simplify the substrate
- make the contracts authoritative earlier
