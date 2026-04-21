# OpenHarness State Persistence and Quiet Engineering

## Why this section matters

One of the best things in OpenHarness is that some boring engineering is already handled with real care.

That matters because young agent projects often fail not on the clever parts, but on:

- crash safety
- concurrent writes
- state corruption
- process boundary hygiene

## Atomic writes and file locking

After issue `#129`, OpenHarness added a strong boring pattern:

- `atomic_write_text`
- `exclusive_file_lock`

This is genuinely good engineering taste.

Good properties:

- temp-file plus `os.replace`
- same-directory atomic swap
- explicit `fsync`
- mode preservation
- cross-platform locking strategy

This is absolutely worth stealing.

## Session metadata allowlist

`session_storage.py` persists only a fixed allowlist of tool metadata keys.

That is a good quiet decision because it prevents:

- accidental persistence of arbitrary runtime internals
- opaque ever-growing snapshot blobs
- more future compatibility pressure than necessary

It also shows that they are at least trying to separate:

- durable session state
- transient runtime scratch

## Worktree slug validation

`validate_worktree_slug()` is a small but high-quality pattern:

- rejects empty values
- rejects long slugs
- rejects absolute paths
- rejects `.` and `..`
- restricts segment charset

This is the kind of small boundary hardening that pays off a lot.

## `contextvars` for in-process teammates

For Python, this is the right equivalent of task-local async identity.

Good part:

- each teammate task gets isolated context without manual argument threading everywhere

Important limit:

- this is only as good as the boundaries around it
- it does not solve cross-process or persisted identity truth

Still, as a local execution primitive, it is strong.

## Compaction checkpoints and carryover state

The compaction subsystem keeps more structure than average:

- checkpoints
- preserved attachments
- discovered tools
- task-focus state
- recent verified work

This is good because it treats compaction as:

- state surgery

not just:

- history deletion

## Quiet engineering summary

OpenHarness already shows several quiet strong habits:

- harden boring persistence
- validate filesystem-facing identifiers
- separate headless worker path from TUI path
- isolate in-process agent context
- preserve structured carryover across compaction

These are not flashy.
They are exactly the kinds of details that make a local orchestrator usable.
