# GoClaw Vault Ingestion and Defensive Omission

## Why this file exists

Some of GoClaw's best engineering taste is not in orchestration logic.
It is in what the system deliberately refuses to ingest.

The vault walk layer is a good example of this.

## 1. Safe walk is treated as a bounded operation, not a blind filesystem crawl

This is a good decision.

`SafeWalkWorkspace(...)` does not just recurse through the workspace.
It enforces:

- max file count
- max total bytes
- max per-file bytes
- periodic context cancellation checks

Architect lesson:

- ingestion walks should have explicit resource limits from day one

## 2. Symlinks are skipped unconditionally

This is one of the strongest local safety decisions in the file.

GoClaw skips:

- symlink files
- symlink directories

And it does so unconditionally.

That is much safer than trying to "mostly resolve safe symlinks".

Architect lesson:

- for ingestion/indexing surfaces, strict symlink omission is often better than clever traversal logic

## 3. Sensitive bootstrap and identity files are excluded from vault registration

This is a very good pattern.

The vault walker excludes root-level context files such as:

- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `BOOTSTRAP.md`
- `AGENTS.md`
- `TOOLS.md`
- `CAPABILITIES.md`
- `MEMORY.md`
- `AGENTS_CORE.md`
- `AGENTS_TASK.md`

That is good because those files carry system authority, persona, or onboarding semantics.
They should not casually re-enter general knowledge indexing.

Architect lesson:

- context-authority files should usually be kept out of generic semantic ingestion

## 4. External fetch artifacts are explicitly distrusted

Another strong local decision:

- `web-fetch/` is excluded at any depth

The code comments say this is because externally fetched content may be dangerous.

That is the right instinct.

Architect lesson:

- data fetched from outside the workspace should not automatically inherit the same trust as local project files

## 5. Hidden directories are excluded, with a narrow explicit carve-out

GoClaw skips hidden directories by default, except for `.uploads`.

That is a nice example of guarded inclusion:

- deny by default
- make the exception narrow and explicit

Architect lesson:

- allowlist exceptions are healthier than broad "hidden files are probably fine" logic

## 6. Extension allowlisting is used as defense in depth

This is not the main safety layer.
But it is still useful.

Unknown extensions are skipped rather than indexed by default.

Architect lesson:

- content ingestion should have a positive type vocabulary, not only path-based exclusions

## 7. This is a strong example of defensive omission

A lot of systems focus only on what they ingest.
GoClaw also makes deliberate decisions about what must stay out:

- symlinks
- bootstrap/context files
- hidden directories
- external fetch content
- sqlite artifacts

This is good architecture.

Architect lesson:

- omission rules are part of the contract, not just implementation details

## 8. There are still small honesty risks in this layer

⚠️ The layer is good, but not perfect.

Examples:

- unreadable entries are silently skipped
- extension normalization comments admit some unicode edge cases are accepted as tradeoffs
- root-level context files are excluded, but nested files with the same names can still be indexed

These are not catastrophic.
But they are reminders that even good ingestion layers need clear honesty about edge behavior.

Architect lesson:

- safe omission is strongest when edge-case behavior is still easy to explain

## 9. Even the tests hint at small contract drift

There is a small but telling signal in `safe_walk_test.go`:

- one assertion expects `len(entries) == 5`
- but the failure message still says "want 6 non-excluded"

That is minor.
But it is exactly the kind of tiny mismatch that shows a subsystem is evolving faster than all of its textual descriptions.

Architect lesson:

- test messages are part of operator and maintainer truth too; stale wording is an early drift signal

## 10. The reusable lesson

The most reusable idea here is not "copy this exact file list".

It is:

- build ingestion around bounded resource usage
- explicitly exclude authority-bearing files
- distrust external fetch artifacts
- prefer omission over clever recovery at dangerous filesystem seams

## The distilled lesson

GoClaw shows a strong non-obvious pattern here:

- a good orchestration platform also needs good defensive omission rules around knowledge ingestion

This is worth stealing.

And the warning is:

- even a strong omission layer can drift if comments, test wording, and edge-case behavior stop moving together
