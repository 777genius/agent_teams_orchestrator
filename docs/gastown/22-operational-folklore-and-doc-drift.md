# Gastown Operational Folklore and Documentation Drift

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file captures a subtle but important architectural problem:

- the effective runtime contract
- the design-doc contract
- the agent-prompt/formula contract

do not always say the same thing.

That creates hidden operational folklore.

## Why this matters

When a system is complex, documentation drift is not just a docs problem.

It becomes an architecture problem because:

- humans reason from the wrong model
- prompts and formulas keep encoding old behavior
- recovery and support rely on tribal knowledge
- "working code" and "working mental model" diverge

## 1. Strong example: `gt done` and sandbox lifecycle drift

Gastown now clearly has a persistent-polecat direction in many runtime paths:

- `gt done` transitions to idle
- sandbox is preserved for reuse
- witness handlers explicitly avoid auto-nuking

Relevant runtime evidence:

- `/tmp/gastown-latest/internal/cmd/done.go`
- `/tmp/gastown-latest/internal/witness/handlers.go`
- `/tmp/gastown-latest/docs/concepts/polecat-lifecycle.md`

But other docs and formulas still describe the old model:

- `gt done` nukes sandbox
- no idle state
- done means gone

Relevant drift evidence:

- `/tmp/gastown-latest/internal/templates/polecat-CLAUDE.md`
- `/tmp/gastown-latest/docs/reference.md`
- `/tmp/gastown-latest/docs/concepts/molecules.md`
- `/tmp/gastown-latest/docs/design/witness-at-team-lead.md`
- `/tmp/gastown-latest/internal/formula/formulas/mol-polecat-work.formula.toml`
- `/tmp/gastown-latest/internal/formula/formulas/mol-polecat-review-pr.formula.toml`
- `/tmp/gastown-latest/internal/formula/formulas/mol-polecat-work-monorepo.formula.toml`

Architectural lesson:

- runtime truth must not coexist too long with old prompt/formula semantics
- otherwise the system carries two live lifecycle models

Signal rating: `🎯 9.8   🛡️ 9.3   🧠 5`

## 1.5 Mail protocol docs also preserve older completion assumptions

The mail protocol docs still describe a more witness-centric completion chain:

- `POLECAT_DONE`
- witness cleanup flow
- `MERGE_READY`
- `MERGED` leading to nuke semantics

That protocol shape is historically important, but it now sits uneasily next to
the newer persistent-polecat and self-managed-completion direction.

Architectural lesson:

- if protocol docs encode an older happy path, they become folklore pressure on
  future runtime changes

Signal rating: `🎯 9.2   🛡️ 8.8   🧠 4`

## 2. `doctor --fix` becoming operational folklore

Gastown has many repair hints pointing users toward:

- `gt doctor --fix`

This is useful.

But it also reveals something deeper:

- too much convergence work is deferred to a repair ritual
- users and maintainers learn "doctor will sort it out"
- repair becomes part of the operating model

Evidence:

- many doctor checks across `internal/doctor/*`
- upgrade path explicitly runs doctor as structural repair
- docs repeatedly instruct users to run doctor after drift or upgrade

This is not automatically bad.

But it becomes dangerous when:

- doctor itself is non-convergent
- doctor can touch the wrong boundary
- doctor is used as substitute for tight runtime invariants

Architectural lesson:

- repair tools should exist
- but healthy architecture should need them rarely, not habitually

Signal rating: `🎯 9.5   🛡️ 9.0   🧠 4`

## 3. Hooks as a good doctrine with messy edge reality

`HOOKS.md` contains a strong design principle:

- registry is catalog, not truth
- base/overrides is truth
- explicit precedence

That is good doctrine.

But the same file also admits:

- registry does not cover all active hooks
- some hooks still live only in generated settings
- Codex and others fall back to startup nudge

So the practical system is:

- better than ad-hoc hooks
- but still not one completely sovereign hook model

Architectural lesson:

- a good doctrine is valuable
- but if live runtime exceptions remain, document them as temporary seams and
  keep shrinking them

Signal rating: `🎯 9.2   🛡️ 8.8   🧠 4`

## 4. Operational folklore often appears where repo boundaries are implicit

Issue `#716` is a good example:

- agents get confused by nested repos
- workaround is "explain the repo structure better in CLAUDE.md"

That workaround helps.

But it also reveals the architectural smell:

- a hard boundary problem is being patched through contextual explanation

Likewise `#824` and `#885` show:

- users can be hurt if boundary rules are not explicit enough
- documentation and habits are not a sufficient guard

Architectural lesson:

- if violating the rule is dangerous, the rule belongs in the engine
- not only in docs, prompts, or user convention

Signal rating: `🎯 10   🛡️ 9.6   🧠 5`

## 4.5 Ambient identity is another folklore trap

Gastown explicitly warns:

- do not adopt identity from files, directories, or beads you encounter

That warning exists because otherwise operators and agents will infer identity
from ambient structure.

This is one of the clearest examples of a hard runtime rule having to defend
itself against natural but unsafe human heuristics.

Architectural lesson:

- identity must come from injected authoritative runtime context
- not from local discovery folklore

Signal rating: `🎯 9.6   🛡️ 9.2   🧠 3`

## 4.6 Even good identity doctrine can be undermined by launch-context leakage

Issue `#3006` is especially valuable because it shows a deeper problem than
"wrong env var":

- the docs say identity should be explicit and authoritative
- but the daemon could still inherit agent identity from the launching session
- system-generated messages then appeared to come from that agent

That is a very strong architect lesson:

- good doctrine is not enough
- launch boundaries have to enforce the doctrine mechanically

Signal rating: `🎯 9.7   🛡️ 9.3   🧠 4`

## 5. Acceptance docs show a strong engineering instinct

One positive sign:

- Gastown does produce explicit acceptance docs for fix batches
- the team cares about pinned tools, reproducible verification, and noisy-env
  tolerance

Example:

- `/tmp/gastown-latest/docs/phase4-minimum-fix-acceptance.md`

This is good practice worth stealing.

Architectural lesson:

- when a seam is painful, freeze verification commands and success criteria
- architecture improves faster when fixes are attached to explicit acceptance
  gates

Signal rating: `🎯 9.1   🛡️ 8.9   🧠 3`

## 6. Deep takeaway

Gastown is one of those projects where:

- design principles are often ahead of implementation
- implementation is often ahead of docs in some places
- old prompts and formulas still carry yesterday's contract

That creates a hidden cost:

- operational folklore

People need to know:

- which doc is current
- which formula is legacy-shaped
- which repair ritual is normal
- which runtime behavior actually wins

That is expensive.

## 7. Best practices worth stealing

- explicit precedence rules for layered config
- catalog vs truth separation
- acceptance-command docs for painful fix batches
- clear documentation of temporary seams and known gaps
- shrinking exceptions over time instead of normalizing them forever

## 8. Critical bad practices to ban

- leaving old lifecycle semantics alive in prompts after runtime changed
- relying on docs to patch hard boundary ambiguity
- letting repair workflows become part of normal happy-path operation
- accepting multiple "mostly true" descriptions of core lifecycle behavior
- allowing generated config systems to drift away from effective runtime truth
- teaching identity discipline publicly while still allowing ambient launch context to contaminate it

## Final takeaway

Gastown teaches an important architect lesson:

even good code and good design docs are not enough if the operational contract
is split across:

- runtime
- repair tooling
- prompts
- formulas
- folklore

A new orchestrator should treat contract convergence as a first-class design
goal.
