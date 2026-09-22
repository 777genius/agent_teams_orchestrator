# GoClaw Workspace Sharing and Dual Workspace Truth

## Why this matters

Workspace semantics are one of the easiest places for an orchestrator to lie to itself.

You can get all of these wrong in subtle ways:

- who shares files
- who shares memory
- who shares knowledge graph state
- who shares sessions
- which path is the real active workspace
- which workspace model tools actually enforce

GoClaw is interesting here because it does something genuinely good and something genuinely risky at the same time.

## What they get right

### 1. Sharing is modeled as independent axes

They do **not** treat "shared workspace" as one giant boolean.

The config separates:

- `shared_dm`
- `shared_group`
- `shared_users`
- `share_memory`
- `share_knowledge_graph`
- `share_sessions`

That is good architecture.

It means:

- file sharing can differ from memory sharing
- memory sharing can differ from KG sharing
- session sharing can differ from filesystem sharing

This avoids a very common mistake where one checkbox silently changes four different isolation domains.

### 2. The tests explicitly defend independence

Their tests make the intended semantics clear:

- `share_memory=true` does **not** imply shared workspace
- `shared_dm=true` does **not** imply shared memory
- `share_sessions` is independent of `share_memory`
- `share_knowledge_graph` is independent of both

That is a strong sign of architectural intent, not accidental behavior.

### 3. They are moving toward a single immutable workspace context

The `internal/workspace/` package is architecturally promising.

It introduces:

- a single `WorkspaceContext`
- explicit `Scope` values: `personal`, `team`, `delegate`
- one `Resolve(...)` step at run start
- an `ActivePath`
- read-only delegate exports
- enforcement labels for prompt injection into the run

This is the right direction.

It is much better than a system where random tools recalculate workspace logic ad hoc.

### 4. Delegate workspace resolution has a real boundary check

For delegated tasks they validate that the shared path stays under `BaseDir`.

That is a good concrete security pattern:

- normalize
- compare against the allowed base
- fail hard on traversal

### 5. Team workspace creation is slightly more conservative

Team directories are created with `0750`, while personal/delegate paths use `0755`.

That is not revolutionary, but it shows some security taste in a place where many projects stay sloppy.

### 6. The UI at least admits this is dangerous

The agent advanced settings UI puts an explicit warning around workspace sharing.

That is good product honesty:

- shared files are presented as a risky capability
- memory/KG/session sharing are shown as separate toggles

This is better than pretending sharing is just a convenience feature.

## What is risky

### 1. They currently have two workspace models alive at once

This is the most important risk.

The system still actively uses old tool-context workspace keys:

- `WithToolWorkspace`
- `WithToolTeamWorkspace`
- `ToolWorkspaceFromCtx`
- `ToolTeamWorkspaceFromCtx`

At the same time it also creates the newer immutable `workspace.WithContext(...)` model.

That means the architecture is in a migration state where:

- the new model exists
- the old model still powers most tools
- both truths can coexist in the same run

That is a classic source of drift.

### 2. The new workspace context does not fully encode the old sharing semantics

This is the deeper smell.

The old path still injects:

- `store.WithSharedMemory`
- `store.WithSharedKG`
- `store.WithSharedSessions`

based on the agent's `workspace_sharing` config.

But the newer `WorkspaceContext` mainly derives `MemoryScope` and `KGScope` from:

- personal vs predefined
- team shared vs isolated
- delegate mode

It does **not** fully represent the agent-level independent flags in the same way.

So during migration, different parts of the runtime can read different semantic sources for "what is shared".

That is dangerous even if it is temporary.

### 3. Compatibility shadow is already visible in the web UI

The web advanced settings still read:

- top-level `workspace_sharing`
- then fallback to `other_config.workspace_sharing`

This is understandable during a migration.

But it is also a warning sign:

- the product surface already has two config dialects
- the runtime has to stay bilingual
- long-lived fallback logic can become the real contract

### 4. Workspace semantics are now powerful enough to become confusing

This design is strong, but it raises semantic complexity:

- shared files but isolated memory
- isolated files but shared sessions
- group-shared but DM-isolated
- user-allowlisted sharing overriding peer-kind defaults

That is fine only if the contract stays explicit and strongly tested.

Otherwise this flexibility becomes a support burden and an operator comprehension trap.

## What to steal

- Orthogonal sharing axes instead of one giant "shared workspace" flag
- Explicit tests proving the axes stay independent
- Single immutable workspace context resolved once per run
- Delegate path traversal defense
- UI warnings on risky sharing surfaces

## What to avoid

- Letting old and new workspace models coexist for too long
- Encoding sharing semantics in two different truth systems at once
- UI compatibility fallbacks that quietly become permanent
- Powerful sharing combinations without a brutally explicit operator contract

## The distilled lesson

GoClaw shows a very good architectural instinct here:

- isolate the sharing axes
- resolve workspace once
- make delegation explicit

But it also shows a very familiar migration danger:

- the new contract is cleaner
- the old contract still drives real behavior
- both stay alive together

That makes this subsystem a strong competitor lesson:

- steal the **orthogonal sharing model**
- steal the **single-run workspace resolution target**
- avoid the **dual-workspace-truth migration state**
