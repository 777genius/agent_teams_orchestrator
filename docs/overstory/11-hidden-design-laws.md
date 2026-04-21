# Hidden Design Laws

## 1. Runtime is a first-class architectural axis

`🎯 10   🛡️ 9   🧠 4`

`overstory` is not just "Claude swarm with adapters".

The real design law is:
- orchestration is built around `AgentRuntime`
- runtime choice is per-agent, not per-project
- the system wants adapter heterogeneity to be normal

This is one of the most interesting decisions in the repo.

## 2. The worktree is the real worker cell

`🎯 9   🛡️ 9   🧠 4`

Workers are not defined primarily by a session or prompt.

They are defined by:
- a dedicated git worktree
- an overlay file in that worktree
- local agent state and logs
- branch naming and merge queue membership

This is stronger than prompt-only delegation.

## 3. Local SQLite is the durable plane inside one project

`🎯 9   🛡️ 8   🧠 4`

Within one repo, the durable truth is intentionally local:
- `mail.db`
- `merge-queue.db`
- `sessions.db`
- `events.db`

That is a good local-first law.

The problem comes when users expect the same model to scale to cross-repo orchestration without a stronger federation contract.

## 4. Headless is the destination, not the current baseline

`🎯 9   🛡️ 8   🧠 5`

The codebase already shows the intended future:
- direct subprocess spawning
- stdout event parsing
- optional RPC connection
- less dependence on `tmux`

But today this is fully real mainly for `SaplingRuntime`.

This makes `overstory` architecturally forward-looking, but operationally transitional.

## 5. Prompts are treated as a real subsystem

`🎯 9   🛡️ 8   🧠 4`

`canopy`, agent definitions, overlays, and `STEELMAN.md` are not decorative docs.

They are part of the actual control surface.

That is unusually mature for an agent project.

## 6. Externalized memory is part of the product model

`🎯 9   🛡️ 8   🧠 5`

`mulch`, `seeds`, `beads`, and emitted prompt artifacts are not side tools.

They act like auxiliary memory and workflow state.

This can be powerful, but it also means the repo gradually accumulates a second control plane next to the code.

## 7. Human/operator judgment still closes important gaps

`🎯 10   🛡️ 8   🧠 3`

This is the deepest hidden law in `overstory`:
- prompts
- `/dispatch`-style skills
- mulch learnings
- operator habits

still heal important correctness gaps that the runtime itself does not fully close.

That is not fatal, but it is a real architectural boundary.

## Architect takeaway

**`overstory` is strongest where these design laws are explicit and dangerous where users must discover them indirectly through issue threads and operational pain.**
