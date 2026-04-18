# Gastown Startup and Runtime Contracts

Date: 2026-04-16  
Studied revision: `bdbe8c4b`

This file covers the deepest startup/runtime faults:

- startup blind spots
- distributed bootstrap contract
- runtime identity
- role config split
- capability inference
- env transport fragmentation
- session lifecycle partial convergence

## Main conclusion

Gastown does not have one sovereign startup/runtime contract.

Instead, startup meaning is distributed across:

- role TOMLs
- runtime config
- presets
- env propagation
- hooks
- prompts
- `gt prime`
- tmux session env
- initial shell env
- runtime-only compensators

## 1. Worker bootstrap is a distributed contract

Startup truth is spread across:

- beacon prompt
- SessionStart hook
- `gt prime`
- delayed nudge
- `CLAUDE.md` / `GEMINI.md` style context files
- wrappers
- doctor checks

That means bootstrap is not one structured startup envelope.

## 2. Canonical hooked startup has a blind spot

Gastown built strong fallback behavior for off-canonical paths.

But the hook+prompt path can still have weaker recovery if hooks silently fail.

This is the kind of bug where the "best" path in theory becomes the least
defended path in practice.

## 3. Runtime identity is lossy

Gastown repeatedly translates between:

- configured alias
- provider
- command binary
- preset identity
- process names for liveness

These are not one stable first-class object.

That is why it needs compensators like:

- `ResolvedAgent`
- `GT_AGENT`
- `GT_PROCESS_NAMES`

## 4. Role definitions are a second runtime-config plane

Role definitions do not only describe orchestration policy.
They also embed concrete provider-shaped startup commands such as:

- `exec claude --dangerously-skip-permissions`

So launch semantics are split across:

- role TOMLs
- runtime-config resolution

The runtime layer is not the only owner of startup.

## 5. The new role-config system is not yet sovereign

`RoleDefinition` looks richer than the runtime wiring that actually consumes it.

The live runtime mostly downcasts it to a smaller legacy-shaped contract, while
other semantics still live elsewhere.

That means schema surface and effective control surface are not the same thing.

## 6. Runtime capabilities are partly inferred

Capabilities such as:

- ACP
- hooks
- prompt delivery
- readiness
- session behavior

are not always fully declared.
They are often inferred from:

- provider
- command
- built-in preset
- helper logic

That is convenient, but expensive for reasoning.

## 7. Capability schema is split

The richest capability model lives in internal preset structures.
Public custom-agent config exposes a poorer schema.

So custom agents can be configurable without becoming fully first-class runtime
citizens.

## 8. Defaulting semantics are inconsistent

The runtime config system does not interpret "omitted" vs "zero" vs "false"
consistently across helper paths.

That means the same partial config can mean different things depending on which
normalization path touched it.

## 9. Session lifecycle abstraction exists, but core roles bypass it

Gastown already has `session.StartSession()`.
That is a good direction.

But several of the hardest startup paths still live outside it:

- witness
- deacon
- refinery
- crew
- polecat

So the shared lifecycle is not authoritative where the startup pain is largest.

## 10. The tmux/env transport itself is fragmented

Startup environment is delivered through a mix of:

- `exec env ...`
- `tmux -e`
- `tmux set-environment`
- global env sanitization

Those are not equivalent.

So:

- initial shell state
- session table state
- respawn inheritance
- liveness metadata

do not come from one mechanism.

## 11. Provider/account identity is sidecar-like

Provider/account identity is mediated through:

- config dir selection
- symlink swaps
- keychain mutation
- `.claude.json`
- `GT_QUOTA_ACCOUNT`
- transcript relinking

That is clever, but it creates another identity plane.

## 12. Provider-specific project-context files are part of the runtime contract

Issue `#3139` exposes a useful but easy-to-miss lesson:

- hooks and slash commands can be provisioned correctly
- yet the runtime still behaves as under-integrated if its persistent project
  context file contract is not satisfied

For example:

- Claude-shaped flows assume `CLAUDE.md`
- Gemini-shaped flows may expect `GEMINI.md` or an explicit redirected filename

This means runtime integration is not complete until the orchestrator owns:

- which context file the provider expects
- whether that name is configurable
- where the file lives inside worktrees
- how the file is kept consistent with the orchestrator's instruction model

Architect lesson:

- "provider support" includes the persistent context-file contract, not just
  process launch, hooks, and env
- otherwise the engine can believe a runtime is integrated while the runtime
  still lacks its real project memory surface

## Key issues to remember

- `#3031` - startup verify can itself destabilize startup
- `#3133` - hook-based polecats can sit idle if hooks fail
- `#3218` - witness ignored `role_agents` model config
- `#3248` - hooks sync fell back to Claude and hid non-Claude targets
- `#3033` - Gemini crew startup/context problems
- `#1289` - crew shell inherited parent `GT_ROLE`
- `#1666` - `CLAUDECODE` leaked and broke nested-session startup
- `#3652` - some role start paths still do not ensure their own lifecycle invariants
- `#3139` - Gemini worktrees revealed a missing provider-specific context-file contract

## Retrieval hint

Open this file when the question is:

- "why is their startup so expensive?"
- "what is wrong with their runtime abstraction?"
- "why is non-Claude support broader in config than in the engine?"
