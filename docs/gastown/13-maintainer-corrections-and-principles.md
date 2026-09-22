# Gastown Maintainer Corrections and Hidden Best Practices

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file focuses on a different question:

> not only "what is Gastown today?", but also "what do the maintainers already
> know is the right architectural direction?"

That is often the most valuable source of best practices.

## Why this file matters

A project can have an expensive current architecture and still contain very good
future-facing design principles.

Gastown is exactly that kind of project.

## 1. Factory Worker API principles are excellent

The document `docs/design/factory-worker-api.md` is one of the strongest
artifacts in the repo.

Its principles are worth taking almost verbatim:

- **Push, not scrape**
- **Structured, not string-matched**
- **Agent-agnostic**
- **Correlation by design**
- **Fail-closed defaults**

Architect rating: `🎯 10   🛡️ 9.5   🧠 5`

Why this is so valuable:

- it directly attacks tmux scraping
- it directly attacks prompt-prefix heuristics
- it directly attacks transcript scraping and shell choreography
- it gives a clean future boundary for Claude, Codex, Gemini, and custom
  runtimes

## 2. They already know terminal scraping is the wrong boundary

`factory-worker-api.md` explicitly lists the current hacks:

- `tmux send-keys`
- prompt regexes
- transcript scraping
- process-tree liveness
- keychain token swapping

This is valuable because it means the maintainers themselves already understand
which seams are unhealthy.

Architect rating: `🎯 9.8   🛡️ 9.4   🧠 2`

## 3. They already know correlation needs to be first-class

The `run_id` principle in the worker API design is exactly right.

That is one of the biggest missing pieces in many agent orchestrators.

Why it matters:

- clearer lifecycle ownership
- cleaner audit
- easier observability
- fewer heuristic joins across logs and subprocesses

Architect rating: `🎯 9.6   🛡️ 9.2   🧠 4`

## 4. They are moving toward event-driven wake

The issue trail and code already show movement away from polling-only behavior:

- `#2067` proposes deacon event-driven wake
- witness code already emits file-based events in some paths
- ACP-safe watcher language appears in the nudge poller code

This is a good direction even if polling still dominates.

Architect rating: `🎯 9.2   🛡️ 8.8   🧠 5`

## 5. They understand that sandboxes need a real control-plane boundary

`docs/proxy-server.md` is another strong architectural clue.

The proxy design includes:

- mTLS identity
- allowlisted binaries
- allowlisted subcommands
- startup-time binary path resolution
- server-side branch authorization
- rate limiting
- concurrency caps

Architect rating: `🎯 9.3   🛡️ 9.1   🧠 6`

This is good because it treats sandboxed workers as a boundary problem, not only
as a prompt problem.

## 6. They understand fail-closed better than many competitors

A recurring positive theme in their newer design writing is:

- unknown state should block dangerous action
- unreachable policy engine should not silently allow action
- guard rules should be data, not shell scripts

This is a very healthy instinct for orchestration systems with write access.

Architect rating: `🎯 9.4   🛡️ 9.3   🧠 5`

## 7. They know headless and sandboxed workers matter

This is visible both in design direction and in open issues:

- `#1382` - headless/sandboxed polecats
- `#2229` - local and remote execution sandboxes
- `#10` - agent-agnostic engine with safe sandboxed headless sessions
- proxy-server design for containerized polecats

This is a genuine strength of vision, even if the current engine still fights it.

Architect rating: `🎯 9.1   🛡️ 8.7   🧠 6`

## 8. They understand the difference between catalog and source of truth

`docs/HOOKS.md` explicitly says:

> The registry is a catalog, not the source of truth.

That sentence matters.

It shows they understand a core architectural principle:

- indexes and registries should not silently become the authority for runtime
  truth

Architect rating: `🎯 9.0   🛡️ 8.9   🧠 3`

## 9. They are trying to make capability handling explicit

ACP work, runtime parity work, wrapper work, and role-agent fixes all point to
the same healthy destination:

- capabilities should be explicit
- runtime behavior should not depend on hidden Claude-only assumptions

This is not fully solved, but the direction is good.

Architect rating: `🎯 8.9   🛡️ 8.4   🧠 6`

## 10. They respect recovery and cleanup interlocks

Even in expensive code, there is a healthy instinct to separate:

- cleanup vetoes
- active session checks
- stale PID cleanup
- persistent sandbox preservation

This is visible in ACP cleanup handling, witness cleanup vetoes, and preserved
sandbox logic.

Architect rating: `🎯 8.8   🛡️ 8.5   🧠 5`

## 11. They are converging on self-managed completion

`polecat-self-managed-completion.md` is a very strong correction document.

The key move is:

- remove witness from the happy-path completion bottleneck
- let polecats self-transition to idle
- let watchdogs verify by exception

That is a healthier future direction than the current witness-heavy completion
path.

Architect rating: `🎯 9.4   🛡️ 8.9   🧠 6`

## 12. They already know critical background work should stay imperative

`dog-execution-model.md` is important because it rejects a common failure mode
in agent systems:

- moving everything into formulas or agent-dispatched workflows

Their stated target model is better:

- critical unattended jobs stay imperative Go
- plugins and dogs are for the less critical and more flexible paths

Architect rating: `🎯 9.5   🛡️ 9.0   🧠 4`

## 13. They understand that public doctrine must be explicit

Docs like:

- `operational-state`
- `property-layers`
- `why-these-features`

show that the maintainers are trying to export explicit public principles, not
just commands.

That is a sign of architectural maturity:

- they understand that public mental models are part of the system

Architect rating: `🎯 9.0   🛡️ 8.6   🧠 4`

## 14. They already have a strong config-first provider integration doctrine

The provider integration guide has a very good north star:

- integration should be configuration, not compilation
- third-party CLIs should be able to join through tiers
- deeper integration should be optional, not mandatory

That is one of the strongest ecosystem-facing ideas in the repo.

Architect rating: `🎯 9.3   🛡️ 8.9   🧠 4`

## 15. They understand that local bootstrap shape matters

The local rig bootstrap guide shows a mature operational instinct:

- prefer clean bootstrap over adopting a hand-assembled directory
- inherited shape is often already inconsistent

This is a good example of maintainers understanding that local structure
integrity is part of architecture, not just setup UX.

Architect rating: `🎯 9.1   🛡️ 9.0   🧠 3`

## 16. They understand that identity must be injected, not discovered

The repeated warnings not to adopt identity from files or ambient structure are
more important than they first look.

They show that the maintainers understand a deep rule:

- identity must come from authoritative runtime injection
- not from cwd, files, directories, or leftover environment

That is one of the right long-term corrections for a system this stateful.

Architect rating: `🎯 9.5   🛡️ 9.1   🧠 3`

## 17. They are already thinking in evidence-first validation terms

The public docs around attribution, validation, and Wasteland participation
show another strong principle:

- completions should carry evidence
- validation should be attributable
- trust should be earned from reviewed work, not assumed

That is a better shape than "task says done" or "review happened somewhere".

Architect rating: `🎯 9.2   🛡️ 8.8   🧠 5`

## Best practices to extract from their direction of travel

- Build one explicit worker API instead of scraping terminals
- Make lifecycle and telemetry agent-pushed where possible
- Give every run a stable correlated identity
- Prefer event-driven wake over blind polling
- Treat sandbox execution as a transport and authorization problem
- Resolve binaries and command allowlists at trusted boundaries
- Fail closed on policy and authorization uncertainty
- Keep catalogs and registries separate from truth
- Design for headless workers early, not as a late patch
- Make security and capability semantics explicit, not prompt-based
- Let workers self-complete when watchdog mediation is not semantically needed
- Keep reliability-critical background work deterministic and imperative
- Treat public doctrine and mental model as part of architecture, not docs garnish
- Make third-party agent integration config-first by default
- Prefer clean bootstrap flows over inherited/adopted structure whenever possible
- Inject identity authoritatively instead of discovering it from ambient context
- Treat validation, evidence, and trust as structured product data

## Bad practices their future direction is implicitly warning against

- terminal scraping as a long-term strategy
- parsing UI prompts to infer lifecycle state
- transcript scraping as the source of telemetry and cost
- subprocess forests as your internal control plane
- runtime behavior depending on vendor-specific CLI quirks
- optimistic authorization on policy uncertainty
- treating interactive sessions as the only "real" worker shape

## Final architect takeaway

Gastown's current runtime is expensive, but its design correction documents are
genuinely strong.

That means the highest-value lesson is:

- do not copy what the runtime currently does
- do copy the architectural principles the maintainers are trying to migrate
  toward
