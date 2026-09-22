# Instruction Bundle Normalization And Compatibility Shadows

## The strong idea

`paperclip` has a better instructions-bundle model than many local-agent systems.

`server/src/services/agent-instructions.ts` already has several genuinely good laws:

- explicit `managed` vs `external` bundle mode
- path containment inside bundle root
- ignored junk files and directories
- managed-root recovery when config metadata is stale or missing
- dedicated test surface around bundle recovery

That is a real subsystem, not a loose convention.

## Where the seam still shows

The same service also shows that old compatibility carriers are still alive:

- `instructionsFilePath`
- `promptTemplate`
- deprecated `bootstrapPromptTemplate`
- legacy relative path resolution through `cwd`

That means the bundle story is stronger than "just a prompt", but not yet fully free of compatibility shadow.

Issue `#3191` is the clearest expression of this:

- managed bundles can still retain legacy `$AGENT_HOME/...` companion references
- runtime resolution got a partial prompt-side fix
- storage-side normalization still looks less closed

The current tree supports that reading.

In `packages/adapters/claude-local/src/server/execute.ts`, the Claude adapter now adds an explicit instruction telling the model to resolve sibling files from:

- `./HEARTBEAT.md`
- `./SOUL.md`
- `./TOOLS.md`

That helps.

But it is still mainly a resolution-side hint.

It is not the same as guaranteeing that stored managed bundle content is already normalized at write-time.

## Why this is a valuable lesson

This is a subtle but important architect smell.

There are two very different classes of fix:

1. fix how the model/tool resolves an ambiguous path
2. fix the persisted bundle so the ambiguity no longer exists

The first is cheaper and useful.

The second is the real contract closure.

Paperclip seems to have done more of the first than the second here.

That is exactly the kind of partial closure that makes a product feel:

- mostly correct
- but still surprisingly fragile around migration edges

## The positive side is still worth stealing

Do not miss the good part:

- bundle roots are explicit
- recovery from stale metadata is explicit
- managed bundle materialization is explicit
- tests cover several stale-root and recovery scenarios

That is much better than systems where instructions just "kind of live somewhere on disk".

## Architect takeaway

Steal:

- explicit managed vs external bundle mode
- path containment within bundle roots
- recovery from stale metadata as a first-class operation
- tests for stale-root and missing-metadata recovery

Avoid:

- fixing storage portability bugs only with prompt hints
- keeping legacy path dialects alive for too long
- letting managed bundle normalization become weaker than runtime resolution hints
