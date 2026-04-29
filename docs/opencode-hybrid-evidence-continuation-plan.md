# OpenCode Hybrid Evidence Pipeline - Source-Driven Continuation Plan

Status: implemented and verified in the continuation worktrees. This document was originally an IOF revision after reading our current bridge code, installed OpenCode 1.14.19 behavior, official docs, current OpenCode `dev` source from `anomalyco/opencode`, and a local `git diff --raw -z` prototype for unusual paths.

Current worktree:

```text
/Users/belief/dev/projects/claude/_worktrees/agent_teams_orchestrator_opencode_snapshot_bridge
branch: research/opencode-hybrid-evidence-continuation
```

Related UI worktree:

```text
/Users/belief/dev/projects/claude/_worktrees/claude_team_opencode_ledger_bridge
branch: feat/opencode-hybrid-evidence-ui-continuation
```

Verified completion snapshot:

```text
orchestrator targeted suite: 175 pass, 0 fail
orchestrator build: bun run build:dev passed
OpenCode fixture/public-runtime E2E: 17 pass, 0 fail
OpenCode live snapshot evidence E2E: 1 pass, 0 fail
OpenCode live ledger bridge E2E: 6 pass, 0 fail, 98 expect calls
Combined live snapshot bridge E2E: real OpenCode snapshot:true run -> strict delivery bridge -> full-text ledger bundle passed
UI targeted suite: 119 pass, 0 fail
UI typecheck: pnpm typecheck passed
git diff --check: passed in both worktrees
```

Latest safety hardening added after the original completion snapshot:

```text
SQLite/WAL/busy/cap read races now resolve to transient-error with retryAfterReason, not stable no-attribution.
This prevents UI auto-backfill from caching a temporarily incomplete OpenCode history as clean/no changes.
Malformed completed OpenCode write/edit toolparts are now row-level diagnostic skips, so one bad toolpart no longer drops otherwise valid session history.
If every file toolpart candidate has unsupported shape, backfill resolves to skipped-capability instead of a clean no-attribution result.
OpenCode same-message toolpart chains now use message-local part id order before timestamps, matching the snapshot window ordering contract and preventing timestamp skew from breaking write -> edit reconstruction.
OpenCode evidence upgrades now fail closed when the existing source import identity and incoming event disagree on relative path, session id, part id, or message id.
Added a gated combined live E2E proving a real snapshot:true OpenCode file edit can be imported through the default bridge path as full-text reviewable task changes.
Added fixture/public-runtime E2E for same-session other-task rejection, missing snapshot gitdir metadata-only visibility, and metadata-only to full-text snapshot evidence upgrade.
Added public-runtime E2E for snapshot dry-run no-write behavior, idempotent duplicate handling, CLI metadata-only to full-text upgrade, and snapshot-backed apply_patch delete lifecycle projection.
Expanded gated real OpenCode bridge E2E to cover strict-delivery fail-closed on wrong delivery ids, multi-file snapshot full-text import, duplicate-safe repeated backfill on live data, and non-snapshot existing-file fallback as visible manual-only changes.
Expanded public runtime E2E to cover mismatched delivery context fail-closed with zero ledger artifacts, plus a gated live CLI test proving real OpenCode snapshot artifacts import through `cli-dev runtime opencode-ledger-backfill` from managed-profile storage.
Expanded E2E again to cover real public-CLI create lifecycle from OpenCode write toolparts and public-runtime binary/large-file manual-only metadata behavior.
Expanded public-runtime Changes E2E to cover workspace-root mismatch fail-closed behavior and snapshot-only formatter noise being excluded unless a strict delivery-matched toolpart proves the path.
```

## Executive Summary

The previous continuation plan was too focused on adding our own pre/post snapshot boundary around delivery. After reading OpenCode source, the better path is clearer:

**Use OpenCode's own session snapshot parts as the primary snapshot boundary.**

OpenCode already records snapshot hashes in SQLite parts:

- `step-start.snapshot`
- `step-finish.snapshot`
- `patch.hash`
- `patch.files`

OpenCode snapshots are implemented as an internal git tree store under:

```text
<OpenCode data>/snapshot/<project.id>/<sha1(worktree)>
```

This is much better than parsing human/debug CLI output and more precise than our own external boundary capture.

Chosen next architecture:

**Session-part snapshot bridge + read-only object-id snapshot git diff + metadata fallback, enabled by default for OpenCode** - 🎯 8.7   🛡️ 9.0   🧠 8.7 - about 3000-5200 LOC, mostly tests and fixtures.

What changes from the last plan:

- Primary full-text source becomes OpenCode SQLite `step-start` / `step-finish` snapshot parts.
- Production reader should read OpenCode's snapshot git store directly with read-only `git` commands.
- `opencode debug snapshot track/patch/diff` stays live-probe/debug only.
- Our current `snapshotBoundary` is removed from the production evidence path. SQLite step windows are the only snapshot boundary.
- Non-git OpenCode projects still cannot get snapshot full diffs, because OpenCode source returns snapshot disabled when `state.vcs !== "git"`.
- UI auto-backfill should use the new OpenCode snapshot evidence path by default. There is no feature flag or legacy boundary provider in the final implementation.

## Product Decision Update

The implementation target is now:

```text
no feature flag
no legacy readBoundaryEvidence provider
OpenCode managed profile enables snapshot by default for new sessions
UI auto-backfill calls the new session evidence path directly
unsupported/ambiguous evidence degrades to metadata-only/manual-review
```

Important distinction:

- **No legacy path** means no production fallback to the old `snapshotBoundary` API, no debug CLI parser, and no UI `chain-only` mode.
- **Fail-closed fallback remains required**. If a session has no snapshots, is non-git, has schema drift, has ambiguous windows, or hits caps, we still import metadata-only/manual-review when exact toolpart paths are proven.

How we verify without a feature flag:

```text
unit tests -> provider is the only OpenCode evidence path
fixture E2E -> SQLite + snapshot gitdir -> ledger bundle -> UI reader
live E2E -> real OpenCode snapshot:true session -> ledger full-text event
UI integration -> ChangeExtractorService auto-backfill invokes default snapshot path
regression -> non-OpenCode task ledger tests unchanged
```

This means we do not need a UI flag to check it. We verify through the same default path users will run.

## Verified Facts

### Official Docs

OpenCode config docs say snapshots are enabled by default and support undo/revert. They also warn that large repos or many submodules can cause slow indexing and significant disk usage because snapshots use an internal git repository. `snapshot: false` disables this behavior.

Source: https://opencode.ai/docs/config/#snapshot

### Installed CLI

Installed locally:

```text
opencode --version
1.14.19
```

Debug snapshot commands:

```text
opencode debug snapshot track
opencode debug snapshot patch <hash>
opencode debug snapshot diff <hash>
```

Help output has no JSON flag and no machine-readable schema. Therefore:

- ok for gated live smoke;
- not ok for normal production Changes path.

### OpenCode Source Findings

Source files inspected:

```text
packages/opencode/src/snapshot/index.ts
packages/opencode/src/session/processor.ts
packages/opencode/src/session/summary.ts
packages/opencode/src/session/message-v2.ts
packages/opencode/src/cli/cmd/debug/snapshot.ts
packages/core/src/util/hash.ts
packages/core/src/global.ts
packages/opencode/src/project/project.ts
packages/opencode/src/session/session.sql.ts
packages/opencode/src/project/project.sql.ts
```

Source revision check:

```text
local source checkout inspected: ea3c6c34811de792ba6870766dd0a36f3a392bc6
remote anomalyco/opencode dev later reported: 2c2fc3499b3723a0595e1666b97207043913f2a8
```

The inspected source supports the snapshot/session assumptions below, but OpenCode `dev` moved after the inspection. Treat these findings as source-derived constraints plus a drift risk, not as a permanent API contract. The implementation needs the version/source-shape sentinel described later in this plan.

Important implementation facts:

1. Snapshot storage is internal git:

```ts
gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
```

2. `Hash.fast` is SHA-1:

```ts
createHash("sha1").update(input).digest("hex")
```

3. Snapshot is only enabled for git projects:

```ts
if (state.vcs !== "git") return false
return (yield* config.get()).snapshot !== false
```

4. `track()` stages changed/untracked files in the snapshot git index and returns `git write-tree` hash.

5. `patch(hash)` runs `add()` again, then `git diff --cached --name-only hash`.

6. `diffFull(from, to)` uses:

```text
git diff --name-status --no-renames from to
git diff --numstat --no-renames from to
git cat-file --batch
git show fallback
```

OpenCode also sets git config flags around snapshot operations:

```text
core.autocrlf=false
core.longpaths=true
core.symlinks=true
core.quotepath=false for path-listing commands
```

Our reader should mirror the read-relevant flags, especially on Windows.

7. OpenCode writes snapshot hashes into session parts:

```ts
type: "step-start", snapshot: ctx.snapshot
type: "step-finish", snapshot: yield* snapshot.track()
```

8. OpenCode writes patch parts after a step:

```ts
type: "patch", hash: patch.hash, files: patch.files
```

9. `patch.hash` is the start snapshot passed to `snapshot.patch(ctx.snapshot)`, not the finish snapshot.

10. `patch.files` are absolute worktree paths normalized to forward slashes:

```ts
path.join(state.worktree, x).replaceAll("\\", "/")
```

11. `patch.files` are produced from `git diff --name-only` text split by newline in OpenCode source. That means odd filenames containing newline are not safely represented there.

12. OpenCode's own summary computes full diffs by finding the first `step-start.snapshot` and last `step-finish.snapshot`, then calling `snapshot.diffFull(from, to)`.

This means we do not need to invent a boundary format first. We should read the exact snapshot hashes already written in SQLite for the message/toolpart window.

### OpenCode SQLite Schema Facts

The schema gives us enough identity to avoid guessing:

```text
session.id
session.project_id
session.directory
session.summary_diffs

project.id
project.worktree
project.vcs

message.id
message.session_id
message.time_created
message.data

part.id
part.message_id
part.session_id
part.time_created
part.data
```

Important interpretation:

- `session.project_id` is the authoritative project id for snapshot storage.
- `project.worktree` is the exact input for OpenCode `Hash.fast(ctx.worktree)`.
- `project.vcs !== 'git'` means OpenCode snapshot full-text evidence is unavailable by design.
- `session.summary_diffs` can be useful as a diagnostic cross-check, but it must not become primary evidence because it is session-level and can cross task boundaries.
- `session.directory` is authoritative for reproducing OpenCode's snapshot diff command cwd and pathspec scope. It should not override `project.worktree` for snapshot gitdir hashing.

### OpenCode Directory/Worktree Contract

OpenCode snapshot state stores both:

```ts
directory: ctx.directory
worktree: ctx.worktree
gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
```

OpenCode diff commands run with:

```text
--git-dir <gitdir>
--work-tree <worktree>
cwd: <directory>
pathspec: -- .
```

Local prototype result:

```text
cwd=<worktree>      -> raw paths include all changed files
cwd=<worktree>/src  -> raw paths include only changes under src
raw paths are still worktree-relative, for example src/a.txt
```

Therefore our reader must:

- compute snapshot gitdir with exact `project.worktree`;
- run read-only git diff commands with `cwd=session.directory`;
- validate `session.directory` is same-or-descendant of `project.worktree`;
- match raw diff paths against worktree-relative candidate paths;
- never use `session.directory` as the snapshot gitdir hash input.

If `session.directory` is missing, outside `project.worktree`, or path-style mismatched:

```text
snapshot evidence unsupported
chain/metadata fallback only
```

## Current Code Reality

Already implemented in our worktree:

- strict OpenCode delivery attribution;
- `OpenCodeOfflineSessionReader` reads SQLite messages and parts;
- `OpenCodeToolpartChangeReconstructor` reconstructs `write`, `edit`, `apply_patch`;
- `OpenCodeApplyPatchEvidenceParser` extracts safe touched paths;
- `OpenCodeChangeEvidenceEnricher` supports `chain-only`, `snapshot-auto`, provider injection, and fallback;
- `OpenCodeLedgerBridgeService` passes `snapshotBoundary` from delivery context to enricher;
- UI auto-backfill sends `strict-delivery` and `chain-only`;
- metadata-only OpenCode changes stay manual-only.

These are current implementation facts, not desired final behavior. The final implementation removes `chain-only` UI mode, removes production `snapshotBoundary` evidence, and makes session snapshot evidence the OpenCode default.

Current gap:

`OpenCodeOfflineSessionReader` does not yet extract snapshot step/patch parts into a typed structure. It only carries raw parts.

Critical current-config correction:

```ts
buildManagedConfig(...): { snapshot: false }
```

This means existing managed OpenCode sessions from our app usually do **not** have OpenCode snapshot parts. The source-driven snapshot bridge is for:

- future sessions where we explicitly enable OpenCode snapshots for evidence;
- sessions created outside our managed profile with snapshots enabled;
- live E2E profiles that opt into `snapshot: true`.

Old/current `snapshot:false` sessions must stay on Variant 1 behavior:

```text
strict toolpart chain -> full text only when toolpart chain proves it -> metadata-only/manual-review otherwise
```

Do not promise Cursor-like full diffs for old `snapshot:false` OpenCode tasks.

## Latest Risk Review

This is the updated confidence after reading OpenCode SQL/schema and our current managed config:

| Area | Previous confidence | New confidence | Reason |
| --- | ---: | ---: | --- |
| Finding project id | 7.0 | 9.2 | `session.project_id` is persisted directly. |
| Finding exact worktree string | 6.8 | 9.0 | `project.worktree` is persisted directly. |
| Detecting non-git unsupported mode | 7.0 | 9.4 | `project.vcs` plus OpenCode `enabled()` source both agree. |
| Using session summary diffs | 6.5 | 4.0 | Too broad for task attribution. Keep diagnostic-only. |
| Reading blob content by `tree:path` ref | 6.2 | 5.1 | Fragile for newline/odd paths. Replace with object-id based raw diff. |
| Existing sessions producing snapshot diffs | 5.0 | 3.5 | Current managed config sets `snapshot:false`, so old sessions can only use metadata/toolpart evidence. |
| Raw git object id width | 5.5 | 9.0 | Prototype showed default `git diff --raw` abbreviates object ids. Require `--abbrev=40`. |
| Snapshot window matching | 7.2 | 8.9 | First-start/last-finish is too broad for multi-step assistant messages. Use part-order windows. |
| `session.directory` vs `project.worktree` | 6.6 | 9.1 | OpenCode runs snapshot diff with `cwd: state.directory` and `--work-tree state.worktree`. Reader must mirror this. |

Main plan change from this review:

**Read snapshot file blobs by git object id, not by `tree:path` refs.**

This is more work, but it removes most path quoting risk and makes Windows/newline/unicode path tests realistic.

### Local Git Prototype Finding

A local synthetic internal gitdir with spaces, unicode, colon, leading dash, tab, and newline filenames showed:

```text
git diff --raw -z -> abbreviated object ids by default
git diff --raw -z --full-index -> still abbreviated object ids
git diff --raw -z --abbrev=40 -> full 40-char object ids
```

Therefore the production command must use:

```text
--raw -z --abbrev=40
```

Do not rely on `--full-index` for raw diff object ids.

## Remaining Low-Confidence Areas

These are the places that still need proof before merging the default-on OpenCode path:

1. **Managed profile data path exactness** - 🎯 8.2   🛡️ 9.0   🧠 5.0 - ~120-220 LOC.
   We believe `path.dirname(resolveDbPath(profileRootKey))` equals OpenCode `Global.Path.data` for our managed profile. Prove it with a live profile that has `snapshot:true`, then assert the expected snapshot gitdir exists after a write.

2. **Raw git diff parser for unusual paths** - 🎯 8.5   🛡️ 9.4   🧠 7.8 - ~350-700 LOC.
   The object-id approach is the right direction, but the parser must be tested against spaces, unicode, tabs, newline filenames, colon paths, leading dash paths, CRLF, and Windows-like case collisions.

3. **Real OpenCode live run with snapshot parts** - 🎯 7.8   🛡️ 9.2   🧠 6.5 - ~250-500 LOC.
   Fixture tests are not enough. We need one gated live test that starts OpenCode with snapshot enabled, causes a write/edit, reads SQLite step parts, resolves the gitdir, and reads before/after blobs through our reader.

4. **Snapshot cost on large repos** - 🎯 6.6   🛡️ 7.8   🧠 5.8 - ~250-500 LOC.
   Official docs warn about slow indexing and disk usage. Because the product decision is no feature flag, the implementation must include hard caps, clear diagnostics, and a stress fixture before merge. The kill behavior is fail-closed metadata-only, not a user-facing toggle.

5. **OpenCode schema drift** - 🎯 8.0   🛡️ 9.0   🧠 5.5 - ~200-400 LOC.
   We need diagnostics for missing `session.project_id`, `project.worktree`, changed part shapes, and missing snapshot gitdir. Drift must fail to metadata-only, not to empty success and not to broad recovery.

6. **Multi-step assistant message attribution** - 🎯 8.3   🛡️ 9.2   🧠 7.2 - ~250-550 LOC.
   A single assistant message can contain more than one model step. First-start/last-finish can be correct for summary, but too broad for task evidence. Use part order and require a toolpart to be inside one exact step window before upgrading to full text.

7. **Subdirectory OpenCode sessions** - 🎯 7.7   🛡️ 9.0   🧠 7.5 - ~350-800 LOC.
   OpenCode stores both `session.directory` and `project.worktree`. Snapshot storage hash uses `project.worktree`, but snapshot diff pathspec `.` is evaluated from `session.directory`. We need tests where OpenCode is launched from a subdirectory, otherwise path matching can silently miss valid changes or, worse, map relative toolpart paths to the wrong root.

## Updated Top 3 Options

1. **Session-part snapshot bridge with object-id blob reader** - 🎯 9.4   🛡️ 9.5   🧠 8.4 - ~2200-3800 LOC.
   Best. It uses OpenCode's own persisted step boundaries, avoids debug output parsing, and reads internal git blobs by object id instead of path refs. It is git-only but exact when supported.

2. **Targeted gitless baseline layer** - 🎯 8.4   🛡️ 9.0   🧠 8.3 - ~1600-3000 LOC.
   Best future path for non-git or `snapshot:false`. More code because we must capture before/after around exact tools ourselves. Safer than broad scanning, but bigger runtime change.

3. **Debug CLI snapshot parser** - 🎯 4.2   🛡️ 4.0   🧠 6.2 - ~800-1600 LOC.
   Reject. No JSON schema, human output, command can mutate snapshot state through `track`/`patch`, and it is brittle across OpenCode versions.

Chosen: option 1 now, option 2 later.

## Non-Goals

- Do not parse debug CLI `patch` or `diff` in production.
- Do not call `snapshot.track` from our production backfill.
- Do not call any OpenCode command in normal UI Changes backfill.
- Do not scan the workspace.
- Do not infer changes from comments or assistant text.
- Do not unlock apply/reject for metadata-only.
- Do not change non-OpenCode agents.
- Do not make OpenCode snapshots mandatory.
- Do not solve non-git full diffs in this phase.
- Do not rewrite historical ledger journal entries.

## Core Safety Model

Full-text diff requires two independent proofs:

```text
strict delivery attribution proof
snapshot file-state proof
```

Attribution proof comes from:

- delivery context matching `teamName`;
- exact `taskId`;
- exact `memberName`;
- exact `laneId`;
- exact OpenCode `runtimeSessionId`;
- exact parent user message id from `deliveredUserMessageId` or `inboxMessageId`;
- reconstructed candidate toolpart path.

File-state proof comes from:

- OpenCode SQLite `step-start.snapshot` and `step-finish.snapshot` parts in the same assistant message/step window;
- read-only internal snapshot git diff between those tree hashes;
- file path matching the already reconstructed candidate touched paths.

If either proof is missing:

```text
metadata-only manual review or diagnostics-only
```

## Important Architectural Shift

### Old Plan

```text
our bridge captures pre snapshot
deliver message
our bridge captures post snapshot
provider reads boundary
```

Problem:

- external capture can miss exact OpenCode step timing;
- `track` mutates snapshot index;
- it duplicates data OpenCode already records;
- it is hard to align with toolpart parent messages.

### New Plan

```text
read OpenCode SQLite parts
find strict-delivery matched assistant message/toolpart window
extract step-start.snapshot and step-finish.snapshot
read internal snapshot git diff from those hashes
intersect with reconstructed touched paths
enrich ledger event
```

Benefits:

- uses OpenCode's own internal boundary;
- no production OpenCode command execution;
- no debug CLI parsing;
- no extra snapshot mutation;
- better task/message alignment;
- easier to test with SQLite fixtures.

## Required Data Extraction

### Add Typed Snapshot Parts

New types:

```ts
export type OpenCodeSnapshotStepPart = {
  rowId: string
  messageId: string
  sessionId: string
  timeCreated: number
  partOrder: number
  type: 'step-start' | 'step-finish'
  snapshot: string
}

export type OpenCodePatchPart = {
  rowId: string
  messageId: string
  sessionId: string
  timeCreated: number
  partOrder: number
  type: 'patch'
  hash: string
  files: string[]
  relativeFiles: string[]
}

export type OpenCodeSnapshotWindow = {
  messageId: string
  sessionId: string
  startPartId: string
  finishPartId: string
  fromSnapshot: string
  toSnapshot: string
  patchHash?: string
  patchFiles: string[]
  startedAt: number
  finishedAt: number
  startOrder: number
  finishOrder: number
  sourcePartIds: string[]
}
```

Add to `OpenCodeOfflineSessionReadResult`:

```ts
snapshotStepParts: OpenCodeSnapshotStepPart[]
patchParts: OpenCodePatchPart[]
snapshotWindows: OpenCodeSnapshotWindow[]
```

Parser rules:

- part JSON must be an object;
- `step-start` and `step-finish` must have non-empty string `snapshot`;
- `patch` must have non-empty string `hash` and `files: string[]`;
- `patch.files` must be normalized from absolute OpenCode worktree paths to safe relative paths;
- if a `patch.files` entry is outside `project.worktree`, keep the part but drop that file with diagnostic;
- do not treat `patch.files` as authoritative for evidence, because OpenCode builds it from newline-split output;
- use `patch.hash` as a consistency hint for `fromSnapshot`, and use reconstructed toolpart paths plus raw snapshot diff paths as the real path proof;
- ignore malformed snapshot parts with diagnostic, do not mark whole history unsupported;
- keep current strict handling for toolpart shape drift.

Window building:

```ts
for each assistant message:
  order parts by (time_created, id)
  assign stable partOrder
  pair each step-start snapshot with the next step-finish snapshot after it
  collect toolpart ids with startOrder < toolPartOrder < finishOrder
  attach patch parts after finish when patch.hash === fromSnapshot
```

Fallback:

```text
if part order cannot form a unique window, do not snapshot-upgrade that toolpart
```

Reason:

- OpenCode summary does this across messages;
- for task delivery, parent/assistant message matching already narrows candidate toolparts;
- part-order window matching is stricter than summary and avoids over-broad upgrades in multi-step assistant messages.

Do not use first-start/last-finish for task evidence except as a diagnostic summary comparison. It is too broad for attribution.

## Snapshot Git Store Resolution

OpenCode source formula:

```text
gitdir = <Global.Path.data>/snapshot/<project.id>/<sha1(worktree)>
```

We need these inputs:

- OpenCode data dir for the profile;
- project id;
- worktree path.

### Data Dir

Our managed profile DB path currently resolves to:

```text
<claude-multimodel data>/opencode/profiles/<profileRootKey>/data/opencode/opencode.db
```

Therefore likely OpenCode `Global.Path.data` for that profile is:

```text
<claude-multimodel data>/opencode/profiles/<profileRootKey>/data/opencode
```

Do not recompute this from OS env in multiple places. Derive it from the same DB path resolver so profile-root escaping stays centralized:

```ts
function resolveOpenCodeProfileDataDir(profileRootKey: string): string | null {
  const dbPath = openCodeOfflineSessionReader.resolveDbPath(profileRootKey)
  if (!dbPath) return null
  return path.dirname(dbPath)
}
```

Safety rules:

- `profileRootKey` must pass the existing safe-profile-key check.
- `profileDataDir` must be exactly `path.dirname(dbPath)`.
- snapshot gitdir must be under `path.join(profileDataDir, 'snapshot')`.
- never accept a snapshot gitdir supplied by SQLite, prompt text, toolpart data, or user input.
- do not support arbitrary `OPENCODE_DATA_DIR` override in this reader until we can prove how the managed OpenCode process was launched.

### Project ID

Do not guess.

Preferred sources:

1. Read `session.project_id` from OpenCode SQLite for the session.
2. Join `project` table to validate project worktree and vcs.
3. Fallback only if schema does not expose it: derive from project table by matching worktree/directory exactly.

Extend `OpenCodeOfflineSessionReader` to read:

```ts
type OpenCodeSqliteSessionIdentity = {
  sessionId: string
  projectId: string | null
  directory: string | null
  projectWorktree?: string | null
  projectVcs?: 'git' | string | null
}
```

If `projectVcs !== 'git'`:

```text
snapshot evidence unsupported
metadata-only fallback
```

### Worktree Hash

OpenCode uses SHA-1 of `ctx.worktree`.

Need exact string:

- Prefer `project.worktree` from OpenCode SQLite.
- If missing, use `record.projectPath` only if it exactly matches project worktree/directory after path normalization.
- Do not use `workspaceRoot` blindly if OpenCode project table disagrees.
- Validate `session.directory` separately as the git command cwd.

Helper:

```ts
function openCodeHashFast(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}
```

Snapshot gitdir:

```ts
const gitDir = path.join(profileDataDir, 'snapshot', projectId, openCodeHashFast(worktree))
```

Snapshot command cwd:

```ts
const cwd = offline.sessionIdentity.directory
```

Validation:

- `cwd` must be absolute.
- `cwd` must be same-or-descendant of `projectWorktree`.
- `cwd` path style must match `projectWorktree`.
- if `record.projectPath` or UI `workspaceRoot` does not match `projectWorktree`, do not snapshot-upgrade. Keep chain/metadata fallback.

Validation:

- `gitDir` must be inside `profileDataDir/snapshot`;
- `gitDir` must exist and be a directory;
- `gitDir/HEAD` or git dir metadata must exist;
- do not run `git init`;
- do not write to git dir.

### Snapshot Enablement Contract

Final target: managed OpenCode config enables snapshots for new sessions without a feature flag.

```ts
function buildManagedConfig(...) {
  return {
    ...
    snapshot: true,
  }
}
```

Why this is acceptable:

- OpenCode snapshots are documented as default behavior.
- We need snapshot parts to produce Cursor-like diffs.
- Old sessions without snapshot parts naturally stay metadata-only/manual-review.
- Hard runtime caps prevent our UI backfill from doing expensive reads.

Migration behavior:

```text
existing managed profiles with snapshot:false:
  no retroactive full-text snapshot evidence
  metadata/toolpart evidence only

new managed profiles or rewritten managed config:
  snapshot:true
  OpenCode writes step snapshot parts
  bridge can attempt full-text proof
```

Do not add `CLAUDE_TEAM_OPENCODE_EVIDENCE_MODE`, `snapshotConfigMode`, or a UI toggle in this implementation. If snapshot cost becomes a real production issue, add a later operational disable switch with separate tests.

## Production Snapshot Reader

New file:

```text
src/services/opencode/OpenCodeSnapshotGitStoreReader.ts
```

Interface:

```ts
export type OpenCodeSnapshotGitStoreInput = {
  profileRootKey: string
  projectId: string
  worktree: string
  directory: string
  fromSnapshot: string
  toSnapshot: string
  touchedRelativePaths: string[]
  limits: {
    maxFiles: number
    maxBytesPerTextFile: number
    maxTotalBytes: number
    timeoutMs: number
  }
}

export type OpenCodeSnapshotGitStoreFile = {
  relativePath: string
  operation: 'create' | 'modify' | 'delete'
  beforeContent?: string
  afterContent?: string
  beforeState: FileState
  afterState: FileState
  additions: number
  deletions: number
  binary: boolean
  proofId: string
}
```

Read commands:

```text
cwd=<directory>
git -c core.autocrlf=false -c core.longpaths=true -c core.symlinks=true -c core.quotepath=false --git-dir <gitDir> --work-tree <worktree> diff --no-ext-diff --raw -z --abbrev=40 --no-renames <from> <to> -- .
git -c core.autocrlf=false -c core.longpaths=true -c core.symlinks=true -c core.quotepath=false --git-dir <gitDir> --work-tree <worktree> diff --no-ext-diff --numstat -z --no-renames <from> <to> -- .
git -c core.autocrlf=false -c core.longpaths=true -c core.symlinks=true --git-dir <gitDir> --work-tree <worktree> cat-file --batch
```

Important:

- use `spawn`/`execFile`, never shell;
- use args array;
- cap stdout/stderr;
- timeouts;
- no `git add`;
- no `git write-tree`;
- no `checkout`;
- no working tree mutation;
- do not pass untrusted pathspecs except `-- .` and later filter result against touched paths.
- require `--abbrev=40` for raw diff object ids;
- reject any raw object id that is not exactly 40 hex chars or all-zero absent id.
- set `cwd` to OpenCode `session.directory`, not process cwd and not necessarily `project.worktree`.

### Why Object IDs, Not `tree:path`

OpenCode source currently reconstructs full diffs with `git cat-file --batch` and can fall back to `git show` by path. That is acceptable inside OpenCode, but our bridge should be stricter because it is an attribution layer.

Avoid this in production:

```text
git show <tree>:<relativePath>
```

Problems:

- newline paths require careful quoting;
- colon in path can be confusing around `<tree>:<path>` refs;
- Windows path normalization bugs are easier to introduce;
- a parser mistake can read the wrong blob.

Preferred production reader:

```text
git diff --raw -z --abbrev=40 --no-renames <from> <to>
parse old object id and new object id
git cat-file --batch by object id
map objects back to the raw diff path
```

This makes the path only metadata for matching, while content is fetched by object id.

Expected raw record model:

```ts
type RawSnapshotDiffEntry = {
  status: 'A' | 'M' | 'D' | 'T' | 'U' | string
  oldMode: string
  newMode: string
  oldObjectId: string
  newObjectId: string
  relativePath: string
}
```

Object ids:

```text
0000000000000000000000000000000000000000 -> absent side
otherwise -> fetch with cat-file --batch
```

Implementation notes:

- Use `-z` and parse bytes, not newline-separated text.
- Use `--abbrev=40`; `--full-index` is not sufficient for raw diff.
- Decode paths with UTF-8 only after splitting on NUL bytes.
- Reject invalid UTF-8 path bytes with diagnostic.
- Reject absolute paths, `..`, device/reserved paths, and case-colliding touched path groups.
- Treat status `R` or `C` as unsupported for the first version, even if someone removes `--no-renames` later.
- Treat typechange `T` as metadata-only unless both sides are normal blobs and text caps pass.
- Treat non-regular file modes as metadata-only.
- Do not fetch blob content for files outside `touchedRelativePaths`.
- Do not fetch blob content for object ids already known to exceed cap after cat-file header.

`numstat -z` remains useful for additions/deletions and binary detection, but it must not be the source of blob identity.

### File Mode Policy

Raw diff modes are part of the evidence:

| Mode | Meaning | V1 behavior |
| --- | --- | --- |
| `100644` | regular file | text diff allowed under caps |
| `100755` | executable regular file | text diff allowed under caps, mode change warning |
| `120000` | symlink | metadata-only |
| `160000` | gitlink/submodule | metadata-only |
| `000000` | absent side | ok for create/delete side |
| anything else | unknown | metadata-only |

Chmod-only changes:

```text
oldObjectId === newObjectId && oldMode !== newMode
```

V1 behavior:

- emit metadata-only/manual-review if reconstructed candidate proves the path;
- do not create fake before/after text blobs;
- show diagnostic `snapshot-mode-only-change`.

Symlink/submodule behavior:

- never dereference symlink target;
- never read submodule contents;
- record mode/sha metadata only if available.

Raw parser outline:

```ts
function parseRawDiffZ(buffer: Buffer): RawSnapshotDiffEntry[] {
  const records = splitNul(buffer)
  const entries: RawSnapshotDiffEntry[] = []
  for (let index = 0; index < records.length;) {
    const header = decodeUtf8(records[index++])
    // Example header:
    // :100644 100644 <old> <new> M
    // Path is the next NUL item.
    const pathBytes = records[index++]
    const relativePath = decodeUtf8Path(pathBytes)
    entries.push(parseHeaderAndPath(header, relativePath))
  }
  return entries
}
```

Do not parse `git diff --raw` with whitespace splitting after the path. In `-z` mode, the header is text, but the path is its own NUL-delimited field and may contain spaces or tabs.

Blob fetch outline:

```ts
const objectIds = unique([
  ...entries.map(entry => entry.oldObjectId).filter(isRealObjectId),
  ...entries.map(entry => entry.newObjectId).filter(isRealObjectId),
])

const blobs = await catFileBatchByObjectId(gitDir, objectIds)
```

The `cat-file --batch` response must be capped per object and globally:

```text
<sha> blob <size>\n
<raw bytes>
\n
```

If the type is not `blob`, or size exceeds cap, mark that side unavailable and keep metadata-only.

Do not read all `cat-file` stdout into one unbounded string. Use a small streaming/bounded parser:

```text
write object ids to stdin
read header line
parse <sha> <type> <size>
read exactly <size> bytes if under cap
read one trailing newline
stop once maxTotalBytes is exceeded
kill process on timeout
```

This keeps large/binary snapshot stores from spiking memory during UI auto-backfill.

Why read-only git is acceptable:

- OpenCode itself uses git as the snapshot store;
- reading tree objects is deterministic;
- this avoids parsing human debug output;
- the snapshot tree hashes already come from OpenCode SQLite.

## Provider Flow

New provider:

```text
src/services/opencode/OpenCodeSnapshotEvidenceProvider.ts
```

Algorithm:

```text
input: session record, offline read result, reconstructed changes

1. strict delivery already matched
2. build touched path set from reconstructed changes
3. find snapshot window for the matched assistant message/toolparts
4. resolve profile data dir
5. read session.project_id and project.worktree/vcs
6. reject if vcs != git
7. compute snapshot gitdir
8. read diff from fromSnapshot to toSnapshot
9. intersect diff rows with touched path set
10. return full text only for matched rows under caps
```

Do not import files found only by snapshot diff.

### Non-OpenCode Isolation

This provider must be impossible to invoke for Claude Code, Codex native, shell snapshot, PowerShell snapshot, or exact file-tool ledger events.

Hard rules:

- provider lives under `src/services/opencode/**`;
- only `OpenCodeLedgerBridgeService` calls it;
- it requires `OpenCodeSessionRecord.profileRootKey`;
- it requires OpenCode SQLite `sessionIdentity`;
- it only upgrades `ReconstructedOpenCodeToolChange` candidates;
- task ledger import format stays additive.

Regression tests:

- existing `TaskChangeLedgerService` tests pass unchanged;
- existing shell snapshot tests pass unchanged;
- existing `ReviewApplierService` behavior for non-OpenCode ledger entries stays unchanged;
- a fake non-OpenCode change cannot be passed into `readSessionEvidence` without type/test helper bypass.

Pseudo-code:

```ts
const touched = new Set(changes.map(change => change.relativePath))
const windows = findSnapshotWindowsForChanges(offline.snapshotWindows, changes)

for (const window of windows) {
  const diff = await gitStoreReader.read({
    profileRootKey: record.profileRootKey,
    projectId: offline.sessionIdentity.projectId,
    worktree: offline.sessionIdentity.projectWorktree,
    directory: offline.sessionIdentity.directory,
    fromSnapshot: window.fromSnapshot,
    toSnapshot: window.toSnapshot,
    touchedRelativePaths: [...touched],
    limits,
  })
  collect matched files
}
```

Matching a change to window:

- candidate has `sourceMessageId` and `sourcePartId`;
- window has `messageId`;
- require `change.sourceMessageId === window.messageId`;
- require `window.sourcePartIds.includes(change.sourcePartId)`;
- if multiple windows contain the same source part, fail closed;
- if no window contains the source part, no snapshot full-text upgrade;
- if not matched, no snapshot full-text upgrade.

This is stricter than session-wide diff and avoids cross-task pollution.

### Snapshot Evidence Cache Policy

Cache only safe negative results:

| Outcome | Cache? | Reason |
| --- | --- | --- |
| `snapshot-project-not-git` | yes, until session DB fingerprint changes | project VCS is stable for that session. |
| `snapshot-window-missing` | short TTL only | session may still be writing parts. |
| `snapshot-gitdir-missing` | short TTL only | snapshot gitdir may appear after OpenCode finishes writing. |
| `snapshot-diff-read-failed` | no or very short TTL | transient lock/process failure likely. |
| full-text success | yes, keyed by DB fingerprint + snapshot hashes + adapter version | deterministic snapshot tree result. |
| metadata-only fallback from cap/binary | yes, keyed by snapshot hashes + caps | deterministic for same caps. |

Do not cache broad `no-attribution` as a final success for UI auto-backfill if there are still active OpenCode deliveries for the task.

## Evidence Upgrade And Duplicate Policy

Current risk:

```text
importTaskChangeLedgerEvents dedupes by sourceImportKey
eventId = opencode-import-<sha(sourceImportKey)>
```

That is correct for idempotency, but it creates a rollout problem:

```text
old behavior:
first UI open with old chain-only build -> imports metadata-only event
later default snapshot path -> finds full text for the same sourceImportKey
current importer -> skips as duplicate
result -> task stays manual-only forever
```

After removing feature flags, the same risk still exists for old sessions and racing reads:

```text
first auto-backfill runs before OpenCode has written step-finish/patch parts
bridge imports metadata-only
second auto-backfill sees completed snapshot evidence
dedupe would skip unless upgrade projection exists
```

Top options:

1. **Append upgrade event and project strongest evidence** - 🎯 8.9   🛡️ 9.2   🧠 7.4 - ~500-950 LOC.
   Best. Keep `sourceImportKey` stable, append a new event only when incoming evidence rank is stronger than existing evidence rank, and have the reader project one visible file change per `sourceImportKey` by strongest evidence then journal order.

2. **Change sourceImportKey to include evidence proof** - 🎯 5.8   🛡️ 5.5   🧠 4.5 - ~150-350 LOC.
   Reject for UI. It makes import easy, but risks duplicate rows for the same toolpart/path.

3. **Never upgrade old metadata-only imports** - 🎯 7.0   🛡️ 8.7   🧠 1.5 - 0 LOC.
   Safe but weak. Existing tasks stay degraded even after snapshot evidence becomes available.

Recommended: option 1.

Additive event fields:

```ts
type TaskChangeEventV1 = {
  sourceImportKey?: string
  evidenceProof?: OpenCodeEvidenceProof
  supersedesEventId?: string
  evidenceRevision?: number
}
```

Evidence rank:

```text
opencode-snapshot = 5
toolpart-chain = 4
inverse-apply-patch-chain = 3
inverse-edit-chain = 3
metadata-only-fallback = 1
unknown = 0
```

Import behavior:

```text
if no existing sourceImportKey:
  import normally

if existing sourceImportKey and incoming rank <= existing rank:
  duplicate skip

if existing sourceImportKey and incoming rank > existing rank:
  append upgrade event
  eventId = opencode-import-upgrade-<sha(sourceImportKey + evidenceProof + snapshotId + before/after sha)>
  sourceImportKey stays unchanged
  supersedesEventId = existing projected event id
```

Reader behavior:

```text
group events by sourceImportKey when sourceImportKey exists
choose highest evidence rank
tie-break by journal append order
expose only the projected strongest event to summary/UI
keep diagnostics/warnings from superseded event only if still relevant
```

Safety:

- upgrades are allowed only from OpenCode imports;
- upgrades cannot change `taskId`, `sourceSessionId`, `sourcePartId`, `sourceMessageId`, `relativePath`, or operation unless operation confidence is strictly stronger and lifecycle proof matches;
- upgrades cannot downgrade from full-text to metadata-only;
- upgrade event must pass the same strict hash/apply/reject rules as a normal full-text event.

Tests:

- metadata-only import followed by snapshot full-text creates one visible file change, not two.
- repeated snapshot full-text import is duplicates-only.
- weaker metadata-only import after full-text is ignored.
- operation mismatch does not upgrade.
- sourceMessageId/sourcePartId mismatch does not upgrade.
- reader projection is stable after journal rebuild and malformed-line recovery.

### Evidence Upgrade Risk Register

This is the riskiest part of the implementation. Treat it as its own subsystem, not as a small dedupe tweak.

| Risk | Failure mode | Severity | Guard |
| --- | --- | --- | --- |
| Duplicate visible rows | Metadata event and full-text event both appear in UI. | High | Bundle projection groups by `sourceImportKey` before path grouping. |
| Wrong event wins | A weaker or unrelated event becomes the visible one. | High | Evidence rank plus identity equality. Never choose by timestamp alone. |
| Cross-task upgrade | Event from task A supersedes event in task B. | Critical | Existing projection key includes `taskId`; upgrade only inside one task journal. |
| Cross-file upgrade | Same source part but different path supersedes another file. | Critical | Require same normalized `relativePath` and same `sourceImportKey`. |
| Cross-session upgrade | Same path/part id from another OpenCode session upgrades event. | Critical | Require same `sourceSessionId`, `sourcePartId`, `sourceMessageId`. |
| Operation drift | Metadata said `modify`, snapshot says `delete`, UI applies wrong action. | High | Operation compatibility matrix. Mismatch becomes new diagnostic, no upgrade. |
| Review decision drift | User has pending decisions keyed by `changeKey`; upgrade changes diff content. | Medium/High | Keep `changeKey` stable by path/relation. UI hunk decisions must be reset when content hashes change. |
| Contributor stats inflated | Superseded events count as extra work. | Medium | Projection stats use projected events for visible files; raw event count remains journal count. |
| Line stats double counted | Metadata event plus upgrade event both contribute additions/deletions. | Medium | Contributor visible/diff stats use projected event only for same sourceImportKey. |
| Warning loss | Metadata warning explains degraded capture but disappears after upgrade. | Low/Medium | Preserve still-relevant warnings, drop only superseded manual-review warnings. |
| Malformed journal recovery | Rebuild after malformed lines picks a different winner. | High | Projection uses deterministic evidence rank, then journal append index. |
| Concurrent imports | Two UI reads append the same upgrade twice. | Medium | Task writer lock + upgrade event id includes sourceImportKey/evidence/snapshot/content hashes. |
| Apply/reject safety | Upgraded full-text event enables auto reject on wrong disk state. | Critical | Existing strict hash guard still applies. Upgrade only affects ledger source text, not disk guard. |
| Binary/large upgrade | Metadata-only binary becomes fake text. | Critical | Rank upgrade requires full-text before/after and text cap; binary/large never full-text. |

Operation compatibility matrix:

| Existing operation | Incoming operation | Upgrade? |
| --- | --- | --- |
| `create` | `create` | yes if same absent-before proof |
| `modify` | `modify` | yes |
| `delete` | `delete` | yes if same absent-after proof |
| `modify` | `create` | no |
| `modify` | `delete` | no |
| `create` | `modify` | no unless existing beforeState was unknown and incoming proves before existed |
| `delete` | `modify` | no |

Projection algorithm must run before file-path accumulators:

```text
read journal events in append order
group OpenCode import events by sourceImportKey
for each sourceImportKey:
  choose strongest compatible event
  remember superseded event ids
pass projected events into existing path/relation accumulators
keep non-OpenCode events unchanged
```

Do not group non-OpenCode events by `sourceImportKey`. They do not use this import identity contract.

### UI Review State Risk

Evidence upgrades can change:

- before blob hash;
- after blob hash;
- hunk count;
- hunk context hashes;
- reviewability from `metadata-only` to `full-text`.

Existing renderer review state is keyed primarily by `changeKey`, so a stronger event for the same file can reuse a stale reject/accept decision unless the content fingerprint changes are considered.

Required UI behavior:

```text
if changeKey is same but latestBeforeHash/latestAfterHash changed:
  clear file decision for that changeKey
  clear hunk decisions for that changeKey
  clear hunk context hashes for that changeKey
```

Do not preserve hunk-level decisions across an evidence upgrade. Preserving a file-level decision is also unsafe because metadata-only manual-review could become full-text auto-review with different semantics.

Tests:

- metadata-only file decision is cleared after full-text upgrade.
- hunk decisions are cleared when hunk count changes.
- no reset when bundle rebuild produces same hashes.
- non-upgraded non-OpenCode file decisions are not cleared.

## Deep Weak-Spot Risk Register

This section is the merge-risk model for the no-feature-flag decision. These risks follow from current code behavior:

- `importTaskChangeLedgerEvents` currently dedupes OpenCode imports by `sourceImportKey` before write.
- `eventId` is currently deterministic from `sourceImportKey`.
- `rebuildBundle` currently groups by path/relation and then derives first/last event state.
- UI review decisions can persist across opens and use `changeKey` plus provenance/content identity.
- `ChangeExtractorService` can run background summary backfill and detailed backfill close together.

The safe implementation must make these invariants true:

```text
one OpenCode toolpart/path identity -> at most one visible UI file row
stronger evidence can replace weaker visible evidence
weaker evidence cannot hide or downgrade stronger evidence
default OpenCode backfill cannot import files that only appear in snapshot diff
stale UI decisions cannot apply to a changed evidence projection
non-OpenCode ledger behavior does not change
```

### Risk Summary By Area

| Area | Risk | Impact | Confidence after review | Required response |
| --- | --- | --- | ---: | --- |
| Import dedupe | Metadata-only import blocks later snapshot full-text. | High false negative. | 🎯 9.2 | Add append-only upgrade events. |
| Import race | Two UI calls append two upgrades or cache wrong duplicate result. | Medium duplicate risk. | 🎯 8.6 | Move existing-source projection read inside task writer lock. |
| Event identity | Upgrade uses same `eventId` and journal recovery drops it. | High silent no-upgrade. | 🎯 9.0 | Upgrade event id must be distinct from base import id. |
| Bundle projection | Projection happens after path grouping and doubles stats. | High UI/stat bug. | 🎯 8.8 | Project strongest events before path accumulators. |
| UI decision persistence | Metadata-only decision applies after full-text upgrade. | Critical unsafe review action. | 🎯 8.5 | Reset decisions when ledger hashes/provenance fingerprint changes. |
| Snapshot window | First-start/last-finish crosses tool/task boundaries. | Critical false attribution. | 🎯 8.9 | Only use exact part-order window containing source toolpart. |
| Snapshot diff | Snapshot diff contains extra file not in toolparts. | Critical false attribution. | 🎯 9.3 | Intersect with reconstructed touched paths. |
| Path parsing | `patch.files` newline split corrupts filenames. | Medium false negative or wrong path. | 🎯 8.7 | Use raw `-z` diff for path proof. Treat `patch.files` as hint only. |
| Object ids | Raw diff abbreviates object ids by default. | High wrong/missing blob read. | 🎯 9.1 | Require `--abbrev=40` and validate 40 hex chars. |
| OpenCode schema drift | SQLite shape changes and bridge reports empty success. | High hidden false negative. | 🎯 8.0 | `unsupported-opencode-history-shape` diagnostic and metadata fallback only. |
| Snapshot store race | SQLite row visible before git object store is readable. | Medium transient false negative. | 🎯 7.8 | Short TTL transient cache, retry on later open. |
| Snapshot cost | Default snapshots slow large repos. | Medium product risk. | 🎯 6.9 | Caps, stress fixture, diagnostics, no unbounded reads. |
| Windows paths | Worktree hash or path matching changes with normalization. | High platform bug. | 🎯 8.2 | Hash exact SQLite string, compare separately with platform rules. |
| Security/privacy | Diagnostics leak prompts, patches, or file content. | Critical privacy bug. | 🎯 9.0 | Diagnostics whitelist only metadata. |

### P0 Risks - Must Block Merge

#### P0.1 Duplicate Visible Rows

Failure:

```text
old metadata-only event remains visible
new snapshot full-text event is also visible
UI shows two rows for the same OpenCode toolpart/path
```

Why it can happen:

Current bundle build groups by path/relation only. If upgrade event is appended and not projected first, the path accumulator may include both events and derive first/last state from the wrong combination.

Required design:

```text
raw journal events
  -> OpenCode sourceImportKey projection
  -> projected event list
  -> existing path/relation accumulator
```

Required code shape:

```ts
const projected = projectTaskChangeEventsForSummary(events)
for (const event of projected.visibleEvents) {
  addToPathAccumulator(event)
}
```

Do not do this:

```ts
for (const event of events) {
  addToPathAccumulator(event)
}
projectInsideAccumulator()
```

Tests:

- metadata-only event then snapshot upgrade shows `files.length === 1`;
- `eventCount` in bundle can remain raw journal count, but `files[0].eventCount` must describe projected visible event count or expose a separate `journalEventCount`;
- total line stats equal upgraded full-text diff only once;
- contributor visible file count is one.

#### P0.2 Upgrade Event Dropped By Journal Deduplication

Failure:

```text
base event id = opencode-import-<sourceKey>
upgrade event id = same id
readJournalEntries seenIds drops second line
bundle never sees upgrade
```

Required design:

```ts
function buildImportedEventId(sourceImportKey: string): string {
  return `opencode-import-${sha256(sourceImportKey).slice(0, 32)}`
}

function buildImportedUpgradeEventId(input: {
  sourceImportKey: string
  evidenceProof: string
  snapshotId?: string
  beforeSha?: string
  afterSha?: string
  revision: number
}): string {
  return `opencode-import-upgrade-${sha256(JSON.stringify(input)).slice(0, 32)}`
}
```

Rules:

- upgrade id must never equal base id;
- repeated same upgrade must produce the same upgrade id;
- different stronger evidence for same source key must produce a different upgrade id;
- projection picks the strongest compatible one.

Tests:

- journal with base and upgrade survives `readTaskEvents`;
- duplicate upgrade line is deduped without changing projection;
- malformed base line plus valid upgrade line still projects upgrade if identity is complete.

#### P0.3 Import Race Outside Writer Lock

Current risk:

```text
call A reads existing source keys outside queue
call B reads existing source keys outside queue
A appends base or upgrade
B appends duplicate base or upgrade
```

Required design:

Move existing projection read into the same task writer critical section:

```ts
await enqueueTaskWrite(taskId, async () => {
  await runTaskLedgerWrite({
    ...,
    write: async () => {
      const existingProjection = await readExistingSourceImportProjection(taskId, projectDir)
      const events = await buildImportEvents(existingProjection, incomingChanges)
      for (const event of events) await appendEvent(event, projectDir)
    },
  })
})
```

The pre-lock validation may still filter unsafe paths, but duplicate/upgrade decisions must be made inside the lock.

Tests:

- two concurrent imports for same metadata-only change append one base event;
- two concurrent upgrades append one upgrade event;
- base import racing upgrade ends with one visible upgraded row;
- lock timeout/degraded rebuild preserves append-only journal semantics.

#### P0.4 Wrong Snapshot Window Attribution

Failure:

```text
assistant message has two model steps
toolpart A belongs to step 1
toolpart B belongs to step 2
reader uses first step-start and last step-finish
toolpart A receives cumulative diff including B
```

Required design:

```text
toolpart.sourcePartId must be strictly inside exactly one window:
window.startOrder < toolPartOrder < window.finishOrder
```

If zero or more than one window matches:

```text
no snapshot upgrade
metadata-only/toolpart-chain fallback
diagnostic snapshot-window-ambiguous
```

Tests:

- two windows in one assistant message;
- same path touched in each window;
- only matching window is used;
- first-start/last-finish test fails if accidentally used for task evidence.

#### P0.5 Snapshot-Only File Import

Failure:

```text
snapshot diff sees file X
toolpart reconstruction only proves file Y
bridge imports X because it is in snapshot
```

Required design:

Full-text evidence is allowed only for:

```text
reconstructed candidate path AND snapshot raw diff path
```

Snapshot files not in candidates:

```text
diagnostic-only
never file event
```

Tests:

- snapshot contains extra formatter output not mentioned by OpenCode write/edit/apply_patch;
- no event for extra file in this phase;
- future shell/delivery git snapshot layer can cover it, but this OpenCode bridge cannot claim it yet.

#### P0.6 Unsafe Review Action After Evidence Upgrade

Failure:

```text
user rejected metadata-only row or persisted a file decision
later same changeKey becomes full-text
old decision applies to new diff
```

Required design:

UI decision scope must change when ledger source fingerprint changes. The fingerprint must include projected evidence-relevant fields:

```text
sourceFingerprint includes:
  journalStamp
  projected event ids
  sourceImportKey projection winners
  latestBeforeHash
  latestAfterHash
  reviewability
  contentAvailability
```

Additionally, renderer must clear per-file decisions when a loaded change set changes hashes for the same `changeKey`:

```ts
if (sameChangeKey && previousHashPair !== nextHashPair) {
  clearFileDecision(changeKey)
  clearHunkDecisions(changeKey)
  clearHunkContextHashes(changeKey)
}
```

Tests:

- persisted reject from metadata-only is not replayed after full-text upgrade;
- persisted hunk decision is not replayed when hunk context hash changes;
- same bundle reload with same fingerprint does not clear decisions;
- non-OpenCode file decisions remain untouched.

### P1 Risks - Must Have Direct Tests

#### P1.1 Contributor And Line Stats Inflation

Risk:

Superseded metadata-only event and upgraded full-text event both increment contributor stats. This can make the task look like more work happened than did.

Policy:

- `bundle.eventCount` may stay raw journal count for audit.
- `files[].eventCount` should be projected visible event count, or add `journalEventCount` if audit count is needed.
- `contributors[].cumulativeLinesAdded/Removed` should use projected visible events for sourceImportKey groups.
- `contributors[].eventCount` can be raw only if clearly documented. Prefer projected for UI-facing scope.

Tests:

- metadata-only + upgrade yields line stats from upgrade only;
- contributor visible/touched counts remain one;
- raw journal count is still available through bundle/freshness if needed.

#### P1.2 Warning Semantics Drift

Risk:

Superseded warnings like `Before content unavailable` can remain after full-text upgrade and confuse UI into manual-review mode. Or useful warnings like `OpenCode snapshot evidence recovered after transient read` can disappear.

Policy:

Drop superseded warnings that are only about missing text:

```text
manual-only
before content unavailable
after content unavailable
metadata-only fallback
```

Preserve warnings that still describe evidence quality:

```text
snapshot-mode-only-change
snapshot-diff-read-retried
snapshot-window-path-ambiguous for skipped sibling path
dirty leader worktree warning
```

Tests:

- full-text upgrade does not render manual-review warning;
- binary/large remains manual-review;
- task-level diagnostics still include skipped sibling path details without disabling safe full-text file.

#### P1.3 Existing Projection Corrupted By Malformed Journal Recovery

Risk:

Journal recovery drops malformed lines. If base survives but upgrade is malformed, projection should show base. If base is malformed but upgrade survives, projection can show upgrade only if upgrade carries full identity.

Policy:

Upgrade event must contain enough identity to stand alone:

```text
sourceImportKey
sourceSessionId
sourceMessageId
sourcePartId
relativePath
operation
evidenceProof
supersedesEventId
```

`supersedesEventId` is audit metadata, not required to find the group.

Tests:

- malformed base + valid upgrade shows upgraded row;
- valid base + malformed upgrade shows base row plus recovered warning;
- neither case throws.

#### P1.4 Snapshot Git Object Store Race

Risk:

OpenCode SQLite can expose `step-finish.snapshot` before our process can read every object from the internal snapshot gitdir, especially during live session writes.

Policy:

- Missing gitdir or missing object is transient, not permanent unsupported.
- UI auto-backfill should not cache this as long-lived `duplicates-only` or success.
- Retry on next detail open or after short TTL.

Diagnostics:

```text
snapshot-gitdir-missing
snapshot-object-missing
snapshot-diff-read-failed
```

Tests:

- fixture with missing object returns metadata-only and transient diagnostic;
- second run with object present upgrades;
- cache key includes DB fingerprint and snapshot hashes, not just task id.

#### P1.5 Schema Drift Misclassified As No Changes

Risk:

If OpenCode changes part shape, the bridge could return `no-history` or `duplicates-only`, causing UI to show no changes even though agent edited files.

Policy:

Unsupported shape outcome:

```text
outcome: skipped-capability
diagnostic: unsupported-opencode-history-shape
candidateEvents: 0
importedEvents: 0
```

It must not be cached as successful backfill.

Tests:

- missing `part.data`;
- invalid JSON in `part.data`;
- `step-start` without snapshot;
- write/edit toolpart shape unknown;
- result includes diagnostic and does not broad scan.

#### P1.6 Windows Worktree Hash And Path Comparison

Risk:

OpenCode snapshot directory uses SHA-1 over exact `project.worktree` string. If we normalize path before hashing, Windows drive-case or separator differences produce a wrong gitdir. If we do not normalize for comparison, safe paths can be rejected or accepted incorrectly.

Policy:

```text
hash input: exact SQLite project.worktree string
safety comparison: normalized platform-aware paths
display path: normalized forward slash relative path
```

Tests:

- `C:\Repo` vs `c:\repo` same safety comparison but different hash input remains exact to SQLite;
- `patch.files` forward slash path maps to native worktree;
- UNC path safety rejects mismatched local drive file;
- device paths are rejected.

#### P1.7 Same Path Multiple Toolparts

Risk:

One snapshot window contains two toolparts touching same file. Assigning window before/after to one part is false attribution.

V1 policy:

```text
exactly one candidate per (windowId, relativePath) required for snapshot full-text upgrade
otherwise no upgrade for that path
```

Tests:

- write then edit same file in one window stays metadata/toolpart-chain only;
- two different files in one window can upgrade independently;
- diagnostic is path-scoped.

#### P1.8 Non-OpenCode Regression

Risk:

Task ledger projection changes affect shell snapshot, file edit, file write, notebook edit, PowerShell, post-hook, or teammate worktree changes.

Policy:

- SourceImportKey projection only applies when `event.sourceRuntime === 'opencode'` and `event.sourceImportKey` exists.
- Non-OpenCode events keep exact current grouping behavior.
- Shared schema additions are optional.

Tests:

- existing task ledger suite unchanged;
- shell create/delete summary unchanged;
- file write create reject still deletes with hash guard;
- worktree metadata badge unchanged.

#### P1.9 UI Auto-Backfill Cache Hides Later Evidence

Risk:

Current UI backfill uses in-flight dedupe and a short cache. If `no-history`, `no-attribution`, `duplicates-only`, `snapshot-window-missing`, or `snapshot-gitdir-missing` is cached as a successful final answer, a task can keep showing empty/manual-only Changes after OpenCode finishes writing SQLite/snapshot state.

Policy:

Cache behavior must distinguish final stable outcomes from transient outcomes:

| Outcome | Cache behavior |
| --- | --- |
| imported full-text | normal short cache |
| duplicates-only with candidate events in same delivery window | normal short cache |
| duplicates-only with zero strict-window candidates | do not cache as success |
| no-attribution | do not cache if delivery records may still appear |
| no-history | very short cache only if no delivery records exist |
| snapshot-window-missing | short transient cache, retry on detail open |
| snapshot-gitdir-missing/object-missing | short transient cache, retry on detail open |
| unsupported schema | cache only by DB fingerprint and adapter version |

Cache key must include:

```text
teamName
taskId
projectDir
workspaceRoot
deliveryContextFingerprint
attributionMode
adapterVersion
OpenCode DB fingerprint when known
snapshot evidence mode version
```

Since the final design removes UI `evidenceMode`, the cache key should use an internal constant like `opencode-session-snapshot-v1`, not `chain-only`.

Tests:

- first detail open before step-finish returns transient metadata/no-upgrade, second open after step-finish upgrades.
- `no-attribution` before delivery ledger write is not cached as final.
- `duplicates-only` with candidate events is cached.
- `duplicates-only` with no strict-window candidates is not cached as evidence success.
- cache key changes when delivery context fingerprint changes.

### P2 Risks - Accept With Diagnostics

#### P2.1 Snapshot Cost On Large Repos

Risk:

OpenCode snapshots are documented as potentially slow and disk-heavy for large repos/submodules. No feature flag means the app will enable a behavior some users may feel.

Why still acceptable:

- OpenCode snapshots are documented default behavior.
- We only return to default for managed OpenCode sessions.
- Our bridge reads with caps and does not run `track`.
- Old `snapshot:false` sessions still work metadata-only.

Required guard:

```text
large repo stress fixture before merge
diagnostic when snapshot read hits cap
no unbounded cat-file output
no workspace scan
```

Future operational escape hatch:

**Admin disable switch** - 🎯 6.5   🛡️ 8.0   🧠 4.0 - ~150-300 LOC.
Not part of this no-flag implementation. Only add later if real production telemetry shows snapshot cost is harmful.

#### P2.2 Rename Semantics

Risk:

OpenCode uses `--no-renames`, so rename appears as delete/create or metadata-only.

Policy:

- Do not invent semantic rename in this phase.
- UI may show two lifecycle rows.
- This is acceptable because content attribution remains safe.

Future:

**Rename relation composer** - 🎯 7.0   🛡️ 8.2   🧠 7.5 - ~500-1000 LOC.

#### P2.3 Chmod-Only, Symlink, Submodule

Risk:

These are real changes but not text diffs.

Policy:

- Metadata-only/manual-review.
- Never dereference symlinks.
- Never read submodule contents.
- Preserve mode metadata in future optional field.

## Deeper Threat Model

This section expands the weak spots that are most likely to produce subtle production bugs. The goal is to make every risk testable before implementation starts.

### T1 - SQLite Consistency, WAL, And Partial History

Current code already opens OpenCode SQLite read-only and uses a transaction for messages/parts. That is good, but not enough by itself.

Failure modes:

| Failure | How it happens | Bad result |
| --- | --- | --- |
| DB changes during read | OpenCode writes `step-finish` or `patch` after our transaction starts. | We read a consistent older view and cache “no snapshot window”. |
| WAL fingerprint changes | `opencode.db-wal` changes after initial fingerprint. | Cache key can point to a DB state we did not actually read. |
| unrelated bad row | One old malformed message/part is present in a long session. | Whole session becomes unsupported even though task-relevant rows are readable. |
| bounded read cap | Session has more than `MAX_OPENCODE_PARTS_PER_SESSION`. | Task-relevant rows after cap disappear. |
| timestamp tie | Multiple parts have same `time_created`. | Window pairing can be unstable if ordering is not deterministic. |
| missing project row | `session.project_id` exists but `project` row was deleted or schema changed. | Snapshot gitdir cannot be resolved, but toolpart metadata can still be useful. |

Required policy:

```text
transaction gives consistency, not finality
if DB/WAL fingerprint changes during read -> mark result transient
transient read results must not be cached as final success
bad snapshot parts must not poison unrelated valid toolpart reconstruction
bad task-relevant write/edit shape can mark OpenCode bridge unsupported for that session
```

Reader output should carry:

```ts
type OpenCodeOfflineSessionReadResult = {
  dbFingerprintBefore: OpenCodeSqliteFingerprint
  dbFingerprintAfter: OpenCodeSqliteFingerprint
  dbChangedDuringRead: boolean
  historyShape: 'supported' | 'unsupported' | 'partial'
  snapshotShape: 'supported' | 'unsupported' | 'unavailable'
  transient?: boolean
}
```

If adding all fields is too much, at minimum add:

```ts
dbChangedDuringRead: boolean
transientDiagnostics: string[]
```

Cache rule:

```text
dbChangedDuringRead === true -> no stable success cache
snapshot-window-missing + dbChangedDuringRead -> retry later
snapshot success + dbChangedDuringRead -> ok to import only if exact window and blobs were read; cache by actual snapshot hashes, not final DB mtime
```

Tests:

- DB fingerprint changes between initial and final stat, missing window result is not cached.
- DB fingerprint changes but exact window and blobs are present, full-text import is allowed.
- malformed unrelated non-tool part does not mark session unsupported.
- malformed task-relevant write/edit part returns `unsupported-opencode-history-shape`.
- rows with identical `time_created` use `(time_created, id)` order deterministically.
- cap exceeded returns `partial` and no broad inference.

### T2 - Snapshot Git Reader Parser State Machine

The raw git reader is the most parser-heavy part. It must be treated like an untrusted binary protocol.

Required command:

```text
git -c core.autocrlf=false -c core.longpaths=true -c core.symlinks=true -c core.quotepath=false \
  --git-dir <gitDir> --work-tree <worktree> \
  diff --no-ext-diff --raw -z --abbrev=40 --no-renames <from> <to> -- .
```

Parser risks:

| Risk | Bad result | Guard |
| --- | --- | --- |
| raw output not paired header/path | out-of-bounds parser read | reject whole diff as `snapshot-raw-parse-failed` |
| status contains score like `R100` | parser reads wrong path count | first version rejects rename/copy statuses |
| object id abbreviated | `cat-file` reads wrong/missing object | require 40 hex or all-zero |
| path invalid UTF-8 | wrong UI path or crash | skip path with diagnostic |
| path absolute or `..` | outside workspace read | skip unsafe group |
| same lower-case path on Windows | wrong file merged | skip colliding group |
| stdout cap hit mid-record | partial blob/content | kill process and return transient diagnostic |
| `cat-file` header type not blob | symlink/submodule/tree confusion | metadata-only |
| missing trailing newline after blob | parser desync | reject current object and stop |

State machine:

```text
RAW_DIFF:
  read NUL item header
  validate header starts with ":"
  read NUL item path
  validate mode/status/object ids/path
  append entry

CAT_FILE:
  write object ids to stdin
  read header line
  validate "<sha> blob <size>"
  if size > cap -> drain/kill and mark side unavailable
  read exact size bytes
  read one trailing newline
  decode UTF-8 only after binary/null-byte check
```

Do not parse blob output with `split("\n")`. Do not convert full stdout to a UTF-8 string before enforcing byte caps.

Tests:

- raw diff output with odd number of NUL items fails closed.
- raw diff status `R100` fails metadata-only, not wrong path.
- `cat-file` `tree` response becomes metadata-only.
- partial `cat-file` output after timeout does not produce content.
- binary content containing NUL is metadata-only.
- UTF-8 replacement characters are not silently accepted as valid text.

### T3 - Evidence Identity And Collision Safety

`sourceImportKey` is the core identity. If it is too broad, unrelated events merge. If it is too narrow, duplicates appear.

Required identity fields for OpenCode toolpart/path:

```text
runtime: opencode
sessionId
sourceMessageId
sourcePartId
sourceTool
normalized absolute filePath or relativePath with workspace identity
```

Upgrade identity must additionally require:

```text
same taskId
same memberName when present
same laneId/runtimeSession delivery record
same sourceImportKey
same sourceSessionId
same sourceMessageId
same sourcePartId
same normalized relativePath
compatible operation
```

Collision policy:

| Collision | Behavior |
| --- | --- |
| same `sourceImportKey`, different path | skip both and diagnostic |
| same `sourceImportKey`, different source part | skip both and diagnostic |
| same path lower-case collision on Windows | skip unsafe path group |
| same part touches same path twice in one window | no snapshot upgrade |
| same source key already full-text, incoming metadata-only | duplicate skip |
| same source key full-text with different hashes | append only if evidence proof is stronger and operation compatible; otherwise diagnostic |

Tests:

- deliberate `sourceImportKey` collision does not import either event.
- full-text with same rank but different hash is not silently accepted.
- lower-rank event after higher-rank event is skipped.
- cross-task same source key cannot upgrade because journals are task-scoped and identity includes taskId.

### T4 - Snapshot Window Versus Toolpart Chain Composition

The current inverse-chain tests prove simple edit/apply_patch upgrades. Snapshot windows introduce a new ambiguity: snapshot before/after is cumulative for a model step, not necessarily one toolpart.

State rules:

```text
one candidate path in one window -> direct full-text upgrade allowed
multiple candidate paths in one window -> each path can upgrade independently
multiple candidates for same path in one window -> no direct snapshot assignment
toolpart-chain exact event -> keep exact event even if snapshot window is ambiguous
metadata-only same-path multi-candidate -> no upgrade
```

Why not compose immediately:

**Window path composer** is useful but risky. It must understand ordered write/edit/apply_patch semantics, verify every intermediate state, and decide whether UI should show one cumulative row or multiple verified rows. That is later work.

Tests:

- same path write then edit in same step remains no-upgrade for metadata-only pieces.
- same path two exact toolpart-chain events remain visible as existing ledger behavior dictates.
- different paths in same step upgrade independently.
- snapshot diff includes one path but two candidates claim it, both stay manual-only.

### T5 - Ledger Apply/Reject Safety After Upgrade

The snapshot bridge only improves diff visibility. It must not weaken strict apply/reject.

Required apply/reject invariants:

```text
full reject modify -> write before only if current disk hash == ledger after hash
full reject create -> delete only if current disk hash == ledger after hash; missing is success
full reject delete -> restore before only if file is still missing
partial reject -> only hunk inverse patch with full before/after and current hash == after hash
metadata-only/binary/large -> manual-review-required
```

Upgrade-specific risks:

| Risk | Behavior |
| --- | --- |
| upgrade has before/after but current disk changed | conflict |
| upgrade changes operation from modify to create/delete | no upgrade unless operation matrix allows |
| delete restore target already exists | conflict |
| create reject target changed after agent | conflict |
| partial reject on metadata-only upgraded sibling | disabled for that sibling |

Tests:

- snapshot-upgraded modify reject restores only with hash match.
- hash mismatch returns `conflict`.
- snapshot-upgraded create reject deletes only with hash match.
- snapshot-upgraded delete reject restores only when file absent.
- metadata-only event beside upgraded event still returns `manual-review-required`.

### T6 - UI Presence And Empty-State Semantics

The UI previously showed confusing “No file changes recorded” for tasks that had diagnostic-only or metadata-only states. Default snapshot path adds more intermediate states.

Required semantics:

| Ledger result | Task row Changes section | Dialog content |
| --- | --- | --- |
| full-text files | show Changes | diff list |
| metadata-only files | show Changes | manual-review metadata row |
| notices/diagnostics only | show Changes section if user opens details, but no blue file-change badge | diagnostic state |
| strict no-attribution | no file-change badge, diagnostic available in dev logs |
| transient snapshot missing | loading/retry state, then metadata/diagnostic if still missing |
| no OpenCode history | no file-change badge |

Test requirements:

- task detail always has a Changes section if the product decision says it should be always available.
- count/loading state does not show `0` while default backfill is in flight.
- metadata-only files count as changes.
- diagnostic-only does not use the same icon as real file changes.
- old cached `no_changes` presence is invalidated after ledger bundle appears.

### T7 - Operational Rollback Without Feature Flags

The user explicitly wants no feature flags and no legacy default path. That still needs a rollback story that does not rely on UI toggles.

Allowed rollback:

```text
ship a code rollback/revert
keep ledger schema additive
old readers ignore new optional fields
new readers can read old bundles
metadata-only fallback still works
```

Not allowed:

```text
hidden UI flag
runtime env flag as normal product path
dual legacy default in production
```

Rollback constraints:

- Do not delete old `snapshotBoundary` fields from existing delivery ledger files, only stop using them for full-text evidence.
- Do not make new ledger events unreadable by current UI if only optional fields are added.
- Do not require journal migration.
- Do not change non-OpenCode event semantics.

Tests:

- old bundle without new fields still reads.
- new bundle with upgrade fields reads in UI.
- old metadata-only event without `evidenceRank` still gets rank by `evidenceProof ?? unknown`.
- rollback build can ignore upgrade fields and still avoid unsafe apply/reject because metadata-only remains manual.

### T8 - Privacy And Debuggability Balance

We need enough diagnostics to debug real user cases like “agent says it edited files but Changes is empty”, without logging sensitive data.

Allowed in diagnostics/dev log:

```text
teamName
taskId
memberName
laneId
sessionId
messageId
partId
sourceTool
relativePath
diagnostic code
snapshot hash prefix
adapterVersion
opencodeVersion
counts and sizes
```

Forbidden:

```text
file content
patch body
oldString/newString
prompt text
assistant text
full absolute path in cloud/remote logs
env vars
tokens
auth fingerprints if not already hashed
```

Diagnostic levels:

| Level | Use |
| --- | --- |
| `debug` | local dev log only, path and ids ok |
| `notice` | UI diagnostic panel, no raw absolute sensitive paths unless already displayed as file path |
| `warning` | task ledger warning, only actionable degraded capture |
| `error` | bridge failed unexpectedly, no content |

Tests:

- diagnostic serialization does not include `oldString`, `newString`, `patch`, `content`, `prompt`, or `text` fields.
- dev log can correlate by task/member/session/sourcePartId.
- UI warning for manual-review does not expose raw patch body.

## Source-Verified Edge Cases To Encode

This is the latest source-driven correction pass. These are not generic concerns. They come from the current OpenCode source and our current bridge code.

### S1 - Snapshot Fields Are Optional

OpenCode `StepStartPart` and `StepFinishPart` schemas define:

```ts
type: 'step-start', snapshot?: string
type: 'step-finish', snapshot?: string
```

Risk:

```text
part exists but snapshot is missing
bridge treats window as valid anyway
provider attempts git diff with empty hash or wrong fallback
```

Required behavior:

- missing `step-start.snapshot` means no snapshot window;
- missing `step-finish.snapshot` means no snapshot window;
- do not treat standalone `type: 'snapshot'` part as a step boundary;
- diagnostic must be window-scoped, not whole-session fatal.

Tests:

- step-start without snapshot keeps metadata-only;
- step-finish without snapshot keeps metadata-only;
- standalone snapshot part is ignored for task evidence;
- valid later window in same session can still upgrade.

### S2 - `patch.files` Is Not Safe Path Proof

OpenCode `patch(hash)` currently gets file names through:

```text
git diff --cached --name-only <hash> -- .
trim().split("\n")
```

Risk:

```text
filename contains newline
patch.files becomes two fake paths
bridge trusts patch.files
wrong file event appears or real file is skipped
```

Extra risk:

`patch()` calls `add()` again after `step-finish.snapshot` was already written. If any file mutates between finish-step `track()` and patch `add()`, `patch.files` can disagree with the `step-start` -> `step-finish` tree diff.

Required behavior:

- `patch.files` is only a consistency hint;
- raw snapshot git diff with `-z` is the path proof;
- imported file must be in reconstructed toolpart candidates and raw diff;
- if `patch.files` disagrees with raw diff, emit diagnostic but trust raw diff for evidence;
- if raw diff has no candidate path match, no file event.

Tests:

- newline filename in raw diff is handled, while corrupted `patch.files` is ignored.
- `patch.files` includes a path absent from raw diff, no event imported.
- raw diff includes candidate path absent from `patch.files`, full-text can still import with diagnostic.

### S3 - OpenCode `diffFull` Is Not The Implementation To Copy

OpenCode `diffFull` uses status/numstat line parsing, `cat-file --batch`, and fallback `git show <tree>:<path>`.

Risk:

```text
we copy OpenCode fallback
tree:path quoting bug or newline path bug returns wrong content
```

Required behavior:

- use OpenCode source to understand semantics, not to copy fallback behavior;
- our production reader uses raw object ids from `git diff --raw -z --abbrev=40`;
- no `git show <tree>:<path>` fallback in production evidence path;
- if object-id reader fails, metadata-only.

Tests:

- path containing colon does not use `tree:path` ref;
- newline path content is fetched by object id;
- forced `cat-file` failure downgrades instead of falling back to path refs.

### S4 - Snapshot Store Can Disappear Before SQLite

OpenCode snapshot service has cleanup behavior, while SQLite session history can outlive snapshot git objects. There has also been public issue history around snapshot gitdir initialization problems, so missing gitdir/objects must be treated as normal degraded state, not as impossible.

Risk:

```text
SQLite has snapshot hashes
snapshot gitdir missing or object pruned
bridge reports no changes or crashes
```

Required behavior:

- missing gitdir -> metadata-only/manual-review with diagnostic;
- missing object -> transient diagnostic if DB looks active, stable unsupported if snapshot store is old/pruned;
- do not delete or repair OpenCode snapshot gitdir;
- do not run `git init`;
- do not call OpenCode `track()` to rebuild evidence.

Tests:

- SQLite snapshot hashes with missing gitdir returns metadata-only.
- gitdir exists but object id missing returns metadata-only.
- retry after object appears upgrades.
- old/pruned fixture does not retry forever.

### S5 - Ignored And Large Files Are Intentionally Missing From Snapshot

OpenCode snapshot `add()` filters ignored files and skips files above its large-file limit.

Risk:

```text
agent edits ignored/large file
toolpart proves path
snapshot does not include content
bridge interprets missing snapshot path as no change
```

Required behavior:

- missing snapshot row for a proven toolpart path is not “no change”;
- import metadata-only/manual-review if toolpart path is strict-delivery matched;
- diagnostic should distinguish `snapshot-path-not-present` from `snapshot-path-not-touched`;
- large-file and ignored-file cases must not enable auto apply/reject.

Tests:

- ignored file write becomes metadata-only.
- large file write becomes metadata-only.
- snapshot missing path does not erase existing metadata-only candidate.

### S6 - Part Ordering Is Lower Confidence Than It Looks

OpenCode creates parts with `PartID.ascending()`, and the table has an index on `(message_id, id)`. Our current reader orders rows by `(time_created, id)`.

Risk:

```text
multiple parts have same timestamp
time ordering differs from actual part order
window matching uses wrong step boundary
```

Required behavior:

- inside one message, derive `partOrder` from `id` ordering unless source proves a stronger order;
- still retain `time_created` for diagnostics;
- if part ids are missing, non-string, duplicated, or not sortable, mark snapshot windows unsupported;
- test same-time rows explicitly.

Candidate implementation:

```ts
const partsForMessage = rows
  .filter(row => row.message_id === messageId)
  .sort((a, b) => a.id.localeCompare(b.id))
```

If future source proves `time_created` should be primary, adjust with tests. Today the safer assumption is message-local part id order.

Tests:

- same `time_created` rows still pair correct window by id.
- deliberately shuffled DB insertion order does not change window pairing.
- duplicated part id marks snapshot windows unsupported.

### S7 - Provider-Executed Tools And Delayed Tool Results

OpenCode processor can represent provider-executed tools and normal tools through the same `tool` parts. Tool input/result events can arrive before or after visible text/reasoning parts.

Risk:

```text
snapshot window contains provider-executed tool with file changes
bridge does not recognize toolpart shape
false no-changes
```

Required behavior:

- provider-executed flag must not disqualify a supported `write/edit/apply_patch` toolpart;
- unsupported provider-executed tool shape becomes diagnostic-only or metadata-only if exact path is not proven;
- source tool identity must still be exact.

Tests:

- `metadata.providerExecuted === true` write tool is reconstructed if shape matches.
- provider-executed unknown tool is ignored with diagnostic.
- delayed completed toolpart still maps to its source part id and window.

### S8 - Compaction And Summary Can Hide Parts

Long OpenCode sessions can include compaction parts and summaries. Summary diffs are session/message-level, not strict task evidence.

Risk:

```text
original toolpart no longer present or is compacted
summary_diffs still says files changed
bridge imports from summary_diffs
cross-task false attribution
```

Required behavior:

- do not import from `session.summary_diffs` or user message summary diffs;
- if strict source toolpart is missing, no full-text snapshot import;
- if delivery context still proves task but toolpart missing, diagnostics-only or metadata-only only when exact path is otherwise proven;
- compaction parts must not be treated as toolparts.

Tests:

- summary_diffs-only fixture imports zero file events.
- compacted session with missing toolpart does not snapshot-upgrade.
- compacted session with still-present toolpart can upgrade normally.

### S9 - Snapshot Config Migration Is Not Retroactive

Current managed config has used `snapshot:false`. Setting `snapshot:true` changes only future OpenCode operations.

Risk:

```text
user opens old task
expects Cursor-like full diff
old session has no snapshot parts
bridge cannot produce before content
```

Required product behavior:

- old sessions stay Variant 1 metadata-only/toolpart-chain;
- UI wording must not imply old OpenCode tasks can be upgraded magically;
- diagnostics should say `snapshot-parts-unavailable-for-session`, not generic “No changes”.

Tests:

- old `snapshot:false` fixture remains metadata-only.
- no snapshot parts does not cause debug CLI fallback.
- new `snapshot:true` fixture produces full-text.

### S10 - External Mutation Still Cannot Be Proven

Even with OpenCode snapshots, this bridge proves only changes represented in OpenCode snapshot state and strict toolpart paths. It does not prove ownership against a concurrent external writer unless the external mutation is inside the same snapshot tree and path candidate, and even then toolpart path proof is required.

Risk:

```text
formatter, watcher, IDE, or user edits same file during OpenCode step
snapshot before/after includes that mutation
bridge attributes it to OpenCode toolpart
```

V1 policy:

- if same path has exactly one OpenCode candidate in the window, snapshot diff can represent the final file state for that candidate;
- if external mutation is indistinguishable on same path, we cannot fully separate it without process/worktree isolation or targeted per-tool baseline;
- strict apply/reject hash guards still prevent unsafe disk writes later;
- diagnostics should not claim absolute ownership, only “captured in OpenCode step snapshot for strict toolpart path”.

Future stronger option:

**Targeted per-tool baseline inside OpenCode bridge** - 🎯 8.0   🛡️ 9.1   🧠 8.9 - ~1800-3400 LOC.
Capture before/after around exact tool execution through a runtime hook or MCP tool wrapper. Useful later, but not part of this snapshot reader phase.

Tests:

- same-path external mutation fixture is documented as indistinguishable and still hash-guarded.
- different-path external mutation in same snapshot window is not imported because no toolpart candidate.

## Assumption Ledger

Every assumption below needs either a test or a fail-closed diagnostic.

| Assumption | Confidence | If false | Guard |
| --- | ---: | --- | --- |
| `project.worktree` string from SQLite is the exact hash input. | 🎯 9.0 | snapshot gitdir not found | live smoke asserts gitdir path after write |
| `profileDataDir = dirname(opencode.db)` for managed profile. | 🎯 8.2 | snapshot gitdir not found | live smoke plus fallback diagnostic |
| `PartID.ascending()` lexical order matches part creation order. | 🎯 7.7 | wrong snapshot window | same-timestamp/id-order fixture |
| `step-start` and `step-finish` bracket the toolpart. | 🎯 8.8 | false full-text attribution | sourcePartId must be inside exactly one window |
| snapshot git objects remain readable after SQLite read. | 🎯 7.4 | transient metadata-only | retry policy, no stable empty cache |
| raw diff `--abbrev=40` always gives full ids. | 🎯 9.0 | blob lookup fails | parser rejects non-40 ids |
| OpenCode stays on SQLite table names `session/message/part/project`. | 🎯 8.0 | unsupported shape | schema sentinel |
| `write/edit/apply_patch` toolpart shape remains stable. | 🎯 7.8 | no reconstruction | unsupported shape diagnostic, no broad scan |
| enabling snapshots restores OpenCode default behavior. | 🎯 8.8 | perf/disk complaints | caps, stress fixture, documented rollback |
| UI projected fingerprint reset catches all stale decisions. | 🎯 8.1 | unsafe stale reject | hash/context decision reset tests |

Risk burn-down priority:

1. Prove profile data dir and snapshot gitdir with live smoke.
2. Prove part ordering with same-timestamp fixture.
3. Prove raw parser with newline/colon/tab paths.
4. Prove projection race with concurrent imports.
5. Prove UI decision reset with metadata-first upgrade fixture.
6. Prove no-content diagnostics through privacy serialization test.

## False Positive / False Negative Risk Taxonomy

This section is intentionally blunt. The hardest bug class here is not a crash. It is showing a confident looking diff for the wrong task, wrong agent, wrong file, or wrong evidence version. The implementation must optimize for fail-closed behavior even if that means some OpenCode sessions stay metadata-only.

| Class | What Can Go Wrong | User Impact | Severity | Target Guard |
| --- | --- | --- | ---: | --- |
| `FP-ATTR` | file belongs to another task/member/session but appears in this task | user accepts/rejects someone else's work | 10 | strict delivery context + sourcePartId + snapshot window |
| `FP-PATH` | unsafe path parsing creates a fake path | wrong row in Changes | 10 | raw `-z` git parser, never trust `patch.files` as proof |
| `FP-WINDOW` | wrong step-start/step-finish window selected | full diff is from wrong model step | 9 | message-local id order, exactly one containing window |
| `FP-UPGRADE` | metadata-only event upgraded with unrelated snapshot diff | UI shows plausible but wrong diff | 10 | upgrade fingerprint requires same sourcePartId/path/task/member/session |
| `FN-HISTORY` | OpenCode DB shape changed, reader misses real toolparts | empty Changes despite edits | 8 | schema drift sentinel, explicit unsupported diagnostics |
| `FN-SNAPSHOT` | snapshot gitdir/object missing, reader treats as no changes | user sees empty Changes | 8 | metadata-only fallback for proven toolpart path |
| `FN-IGNORED` | ignored/large file not included in snapshot | user sees no change for real edit | 7 | toolpart path creates metadata-only event |
| `SAF-REVIEW` | stale accept/reject decision applies to upgraded content | disk mutation is unsafe | 10 | decision key includes evidence proof + content hashes |
| `PERF-SCAN` | wide SQLite/git reads on large repos | UI hangs or machine pressure | 8 | bounded sessions, bounded parts, streaming cat-file, caps |
| `PRIV-LOG` | debug logs leak prompt, patch, or content | privacy/security bug | 10 | diagnostic whitelist only |
| `COMPAT-DRIFT` | OpenCode source changes behavior after we ship | silent regression | 8 | version/source-shape sentinel and release smoke |

### `FP-ATTR` - Wrong Task Attribution

Failure shape:

```text
task A and task B use same OpenCode session or same repo
strict reader sees write/edit parts in DB
reader imports part into task A because filename or prompt text matches
```

Why this is dangerous:

- the diff can look valid;
- user has no easy way to detect wrong attribution;
- strict ledger-native reject can then mutate a file from the wrong workflow.

Required implementation rule:

- UI auto-backfill must require delivery ledger context;
- delivery context must match `teamName`, `taskId`, `memberName` or `laneId` or `sessionId`;
- `sourcePartId` must belong to the delivered user message, inbox message, or exact recorded OpenCode turn;
- prompt text matching is not allowed for UI auto-backfill;
- compatible/manual CLI can keep broader recovery, but that path must not be used by default UI.

Required tests:

- same session contains toolparts for two tasks, only the delivered one imports;
- same filename edited by two different members, no cross-import;
- prompt mentions another task id, strict mode ignores it unless delivery record matches;
- duplicated task id string in comments does not create file events.

### `FP-PATH` - Path Parser Creates A Fake File

Failure shape:

```text
file name contains newline, tab, colon, leading dash, backslash, or unicode normalization edge
OpenCode patch.files was built from newline split
bridge trusts patch.files
```

Required implementation rule:

- raw snapshot diff path proof must come from `git diff --raw -z`;
- parser must reject malformed records, non-40 object ids, outside-workspace paths, device paths, and absolute paths;
- OpenCode `patch.files` may only be used for diagnostics and candidate intersection hints;
- path normalization must preserve exact git path bytes as much as Node APIs allow.

Required tests:

- newline filename imports exactly one correct file through raw `-z`;
- `patch.files` split into two strings does not create two events;
- `foo:bar.ts` never uses `tree:path` lookup;
- `--looks-like-option.ts` does not affect git command invocation;
- unicode NFC/NFD paths are not collapsed into another path.

### `FP-WINDOW` - Wrong Snapshot Window

Failure shape:

```text
toolpart appears between two model steps
rows have same timestamp
reader chooses nearest timestamp instead of part id order
```

Required implementation rule:

- windows are computed per message;
- ordering inside message is by sortable part id;
- source part must be strictly inside one window;
- if two windows can contain the same source part because ordering is ambiguous, no full-text upgrade;
- time is diagnostic only, not proof.

Required tests:

- same timestamp rows still select correct window;
- shuffled SQLite insertion order still selects correct window;
- duplicate part id makes snapshot evidence unsupported;
- sourcePartId before first step-start remains metadata-only;
- sourcePartId after last step-finish remains metadata-only.

### `FP-UPGRADE` - Wrong Metadata Upgrade

Failure shape:

```text
Variant 1 metadata-only event exists for path src/a.ts
later snapshot backfill finds src/a.ts diff in same session but different toolpart
reader upgrades old row to full text
```

Required implementation rule:

- upgrade identity is not just path;
- upgrade identity must include task, team, member/lane/session, sourcePartId, source tool, operation, and normalized path;
- if the exact sourcePartId is missing in old metadata event, upgrade must stay metadata-only unless one-to-one proof exists;
- if multiple candidates exist for the same path/window, no automatic upgrade.

Required tests:

- metadata event with same path and different sourcePartId is not upgraded;
- two writes to same file in one task produce one final visible row only if bundler intentionally folds them with a shared ledger identity;
- duplicate row is not shown after upgrade;
- stale renderer decision key resets when metadata-only becomes full-text;
- accept/reject hashes are from the upgraded event, not the old metadata event.

### `FN-HISTORY` - OpenCode Shape Drift

Failure shape:

```text
OpenCode changes SQLite column names or toolpart JSON shape
reader sees no known toolparts
UI says No file changes
```

Required implementation rule:

- schema drift must produce `unsupported-opencode-history-shape`;
- unknown write/edit/apply_patch part shape must produce a bounded diagnostic;
- this must not be cached as stable `no-history`;
- strict UI should show diagnostic state if task activity proves an OpenCode session existed.

Required tests:

- missing table returns unsupported shape, not no changes;
- missing `part.message_id` or `part.id` returns unsupported shape;
- invalid JSON row count is reported with cap, not thrown;
- unknown toolpart shape returns diagnostic and zero events;
- unsupported shape cache expires quickly or is invalidated when DB mtime changes.

### `FN-SNAPSHOT` - Snapshot Missing Or Pruned

Failure shape:

```text
SQLite has step-start/step-finish snapshot hashes
snapshot gitdir is missing, object is missing, or OpenCode cleanup pruned it
```

Required implementation rule:

- proven strict-delivery toolpart path still imports metadata-only/manual-review;
- missing snapshot must never become `no changes`;
- missing snapshot is retryable if DB/session appears active, stable degraded if old/pruned;
- no code should initialize or repair OpenCode snapshot gitdir.

Required tests:

- missing gitdir gives metadata-only event and diagnostic;
- missing object gives metadata-only event and diagnostic;
- object appears on retry, event upgrades to full-text without duplicate;
- old/pruned fixture is not retried forever.

### `SAF-REVIEW` - Unsafe Accept/Reject

Failure shape:

```text
user opens Changes while metadata-only
UI stores reject decision
snapshot upgrade later provides full text
old decision applies to upgraded row
```

Required implementation rule:

- any decision identity must include evidence kind and before/after hashes;
- metadata-only actions remain disabled;
- upgrade invalidates old decisions;
- strict ledger apply/reject must re-check current disk hash.

Required tests:

- metadata-only reject decision cannot apply after upgrade;
- hash mismatch blocks full reject;
- missing before text returns `manual-review-required`;
- binary/large stays manual-only even with path proof;
- stale async backfill result cannot overwrite newer summary generation.

### `PERF-SCAN` - Heavy Reader Work

Failure shape:

```text
UI opens a task
reader scans large OpenCode DB and large snapshot gitdir
app hangs or creates memory pressure
```

Required implementation rule:

- strict mode filters to delivery session before reading parts;
- all SQLite reads have row caps;
- all git output reads are streaming/capped;
- all blob reads are size-capped before materializing strings;
- no workspace-wide scans;
- no full OpenCode `diffFull` clone in production path.

Required tests:

- large DB fixture exits under budget and reports cap diagnostic;
- huge snapshot diff stops at path/blob cap and imports partial metadata-only with warning;
- in-flight dedupe prevents duplicate backfills for same task;
- cache key includes attribution mode, DB mtime, session id, and evidence version.

### `PRIV-LOG` - Sensitive Logging

Failure shape:

```text
diagnostic log includes oldString/newString, patch body, prompt, or file content
```

Required implementation rule:

- diagnostics use an allowlist, not a denylist;
- local dev log can include ids, counts, relative paths, and short hash prefixes;
- renderer/UI diagnostics must not include prompt text or patch text;
- cloud/remote logging, if any, must strip absolute paths.

Required tests:

- diagnostic JSON does not contain `content`, `patch`, `oldString`, `newString`, `prompt`, `text`, `env`;
- debug log redaction test with realistic toolpart payload;
- path policy test for local-only absolute path fields.

## What This Phase Still Cannot Prove

These are hard limits of the evidence available without a targeted per-tool baseline, runtime hook, or worktree/process isolation.

1. **Same-path external mutation inside the same OpenCode step** - 🎯 9.1   🛡️ 8.0   🧠 7.8 - ~0 LOC in this phase
   Snapshot before/after cannot separate authorship if a formatter, IDE, watcher, or user mutates the same file during the same OpenCode step. The product wording should say “captured in OpenCode step snapshot for strict toolpart path”, not “OpenCode alone authored every byte”.

2. **Old `snapshot:false` sessions cannot become full-text** - 🎯 9.7   🛡️ 9.5   🧠 2.0 - ~0 LOC
   If OpenCode did not record snapshot hashes, we cannot recover before content without guessing. Old sessions remain metadata-only unless another exact evidence source exists.

3. **Non-git projects cannot use OpenCode snapshot gitdir** - 🎯 9.4   🛡️ 9.1   🧠 3.0 - Variant 2, ~1600-3200 LOC
   OpenCode snapshots are gated by `project.vcs === 'git'`. Non-git full diff needs targeted baseline, not this snapshot reader.

4. **Snapshot objects can be cleaned after SQLite survives** - 🎯 8.8   🛡️ 8.7   🧠 5.0 - ~150-300 LOC diagnostics/tests
   SQLite rows may outlive snapshot objects. This phase must degrade to metadata-only and must not claim stable no-changes.

5. **Live model/tool smoke depends on auth and provider behavior** - 🎯 8.5   🛡️ 8.4   🧠 6.5 - ~250-500 LOC harness
   Auth-independent fixtures prove parsing and ledger semantics, but final 9.5+ confidence requires a real OpenCode process that produces a write/edit/patch part with snapshot hashes.

6. **OpenCode dev branch can change underneath us** - 🎯 8.3   🛡️ 8.6   🧠 5.5 - ~150-350 LOC sentinel
   Local source checked earlier was `ea3c6c34811de792ba6870766dd0a36f3a392bc6`, while remote `refs/heads/dev` later reported `2c2fc3499b3723a0595e1666b97207043913f2a8`. The implementation must not rely on one checkout as a permanent API.

## Stop-Ship / Kill Criteria

Because there is no feature flag and no legacy default, these conditions should block merge until fixed.

1. UI auto-backfill imports any OpenCode file event without delivery context in strict mode.
2. Full-text event is produced from `patch.files` alone.
3. Snapshot reader uses `git show <tree>:<path>` in production evidence path.
4. Metadata-only and full-text rows for the same source event both appear in UI.
5. A persisted accept/reject decision survives evidence upgrade.
6. Binary, large, missing-before, missing-snapshot, or ignored-file event enables automatic apply/reject.
7. Unsupported OpenCode schema is displayed as clean “No changes”.
8. Missing snapshot gitdir is displayed as clean “No changes”.
9. A large fixture exceeds configured time/memory caps without a diagnostic.
10. Diagnostics contain prompt text, patch text, old/new strings, file content, tokens, or env vars.
11. Non-OpenCode agents change behavior or fail existing ledger tests.
12. Windows path fixtures fail for drive-case, separators, reserved names, backslashes, or long ids.

If any of these happen:

```text
do not merge
fix the proof path or downgrade to metadata-only
add a regression fixture before retrying
```

## Version Drift Sentinel

OpenCode is not our codebase, and its internal storage is not a guaranteed public API. The bridge needs a small sentinel layer that detects whether the current OpenCode history shape still matches what the adapter knows.

Sentinel inputs:

- OpenCode binary version if available;
- SQLite tables and columns for `project`, `session`, `message`, `part`;
- sample bounded `part` JSON shapes for supported toolparts;
- existence of `step-start.snapshot` and `step-finish.snapshot` fields;
- project `worktree` and `vcs` fields;
- snapshot gitdir existence derived from profile data dir, project id, and worktree hash;
- adapter version and parser version.

Sentinel output:

```ts
type OpenCodeSchemaSentinelResult = {
  readonly supported: boolean
  readonly adapterVersion: number
  readonly opencodeVersion?: string
  readonly sourceShapeFingerprint: string
  readonly tableChecks: Record<string, 'ok' | 'missing' | 'unsupported'>
  readonly toolpartChecks: Record<string, 'ok' | 'unknown' | 'absent'>
  readonly snapshotChecks: {
    readonly hasStepStartSnapshotField: boolean
    readonly hasStepFinishSnapshotField: boolean
    readonly gitdirStatus: 'present' | 'missing' | 'not-git' | 'unknown'
  }
  readonly diagnostics: OpenCodeBridgeDiagnostic[]
}
```

Behavior:

- unsupported sentinel result blocks full-text import;
- if strict toolpart path is still proven, metadata-only may still import;
- unsupported sentinel is not cached as no-changes;
- sentinel diagnostics must be visible in dev logs and optionally in UI diagnostics;
- sentinel must run on bounded samples only, never full DB.

Tests:

- current fixture returns supported;
- missing `part` table returns unsupported;
- `step-start` rows without snapshot field return unsupported for snapshot evidence but not for metadata fallback;
- unknown write/edit shape returns unsupported toolpart check and no broad scan;
- changed sourceShapeFingerprint invalidates previous `no-history` cache.

## Dev Diagnostics Contract

The goal is to debug real reports like “task says files changed but Changes is empty” without exposing content.

Required local dev log event:

```ts
type OpenCodeLedgerBridgeDebugEvent = {
  readonly event: 'opencode-ledger-backfill'
  readonly taskId: string
  readonly teamName?: string
  readonly memberName?: string
  readonly laneId?: string
  readonly sessionId?: string
  readonly messageId?: string
  readonly sourcePartId?: string
  readonly attributionMode: 'strict-delivery' | 'compatible'
  readonly evidenceMode: 'metadata-only' | 'snapshot-full-text' | 'diagnostic-only'
  readonly outcome:
    | 'imported'
    | 'upgraded'
    | 'duplicates-only'
    | 'no-attribution'
    | 'no-history'
    | 'unsupported-shape'
    | 'snapshot-missing'
    | 'manual-only'
    | 'error'
  readonly counts: {
    readonly deliveryRecords: number
    readonly candidateSessions: number
    readonly candidateParts: number
    readonly supportedToolparts: number
    readonly snapshotWindows: number
    readonly importedEvents: number
    readonly upgradedEvents: number
    readonly skippedEvents: number
  }
  readonly timingsMs: {
    readonly sqliteRead: number
    readonly snapshotDiff: number
    readonly blobRead: number
    readonly ledgerWrite: number
    readonly total: number
  }
  readonly diagnostics: Array<{
    readonly code: string
    readonly path?: string
    readonly hashPrefix?: string
    readonly count?: number
  }>
}
```

Explicitly forbidden in this event:

```text
file contents
patch body
prompt text
assistant text
oldString
newString
full tool input
full tool output
env
tokens
provider auth details
```

Cache policy for diagnostic outcomes:

| Outcome | Cache | Reason |
| --- | --- | --- |
| `imported` | stable by ledger generation | ledger now has source of truth |
| `upgraded` | stable by ledger generation | visible row changed generation |
| `duplicates-only` | short cache only if candidate parts existed | avoid repeat work, but do not hide later writes |
| `no-attribution` | short cache, invalidated by delivery ledger mtime | delivery can arrive late |
| `no-history` | short cache, invalidated by DB mtime | OpenCode can write after UI opens |
| `unsupported-shape` | cache by sourceShapeFingerprint only | new version may become supported |
| `snapshot-missing` | very short retry if session active, stable degraded if old | objects can appear shortly after write |
| `error` | no stable cache | avoid sticky false negatives |

## Reviewability Matrix

This matrix should drive both UI presentation and apply/reject behavior.

| Evidence | Before Text | After Text | UI Diff | Full Reject | Partial Reject | Accept |
| --- | --- | --- | --- | --- | --- | --- |
| exact ledger text | yes | yes | text diff | allowed with hash guard | allowed via inverse patch with hash guard | allowed |
| snapshot full-text | yes | yes | text diff | allowed with hash guard | allowed via inverse patch with hash guard | allowed |
| metadata-only write | no | maybe | metadata row | manual-review-required | manual-review-required | mark-reviewed only |
| metadata-only edit | no | maybe | metadata row | manual-review-required | manual-review-required | mark-reviewed only |
| binary/large | no | no | metadata row | manual-review-required | manual-review-required | mark-reviewed only |
| missing snapshot object | no | maybe | metadata row + diagnostic | manual-review-required | manual-review-required | mark-reviewed only |
| unsupported shape | no | no | diagnostic-only | no file action | no file action | no file action |
| no delivery context | no | no | diagnostic-only | no file action | no file action | no file action |

Do not use the same icon or count semantics for diagnostic-only and real file changes. `has_changes` should mean file events exist. `needs_attention` should not masquerade as a file change count.

## Manual QA Checklist For Real Teams

These manual cases are not a replacement for automated tests, but they catch product-level regressions before merging without a feature flag.

1. Old OpenCode team created before snapshot default:
   - expected: metadata-only or diagnostic, no false “No changes” if toolparts prove paths;
   - no full-text diff claim.

2. New OpenCode team with snapshot default:
   - create file;
   - edit file;
   - delete file;
   - apply_patch add/update/delete;
   - expected: full-text where snapshot objects exist, metadata-only for unsupported/large/binary.

3. OpenCode task opened while agent is still running:
   - expected: loader/backfill can show metadata-only first;
   - later snapshot upgrade does not duplicate rows;
   - old decisions reset.

4. Missing snapshot gitdir:
   - remove/copy fixture snapshot store out of the way;
   - expected: metadata-only/manual-review with diagnostic, not empty state.

5. Same path edited twice in one task:
   - expected: one coherent final visible row or two clearly separate source events if ledger identity proves both;
   - no duplicate metadata/full-text pair.

6. Same file edited by two OpenCode members:
   - expected: each task only sees its strict delivery-matched source part;
   - no cross-member attribution.

7. Non-OpenCode agent task:
   - expected: existing exact ledger behavior unchanged;
   - no OpenCode backfill diagnostics pollute normal tasks.

8. Windows path fixture:
   - reserved names, backslashes, drive-case, long ids, unicode path;
   - expected: safe artifact paths, correct relative path display, no outside-workspace import.

## Fresh Source Drift And Current-Code Drilldown

This pass checked the fresh OpenCode remote `origin/dev` after the earlier source read. Between the inspected commit `ea3c6c34811de792ba6870766dd0a36f3a392bc6` and fresh `origin/dev` `2c2fc3499b3723a0595e1666b97207043913f2a8`, the relevant snapshot/session diff was small:

```text
M packages/opencode/src/session/projectors.ts
M packages/opencode/src/session/session.sql.ts
M packages/opencode/src/session/session.ts
```

The direct schema delta seen in `session.sql.ts`:

```text
session.path: text()
```

Snapshot storage code, processor snapshot writes, and message part snapshot fields did not change in this checked delta. That is good, but the new `session.path` column is a useful warning: OpenCode session/project identity is evolving, so the bridge must be additive-compatible and must not treat unknown columns as failure.

### Drift Implications

| Drift Surface | Risk | Required Response |
| --- | --- | --- |
| new `session.path` column | future OpenCode may split display path, launch path, and working directory | sentinel must allow extra columns and record `session.path` as diagnostic context |
| `session.directory` semantics change | snapshot diff cwd can be wrong | tests must cover `directory !== project.worktree` and `path` present |
| project/session projector changes | app may read summarized state differently | bridge must read raw SQLite tables, not projected summary state |
| snapshot code unchanged today | current plan remains viable | still require version/source-shape fingerprint |

Recommended sentinel behavior:

```text
required columns missing -> unsupported shape
extra columns present -> supported with sourceShapeFingerprint change
session.path present -> include in diagnostics, but do not use as gitdir hash input
directory/path/worktree conflict -> no full-text snapshot upgrade until fixture proves intended semantics
```

Tests:

- schema with extra `session.path` remains supported.
- `session.path` differs from `session.directory`, bridge keeps using `session.directory` for snapshot diff cwd unless source proof changes.
- `project.worktree` remains the only hash input for snapshot gitdir.
- missing `session.directory` blocks snapshot full-text, even if `session.path` exists.

## Current Implementation Weak Spots To Burn Down

These risks come from the current local code, not from abstract design. They should become implementation checklist items.

### C1 - Production Still Has `snapshotBoundary`

Current code path:

```text
OpenCodeLedgerBridgeService -> getSnapshotBoundaryForRecord()
OpenCodeChangeEvidenceEnricher -> snapshotProvider.readBoundaryEvidence()
```

Risk:

```text
new session-part snapshot reader is added
old delivery-boundary snapshot path still runs in some mode
two evidence systems disagree or produce duplicate rows
```

Required change:

- remove `readBoundaryEvidence` from production OpenCode auto-backfill;
- keep any old boundary field only as ignored legacy metadata;
- `OpenCodeChangeEvidenceEnricher` should either be deleted or narrowed to non-snapshot chain/materialization helpers;
- tests should assert default UI and CLI paths cannot request `snapshot-auto` boundary mode.

Acceptance test:

```text
mock provider with readBoundaryEvidence throws
default OpenCode backfill still succeeds through session evidence
```

### C2 - SQLite Reader Orders Rows By Time First

Current reader queries:

```sql
order by time_created asc, id asc
```

Risk:

```text
same timestamp parts
part id ordering proves actual order
window pairing uses wrong sequence if time is primary
```

Required change:

- raw query can stay broad, but snapshot window building must regroup parts by `message_id`;
- inside one message, order by `part.id`;
- if `part.id` is missing, duplicated, or not sortable, no snapshot full-text.

Acceptance test:

```text
same time_created rows inserted in reverse order
window builder still pairs start/tool/finish by id
```

### C3 - Schema Assert Does Not Yet Validate Session/Project

Current reader validates only `message` and `part`. Snapshot bridge needs:

```text
session.project_id
session.directory
session.version
project.worktree
project.vcs
```

Risk:

```text
message/part rows look supported
snapshot reader later lacks project identity
code falls back to workspaceRoot and computes wrong snapshot gitdir
```

Required change:

- sentinel validates required session/project columns before full-text snapshot evidence;
- missing session/project identity means metadata-only fallback, not workspaceRoot guessing;
- extra columns like new `session.path` are allowed.

Acceptance test:

```text
DB has message/part but missing project.worktree
strict toolpart path imports metadata-only
full-text snapshot is blocked with unsupported-shape diagnostic
```

### C4 - `sourceImportKey` Is Too Easy To Overload

Current key shape:

```text
opencode + sessionId + partId + normalizedPath.comparisonKey
```

Risk:

```text
same source part emits two operations for same path
metadata event and full-text upgrade collide incorrectly
operation/source tool differs but key is same
```

Required change:

- define ledger event identity and projection identity separately;
- event identity can include evidence generation;
- projection identity must group exactly one visible row per source event;
- if one part/path has multiple operations, block full-text upgrade unless a composer proves the final lifecycle chain.

Candidate types:

```ts
type OpenCodeSourceEventIdentity = {
  sessionId: string
  messageId: string
  partId: string
  tool: 'write' | 'edit' | 'apply_patch'
  relativePath: string
}

type OpenCodeEvidenceIdentity = OpenCodeSourceEventIdentity & {
  operation: 'create' | 'modify' | 'delete'
  evidenceKind: 'metadata-only' | 'snapshot-full-text'
  beforeSha256?: string
  afterSha256?: string
}
```

Acceptance tests:

- same part/path cannot create two visible rows unless operation chain is explicitly represented.
- metadata-only then snapshot-full-text becomes one projected visible row.
- operation mismatch blocks upgrade.

### C5 - Current Disk Materialization Is Manual-Only But Still Can Mislead

Current metadata-only path reads current disk state after the fact:

```text
readMetadataOnlyDiskState(filePath)
```

Risk:

```text
OpenCode touched file
external writer changes file before backfill
metadata-only afterState hash belongs to external writer
```

Because this stays manual-only, it is not an apply/reject safety bug, but it can still confuse users.

Required change:

- mark after-fact disk materialization as `evidenceProof: metadata-only-fallback`;
- attach diagnostic `after-state-read-after-fact`;
- never upgrade an after-fact disk state to full-text unless snapshot object evidence independently proves before/after;
- UI should label it manual review, not precise diff.

Acceptance test:

```text
metadata-only path current disk hash differs from snapshot after hash
snapshot hash wins if full evidence is valid
otherwise manual-only diagnostic remains
```

### C6 - Unsupported Toolpart Shape Can Be Too Fatal Or Too Quiet

Current validation can mark the whole history unsupported if a supported tool name has an unexpected shape.

Risk:

```text
one malformed write row exists
other valid toolparts in same session are skipped
or unsupported shape is cached as clean no-history
```

Required rule:

- malformed required schema for tables is session-level unsupported;
- malformed individual toolpart is row-level skipped with diagnostic;
- if all supported toolparts are malformed, outcome is `unsupported-shape`, not `no-history`;
- cache by DB fingerprint + sourceShapeFingerprint, not by task only.

Acceptance tests:

- one bad write row and one good write row imports the good row.
- all write rows malformed returns unsupported-shape diagnostic.
- unsupported-shape cache invalidates when DB mtime/WAL mtime changes.

### C7 - Strict Delivery Record Matching Can Be Too Narrow During Races

Current strict record collection requires:

```text
laneId
runtimeSessionId
deliveredUserMessageId or inboxMessageId
exact single task ref
```

This is correct for safety, but during live runs the delivery file can lag behind OpenCode SQLite.

Risk:

```text
UI opens changes immediately
delivery context not written yet
backfill returns no-attribution
result cached too long
user keeps seeing empty changes
```

Required change:

- `no-attribution` should be short-lived and invalidated by delivery ledger mtime;
- active/running OpenCode member should keep retryable state;
- once delivery context appears, strict backfill should rerun.

Acceptance tests:

- first call without delivery context returns no-attribution and is not stable cached.
- second call after delivery context appears imports events.
- active session no-attribution does not remove existing ledger changes.

### C8 - Non-OpenCode Regression Boundary

Risk:

```text
shared ledger reader/apply code changes for OpenCode evidence upgrade
Claude Code, Codex, shell, PowerShell task changes regress
```

Required change:

- new OpenCode snapshot fields are optional and source-scoped;
- default exact ledger apply/reject tests for non-OpenCode must pass unchanged;
- no OpenCode diagnostic should appear for tasks whose provider is not OpenCode.

Acceptance tests:

- exact Edit create/modify/delete fixtures unchanged.
- shell snapshot fixture unchanged.
- PowerShell source mapping unchanged.
- UI reader ignores OpenCode-only fields on non-OpenCode bundle.

## UI Projection And Review Risk Drilldown

The orchestrator can write correct evidence and the product can still be wrong if the desktop reader/store projects it incorrectly. These risks belong in the plan because the user-visible bug is “Changes is empty”, “Changes shows zero”, or “manual review is confusing”, not just “journal event missing”.

### U1 - Summary-Only Backfill Race

Current UI flow can request `summaryOnly` first, enqueue OpenCode backfill in the background, and then later load details.

Risk:

```text
summaryOnly request sees no ledger bundle
OpenCode backfill starts but details dialog opens before it finishes
UI caches no_changes or shows stale 0
```

Required behavior:

- summary-only OpenCode backfill should mark a retryable loading state, not a stable empty result;
- the Changes section can show loader while backfill is in flight;
- `no-history`, `no-attribution`, and `snapshot-missing` must have short TTLs and be invalidated by DB, WAL, delivery ledger, and bundle freshness changes;
- details load must re-read ledger after backfill promise resolves, not trust pre-backfill summary.

Acceptance tests:

- first summary returns empty while backfill is in flight, second details call sees imported ledger.
- cached `0` count is replaced by loader during in-flight OpenCode backfill.
- stale no-changes cache is invalidated when bundle freshness file appears.

### U2 - Presence State Confuses Diagnostics With Changes

Risk:

```text
diagnostic-only outcome becomes has_changes
button opens Changes
dialog says No file changes recorded
```

Required behavior:

- `has_changes` means file events exist;
- `needs_attention` means diagnostics/warnings exist without file events;
- diagnostic-only should not increment file count;
- old warning-only presence should not reuse the Changes icon/count.

Acceptance tests:

- diagnostic-only OpenCode unsupported-shape does not show file count.
- metadata-only file event shows Changes with manual-review row.
- warning-only notice opens diagnostics path, not empty diff path.

### U3 - Review Key And Decision Staleness

Current UI stores file and hunk decisions under `changeKey`/review keys. Snapshot upgrade can change content after a decision was made.

Risk:

```text
user rejects hunk on metadata/partial event
snapshot upgrade changes snippets and hashes
old reject decision remains selected and applies to new content
```

Required behavior:

- review key must include evidence kind, before hash, after hash, operation, sourcePartId, and relation identity;
- metadata-only to full-text upgrade must clear or quarantine old file/hunk decisions;
- if a row changes `reviewability`, persisted decisions must be invalidated;
- file path aliases should not resurrect stale decisions.

Acceptance tests:

- metadata-only decision is cleared when row becomes snapshot full-text.
- same path but different sourcePartId does not reuse hunk decisions.
- same sourcePartId but changed before/after hash invalidates hunk context hashes.
- rename/copy grouped decisions stay scoped to relation identity.

### U4 - Apply/Reject Strictness Regression

Risk:

```text
snapshot full-text event flows through legacy snippet-level reject
conflict guard is bypassed or weak
```

Required behavior:

- ledger-native apply/reject path handles snapshot full-text the same as exact ledger full-text;
- reject requires current disk hash equals expected after hash;
- partial reject uses inverse patch only when full before/after text is available and current hash matches;
- metadata-only, binary, missing snapshot, missing before, unsupported shape remain `manual-review-required`.

Acceptance tests:

- full reject snapshot modify restores before only when current hash matches after.
- current hash mismatch returns `conflict`.
- partial reject metadata-only returns `manual-review-required`.
- unsupported-shape cannot create apply/reject action.

### U5 - Ledger Reader Bundle Projection Hides Stronger Evidence

Risk:

```text
journal has metadata-only event then snapshot upgrade event
summary bundle projection keeps older metadata event
UI stays manual-review despite full evidence
```

Required behavior:

- projection chooses strongest valid evidence for same source event;
- stronger evidence wins only if identity matches exactly;
- latest timestamp alone must not override stronger evidence with weaker metadata;
- bundle must expose enough provenance for UI to explain why a row is full-text or manual-only.

Acceptance tests:

- metadata-only then snapshot full-text projects full-text.
- snapshot full-text then later duplicate metadata-only keeps full-text.
- mismatched sourcePartId produces two separate diagnostics or blocks projection, not silent replacement.

### U6 - Async Result Ordering

Risk:

```text
slow old backfill returns after fast new backfill
store overwrites new full-text result with old empty/manual result
```

Required behavior:

- in-flight summary/details calls carry generation tokens;
- UI drops stale async results if a newer request/version exists;
- backfill cache key includes attribution mode, evidence mode, DB fingerprint, delivery fingerprint, and ledger generation;
- persisted cache must not outlive ledger freshness changes.

Acceptance tests:

- delayed stale no-history result cannot overwrite later imported result.
- delayed metadata-only result cannot overwrite later full-text result.
- forceFresh bypasses OpenCode backfill cache.

### U7 - File Content Resolver Mislabels Synthetic Empty Content

Risk:

```text
create/delete uses synthetic empty side for display
review applier treats synthetic empty as real before/after content
```

Required behavior:

- `synthetic-empty-side` is display-only;
- apply/reject uses ledger `beforeState`/`afterState` and content availability, not just displayed strings;
- missing before content never becomes real empty string for reject.

Acceptance tests:

- create display original empty but reject delete only if ledger proves create and hash matches.
- delete display modified empty but restore only if real before text exists.
- missing before with synthetic empty returns `manual-review-required`.

### U8 - Worktree Path Targeting

Risk:

```text
centralized ledger stores worktree filePath
UI normalizes display path to main repo path
apply/reject mutates main repo instead of teammate worktree
```

Required behavior:

- review decisions use absolute ledger `filePath` as target;
- display path can be relative, but mutation target must stay worktree path;
- worktree badge/path must be preserved in bundle and UI state;
- centralized project dir never becomes mutation root.

Acceptance tests:

- worktree fixture apply/reject changes only worktree file.
- same relative path in main and worktree does not target main.
- Windows drive-case normalization preserves the actual target path.

## Ledger Artifact And Durability Risk Drilldown

### L1 - Journal Append And Bundle Generation Race

Risk:

```text
event appended
bundle rebuild starts
another event appended
bundle writes summary missing the second event but freshness looks current
```

Required behavior:

- bundle generation records journal stamp before and after rebuild;
- if stamp changes during rebuild, mark partial or retry;
- freshness file must match bundle journal stamp;
- reader must rebuild from journal if freshness/bundle stamp mismatches.

Acceptance tests:

- append during rebuild does not produce stable stale bundle.
- freshness points to old stamp, reader falls back to journal rebuild.
- bundle write failure leaves readable journal and partial diagnostic.

### L2 - Upgrade Event Idempotency

Risk:

```text
same OpenCode source event is imported multiple times
journal grows duplicate full-text events
UI duplicates rows or line counts inflate
```

Required behavior:

- event idempotency key separates raw event append id from projection identity;
- duplicate same evidence becomes duplicates-only without line count growth;
- stronger evidence can append an upgrade event, but projection shows one row;
- upgrade event must reference prior source identity.

Acceptance tests:

- same strict backfill run twice imports once.
- same metadata-only fallback then same metadata-only fallback remains one visible row.
- metadata-only then stronger snapshot event increments journal but not visible row count.

### L3 - Blob Store Integrity

Risk:

```text
bundle references before/after blob
blob missing, truncated, or hash mismatch
UI shows wrong content or crashes
```

Required behavior:

- reader verifies blob sha256 and size before using content;
- hash mismatch downgrades to metadata-only with warning;
- missing blob does not remove file row;
- no content should be reconstructed from current disk as historical blob.

Acceptance tests:

- missing before blob becomes metadata-only/manual-review.
- corrupt blob produces diagnostic and no text diff.
- after blob hash mismatch does not show text diff.

### L4 - Artifact Path Encoding Compatibility

Risk:

```text
old artifact name uses encodeURIComponent(taskId)
new safe encoder hashes reserved/long task ids
reader only checks one path
```

Required behavior:

- reader checks both safe and legacy artifact path candidates;
- writer uses safe path only;
- migrated/old tasks remain readable;
- no path segment can be Windows reserved or too long.

Acceptance tests:

- legacy bundle still reads.
- long task id safe bundle reads.
- reserved task id like `CON` or `LPT1` does not create invalid path.

### L5 - Notice-Only Versus Empty Files

Risk:

```text
journal has notices only
bundle files empty
UI treats as no changes and discards warnings
```

Required behavior:

- reader returns notices even with zero files;
- presence state becomes needs_attention, not has_changes;
- details view can show diagnostics panel;
- no file actions exist.

Acceptance tests:

- multi-scope skipped notice appears with zero files.
- recovered journal notice appears with zero files.
- empty clean task remains no_changes without notice.

## Platform And Filesystem Risk Drilldown

### P1 - Windows And Case-Colliding Paths

Risk:

```text
OpenCode snapshot has Foo.ts and foo.ts
Windows UI/workspace treats them as same file
projection merges or applies wrong row
```

Required behavior:

- case-colliding paths in same session are manual/diagnostic or skipped for full-text;
- path comparison uses platform-aware normalization;
- actual mutation target remains original absolute path.

Acceptance tests:

- `Foo.ts` and `foo.ts` fixture on Windows path style blocks full-text projection.
- POSIX fixture can keep both if workspace path style is POSIX and not case-insensitive.

### P2 - Symlink, Junction, Submodule, And Directory Paths

Risk:

```text
toolpart path points to symlink, junction, submodule, directory, or gitlink
snapshot object mode is not normal file
```

Required behavior:

- normal files only for full-text;
- symlink target text is not treated as file content;
- submodule/gitlink and directory changes are metadata-only/manual-review;
- chmod-only is diagnostic/metadata-only.

Acceptance tests:

- symlink change stays metadata-only.
- submodule pointer change stays metadata-only.
- chmod-only event does not show fake text diff.

### P3 - Unicode And Path Normalization

Risk:

```text
macOS stores path as decomposed unicode
OpenCode SQLite/toolpart path uses composed unicode
comparison collapses two different names or misses same name
```

Required behavior:

- path normalization must be explicit and tested;
- source identity should use normalized comparison key and original display path separately;
- if two raw paths collapse to same comparison key, block full-text.

Acceptance tests:

- NFC/NFD same-looking paths do not cross-upgrade.
- raw display path is preserved in UI.

## Security And Privacy Risk Drilldown

### S11 - Snapshot Git Store Trust Boundary

Risk:

```text
malicious or corrupted OpenCode data dir points reader outside profile data
```

Required behavior:

- snapshot gitdir is computed, never read from DB;
- computed gitdir must be inside managed profile data dir;
- git commands must pass paths as args, never shell-concatenated;
- no environment variable from toolpart/prompt can influence gitdir.

Acceptance tests:

- project id with path separators is rejected or safely encoded.
- profileRootKey escape is rejected.
- gitdir outside profile data dir blocks full-text.

### S12 - Diagnostic Data Exfiltration

Risk:

```text
debug event includes patch body, prompt, file content, env, or absolute path in cloud log
```

Required behavior:

- local dev log uses allowlisted fields;
- any remote/cloud log strips absolute paths and ids not needed for telemetry;
- diagnostics in bundle are human-actionable but content-free.

Acceptance tests:

- serialization redaction test with real OpenCode toolpart payload.
- no `content`, `patch`, `oldString`, `newString`, `prompt`, `text`, `env` keys in diagnostic JSON.

## Decision Table For Critical Remaining Work

1. **Implement all C/U/L/P/S guards before default-on** - 🎯 8.8   🛡️ 9.4   🧠 9.0 - ~4200-7000 LOC.
   Highest safety. This is the right path if we remove legacy/default feature flags and want default-on behavior immediately.

2. **Implement snapshot reader first, leave projection upgrade out** - 🎯 7.3   🛡️ 8.5   🧠 6.7 - ~2400-4200 LOC.
   Safer implementation slice, but user-visible value is weaker because metadata-first rows can remain manual-only until projection upgrade lands.

3. **Pause snapshot full-text and improve diagnostics/cache only** - 🎯 6.4   🛡️ 8.9   🧠 4.8 - ~700-1400 LOC.
   Lowest risk short-term, but it does not solve Cursor-like diffs. Useful only if live OpenCode smoke keeps failing.

Recommendation remains option 1, but only with the stop-ship gates below and with non-OpenCode regression tests required in both repos.

## Operational Rollout And Migration Risk Drilldown

This section is about the path from “code exists” to “new real teams actually show correct Changes”. It is separate from parser correctness.

### O1 - Managed Profile Still Writes `snapshot:false`

Current orchestrator code in `buildManagedConfig` writes:

```ts
snapshot: false
```

Risk:

```text
session snapshot reader ships
managed OpenCode profile keeps disabling snapshots
new app-created teams still produce metadata-only or empty Changes
```

Required change:

- change managed profile config for new sessions to `snapshot: true`;
- ensure managed config fingerprint changes so existing healthy hosts are not silently reused with stale config;
- after config change, host restart/adoption path must observe new resolved config fingerprint;
- old sessions remain metadata-only, but newly launched sessions should produce `step-start.snapshot` and `step-finish.snapshot`.

Acceptance tests:

- `buildManagedConfig` returns `snapshot: true`.
- managed config fingerprint changes when snapshot default changes.
- `ensureHost` does not keep using a healthy host with old resolved config if profile config fingerprint changed.
- new session fixture with managed profile has snapshot parts.

### O2 - UI Auto-Backfill Still Sends `chain-only`

Current UI code has:

```ts
OPEN_CODE_AUTO_BACKFILL_EVIDENCE_MODE = 'chain-only'
```

Risk:

```text
orchestrator snapshot reader works
UI never asks for it
manual CLI succeeds but app still shows metadata-only
```

Required change:

- default UI backfill must request the new session evidence path, not `chain-only`;
- old `chain-only` should not remain a hidden default if user requested no feature flags;
- CLI should still have a diagnostic/dry-run mode, but production UI uses same default path as users.

Acceptance tests:

- `ChangeExtractorService` sends new default evidence mode.
- summary-only background backfill sends same mode as details load.
- test fails if `chain-only` literal remains as the UI default.

### O3 - Existing Healthy Host Reuse Can Hide Config Changes

Current host key includes:

```text
projectPath::profileRootKey::projectBehaviorFingerprint::managedConfigFingerprint
```

Risk:

```text
snapshot config changes
existing host remains healthy with old config
new prompts go through old snapshot:false process
```

Required behavior:

- host key/fingerprint must change when managed config changes;
- persistent host adoption must verify resolved config fingerprint, not just host liveness;
- if resolved config fingerprint mismatches, old host should not be used for new managed session.

Acceptance tests:

- old persistent host with snapshot:false is not adopted for snapshot:true profile.
- config fingerprint mismatch creates or reconnects to correct host.
- no duplicate host leak on failed restart.

### O4 - Existing Teams And Old Tasks Cannot Be Magically Fixed

Risk:

```text
user opens old team created before snapshot:true
expects full diff after app update
session has no snapshot parts
```

Required product behavior:

- old tasks can improve only through Variant 1 metadata/toolpart fallback;
- UI copy should say manual review/metadata-only when before content is unavailable;
- no backfill retry loop should keep hammering old snapshot:false sessions.

Acceptance tests:

- old fixture with no snapshot parts returns metadata-only or diagnostic, not repeated transient retry.
- old task with proven toolpart path shows manual-review file row.
- old task without proven path shows diagnostics/no changes accurately.

### O5 - Rollout Without Feature Flag Still Needs Code Rollback Path

The user explicitly does not want feature flags. That is fine, but rollback must be executable as a code rollback.

Risk:

```text
snapshot:true causes large-repo pressure or OpenCode regression
no feature flag exists
team cannot quickly disable behavior without reverting
```

Required behavior:

- all schema additions are optional;
- old readers ignore new fields;
- reverting managed config to `snapshot:false` should not break existing ledger bundles;
- no migration should rewrite old journals destructively.

Acceptance tests:

- new bundles with snapshot fields are readable by current reader as optional fields.
- old bundles without snapshot fields are readable by new reader.
- code rollback leaves metadata-only/manual-review safety intact.

### O6 - Auth And Live Smoke Are Operational Gates, Not Unit Tests

Risk:

```text
fixture tests pass
real OpenCode model flow fails auth or emits different toolpart sequence
release claims high confidence incorrectly
```

Required behavior:

- auth-independent fixture E2E is merge gate for parser/ledger correctness;
- real OpenCode live smoke is release confidence gate;
- if live smoke gets 401, confidence stays below 9.5 and plan must say why;
- live smoke should create a tiny git repo, run one write and one edit, then verify SQLite parts and snapshot gitdir.

Acceptance tests:

- live smoke can be skipped in CI without failing normal PR if no credentials;
- local release checklist records live smoke result;
- failed auth does not mark snapshot bridge unsupported, but blocks high-confidence claim.

## SQLite, WAL, And Concurrency Risk Drilldown

### DB1 - WAL Fingerprint Can Change After A Consistent Read

Current reader fingerprints DB and WAL mtime/size. It already records when the file changed while a transaction snapshot was read.

Risk:

```text
reader sees a consistent old transaction
caches no-history or no-window
OpenCode commits step-finish immediately after
```

Required behavior:

- if DB or WAL changed during read, any negative result must be short-cache only;
- positive full-text result can be cached by snapshot hashes and source fingerprint;
- negative results from active sessions should remain retryable.

Acceptance tests:

- DB changes during read and no window found returns retryable diagnostic.
- DB changes during read and full window found still imports if snapshot objects verify.
- negative cache invalidates on WAL mtime/size change.

### DB2 - SQLite Busy Timeout Is A Product Latency Risk

Current reader sets:

```sql
PRAGMA busy_timeout = 1000
```

Risk:

```text
UI opens Changes
OpenCode holds write lock
backfill waits or fails repeatedly
dialog feels stuck
```

Required behavior:

- keep timeout bounded;
- expose retryable `sqlite-busy` diagnostic;
- UI loader should not spin forever;
- no broad fallback scan on busy.

Acceptance tests:

- locked DB returns retryable transient outcome under budget.
- next retry after lock release imports.
- busy result is not cached as stable no-history.

### DB3 - Multi-Message And Compaction Boundaries

Risk:

```text
OpenCode compacts or summarizes session
toolpart and step snapshot parts are split across messages
reader pairs unrelated step-start and step-finish
```

Required behavior:

- snapshot window must be message-local unless source proves cross-message step continuity;
- if toolpart has no message-local window, metadata-only;
- summary_diffs can be diagnostic only, not primary evidence.

Acceptance tests:

- step-start in message A and step-finish in message B does not upgrade.
- compacted session without raw toolpart stays diagnostic/metadata-only.
- summary_diffs alone does not create file event.

## Git Object Reader Risk Drilldown

### G1 - Raw Diff Parser Must Be Exact Or Fail Closed

Risk:

```text
git diff --raw -z output includes status, mode, object id, path
parser accepts malformed or partial record
wrong blob is read
```

Required behavior:

- require full old/new modes and 40-char object ids;
- reject status entries not explicitly supported;
- reject paths outside `session.directory`/`project.worktree` policy;
- malformed record downgrades entire path to metadata-only, not best-effort text.

Acceptance tests:

- truncated raw record fails closed.
- non-40 object id fails closed.
- unsupported status code fails closed with diagnostic.

### G2 - `cat-file --batch` Streaming Can Cross-Wire Blobs

Risk:

```text
request order and response order diverge
wrong content assigned to path
```

Required behavior:

- track requested object id queue explicitly;
- verify response object id equals requested id;
- verify size matches bytes read;
- hash blob content and compare to expected object id semantics when possible;
- any mismatch downgrades affected file.

Acceptance tests:

- fake cat-file response with wrong object id is rejected.
- short read is rejected.
- binary blob does not become text.

### G3 - Snapshot Gitdir Must Be Read-Only

Risk:

```text
bridge accidentally runs git command that mutates OpenCode snapshot store
```

Required behavior:

- only read commands: `git diff`, `git cat-file`, `git rev-parse` if needed;
- no `git add`, `git write-tree`, `git gc`, `git init`, `opencode debug snapshot track`, or `opencode debug snapshot patch` in production;
- production tests should stub process spawn and assert command allowlist.

Acceptance tests:

- snapshot provider command list contains no mutating commands.
- debug CLI commands are used only by live smoke harness, never UI path.

## Real Incident Triage Playbook

When a real team reports empty or wrong Changes, debug in this order:

1. **Is this OpenCode or another provider?**
   - if not OpenCode, do not run OpenCode backfill;
   - inspect normal ledger artifacts.

2. **Does the task have a ledger bundle or journal?**
   - bundle with files means UI projection issue;
   - journal with events but no bundle means bundle/freshness issue;
   - no journal means capture/backfill issue.

3. **Does OpenCode strict delivery context exist?**
   - no context means no-attribution, retryable if task/member active;
   - wrong session/member/task means fail closed.

4. **Does SQLite have supported toolparts?**
   - no supported toolparts means diagnostic, not fake file event;
   - malformed shape means unsupported-shape diagnostic.

5. **Does SQLite have snapshot step window?**
   - no window means metadata-only if path proven;
   - ambiguous window means metadata-only.

6. **Does snapshot gitdir/object exist?**
   - missing object means metadata-only/manual-review;
   - valid object diff can upgrade to full-text.

7. **Does UI show stale result?**
   - compare ledger freshness generation, DB/WAL fingerprint, delivery fingerprint, cache key.

8. **Does apply/reject target the right path?**
   - verify absolute ledger `filePath`, worktree metadata, current disk hash.

Plan requirement:

- add one developer-facing diagnostic command or log summary that prints this chain without content;
- every outcome must map to one of: `file-events`, `metadata-only`, `diagnostic-only`, `no-attribution`, `unsupported-shape`, `transient-error`.

## Risk Scoreboard After This Review

| Area | Current Risk | After Plan If Implemented | Notes |
| --- | ---: | ---: | --- |
| Wrong task attribution | 8/10 | 2/10 | strict delivery + sourcePartId + window proof |
| Empty Changes for real OpenCode edits | 8/10 | 3/10 | snapshot:true + metadata fallback + cache invalidation |
| Unsafe apply/reject | 6/10 | 2/10 | strict hash guards and manual-only unavailable states |
| Duplicate rows after upgrade | 7/10 | 3/10 | projection identity and stronger-evidence projection |
| Large repo perf | 6/10 | 4/10 | still nonzero because OpenCode snapshot indexing cost exists |
| OpenCode version drift | 7/10 | 4/10 | sentinel detects, but external API can still change |
| Windows path correctness | 6/10 | 3/10 | fixtures help, real Windows CI still needed |
| Old snapshot:false teams | 8/10 | 6/10 | cannot recover full diffs, only clearer metadata/diagnostics |
| Non-git OpenCode full diff | 9/10 | 8/10 | needs later targeted baseline |
| Privacy/logging | 5/10 | 2/10 | allowlisted diagnostics |

Remaining uncomfortable risks:

- OpenCode snapshot indexing cost on very large repos is real and cannot be fully proven by unit tests.
- Same-path external mutation inside one OpenCode step remains indistinguishable without targeted baseline or isolation.
- Old `snapshot:false` sessions cannot become Cursor-like full diffs.
- Real live model/tool smoke still depends on auth and provider behavior.

## Evidence State Machine And Illegal Transitions

The next implementation should be written as a state machine, not as a pile of if statements. Most serious bugs are illegal transitions: empty -> no changes too early, metadata -> full-text with the wrong proof, full-text -> metadata downgrade, or decisions surviving content changes.

### Evidence States

| State | Meaning | File Events | Auto Review Actions |
| --- | --- | ---: | --- |
| `no-attribution` | no strict delivery context | 0 | none |
| `no-history` | no relevant OpenCode history found in bounded read | 0 | none |
| `unsupported-shape` | DB/toolpart shape unsupported | 0 | none |
| `toolpath-only` | exact toolpart path proven, no before/after | >= 1 | manual-only |
| `metadata-after` | exact path plus current disk after metadata | >= 1 | manual-only |
| `snapshot-window` | source part is inside one valid snapshot window | candidate | none yet |
| `snapshot-metadata` | snapshot exists but text unavailable or object missing | >= 1 | manual-only |
| `snapshot-full-text` | before/after text proven by snapshot object ids | >= 1 | hash-guarded |
| `exact-chain` | before/after proven from toolpart chain | >= 1 | hash-guarded |
| `diagnostic-only` | warnings without proven file path | 0 | none |

### Allowed Transitions

```text
no-attribution -> no-attribution
no-attribution -> toolpath-only
no-attribution -> snapshot-full-text
no-history -> toolpath-only
no-history -> snapshot-full-text
toolpath-only -> metadata-after
toolpath-only -> snapshot-metadata
toolpath-only -> snapshot-full-text
metadata-after -> snapshot-full-text
snapshot-metadata -> snapshot-full-text
exact-chain -> snapshot-full-text only if identity matches and content proof is stronger
snapshot-full-text -> snapshot-full-text only if same identity and same hashes
```

### Forbidden Transitions

```text
diagnostic-only -> has_changes
unsupported-shape -> no_changes stable cache
metadata-after -> exact-chain without toolpart proof
metadata-after -> snapshot-full-text with different sourcePartId
snapshot-full-text -> metadata-after downgrade
snapshot-full-text -> same row with different hashes without generation bump
any unavailable-before state -> auto reject enabled
any state -> broad filesystem scan
```

Implementation rule:

- store `evidenceState` or enough fields to derive it deterministically;
- every state transition should be covered by unit tests;
- illegal transitions should either throw in tests or emit fail-closed diagnostics in production.

Acceptance tests:

- table-driven test over every allowed transition.
- table-driven test over forbidden transitions.
- metadata event upgraded to full-text increments ledger generation and invalidates review decisions.
- full-text event cannot downgrade to metadata-only in projection.

## Cache Invalidation State Machine

Cache is one of the highest-risk areas because it can convert a transient empty result into a persistent product bug.

### Cache Inputs

Every OpenCode backfill cache key or persisted summary key must include the relevant subset of:

```text
teamName
taskId
memberName/laneId
workspaceRoot
projectDir
attributionMode
evidenceMode
OpenCode db mtime/size
OpenCode wal mtime/size
delivery context fingerprint
ledger freshness journalStamp
adapterVersion
sourceShapeFingerprint
snapshot hashes
```

### Negative Cache Policy

| Outcome | Stable Cache? | TTL | Invalidated By |
| --- | --- | ---: | --- |
| `no-attribution` | no | 1-3 seconds | delivery mtime, active member state, forceFresh |
| `no-history` | no | 1-3 seconds | DB/WAL mtime, active member state, forceFresh |
| `unsupported-shape` | fingerprint-only | 30-120 seconds | DB/WAL mtime, adapterVersion, sourceShapeFingerprint |
| `snapshot-gitdir-missing` | no while active, short when old | 1-10 seconds | snapshot dir appears, DB/WAL mtime |
| `snapshot-object-missing` | no while active, short when old | 1-10 seconds | object appears, DB/WAL mtime |
| `sqlite-busy` | no | 0-1 seconds | next retry |
| `transient-error` | no | 0 seconds | next retry |

Positive cache policy:

- full-text success can be stable by `sourceImportKey + snapshot hashes + blob hashes + adapterVersion`;
- metadata-only fallback can be stable only if source proof and after-state fingerprint are stable;
- duplicate-only can be cached only if candidate event count was positive.

Acceptance tests:

- stale `no-history` cannot hide a later DB append.
- stale `no-attribution` cannot hide a later delivery record.
- unsupported-shape cache invalidates on DB mtime change.
- positive full-text cache survives unrelated delivery file mtime changes.

## Snapshot Retention, Cleanup, And Disk Budget Risk

OpenCode source currently defines:

```text
snapshot gc prune: 7.days
large file limit: 2 * 1024 * 1024
snapshot enabled only when project.vcs === git and config.snapshot !== false
```

Official docs also warn that snapshots can cause slow indexing and significant disk usage on large repositories or projects with many submodules.

Risk:

```text
task completed 10 days ago
SQLite still has snapshot hashes
snapshot object pruned by OpenCode gc
UI opens Changes and expects full diff
```

Required behavior:

- snapshot object missing after prune is a normal degraded state;
- old tasks must keep ledger materialized full-text blobs if we imported them earlier;
- once full-text evidence is imported into our ledger, UI should not depend on OpenCode snapshot store still existing;
- if snapshot was never imported before pruning, degrade to metadata-only/manual-review.

Disk budget policy:

- do not copy whole snapshot stores;
- only materialize ledger blobs for files that are strict-delivery matched;
- cap imported text blob size at ledger cap;
- do not import ignored/large files as text;
- expose warning if OpenCode snapshot store is missing/pruned.

Acceptance tests:

- full-text imported ledger stays readable after deleting OpenCode snapshot gitdir.
- old SQLite snapshot hashes with missing gitdir degrade to metadata-only.
- ignored/large file is metadata-only, not fake no-changes.
- perf fixture with many unrelated snapshot paths imports only candidate paths.

## Snapshot Cost And Large Repo Performance Gates

This feature changes managed OpenCode from `snapshot:false` to `snapshot:true`. That is product-significant because OpenCode itself documents possible slow indexing and disk usage.

Required perf gates:

| Gate | Budget | Failure Behavior |
| --- | ---: | --- |
| UI details backfill default path | under 2 seconds for bounded fixture | show loader + retryable diagnostic, no freeze |
| summary-only background backfill | under 1 second before returning control | enqueue and return loading/retryable state |
| SQLite read | bounded rows, under 500 ms fixture | cap diagnostic |
| raw snapshot diff | bounded bytes/paths, under 1 second fixture | metadata-only/cap diagnostic |
| blob materialization | cap per blob and total bytes | metadata-only for oversized |
| managed OpenCode launch config write | no extra project scan beyond existing behavior metadata | fail launch if config cannot be written |

Stress fixtures:

- 50k SQLite parts, only 1 relevant session.
- 10k snapshot diff paths, only 3 candidate toolpart paths.
- 5MB binary file touched by OpenCode.
- repo with many ignored files.
- submodule-heavy fixture, using fake gitlinks if real submodule setup is too slow.

Stop condition:

```text
if a large fixture forces broad snapshot/session scan, do not merge default-on
```

## OpenCode Config Precedence Risk

Official docs state config files are merged and precedence includes remote, global, custom, project, inline config, managed settings, and macOS managed preferences. Later/higher layers can override earlier layers.

Risk:

```text
our inline managed profile writes snapshot:true
project or managed preference still resolves snapshot:false
we assume snapshots are active
```

Required behavior:

- after host starts, read resolved config and verify effective `snapshot` value;
- delivery context should record whether effective snapshot was true, false, or unknown;
- backfill should trust SQLite snapshot parts, not config intent;
- if config intent says true but no snapshot parts appear, emit diagnostic `snapshot-config-true-but-no-parts`.

Acceptance tests:

- managed config has snapshot true but resolved config false, launch/probe records snapshot-disabled.
- resolved config true and SQLite has snapshot parts, full evidence path runs.
- resolved config unknown never blocks metadata fallback.

## Fixture Generator And Fuzz Strategy

Handwritten fixtures are not enough for this feature because many bugs are parser and projection edge cases.

Required fixture layers:

1. **Minimal deterministic fixtures** - exact known shapes:
   - one write;
   - one edit;
   - apply_patch add/update/delete;
   - missing snapshot;
   - unsupported shape;
   - metadata then full-text upgrade.

2. **Source-shaped OpenCode fixtures** - generated from current OpenCode source assumptions:
   - realistic `session/project/message/part` SQLite tables;
   - snapshot gitdir with actual git tree objects;
   - WAL present and absent variants;
   - `session.path` extra column variant.

3. **Fuzz fixtures** - randomized but bounded:
   - path names with spaces, tabs, newlines, colons, unicode, leading dash;
   - part order permutations;
   - duplicated ids;
   - missing fields;
   - case-colliding paths;
   - mixed valid and malformed toolparts.

4. **Golden UI fixtures**:
   - real orchestrator artifacts copied into UI test fixture directory;
   - no hand-repaired DTOs;
   - expected visible files, diagnostics, reviewability, changePresence.

Acceptance bar:

- every production parser has fuzz tests for malformed inputs;
- every fixture has a manifest explaining expected state and why;
- UI consumes real ledger artifacts, not reconstructed in-memory objects.

## Release And Rollback Playbook Without Feature Flags

No feature flag means the release process needs a concrete code rollback plan.

Release checklist:

1. Merge orchestrator snapshot reader and ledger projection.
2. Merge UI default backfill mode change.
3. Run auth-independent fixture E2E.
4. Run real OpenCode live smoke locally with credentials.
5. Run non-OpenCode regression suite.
6. Run Windows path CI fixture.
7. Open an old snapshot:false team and verify metadata-only messaging.
8. Open a new snapshot:true team and verify full-text diff.

Rollback checklist:

1. Revert UI default evidence mode to safe metadata/toolpart path if needed.
2. Revert managed config `snapshot:true` to `snapshot:false` if OpenCode performance is unacceptable.
3. Keep ledger schema additions optional and readable.
4. Do not delete snapshot-imported ledger blobs.
5. Keep manual-review safety for unavailable evidence.

Important:

- rollback should not remove already imported ledger evidence;
- rollback should only stop new snapshot evidence capture/import;
- old bundles must remain readable after rollback.

## Additional Stop-Ship Gates From This Pass

Add these to the merge gate:

1. Managed OpenCode effective resolved config is not proven to enable snapshots for new sessions.
2. UI still sends `chain-only` as default evidence mode.
3. Snapshot full-text evidence depends on OpenCode snapshot gitdir at UI read time after ledger import.
4. Negative cache can survive DB/WAL or delivery context changes.
5. Full-text projection can downgrade to metadata-only.
6. `snapshot:true` cost has no large-repo/submodule stress fixture.
7. Config precedence can silently force snapshot false without a diagnostic.
8. No fuzz tests exist for raw diff and OpenCode part ordering.
9. Incident diagnostic cannot explain why a real task is empty without reading file contents.
10. Rollback cannot be done by a normal code revert.

## Delivery Provenance Risk Drilldown

OpenCode snapshot evidence is only useful if the task attribution is exact. The most fragile link is the chain:

```text
UI inbox/task event
-> RuntimeDeliveryJournal
-> OpenCodePromptDeliveryLedger
-> OpenCode session/message/part rows
-> snapshot step window
-> ledger event
```

If any link is stale or ambiguous, full-text evidence must not be imported.

### D1 - Delivery Record Status Is Not The Same As Work Completion

Delivery ledger statuses include:

```text
pending
accepted
responded
unanswered
retry_scheduled
retried
failed_retryable
failed_terminal
```

Risk:

```text
status accepted means prompt was accepted by OpenCode
but not necessarily that the toolpart finished or snapshot step finished
backfill runs too early and caches no-history
```

Required behavior:

- `accepted` can authorize a retryable watch, not a stable no-history result;
- `responded` with tool calls can be stronger evidence that the assistant turn exists;
- `unanswered`, `failed_retryable`, and `retry_scheduled` must not produce stable empty changes;
- `failed_terminal` can still have mutations if OpenCode/tool crashed after writing, so strict history should be read if a session/message id exists.

Acceptance tests:

- accepted-without-response returns retryable, not stable no-history.
- failed_retryable with completed write toolpart imports metadata/full evidence.
- failed_terminal with no toolpart returns diagnostic-only, not file event.

### D2 - Runtime Session Recreation Can Split Evidence

Current send flow can recreate a stale OpenCode session before delivery if app MCP is unavailable or the stored session is stale.

Risk:

```text
delivery ledger record starts with old runtimeSessionId
send path recreates session
toolparts are written in new session
backfill filters only old session
```

Required behavior:

- delivery record must store final `runtimeSessionId` used for prompt delivery;
- if a session is recreated, diagnostics must include old and new session ids as metadata;
- strict backfill can inspect only the final session id, unless delivery ledger explicitly records a safe alias chain;
- no broad scan across all member sessions.

Acceptance tests:

- stale session recreated, final session imports changes.
- old session with same task marker is ignored in strict mode.
- alias chain absent means no-attribution, not compatible fallback.

### D3 - PrePromptCursor/PostPromptCursor Are Hints, Not File Evidence

Risk:

```text
cursor range contains the assistant turn
reader assumes all toolparts in range belong to task
```

Required behavior:

- cursor range can narrow candidate messages;
- exact source part still needs delivered message id or observed assistant message id;
- cursor-only evidence cannot create file events in strict UI mode;
- cursor mismatch should be diagnostic, not fallback to broad scan.

Acceptance tests:

- cursor range with two assistant messages does not import without exact message/part proof.
- observedAssistantMessageId narrows to one message.
- missing cursor does not block import if deliveredUserMessageId and sourcePartId are exact.

### D4 - TaskRefs Can Be Too Broad Or Stale

Delivery records store `taskRefs`. A prompt can mention several tasks, related tasks, dependencies, or old comments.

Risk:

```text
taskRefs contains multiple same-team tasks
strict import chooses requested task by display id or first ref
```

Required behavior:

- UI strict mode requires exactly one task ref for the requested task in the relevant delivery record;
- if multiple same-team task refs exist, no full-text import unless the source part is explicitly scoped to the requested task by a stronger marker;
- display id is only a helper, canonical taskId wins.

Acceptance tests:

- two taskRefs in one delivery record blocks strict import.
- display id collision does not import.
- canonical taskId match with unrelated display id uses canonical id or fails closed.

### D5 - Visible Reply Correlation Is Not Change Evidence

Delivery observation can classify visible replies:

```text
relayOfMessageId
direct_child_message_send
plain_assistant_text
```

Risk:

```text
visible reply says "I edited files"
bridge treats it as proof of file changes
```

Required behavior:

- visible reply correlation is useful for task status/logs only;
- file changes require toolpart/path/snapshot evidence;
- natural language claims never create file events.

Acceptance tests:

- assistant text claims edit but no toolpart path -> diagnostic/no file event.
- visible reply plus supported toolpart -> toolpart drives file event.

## Bridge IPC Contract And Versioning Risk Drilldown

The UI talks to the orchestrator through `opencode.backfillTaskLedger`. The current contract still exposes old evidence modes:

```text
off
metadata-only
chain-only
snapshot-probe
snapshot-auto
```

The target design removes legacy/default snapshot boundary behavior, but the contract cannot be changed carelessly.

### I1 - Legacy Evidence Modes Survive As Hidden Behavior

Risk:

```text
UI default changes
but another caller or stale build still sends snapshot-auto
orchestrator runs old boundary provider
```

Required behavior:

- default UI must send new session evidence mode or omit mode to use new default;
- orchestrator should treat legacy `snapshot-auto` as unsupported/deprecated for production full-text, unless command is dry-run/debug-only;
- `chain-only` can exist only for compatible/manual diagnostics, not default UI;
- response should include `adapterVersion` and `effectiveEvidenceMode`.

Acceptance tests:

- non-dry-run UI request with `snapshot-auto` does not invoke boundary provider.
- dry-run compatible request can still report legacy diagnostics if explicitly allowed.
- response exposes effective mode so UI logs prove what ran.

### I2 - UI And Orchestrator Schema Versions Can Drift

Risk:

```text
UI expects new fields
orchestrator old binary returns schemaVersion 1 without evidenceState
UI treats missing fields as success
```

Required behavior:

- response schema remains additive;
- UI must feature-detect capabilities from response, not assume;
- missing new capability means metadata/diagnostic fallback;
- incompatible response shape returns `skipped-capability`, not no-changes.

Acceptance tests:

- old orchestrator response does not crash UI.
- old orchestrator response does not mark no_changes stable.
- new orchestrator response with extra fields is ignored by old-safe reader.

### I3 - Timeout And Partial Output Can Hide Backfill Failure

Current UI bridge has default backfill timeout around tens of seconds. A timeout can happen after the orchestrator already wrote partial ledger artifacts.

Risk:

```text
UI command times out
ledger import actually completed just after timeout
UI caches failure/no-history
```

Required behavior:

- timeout result should trigger immediate ledger freshness re-read before caching empty;
- if freshness changed, UI should use ledger result;
- timeout should not delete or invalidate successful partial artifacts;
- command stdout/stderr caps should not truncate JSON silently.

Acceptance tests:

- command timeout with bundle appearing still shows changes.
- truncated JSON result triggers ledger re-read.
- timeout without bundle stays retryable, not stable no-history.

### I4 - Command CWD And WorkspaceRoot Mismatch

Risk:

```text
bridge command cwd is projectPath
workspaceRoot passed from UI differs from OpenCode project.worktree
snapshot reader computes paths against wrong root
```

Required behavior:

- command `cwd` is not trusted as evidence root;
- snapshot reader uses SQLite `project.worktree` and `session.directory`;
- UI `workspaceRoot` must match or be compatible with OpenCode project identity before full-text upgrade;
- mismatch becomes metadata-only/manual-review.

Acceptance tests:

- UI workspaceRoot points at parent dir, OpenCode project.worktree points at child repo -> full-text blocked or correctly scoped.
- cwd mismatch does not produce outside-workspace file event.

## Runtime Marker And Prompt Injection Risk Drilldown

Structured delivery markers reduce ambiguity, but they also become a protocol surface.

### M1 - Marker Missing Or Stripped By Model/Runtime

Risk:

```text
prompt marker is missing from stored OpenCode user message
strict backfill has no delivery context
```

Required behavior:

- marker absence is no-attribution or compatible/manual-only, not broad UI import;
- delivery ledger record remains primary source if marker is stripped;
- marker is a helper, not single point of failure.

Acceptance tests:

- marker absent but delivery ledger exact -> strict import works.
- marker absent and delivery ledger absent -> no-attribution.

### M2 - Marker Replayed Or Copied By Assistant

Risk:

```text
assistant quotes old marker
reader sees marker in assistant text
wrong task refs imported
```

Required behavior:

- marker parsing is allowed only from delivered user message content or app-owned delivery context file;
- assistant messages are never marker authority;
- marker JSON must match inboxMessageId, teamName, memberName, laneId, and taskRefs.

Acceptance tests:

- assistant quotes marker, strict import ignores it.
- marker with mismatched inboxMessageId is ignored.
- marker with mismatched laneId is ignored.

### M3 - Marker Contains Sensitive Data

Risk:

```text
delivery marker includes prompt text or user content
diagnostics or OpenCode DB stores too much sensitive data
```

Required behavior:

- marker contains ids only: team, member, lane, inboxMessageId, taskRefs;
- no file content, prompt text, user secrets, or full task description;
- diagnostics log marker hash/counts, not marker body.

Acceptance tests:

- marker serializer allowlist test.
- diagnostic redaction test with marker payload.

## Multi-Lane, Multi-Member, And Team Lifecycle Risk Drilldown

### T1 - Same Member Name Across Lanes

Risk:

```text
member bob exists in primary and secondary lane
delivery context matches memberName but not laneId
changes cross-attributed
```

Required behavior:

- laneId is required for strict OpenCode attribution;
- memberName-only match is compatible/manual only;
- UI backfill must pass laneId when known.

Acceptance tests:

- same memberName two lanes, only matching lane imports.
- missing laneId returns no-attribution in strict mode.

### T2 - Team Relaunch Reuses Member Names

Risk:

```text
old team run and new team run share teamName/memberName
runtimeSessionId differs
old delivery record remains active enough to match
```

Required behavior:

- runId/runtimeSessionId must be part of strict matching when available;
- stale run records cannot authorize new session imports;
- delivery ledger retention must not make old responded records active for current run.

Acceptance tests:

- old run delivery record cannot import new session toolpart.
- new run with same memberName imports only new runtimeSessionId.

### T3 - Task Ownership Changes During Work

Risk:

```text
task owner changes from jack to tom
OpenCode backfill filters by current owner
original owner edits vanish
```

Required behavior:

- strict attribution should use delivery record member, not current task owner alone;
- current owner can narrow only when no stronger delivery context exists;
- task changes can have multiple contributors.

Acceptance tests:

- owner changes after delivery, original member changes still show.
- two contributors both appear in ledger scope.

### T4 - Task Deleted Or Recreated With Same Display Id

Risk:

```text
old task deleted
new task reuses short display id
delivery/backfill uses display id and imports old changes
```

Required behavior:

- canonical taskId is required for strict import;
- display id is never sole identity for UI auto-backfill;
- legacy display-only recovery remains compatible/manual CLI only.

Acceptance tests:

- same display id, different canonical id does not import.
- missing canonical id in UI strict mode returns no-attribution.

## Contract Traceability Matrix

Each major invariant needs at least one orchestrator test, one UI test when projection is involved, and one fixture or smoke when external OpenCode shape is involved.

| Invariant | Orchestrator Test | UI Test | Fixture/Smoke |
| --- | --- | --- | --- |
| strict delivery exact task/member/lane/session | `OpenCodeToolpartChangeReconstructor` | `ChangeExtractorService` | multi-task same-session fixture |
| snapshot window exact sourcePartId | `OpenCodeOfflineSessionReader` + snapshot provider | `TaskChangeLedgerReader` | same timestamp part fixture |
| metadata -> full-text upgrade no duplicates | `TaskChangeLedgerService` projection | `changeReviewSlice` | golden ledger fixture |
| unavailable before stays manual-only | `OpenCodeLedgerBridgeService` | `ReviewApplierService` | missing blob fixture |
| old orchestrator response is safe | bridge command contract test | `ChangeExtractorService` | old schema fixture |
| Windows path safety | path/provider tests | reader/review path tests | Windows CI fixture |
| non-OpenCode isolation | task ledger suites | reader/review suites | Claude Code shell fixture |
| privacy diagnostics | diagnostics unit test | renderer diagnostic test | real payload redaction fixture |
| config effective snapshot true | profile/host tests | readiness bridge test | live OpenCode smoke |
| timeout partial success | command handler test | `OpenCodeReadinessBridge`/extractor test | delayed bundle fixture |

Merge rule:

```text
no invariant enters default-on path without at least one failing-before/passing-after test
```

## Red-Team Scenarios

These are adversarial product tests, not just unit tests.

1. **Wrong task bait**:
   - prompt asks agent to edit file for task A but text mentions task B;
   - expected: A only, if delivery context says A.

2. **Marker replay bait**:
   - assistant repeats old delivery marker in answer;
   - expected: marker ignored.

3. **Same file two agents**:
   - jack and tom edit same file in same repo;
   - expected: each task shows only its session/sourcePartId events, or metadata conflict if indistinguishable.

4. **Old display id reuse**:
   - deleted task display id reused;
   - expected: canonical id prevents import.

5. **Slow DB writer**:
   - SQLite locked then unlocks;
   - expected: retryable then imported.

6. **Snapshot pruned after import**:
   - ledger full-text imported, OpenCode snapshot gitdir deleted;
   - expected: UI still shows full diff from ledger blobs.

7. **Snapshot pruned before import**:
   - SQLite has hashes but gitdir missing;
   - expected: metadata/manual-only.

8. **Config says true, effective false**:
   - project/managed override disables snapshots;
   - expected: diagnostic and metadata fallback.

9. **Case collision**:
   - `Foo.ts` and `foo.ts`;
   - expected: no unsafe full-text projection on Windows-style root.

10. **Timeout after success**:
   - backfill command times out after writing bundle;
   - expected: UI re-reads ledger and shows changes.

## Additional Stop-Ship Gates From Protocol Review

Add these to the merge gate:

1. `OpenCodeBackfillTaskLedgerEvidenceMode` still allows legacy modes as default product behavior without deprecation handling.
2. Strict UI backfill can import from memberName without laneId/session proof.
3. Delivery `accepted` status can be cached as stable no-history before response/toolpart observation.
4. Runtime session recreation is not reflected in delivery context used for backfill.
5. Marker parser trusts assistant text or natural language.
6. Display id can be used as sole strict identity.
7. Timeout/truncated bridge response can cache empty without ledger re-read.
8. Contract traceability matrix has untested default-on invariants.
9. Red-team scenarios are not represented in fixtures or tests.
10. Backfill diagnostics cannot distinguish delivery missing, SQLite missing, snapshot missing, and UI stale cache.

## OpenCode Shell And Snapshot-Only Side Effect Risk Drilldown

This is one of the biggest remaining product gaps. OpenCode snapshots can prove that files changed inside a model step, but they do not by themselves prove which task/tool caused each file. Our current safe bridge reconstructs only exact path toolparts:

```text
write
edit
apply_patch
```

OpenCode can also run tools or shell commands that mutate files indirectly:

```text
bash
formatters
package scripts
test commands that update snapshots
code generators
custom MCP/tools
provider-executed tools
```

If the snapshot diff contains changed files but no exact supported toolpart path, importing those files into a task would be a false-attribution risk.

### SH1 - Snapshot Diff Has Files But No Exact Toolpart Path

Failure shape:

```text
OpenCode runs bash: npm run generate
snapshot diff contains src/generated.ts
no write/edit/apply_patch part proves src/generated.ts
bridge imports src/generated.ts into task
```

Why this is dangerous:

- snapshot window can contain formatter/watcher/user side effects;
- shell command may touch many files outside the task intent;
- no exact path proof means the UI cannot safely say “this task changed this file”.

V1 required behavior:

- do not import snapshot-only paths as file events;
- emit diagnostic `snapshot-path-without-toolpart-proof`;
- if there is at least one exact toolpart path in the same window, import only the intersection;
- diagnostic should include counts, not file contents.

Acceptance tests:

- snapshot diff has `a.ts` and `b.ts`, toolpart proves only `a.ts`, UI shows only `a.ts` plus diagnostic count for excluded path.
- snapshot diff has paths but no supported toolparts, UI shows diagnostic-only/needs_attention, not has_changes.
- shell command output mentioning a path does not create file event.

### SH2 - Bash Apply Patch Is Ambiguous Unless It Becomes An ApplyPatch Part

OpenCode source includes patch parsing support for direct/implicit apply_patch flows, including some bash heredoc handling in patch code. But the session part can still appear as a generic shell/bash tool depending on runtime/tool shape.

Risk:

```text
bash heredoc applies patch
OpenCode snapshot sees exact file change
bridge does not recognize it as apply_patch
Changes stays diagnostic-only
```

This is a false-negative risk, not a safety bug.

Options:

1. **Do not parse generic bash in this phase** - 🎯 9.1   🛡️ 9.6   🧠 2.5 - ~0-150 LOC.
   Safest. We accept missing shell-generated changes unless OpenCode provides exact structured apply_patch/write/edit parts.

2. **Parse only direct apply_patch toolpart shapes** - 🎯 8.5   🛡️ 9.0   🧠 5.5 - ~350-800 LOC.
   Good if OpenCode stores apply_patch as a distinct toolpart. Still do not parse arbitrary bash scripts.

3. **Parse generic bash commands for file paths** - 🎯 4.2   🛡️ 4.0   🧠 8.5 - ~1200-2600 LOC.
   Reject for default UI. Shell parsing is brittle and can create false positives. This belongs only in a future explicit diagnostics/recovery tool, not automatic Changes.

Recommendation:

```text
V1 uses option 1 + existing structured apply_patch support.
Future targeted baseline can handle shell safely.
```

### SH3 - Formatter/Post-Tool Side Effects In Same Window

Failure shape:

```text
write tool changes src/a.ts
formatter automatically changes src/b.ts in same snapshot window
snapshot diff contains both
toolpart proves only src/a.ts
```

Required behavior:

- import `src/a.ts` only;
- exclude `src/b.ts` with diagnostic;
- do not claim task changed `src/b.ts` until exact toolpath evidence exists;
- if formatter changed the same `src/a.ts`, this remains indistinguishable and must be documented as same-path limitation.

Acceptance tests:

- different-path formatter side effect excluded.
- same-path formatter side effect remains full-text but diagnostic says ownership is “captured in OpenCode step”, not absolute authorship.

### SH4 - Custom Tools And MCP Tools

Risk:

```text
custom MCP tool writes files
snapshot diff captures files
toolpart name is not write/edit/apply_patch
```

Required behavior:

- unknown tool names do not create file events automatically;
- tool-specific exact path adapters can be added later one by one;
- adapter must provide exact path, operation, and evidence confidence;
- otherwise snapshot-only diff remains diagnostic-only.

Acceptance tests:

- custom tool with no adapter -> diagnostic-only.
- custom tool adapter with exact path -> metadata/full-text path allowed through same strict intersection.

### SH5 - What Users Will See For Shell-Only Changes

This needs product clarity. If an OpenCode teammate says “I changed files” but only shell side effects exist, V1 may not show full file rows. That is intentional until a targeted baseline exists.

UI behavior:

- if no exact file path evidence: no Changes file rows;
- if snapshot-only paths exist: diagnostics can explain “snapshot saw file changes, but no exact toolpart path proved task attribution”;
- do not show a fake file count;
- do not allow apply/reject.

Future stronger option:

**Targeted shell-side baseline around OpenCode tool execution** - 🎯 8.2   🛡️ 9.2   🧠 9.0 - ~2200-4200 LOC.
Capture before/after around exact tool execution with a runtime hook or controlled tool wrapper. This is the correct way to support shell-generated diffs later without broad snapshot attribution.

## Text, EOL, Encoding, And Diff Semantics Risk Drilldown

### E1 - CRLF/LF Changes Can Look Like Whole-File Rewrite

OpenCode snapshot git config sets `core.autocrlf=false`. Our ledger blobs and UI diffs read text as UTF-8. On Windows or mixed repos, EOL changes can become noisy.

Risk:

```text
file content changes only line endings
UI shows huge diff
reject applies wrong EOL style
```

Required behavior:

- preserve exact blob bytes for hash and apply/reject;
- display diff can normalize only for presentation if explicitly marked;
- apply/reject writes exact ledger text, not normalized display text;
- line ending only changes should have a diagnostic or compact display mode.

Acceptance tests:

- CRLF before and LF after hashes remain distinct.
- reject restores original CRLF exactly.
- display does not enable partial reject from normalized-only content.

### E2 - UTF-8 Roundtrip Is Not Enough For All Text-Like Files

Risk:

```text
UTF-16, Latin-1, or mixed encoding file has no NUL or decodes oddly
reader treats it as text
diff/apply corrupts it
```

Required behavior:

- text blob must pass strict UTF-8 roundtrip;
- non-UTF-8 becomes metadata-only/manual-review;
- binary detection includes NUL and failed roundtrip;
- no encoding conversion.

Acceptance tests:

- UTF-16 file stays metadata-only.
- Latin-1 bytes that fail roundtrip stay metadata-only.
- valid UTF-8 with emoji remains text.

### E3 - Generated Huge Single-Line Files

Risk:

```text
large minified file under cap
diff algorithm consumes CPU/memory
```

Required behavior:

- diff rendering has separate max line length and max hunk count caps;
- ledger can store text under cap, but UI may mark diff display capped;
- apply/reject only if full text hashes are available and current hash matches.

Acceptance tests:

- single 900KB line does not freeze UI test.
- display caps hunk rendering but full reject remains hash-guarded.

## Nested Git, Sparse Checkout, LFS, And Repo Topology Risk Drilldown

### R1 - Nested Git Repositories

Risk:

```text
workspace root has nested git repo
OpenCode project.worktree is parent
snapshot diff includes nested repo path as directory/gitlink or ignores it
```

Required behavior:

- trust OpenCode `project.worktree` and `project.vcs`;
- nested repo paths are metadata-only unless snapshot object is a normal blob;
- no recursive git calls inside nested repos for evidence;
- diagnostics should identify topology mismatch.

Acceptance tests:

- nested git directory touched by toolpart stays metadata-only unless normal blob evidence exists.
- nested repo file path outside OpenCode worktree is rejected.

### R2 - Sparse Checkout And Partial Clone

Risk:

```text
OpenCode snapshot tracks sparse-visible files
toolpart path points to sparse-missing file
snapshot object unavailable
```

Required behavior:

- missing snapshot path for proven toolpart path becomes metadata-only;
- do not run git commands that expand sparse checkout;
- do not fetch remote objects.

Acceptance tests:

- sparse-missing path is metadata-only.
- git reader never runs fetch.

### R3 - Git LFS Pointer Versus Real Content

Risk:

```text
snapshot contains LFS pointer text
actual working tree has large binary
UI shows pointer diff as if it were real file content
```

Required behavior:

- snapshot reader reads exactly snapshot blob content;
- if blob looks like LFS pointer, add diagnostic `snapshot-lfs-pointer-content`;
- auto apply/reject should be conservative unless before/after are both pointer text and current disk hash matches ledger after hash;
- real binary LFS content remains metadata-only.

Acceptance tests:

- LFS pointer detected and labeled.
- binary LFS file stays metadata-only.

### R4 - Subdirectory Session Pathspec

Risk:

```text
OpenCode launched in subdirectory
snapshot diff uses cwd/pathspec "."
reader diffs whole worktree
extra files from outside subdir appear
```

Required behavior:

- reproduce OpenCode `cwd: session.directory` and pathspec scope where applicable;
- candidate toolpart path must still normalize inside `project.worktree`;
- if session.directory is outside project.worktree, block full-text.

Acceptance tests:

- subdir session imports subdir file only.
- parent worktree unrelated file in same snapshot is not imported without toolpart proof.

## Permission, Tool Disabled, And Provider-Executed Tool Risk Drilldown

### PT1 - Tools Disabled In OpenCode Config

Risk:

```text
write/edit disabled
agent uses bash or custom tool
snapshot has changes but no supported toolparts
```

Required behavior:

- readiness/provisioning diagnostics should record effective tools config if available;
- no supported toolpart means diagnostic-only or metadata-only only if exact path evidence exists;
- do not loosen attribution because tools were disabled.

Acceptance tests:

- write disabled and bash modifies file -> diagnostic-only, not fake file event.
- write enabled and write toolpart exists -> normal flow.

### PT2 - Provider-Executed Tools

Risk:

```text
provider executes tool internally
part shape differs from normal OpenCode toolpart
```

Required behavior:

- provider-executed supported write/edit/apply_patch shape is accepted if exact path fields match;
- unknown provider-executed shape is diagnostic-only;
- shape drift sentinel records providerExecuted sample.

Acceptance tests:

- providerExecuted write exact shape imports.
- providerExecuted unknown shape does not import.

## Clock, Timestamp, And Retention Risk Drilldown

### TIME1 - System Clock Skew

Risk:

```text
delivery ledger timestamps and SQLite timestamps differ by clock skew
ordering by wall clock picks wrong record or evicts active delivery
```

Required behavior:

- strict attribution should prefer ids and session/message relationships over timestamps;
- timestamps are only tie-breakers and retention hints;
- if retention cleanup sees future timestamps, keep records and emit diagnostic.

Acceptance tests:

- future delivery timestamp does not evict active record.
- same timestamp records use ids/order, not wall clock.

### TIME2 - Retention Cleanup Deletes Needed Delivery Proof

Delivery ledger has responded/failed retention windows. If delivery proof is cleaned before the user opens Changes, strict backfill may fail even though SQLite still exists.

Risk:

```text
delivery record deleted after retention
old task opened
strict backfill no-attribution
```

Required behavior:

- materialized ledger events should be durable once imported;
- for old non-imported tasks, missing delivery proof means no-attribution or compatible/manual recovery only;
- retention cleanup should not delete records needed by active tasks.

Acceptance tests:

- imported ledger survives delivery cleanup.
- non-imported old task with deleted delivery record does not broad scan.

## Additional Stop-Ship Gates From Shell/Text/Topology Review

Add these to the merge gate:

1. Snapshot-only changed paths can become UI file rows without exact supported toolpart path.
2. Shell/bash output text can create file events.
3. Generic bash parser is used in default UI path.
4. CRLF/LF normalization can change apply/reject bytes.
5. Non-UTF-8 content can be treated as editable text.
6. Large single-line diff can freeze renderer or worker.
7. Nested repo, sparse checkout, or LFS pointer fixtures are missing.
8. Subdirectory session pathspec is not tested.
9. Tool-disabled/bash-only OpenCode session reports clean no-changes without diagnostic.
10. Delivery retention cleanup can remove proof for active tasks.

## Board Task Lifecycle And Scope Risk Drilldown

This is the next weak area after source evidence. The ledger can only be correct if the task identity is stable. The current code has a deliberately strict in-memory scope model:

```ts
// src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.ts
buildActorKey(sessionId, agentId)
openScopes: Map<string, ActiveScope>
getSingleActiveScope() returns null unless exactly one scope is active
getActiveScopes() returns all active scopes for multi-scope notices
```

That is a good false-positive defense, but it creates several production risks that the plan must handle explicitly.

### TL1 - No `task_start`, No Active Scope

Failure shape:

```text
OpenCode receives task prompt
assistant edits files
assistant comments "done"
no runtime task_start/task_complete carrier reached orchestrator
```

Risk:

- exact file tools cannot be safely attached through `RuntimeBoardTaskExecutionStore`;
- OpenCode strict delivery may still attach if delivery context and toolparts match;
- legacy log reconstruction might show nothing because there is no work interval.

Required behavior:

- do not infer task attribution from assistant prose;
- OpenCode path may import only if strict delivery proof exists;
- non-OpenCode path should return no file changes or diagnostic, not broad scan.

Acceptance tests:

- OpenCode strict delivery with no board scope but valid delivery record imports matched toolparts.
- Exact file tool with no board scope does not attach to a random task.
- Comment-only "I changed calculator.js" does not create changes.

### TL2 - App Restart Loses In-Memory Scope

Current fact:

```text
RuntimeBoardTaskExecutionStore is process memory only.
```

Failure shape:

```text
task_start opens scope
app restarts
agent/tool completion arrives later
memory scope is gone
```

Risk:

- file event can be silently dropped;
- if we try to recover by current active UI task, we can attach wrong files.

Required behavior:

- never recover task scope from "selected task" or visible UI state;
- prefer persisted delivery evidence for OpenCode;
- for shell/background exact snapshots, keep using durable deferred shell snapshots from the earlier hardening layer;
- if neither proof exists, write a warning/diagnostic only when we have a safe task id, otherwise no file event.

Implementation note:

```ts
if (!activeScope && !strictDeliveryContext && !durableDeferredSnapshot) {
  return { outcome: 'no-attribution', importedEvents: 0 }
}
```

Acceptance tests:

- clear `RuntimeBoardTaskExecutionStore`, then strict OpenCode backfill still imports only delivery-matched toolparts.
- clear store, exact non-OpenCode file tool without persisted task evidence imports zero file events.
- app restart plus old ledger bundle remains readable because imported ledger is durable.

### TL3 - Reopen / Review / Needs-Fix Creates A Second Work Interval

Failure shape:

```text
task completed
review requests changes
same agent edits same file again
UI opens Changes for task
```

Risk:

- old accepted changes and new review changes collapse into one row without provenance;
- apply/reject may target stale content hash;
- summary cache may return old terminal result.

Required behavior:

- ledger projection should group by task but preserve event chronology and content hashes;
- UI review decision identity must include content hash/provenance, not only path;
- cache invalidation must happen on task history/review state changes.

Acceptance tests:

- completed task summary cached, then review-state changes to `review`, then new ledger event appears after invalidation.
- same path edited in work phase and review phase produces one visible current diff with provenance history, not duplicate active actions.
- persisted decision created before review change cannot apply to later content hash.

### TL4 - Owner Changes During A Run

Failure shape:

```text
task assigned to Alice
prompt delivered to Bob
owner changed to Carol before backfill
```

Risk:

- UI `effectiveOptions.owner` can filter or label the wrong member;
- strict delivery can miss valid Bob toolparts if it only trusts current owner;
- broadening to all members risks false positives.

Required behavior:

- delivery ledger record is stronger than current owner;
- backfill member filter should accept:
  - explicit delivery `memberName/laneId/runtimeSessionId`;
  - current owner only as a search narrowing hint when delivery context is absent, and only in compatible/manual modes.
- imported ledger event should store actual source member from delivery record.

Acceptance tests:

- owner changed after delivery, strict backfill still imports Bob events if delivery record says Bob.
- owner changed without delivery context does not scan every member in UI strict mode.

### TL5 - Multiple Active Scopes For One Actor

Current fact:

```ts
getSingleActiveScope() returns null when openScopes.length !== 1
getActorContextForTarget() returns relation: 'ambiguous'
```

Risk:

- a single agent can start work/review on two tasks and then edit one file;
- attaching the file to both tasks is wrong;
- attaching it to whichever task is opened in UI is worse.

Required behavior:

- exact file tools: write notice to all active scopes and no file events;
- OpenCode strict delivery: delivery context may still disambiguate if the prompt's task id and message id are exact;
- snapshot-only evidence cannot override multi-scope ambiguity.

Acceptance tests:

- two active scopes plus exact Write creates notices only.
- two active scopes plus strict delivery for one task imports only that delivery-matched OpenCode event.
- two active scopes plus snapshot diff but no supported toolpart imports zero events.

### TL6 - Task Deleted Or Recreated With Same Display Id

Failure shape:

```text
task #abc123 deleted
new task later reuses visible/display id or title
old delivery records still exist
```

Risk:

- old OpenCode toolparts backfill into a new task;
- persisted presence says `has_changes` for the wrong task.

Required behavior:

- prefer canonical task id whenever available;
- cache/presence signature must include task createdAt/history signature, not just display id;
- strict delivery context should match task id plus delivery message id, not title.

Acceptance tests:

- deleted task then recreated display id does not reuse old backfill cache.
- delivery context from old task cannot import into new canonical id.

### TL7 - Task Dependencies Are Not Attribution

Failure shape:

```text
task A blocks task B
agent edits file while working task A
UI opens task B
```

Risk:

- relationship links can be mistaken for execution ownership.

Required behavior:

- `blocked-by`, `blocks`, and `related` are not file attribution evidence;
- only subject execution/review scope or strict delivery context can attribute changes.

Acceptance tests:

- related task links appear in history, but no changes are shown for related task without its own evidence.

## Runtime Recovery And App Restart Risk Drilldown

### RR1 - In-Flight Backfill Is Memory-Only

Current fact:

```ts
openCodeBackfillInFlight: Map<string, Promise<boolean>>
openCodeBackfillCache: Map<string, { backfilledAt, expiresAt }>
```

Failure shape:

```text
UI opens Changes
background backfill starts
app restarts before completion
user opens Changes again
```

Risk:

- if idempotency is weak, rerun can duplicate events;
- if cache says empty incorrectly, user sees stale no-changes.

Required behavior:

- source import key must make rerun idempotent;
- empty/no-attribution cache TTL must be short and keyed by delivery fingerprint;
- `duplicates-only` should be treated as successful only if there were valid candidate events inside strict delivery window.

Acceptance tests:

- kill simulated backfill after writing one event, rerun imports no duplicate and bundle projection stays one row.
- no-attribution cache invalidates when delivery context changes.

### RR2 - Bridge Command Status Is Not A Source Of Truth

Failure shape:

```text
opencode.backfillTaskLedger command accepted
renderer loses IPC result
commandStatus not durable after restart
```

Risk:

- UI may not know whether import finished.

Required behavior:

- ledger artifacts are the source of truth;
- command status is only progress telemetry;
- UI should re-read ledger after command failure/timeout before returning empty state.

Implementation rule:

```ts
try {
  await bridge.backfillTaskLedger(...)
} finally {
  const ledger = await readLedgerTaskChanges(...)
  if (ledger?.files.length) return ledger
}
```

Acceptance tests:

- bridge returns timeout after import, UI second read shows changes.
- bridge returns timeout before import, UI does not cache empty as terminal.

### RR3 - Delivery Journal Recovery Is App-Owned, Not Orchestrator-Owned

Current fact:

- `RuntimeDeliveryJournalStore` persists delivery envelopes in UI/main process.
- Orchestrator backfill receives delivery context through a temp file.

Risk:

- orchestrator cannot recover strict task context by itself;
- if UI does not pass delivery context, strict mode must fail closed.

Required behavior:

- `opencode.backfillTaskLedger` strict UI path requires delivery context for auto attribution;
- `opencode.recoverDeliveryJournal` can repair delivery rows before backfill, but cannot invent file evidence;
- no delivery context means `no-attribution`, not compatible broad recovery.

Acceptance tests:

- strict command without delivery context imports zero events.
- after `recoverDeliveryJournal`, strict backfill imports only records with matching message ids.

### RR4 - OpenCode Session Recreated Or Stale After Restart

Failure shape:

```text
old runtimeSessionId in delivery ledger
OpenCode restarts and creates new session id
old SQLite still exists
```

Risk:

- strict filtering by current session misses old real toolparts;
- broad filtering by member scans unrelated old sessions.

Required behavior:

- delivery record `runtimeSessionId` is the primary session search key when present;
- if session id is missing but delivered message id is present, bounded search can look for that message id across member sessions with hard caps;
- if more than one session matches same delivery message id, skip as ambiguous.

Acceptance tests:

- old session id still imports after current runtime changes.
- missing session id plus unique delivered message id imports.
- missing session id plus two matching sessions imports zero and emits ambiguity diagnostic.

### RR5 - Logs Empty Does Not Mean No Changes

Failure shape:

```text
OpenCode task logs panel empty
SQLite/session store still has message/toolpart evidence
```

Risk:

- UI relies on logs path and never triggers ledger backfill;
- user sees "No file changes recorded" even though OpenCode evidence exists.

Required behavior:

- OpenCode backfill should not depend on rendered task logs;
- task logs are a display artifact, not evidence source;
- Changes load path should attempt ledger read/backfill when project/team context is available.

Acceptance tests:

- fixture with empty task logs but valid OpenCode SQLite/delivery imports changes.
- fixture with empty task logs and no delivery context does not broad scan.

## Evidence Claims Policy

User-visible assistant text is not file evidence.

Examples that must not create file events:

```text
"I updated calculator.js"
"I created tests"
"Changed the config as requested"
```

Why:

- model text can be wrong;
- filenames in text can be stale or hallucinated;
- text does not prove before/after bytes;
- text does not prove which task owns the edit.

### Top 3 Claim Handling Options

1. **Ignore claims for changes, keep them in Comments/Logs only** - 🎯 9.5   🛡️ 9.8   🧠 1.5 - ~0-80 LOC.
   This is the production default. It prevents false positives and keeps the Changes tab evidence-based.

2. **Diagnostic-only claim marker in dev logs** - 🎯 8.3   🛡️ 9.0   🧠 4.0 - ~250-600 LOC.
   Useful for debugging cases where agents claim edits but evidence is missing. Must never affect `has_changes`.

3. **Parse claims into file rows** - 🎯 2.0   🛡️ 1.8   🧠 6.0 - ~700-1600 LOC.
   Rejected. This would create exactly the false Changes rows we are trying to remove.

Recommended policy:

```text
comments/logs can explain intent
ledger evidence decides Changes
diagnostics explain missing evidence in dev/debug mode
```

Acceptance tests:

- assistant claim with no toolpart/snapshot/exact tool event returns no file rows.
- assistant claim plus valid evidence returns file rows from evidence only.
- diagnostic logging, if enabled, redacts prompt content and file snippets.

## Board/Runtime Test Matrix For Remaining Weak Spots

P0 means no default-on merge without it.

| Priority | Scenario | Expected result |
| --- | --- | --- |
| P0 | App restart clears `RuntimeBoardTaskExecutionStore`, strict OpenCode delivery exists | imports matched OpenCode events |
| P0 | App restart clears scope, no delivery/exact durable proof | imports zero file events |
| P0 | Task deleted then recreated with same display id | old events do not attach to new task |
| P0 | Owner changes after delivery | delivery member wins over current owner |
| P0 | Multiple active scopes plus exact file tool | notices only, no file attribution |
| P0 | Multiple active scopes plus strict delivery for one task | imports only delivery-matched task |
| P0 | Assistant says "changed file" with no evidence | no file rows |
| P0 | Backfill timeout after import | UI reread shows ledger rows |
| P0 | Backfill timeout before import | no terminal empty cache |
| P0 | Empty task logs plus valid OpenCode evidence | changes appear |
| P1 | Reopen/review second interval same path | latest projection stable, stale decisions reset |
| P1 | Missing runtimeSessionId but unique delivered message id | bounded import succeeds |
| P1 | Missing runtimeSessionId and duplicate message ids | skip ambiguous |
| P1 | Delivery retention removed old proof before import | no broad scan, diagnostic |
| P1 | Related/blocked task only | no changes for related task |
| P2 | Claim diagnostic-only dev log | logs useful diagnostics, no UI false positive |

## Observability Contract For These Risks

Default user UI should stay simple. Developer diagnostics should be precise.

Suggested diagnostic codes:

```text
task-scope-missing
task-scope-ambiguous
task-scope-lost-after-restart
delivery-context-missing
delivery-session-stale
delivery-session-ambiguous
assistant-claim-ignored
backfill-timeout-ledger-reread
backfill-timeout-no-ledger
task-identity-reused
owner-changed-after-delivery
empty-logs-not-evidence
```

Rules:

- diagnostics can mention ids, counts, and hashes;
- diagnostics must not include prompt text, file content, or patch content;
- UI `has_changes` must require file events, not diagnostics;
- `needs_attention` should not be rendered as the normal Changes diff button.

## Task Detail UI And Presence Race Risk Drilldown

This layer is separate from ledger correctness. A perfect ledger can still look broken if the renderer shows stale summary state, a cached negative result, or an empty diff dialog before auto-backfill finishes.

Current code facts from the UI worktree:

```ts
latestTaskChangesRequestToken
taskChangesCheckInFlight
taskChangesNegativeCache
taskChangePresenceByKey
summaryOnly: true
resolveTaskChangePresenceFromResult()
```

### UI1 - Count Shows `0` While A Backfill Is Running

Failure shape:

```text
task detail opens
summary request starts
UI renders Changes 0
OpenCode backfill imports rows later
user sees 0 and assumes no changes
```

Risk:

- correct backend eventually imports rows, but user-visible state loses trust;
- a stale negative cache can hide the later positive state until TTL expires.

Required behavior:

- while summary/backfill is in flight, the row should show loading state, not a final count;
- `0` is only final after the latest request finished and no positive presence exists;
- if a full detail fetch starts after a summary fetch, the summary result cannot overwrite full result.

Acceptance tests:

- delayed `getTaskChanges(summaryOnly: true)` renders loader instead of `0`.
- backfill imports after initial zero, UI presence updates to `has_changes`.
- stale summary response after full fetch is ignored.

### UI2 - Changes Section Hidden Because Presence Is Unknown

Failure shape:

```text
task has status completed/review
presence unknown
Changes accordion not rendered
user cannot trigger manual backfill by opening it
```

Risk:

- the only path that would discover changes is not reachable;
- old teams created before presence cache never recover.

Required behavior:

- task detail may show Changes section for display-eligible task states even if count is unknown;
- icon/badge can remain neutral/loading/unknown;
- opening the section performs a fresh `includeDetails` load.

Acceptance tests:

- completed task with unknown presence renders Changes section.
- opening Changes triggers detail fetch and OpenCode backfill.
- pending/backlog task without work state can still hide Changes if product chooses that, but completed/review should not.

### UI3 - `needs_attention` Becomes A Fake Changes Button

Failure shape:

```text
ledger has warning-only/no file rows
presence = needs_attention
UI renders normal Changes button
dialog opens "No file changes recorded"
```

Risk:

- same confusion as the earlier beacon/vector incidents;
- warning-only state looks like file diff availability.

Required behavior:

- `has_changes` controls diff affordance and file count;
- `needs_attention` is diagnostics/attention state, not a normal file diff count;
- if the section is always visible, warning-only content must render diagnostics, not "No file changes recorded" as a final clean empty state.

Acceptance tests:

- warning-only task renders attention text/badge but no positive file count.
- opening section with warnings and zero files shows diagnostics state.
- `has_changes` and `needs_attention` do not share the same icon/color/action semantics.

### UI4 - Negative Cache Outlives New Evidence

Failure shape:

```text
summary returns no_changes
negative cache stores timestamp
OpenCode ledger import writes event
same task is reopened quickly
negative cache suppresses recheck
```

Risk:

- user sees stale zero even after ledger changed.

Required behavior:

- any successful import invalidates summary and presence caches;
- cache key must include task signature and delivery/evidence fingerprint;
- negative cache is not persisted across app restart;
- negative cache TTL stays short.

Acceptance tests:

- importedEvents > 0 clears negative cache immediately.
- delivery context fingerprint change bypasses negative cache.
- task history/review/owner change changes the presence key.

### UI5 - Global Request Token Drops A Valid Result From Another Task

Current risk:

```ts
latestTaskChangesRequestToken is global for all task fetches
```

Failure shape:

```text
open task A changes
quickly open task B changes
task A request completes late and is dropped
return to task A
task A still shows loading/old state unless refetched
```

Required behavior:

- stale drop is correct for the active dialog;
- each task row/presence cache should still be updated only by scoped cache APIs;
- active dialog request token should include team/task/options, or the store must refetch on every task activation.

Acceptance tests:

- rapid A -> B -> A navigation ends with A detail loaded.
- late A response cannot overwrite B active dialog.
- late B response cannot set A presence.

### UI6 - Summary-Only Result Cannot Be Used As Detail Result

Failure shape:

```text
summaryOnly true returns files without snippets/details
active dialog installs it as activeChangeSet
renderer shows empty or manual-review rows incorrectly
```

Required behavior:

- summary-only can update count/presence only;
- detail dialog must require `includeDetails = true`;
- if full detail is missing while summary says `has_changes`, UI shows loading/retry, not empty diff.

Acceptance tests:

- summary-only `has_changes` never renders file review list.
- full detail fetch follows summary positive state.
- full detail failure preserves actionable retry state.

## Ledger Apply/Reject Mutation Risk Drilldown

This is a different risk class from "does Changes show the right rows". It is about whether a user action can safely mutate the filesystem after the row is shown. The current UI code already has a ledger-native path, but the snapshot upgrade work makes it more important because more OpenCode rows can become full-text and therefore reviewable.

Current code facts from `ReviewApplierService`:

```ts
tryApplyLedgerDecision(...)
checkLedgerCurrentHash(filePath, expectedAfterHash)
readCurrentText(filePath) -> readFile(filePath, 'utf8')
hashText(content) -> sha256(utf8 string)
partial reject -> tryHunkLevelReject(...)
tryHunkLevelReject(...) -> applyPatch(modified, inversePatch, { fuzzFactor: 2 })
rename reject -> restore old path, then unlink new path
```

### AP1 - Hash Domain Mismatch

Failure shape:

```text
ledger before/after hash was computed from bytes
review applier hashes UTF-8 string
same visible text produces different hash
or different bytes produce same decoded text
```

Risk:

- false conflict for valid files;
- worse, false non-conflict if byte representation is not preserved.

Required behavior:

- full-text ledger events that enable auto apply/reject must use one explicit hash domain;
- for text blobs, the hash must match exactly the bytes that will be written by `writeFile(..., 'utf8')`;
- if the source blob came from raw bytes that cannot round-trip through UTF-8 exactly, event must stay metadata-only/manual-review;
- binary, non-UTF-8, and decode-error content cannot become auto-reviewable.

Acceptance tests:

- UTF-8 non-ASCII file hash guard passes.
- CRLF file hash guard passes without newline normalization.
- UTF-8 BOM file hash guard is stable.
- invalid UTF-8 file is metadata-only/manual-review.
- hash computed from raw byte fixture and hash computed from UI write string are explicitly compared.

### AP2 - Fuzzy Partial Reject Can Apply The Wrong Hunk

Current risk:

```ts
applyPatch(modified, inversePatch, { fuzzFactor: 2 })
```

Fuzzy patching is acceptable for some legacy convenience paths, but it is too permissive for ledger-native snapshot evidence. A snapshot-upgraded event gives us exact before/after text. If a hunk cannot be applied with exact context, that is a conflict/manual review, not an opportunity to guess.

Top 3 options:

1. **Strict ledger partial reject with fuzzFactor 0 plus context-hash mapping** - 🎯 9.0   🛡️ 9.5   🧠 5.5 - ~180-450 LOC.
   Best. Ledger-native partial reject uses exact inverse patch only. Legacy non-ledger behavior can keep current fallback if needed.

2. **Disable partial reject for snapshot-upgraded ledger rows** - 🎯 8.0   🛡️ 9.8   🧠 2.0 - ~80-180 LOC.
   Very safe, but worse UX. Good emergency fallback if exact partial reject gets complicated.

3. **Keep fuzzFactor 2 everywhere** - 🎯 4.0   🛡️ 3.5   🧠 0.5 - 0 LOC.
   Rejected. It can silently move edits to a similar hunk after the file changed.

Required behavior:

- ledger-native partial reject must not use fuzzy patching;
- if hunk context hash is missing, duplicated, or changed, return `conflict` or `manual-review-required`;
- after applying the strict inverse patch in memory, compare resulting content against an expected hash when possible;
- then write only after current disk hash equals ledger `afterState.sha256`.

Acceptance tests:

- two identical hunks, reject one -> ambiguous -> no auto apply.
- nearby context shifted -> conflict, no write.
- exact hunk context -> applies.
- current disk hash mismatch -> conflict before patch.
- legacy non-ledger partial reject behavior is unchanged if intentionally kept.

### AP3 - Rename Reject Is A Two-Path Transaction

Failure shape:

```text
reject rename
old path is restored successfully
unlink new path fails
filesystem now has both old and new files
```

Risk:

- partial mutation after an error;
- user thinks reject failed or succeeded, but disk is half-mutated.

Required behavior:

- rename reject is auto-allowed only when both path states are fully guarded:
  - new path hash equals ledger after hash;
  - old path is absent, or old path hash equals ledger before hash and content is identical;
  - neither path is symlink unless explicitly supported;
  - parent directory creation is inside workspace.
- operation should be ordered to minimize data loss:
  - verify all preconditions first;
  - write old path only if new path is still guarded;
  - if delete new path fails after old write, return `io-error` plus diagnostic that disk may contain both paths;
  - never delete new path before old content is durably written.

Top 3 options:

1. **Keep auto rename reject with strict preflight and partial-mutation diagnostics** - 🎯 8.2   🛡️ 8.6   🧠 6.5 - ~250-600 LOC.
   Balanced. It preserves useful UX but needs explicit tests for two-path failure.

2. **Make rename/copy reject manual-review-only for OpenCode snapshot events** - 🎯 8.7   🛡️ 9.6   🧠 2.5 - ~80-200 LOC.
   Safest. Less Cursor-like, but avoids multi-path transactions in v1.

3. **Best-effort rename reject without rollback diagnostics** - 🎯 4.5   🛡️ 4.0   🧠 1.0 - 0 LOC.
   Rejected. Silent half-mutation is not acceptable.

Acceptance tests:

- rename reject succeeds when old missing and new hash matches.
- new path changed -> conflict, no write.
- old path exists with different content -> conflict, no write.
- simulated unlink failure after old write returns `io-error` and explicit partial-mutation diagnostic.
- copy relation remains manual-review unless there is a precise intended rollback policy.

### AP4 - Symlink And Outside-Workspace Mutation

Failure shape:

```text
ledger filePath points inside workspace
filePath is a symlink to outside workspace
reject writes through symlink
```

Risk:

- apply/reject mutates files outside the project;
- review UI becomes a path traversal primitive.

Required behavior:

- review apply/reject should either:
  - receive `workspaceRoot` and verify `realpath(filePath)` is inside it; or
  - reject symlink paths as `manual-review-required` when workspace root is unavailable.
- directory creation for restore/delete must be checked against workspace root before writing;
- relation paths must be resolved from ledger workspace root, not from string suffix alone.

Acceptance tests:

- symlink inside workspace pointing outside -> manual-review-required.
- symlink inside workspace pointing inside -> allowed only if explicit policy supports it.
- relation oldPath/newPath suffix collision does not resolve to wrong directory.
- `../` and absolute relation paths outside workspace are skipped before UI actions.

### AP5 - File Permissions And Read-Only Targets

Failure shape:

```text
ledger row is valid
current hash matches
write/unlink fails with EACCES, EPERM, EBUSY, or file lock
```

Required behavior:

- return typed `io-error`;
- do not downgrade to `conflict`;
- do not update UI decision as applied;
- keep retry possible after user fixes permissions.

Acceptance tests:

- read-only file reject returns `io-error`.
- locked file on Windows returns `io-error` and no stale applied state.
- missing parent directory restore creates only safe parents inside workspace.

### AP6 - Apply/Reject Result Can Be Stale After External Writer

Failure shape:

```text
current hash check passes
external writer changes file
writeFile overwrites external change
```

Risk:

- classic TOCTOU race.

Without worktree/process isolation, we cannot prove absolute ownership. But we can reduce the window:

- hash check should happen immediately before write;
- write should be as small and direct as possible;
- after write, verify final hash equals expected result;
- if final verify fails, return conflict/io-error and keep diagnostics.

Acceptance tests:

- injected external mutation between guard and write is detected when final verify fails.
- final verify hash mismatch does not report success.

### AP7 - Metadata-Only Event Accidentally Becomes Auto-Reviewable

Failure shape:

```text
snapshot upgrade adds after text only
before remains unavailable
UI enables Reject
```

Required behavior:

- auto full reject for modify requires before and after full text plus current hash guard;
- create reject requires after hash and expected absent-before proof;
- delete reject requires before text and expected absent-after proof;
- partial reject requires before and after full text;
- any `unavailableReason` on a required side returns `manual-review-required`.

Acceptance tests:

- before unavailable + after text -> manual-review-required.
- after unavailable + before text -> manual-review-required except already-missing delete success policy if explicitly intended.
- metadata-only sibling in same file group does not inherit full-text reviewability from upgraded sibling.

### AP8 - Review Key Stability vs Safety

The UI needs a stable key so the row does not jump around, but a stale decision must not survive when evidence changes.

Required behavior:

```text
display identity = stable path/relation identity
decision identity = display identity + evidence fingerprint
```

The evidence fingerprint must include:

- projected event id;
- sourceImportKey;
- evidence rank/proof;
- before sha;
- after sha;
- operation;
- relation kind and paths;
- reviewability.

Acceptance tests:

- row remains visually stable after metadata -> full-text upgrade.
- stale metadata decision is cleared after upgrade.
- hunk decisions are cleared when hunk hashes change.
- same exact bundle reload does not clear decisions.

## Apply/Reject Stop-Ship Gates

Add these to the merge gate:

1. Ledger partial reject uses fuzzy patching.
2. Snapshot-upgraded metadata-only event can be auto-rejected without full required sides.
3. Rename reject can partially mutate two paths without explicit error diagnostics.
4. Apply/reject can follow a symlink outside workspace.
5. Relation path resolution can select the wrong same-suffix path.
6. Review action reports success without verifying final disk hash.
7. UTF-8/CRLF/BOM hash-domain fixtures are missing.
8. Invalid UTF-8 can become full-text reviewable.
9. Windows locked/read-only file errors are not typed as `io-error`.
10. Decision identity does not include evidence/content fingerprint.

## Mass Loading, Backpressure, And Cost Risk Drilldown

This system is often triggered indirectly: opening a team, warming task summaries, expanding task detail, and opening Changes can all issue work. The evidence path must stay bounded when a team has many tasks or OpenCode sessions are large.

Current code facts:

```text
renderer TASK_CHANGE_WARM_CONCURRENCY = 4
renderer NEGATIVE_CACHE_TTL = 30_000
main TaskChangeWorkerClient timeout = 30_000
main OpenCode backfill cache TTL = 60_000
orchestrator MAX_SCANNED_RECORDS = 50
OpenCodeOfflineSessionReader message cap = 20_000
OpenCodeOfflineSessionReader part cap = 80_000
SQLite busy_timeout = 1000
```

These caps are useful, but the snapshot path adds additional cost: reading SQLite rows, reading snapshot git objects, building ledger blobs, rebuilding bundles, and possibly rereading from UI.

### PERF1 - Warm Summaries Trigger Too Many Backfills

Failure shape:

```text
team detail opens
warmTaskChangeSummaries queues many completed tasks
each summary tries OpenCode backfill
SQLite and snapshot gitdir get hammered
```

Risk:

- UI stalls;
- OpenCode DB busy timeout spikes;
- repeated transient failures are cached as no changes.

Required behavior:

- summary warm path should be cheap:
  - read existing ledger bundle first;
  - only trigger OpenCode backfill when task is display-eligible and no fresh ledger answer exists;
  - keep global OpenCode backfill concurrency separate from generic task summary concurrency;
  - coalesce by `teamName + taskId + delivery fingerprint + evidence version`.
- full detail open can use higher priority than background warm.

Top 3 options:

1. **Separate OpenCode backfill queue with priority and concurrency 1-2 per team** - 🎯 8.8   🛡️ 9.1   🧠 6.5 - ~350-800 LOC.
   Best. Prevents mass warm from starving user-opened Changes.

2. **Disable OpenCode backfill from warm summaries, only run on explicit Changes open** - 🎯 8.0   🛡️ 9.5   🧠 2.0 - ~80-180 LOC.
   Very safe and simple, but badges/counts become lazy.

3. **Use existing warm concurrency only** - 🎯 5.5   🛡️ 5.8   🧠 0.5 - 0 LOC.
   Rejected for snapshot default-on. It does not cap snapshot git reads separately.

Acceptance tests:

- 100 completed tasks warm summaries -> at most N concurrent OpenCode backfills.
- explicit Changes open jumps ahead of background warm.
- repeated warm calls coalesce to one backfill per task/fingerprint.

### PERF2 - Large SQLite Session Hits Caps And Looks Clean

Failure shape:

```text
OpenCode session has >80_000 parts
reader caps rows
target task's part is beyond cap
UI shows no changes
```

Risk:

- false negative hidden behind cap.

Required behavior:

- cap exceeded must be `needs_attention`/diagnostic, not clean `no_changes`;
- strict delivery should query by message/session anchors where possible, not scan from oldest rows only;
- if bounded targeted query cannot prove coverage, return transient/degraded diagnostic.

Acceptance tests:

- parts cap exceeded before target message -> diagnostic, no clean no_changes cache.
- targeted deliveredUserMessageId query finds target rows even when old session is huge.
- cap exceeded with no delivery context stays no-attribution, not broad scan.

### PERF3 - Snapshot Git Object Fanout

Failure shape:

```text
one step touches 500 files
snapshot reader reads before/after blobs for all files
```

Risk:

- high disk IO;
- renderer gets huge payload;
- app freezes or OS pressure increases.

Required behavior:

- never read blobs for snapshot-only extra paths;
- read blobs only for strict toolpart candidate paths;
- hard cap per task:
  - max candidate files;
  - max full-text files;
  - max total blob bytes;
  - max per-file bytes.
- over cap degrades remaining files to metadata-only/manual-review with diagnostics.

Acceptance tests:

- 500 file snapshot diff with 2 toolpart candidates reads only 2 paths.
- 500 candidate paths caps and returns diagnostics.
- huge full-text file degrades metadata-only.

### PERF4 - Worker Timeout And Partial Results

Failure shape:

```text
task-change worker times out at 30s
OpenCode ledger import may have succeeded
UI receives worker failure and shows empty
```

Required behavior:

- ledger read/backfill path should be separate from legacy worker timeout semantics;
- after any timeout, re-read ledger before returning empty;
- timeout result should be transient, not persisted as no_changes.

Acceptance tests:

- worker timeout with existing ledger bundle still shows changes.
- backfill timeout after import then ledger reread shows changes.
- timeout before import does not write persisted no_changes.

### PERF5 - Cache Key Explosion And Memory Growth

Failure shape:

```text
task option signature changes frequently
presence/backfill caches accumulate many keys
```

Risk:

- long-running desktop session memory growth;
- stale keys cause wrong presence restoration.

Required behavior:

- in-memory caches should have max entries and TTL pruning;
- cache key should include only stable semantic fields;
- delivery/evidence fingerprint should be short hash, not raw records;
- invalidate keys on team unload/delete.

Acceptance tests:

- repeated task history changes do not grow cache without bound.
- team delete clears presence/backfill caches for that team.
- project switch does not reuse cache keys across project fingerprint.

### PERF6 - SQLite Busy Or WAL Race

Failure shape:

```text
OpenCode writes SQLite/WAL
our readonly reader opens at the same time
busy_timeout hits
```

Risk:

- transient errors become false no-history;
- repeated UI opens keep missing changes.

Required behavior:

- busy/locked reads return `transient-error`;
- transient-error does not cache successful empty;
- short retry can be scheduled for explicit Changes open;
- background warm should not retry aggressively.

Acceptance tests:

- locked SQLite returns transient-error and no no_changes cache.
- explicit detail open retries once after short delay.
- warm path records diagnostic and backs off.

## Performance Stop-Ship Gates

Add these to the merge gate:

1. Background warm summaries can run unbounded OpenCode backfills.
2. Summary warm backfill has the same priority as explicit Changes open.
3. SQLite cap exceeded can become clean `no_changes`.
4. Snapshot reader reads blobs for paths not proven by strict toolpart candidates.
5. Full-text blob fanout has no per-task cap.
6. Worker/backfill timeout can persist no_changes.
7. OpenCode SQLite busy/locked error can be cached as no-history.
8. Backfill cache key stores raw delivery records instead of fingerprint.
9. Team/project switch can reuse old task presence keys.
10. Renderer can receive an unbounded change payload.

## OpenCode Profile, Data Root, And Project Identity Risk Drilldown

This is one of the most failure-prone areas because a wrong identity usually does not crash. It just produces missing snapshot evidence and the user sees metadata-only or empty Changes.

Fresh source facts:

```ts
// OpenCode snapshot service
gitdir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
args = ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]
```

OpenCode global paths come from XDG-style env paths:

```ts
Global.Path.data
Global.Path.config
Global.Path.state
Global.Path.cache
```

OpenCode project identity comes from SQLite/project state:

```ts
project.id
project.worktree
project.vcs // "git" when snapshot is usable
session.project_id
session.directory
```

The bridge must treat this as a strict identity contract, not a convenience lookup.

### ID1 - Wrong Data Root For Managed Profile

Failure shape:

```text
our OpenCode DB resolver reads profile A
snapshot gitdir resolver uses default user OpenCode data dir
snapshot gitdir missing
changes degrade or disappear
```

Risk:

- false negative for every snapshot-capable session;
- worse, accidentally reading the user's non-managed OpenCode snapshot store.

Required behavior:

- profile data dir must be derived from the exact same managed profile env/config that launched OpenCode;
- do not independently guess using current process `HOME`, `XDG_DATA_HOME`, `APPDATA`, or `LOCALAPPDATA` unless it is the same env captured in the session record;
- `profileDataDir` should be stored or derivable from session record with a stable `profileRootKey`;
- computed snapshot gitdir must be under that profile data dir.

Acceptance tests:

- macOS-style `~/Library/Application Support/opencode` fixture resolves correctly.
- Linux `XDG_DATA_HOME` fixture resolves correctly.
- Windows `LOCALAPPDATA/opencode/Data` fixture resolves correctly.
- current process env changed after launch does not change resolved profile data dir.
- missing profileRootKey in strict path returns metadata-only diagnostic, not default user scan.

### ID2 - Project Worktree Hash Input Is Not UI WorkspaceRoot

Failure shape:

```text
UI workspaceRoot = /repo/subdir
OpenCode project.worktree = /repo
bridge hashes /repo/subdir
snapshot gitdir not found
```

Risk:

- false negative in monorepos and subdirectory launches;
- accidental mismatch when worktree path has symlinks or different case.

Required behavior:

- snapshot gitdir hash input is exactly OpenCode `project.worktree`;
- UI `workspaceRoot` is only used to validate visible file containment and review target;
- `session.directory` can define pathspec scope, but must not replace `project.worktree` for gitdir hashing;
- if `project.worktree` and UI workspaceRoot are incompatible, no snapshot upgrade.

Acceptance tests:

- session directory subdir, project worktree root -> gitdir uses project worktree.
- symlinked repo path and realpath repo path mismatch -> no upgrade unless exact OpenCode worktree identity is proven.
- Windows drive-case mismatch is handled for comparison, but hash uses exact OpenCode string.

### ID3 - Project Moved Or Deleted After Session

Failure shape:

```text
OpenCode session SQLite still exists
project.worktree path no longer exists
snapshot gitdir may still exist
UI workspaceRoot points to new clone
```

Risk:

- old snapshot evidence might be applied to a different checkout;
- review actions can target the wrong repo.

Required behavior:

- full-text import can read old snapshot objects only if workspace identity matches current UI project fingerprint;
- review apply/reject targets current `filePath`, but must verify current disk hash;
- if current workspace differs from OpenCode `project.worktree`, show metadata-only/manual-review or diagnostic, not auto-review.

Acceptance tests:

- session from old repo path opened under new repo path -> no auto-review.
- old snapshot full text can still be imported as audit only if UI marks non-reviewable.
- current disk hash mismatch blocks reject.

### ID4 - OpenCode Project Id Missing Or Reused

Failure shape:

```text
session.project_id missing
project table row missing
bridge falls back to workspaceRoot hash or session id
```

Risk:

- wrong snapshot gitdir;
- cross-project evidence collision.

Required behavior:

- missing `session.project_id` or missing project row means no snapshot full-text upgrade;
- do not synthesize project id;
- do not search all `snapshot/*/*` directories;
- metadata-only fallback is allowed only for strict toolpart paths.

Acceptance tests:

- missing project table row -> metadata-only with diagnostic.
- two projects same worktree string but different project id -> no cross-read.
- project id containing path separators or unsafe chars is rejected.

### ID5 - `project.vcs` Is Not Git

Fresh source fact:

OpenCode snapshot service carries `vcs` in state and snapshots are useful only for git projects. Non-git projects cannot rely on OpenCode snapshot gitdir.

Required behavior:

- `project.vcs !== "git"` means no OpenCode snapshot full-text evidence;
- do not shell out to `git` in non-git workspace hoping it works;
- Variant 1 metadata-only remains the correct fallback.

Acceptance tests:

- non-git OpenCode write imports metadata-only/manual-review.
- non-git edit does not show clean no_changes if strict toolpart path exists.
- no broad workspace scan is introduced.

### ID6 - OpenCode Autoupdate / Version Drift Between Launch And Backfill

Failure shape:

```text
team launched with OpenCode version A
OpenCode autoupdates to version B
SQLite/snapshot shape changes
backfill runs later
```

Risk:

- parser silently skips new shapes;
- schema drift looks like no-history.

Current local code already has auto-update policy controls:

```text
OPENCODE_DISABLE_AUTOUPDATE
CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE
```

Required behavior:

- managed teammates should disable OpenCode autoupdate by default unless explicitly allowed;
- session record should store observed OpenCode version/channel if available;
- reader diagnostics should include supported/observed shape version metadata without raw content;
- unsupported shape returns `unsupported-opencode-history-shape`, not no_changes.

Acceptance tests:

- managed env includes `OPENCODE_DISABLE_AUTOUPDATE=1` by default.
- version changes between launch and backfill logs diagnostic.
- unknown newer part shape does not poison supported old rows in same session.

### ID7 - Multiple Profiles For Same Team

Failure shape:

```text
team run uses profileRootKey A
later relaunch uses profileRootKey B
delivery records from A still exist
UI passes current profile B
```

Risk:

- old session evidence cannot be found;
- broad scan over profiles could import wrong member.

Required behavior:

- delivery context records should include profileRootKey/profile data fingerprint when available;
- backfill should search only profiles referenced by strict delivery/session records;
- if multiple profiles match the same delivery id, skip as ambiguous.

Acceptance tests:

- same task delivered in profile A then profile B imports only matching session for each delivery.
- delivery record without profileRootKey does not search every profile in strict UI mode.

### ID8 - Profile Data Root Escapes Or Is User-Controlled

Failure shape:

```text
corrupt session-store profileRootKey = ../../real-home
bridge computes snapshot path outside managed profile
```

Risk:

- privacy leak from user's normal OpenCode store;
- reading attacker-controlled gitdir.

Required behavior:

- profileRootKey must pass existing safe key validation;
- profile data dir must be inside known app-owned OpenCode profile root or explicit trusted data root;
- snapshot gitdir is computed, never read from SQLite/prompt/toolpart input;
- computed gitdir realpath must stay inside profile data dir when it exists.

Acceptance tests:

- traversal profileRootKey rejected.
- absolute profileRootKey rejected.
- symlink profile data dir escaping trusted root rejects full-text upgrade.

### Profile/Data Identity Options

1. **Persist launch profile identity in session records and derive all paths from it** - 🎯 9.0   🛡️ 9.4   🧠 6.0 - ~300-700 LOC.
   Best. Keeps launch-time env and backfill-time reader aligned.

2. **Recompute profile paths from current process env during backfill** - 🎯 4.8   🛡️ 4.5   🧠 2.0 - ~80-180 LOC.
   Rejected. Easy to implement, but wrong after app restart, profile changes, or platform env changes.

3. **Scan all known OpenCode data roots for snapshot gitdir** - 🎯 3.5   🛡️ 2.5   🧠 5.5 - ~400-1000 LOC.
   Rejected for strict UI path. It creates privacy and false-attribution risk.

## Profile And Identity Stop-Ship Gates

Add these to the merge gate:

1. Snapshot gitdir is derived from current process env instead of launch/session profile identity.
2. Snapshot gitdir uses UI workspaceRoot instead of OpenCode `project.worktree`.
3. Missing project id falls back to scanning snapshot directories.
4. Non-git project attempts snapshot full-text import.
5. ProfileRootKey traversal can influence data root.
6. Current user default OpenCode store can be read for a managed team session.
7. OpenCode autoupdate/version drift can produce clean no_changes.
8. Project moved/new clone can get auto-reviewable old snapshot evidence.
9. Multiple profiles for one task can be searched without delivery profile proof.
10. `session.directory` is used as the snapshot gitdir hash input.

## Bridge IPC And Temp Delivery Context Risk Drilldown

OpenCode strict backfill currently depends on a UI-created temp JSON file:

```ts
mkdtemp(os.tmpdir() + "/claude-team-opencode-ledger-context-")
writeFile(delivery-context.json, JSON.stringify({ schemaVersion: 1, teamName, taskId, records }))
opencode.backfillTaskLedger({ deliveryContextPath })
rm(tempDir, { recursive: true, force: true })
```

The orchestrator then reads the path:

```ts
readFile(deliveryContextPath, "utf8")
size cap 512 KiB
normalizeDeliveryContext(JSON.parse(raw))
fingerprint = sha256(raw)
```

This is a reasonable bridge for a local desktop app, but default-on snapshot evidence makes it a trust boundary. The temp file should be treated as an app-owned IPC artifact, not as user input.

### IPC1 - Temp File Path Injection

Failure shape:

```text
renderer/main passes deliveryContextPath
orchestrator accepts any absolute path
path points to unrelated JSON controlled by another process
strict attribution uses forged delivery context
```

Risk:

- false attribution to the wrong task/member/session;
- privacy leak if diagnostics include data from the file.

Required behavior:

- UI should create context files only under an app-owned temp root with mode `0700`;
- orchestrator should accept delivery context paths only if:
  - absolute;
  - realpath is under approved app temp roots or an explicit trusted IPC directory;
  - file basename is expected, for example `delivery-context.json`;
  - parent directory mode is private where platform supports it.
- if path validation fails, strict backfill returns `no-attribution`, not compatible fallback.

Acceptance tests:

- deliveryContextPath outside temp root is rejected.
- symlink deliveryContextPath escaping temp root is rejected.
- relative path is rejected.
- valid app temp context succeeds.

### IPC2 - Temp File Race Or Cleanup Before Read

Failure shape:

```text
UI writes temp context
bridge command starts
cleanup runs early because command times out/cancels
orchestrator reads missing file
strict backfill no-attribution
```

Risk:

- false negative after a valid delivery.

Required behavior:

- cleanup must happen only after bridge command returns or after a hard timeout where result is no longer consumed;
- if read fails with ENOENT, result is transient/no-attribution and should not be cached as final when delivery records exist;
- explicit Changes open may retry once by recreating context.

Acceptance tests:

- deleted temp file before orchestrator read -> no import, no stable no_changes cache.
- retry with same delivery context imports.
- command timeout does not delete temp file before child process has been killed or detached result is ignored.

### IPC3 - Context File Tamper Between Write And Read

Failure shape:

```text
context file written
another process modifies file before orchestrator reads
fingerprint changes but no expected fingerprint exists
```

Risk:

- forged context can pass schema validation.

Top 3 options:

1. **Pass expected context hash in command body and verify file hash in orchestrator** - 🎯 9.2   🛡️ 9.4   🧠 3.5 - ~120-260 LOC.
   Best. Keeps temp-file transport but makes tamper detectable.

2. **Inline delivery context in command body instead of temp file** - 🎯 8.0   🛡️ 9.0   🧠 4.5 - ~180-400 LOC.
   Good for small contexts, but stdout/input size limits and command ledger size need care.

3. **Trust temp file only** - 🎯 5.0   🛡️ 5.2   🧠 0.5 - 0 LOC.
   Not enough for default-on strict attribution.

Required behavior:

- UI computes `deliveryContextHash = sha256(rawContext)`;
- command body includes the hash, not the raw context;
- orchestrator computes raw file hash before parsing and rejects mismatch;
- cache key uses the verified hash.

Acceptance tests:

- tampered context file hash mismatch -> no-attribution, diagnostic.
- same context with whitespace change has different hash and cache key.
- verified hash is returned in bridge response.

### IPC4 - Context Schema Skew Between UI And Orchestrator

Failure shape:

```text
UI creates schemaVersion 2 context
old orchestrator knows schemaVersion 1 only
old orchestrator treats context as missing
```

Risk:

- silent no changes after mixed-version deploy;
- if old orchestrator falls back to compatible, false positives.

Required behavior:

- unsupported context schema returns explicit `unsupported-delivery-context-schema`;
- strict mode never falls back to compatible;
- UI response handling treats this as actionable diagnostic, not final clean empty state.

Acceptance tests:

- schemaVersion 2 with old orchestrator -> skipped-capability/no-attribution diagnostic.
- schemaVersion 1 still works.
- missing required fields in one record does not poison other valid records unless task identity is ambiguous.

### IPC5 - Bridge Contract Version Skew

Failure shape:

```text
new UI sends no evidenceMode because final design removed it
old orchestrator defaults to chain-only
or old UI sends chain-only to new orchestrator
```

Risk:

- default path silently degrades to metadata-only;
- user thinks snapshot bridge is active when it is not.

Required behavior:

- bridge handshake should expose `opencodeTaskLedgerEvidenceContractVersion`;
- UI should require minimum version before assuming snapshot session evidence path;
- if version is too old, UI should show degraded diagnostic and not cache no_changes;
- final implementation should remove `chain-only` from UI request, but orchestrator must still respond safely to old clients.

Acceptance tests:

- old orchestrator response does not crash UI.
- new UI detects old contract and returns degraded diagnostic.
- old UI hitting new orchestrator still gets safe metadata/chain behavior, not false full-text.

### IPC6 - Delivery Context Too Large

Current cap:

```text
512 KiB raw JSON
```

Failure shape:

```text
team has many delivery records for one task
context exceeds cap
strict backfill loses all context
```

Required behavior:

- context generation should filter records before writing:
  - same team;
  - same canonical task/display task;
  - relevant member/lane/session when available;
  - newest bounded count;
  - terminal and active records that can still prove delivery.
- if still over cap, strict result is degraded diagnostic, not broad scan.

Acceptance tests:

- 1000 unrelated delivery records are not written to task context.
- over-cap filtered context returns explicit diagnostic.
- valid smaller subset imports.

### IPC7 - Diagnostics Leak Delivery Prompt Content

Risk:

- delivery context can include ids and task refs, but must not include prompt body, comments, file content, or raw tool input.

Required behavior:

- context records contain only ids, timestamps, lane/member/session, taskRefs, and cursor ids;
- diagnostics can include counts/hashes/codes only;
- bridge command ledger must not persist raw context content if it contains sensitive text.

Acceptance tests:

- context JSON fixture has no `text`, `prompt`, `content`, `patch`, `fileContent` fields.
- diagnostic snapshots redact raw context.

## Ledger Crash Consistency And Artifact Atomicity Risk Drilldown

The task ledger has multiple artifact classes:

```text
.board-task-changes/events/<task>.jsonl
.board-task-changes/notices/<task>.jsonl
.board-task-changes/blobs/sha256/<hash>
.board-task-changes/bundles/<task>.json
.board-task-change-freshness/<task>.json
.board-task-changes/locks/<task>.lock/owner.json
```

Current implementation writes journal lines with `appendFile`, blobs/bundle/freshness with temp file + rename, and serializes per-task writes with an in-process queue plus a filesystem writer lock.

### DUR1 - Crash After Journal Append Before Bundle/Freshness

Failure shape:

```text
event appended to JSONL
process crashes before bundle/freshness write
UI reads stale bundle or no bundle
```

Required behavior:

- reader must compare freshness/bundle `journalStamp` with actual journal stamp;
- stale/missing bundle triggers rebuild from journal;
- stale cached no_changes must be invalidated when journal exists or freshness changes.

Acceptance tests:

- append event, delete bundle/freshness -> reader rebuilds.
- append event, old bundle remains -> reader detects stamp mismatch and rebuilds.
- UI presence cache invalidates after rebuilt bundle appears.

### DUR2 - Crash During Bundle Write

Current write is temp file + rename, which protects against partial target content, but does not fsync by default.

Risk:

- after OS crash, rename or file data may not be durable on all filesystems;
- temp files may be left behind.

Required behavior:

- normal app crash can rely on journal rebuild;
- OS crash durability target should be documented as best-effort unless fsync is added;
- startup/reader cleanup can ignore stale `*.tmp`;
- corrupt bundle JSON triggers rebuild from journal.

Top 3 options:

1. **Journal-first with rebuild fallback, no fsync** - 🎯 8.5   🛡️ 8.4   🧠 2.0 - ~80-220 LOC tests/docs.
   Good pragmatic default for desktop. Current design is close, but needs explicit corrupt bundle tests.

2. **Add fsync for journal, blobs, bundle, and parent dirs** - 🎯 7.8   🛡️ 9.3   🧠 7.0 - ~500-1100 LOC.
   Stronger durability, but more platform-specific and can slow writes.

3. **Trust bundle as primary and ignore journal mismatch** - 🎯 2.0   🛡️ 2.0   🧠 0.5 - 0 LOC.
   Rejected.

Acceptance tests:

- corrupt bundle with valid journal rebuilds.
- temp bundle files are ignored.
- freshness partial integrity causes reader fallback.

### DUR3 - Blob Missing But Bundle References It

Failure shape:

```text
bundle file row references blob sha
blob write failed or blob was deleted
reader cannot load text
```

Required behavior:

- row becomes metadata-only/manual-review or partial-text, not crash;
- warning includes missing blob ref hash only, no content;
- apply/reject disabled for missing side.

Acceptance tests:

- missing before blob -> manual-review-required.
- missing after blob -> manual-review-required.
- missing blob does not hide the file row.

### DUR4 - Journal Line Torn Or Malformed

Failure shape:

```text
appendFile writes partial JSON line
process crashes
reader parses journal
```

Required behavior:

- skip malformed trailing line and mark recovered;
- do not drop earlier valid events;
- if malformed line was an upgrade event, project base event and warning;
- if base malformed but upgrade valid and identity is complete, projection may use upgrade.

Acceptance tests:

- malformed final line recovered warning.
- malformed middle line recovered warning and valid later lines still read if parser can continue line-by-line.
- malformed upgrade does not duplicate rows.

### DUR5 - In-Process Queue Is Not Cross-Process

Current fact:

```ts
taskWriteQueues Map serializes writes only inside one process.
TaskChangeWriterLock serializes cross-process writes by lock dir.
```

Risk:

- if the filesystem lock fails or is stolen too early, two processes can rebuild bundles against different journal views.

Required behavior:

- bundle rebuild must read journal after acquiring the lock;
- freshness stamp must be computed from the same post-write journal view;
- stale lock steal must write a notice;
- lock heartbeat must prevent false stale steal during long snapshot reads.

Acceptance tests:

- two processes append same task -> final journal has both, bundle sees both.
- stale lock stolen -> notice appears.
- fresh heartbeat lock is not stolen.
- long rebuild heartbeat prevents second writer from stealing.

### DUR6 - Freshness Says `partial` But UI Treats It As Current

Failure shape:

```text
bundle write fails
partial freshness written
UI sees freshness and trusts missing/old bundle
```

Required behavior:

- `integrity: partial` means reader must prefer journal rebuild or show degraded state;
- partial freshness must not produce stable `no_changes`;
- UI should surface retry/degraded diagnostics when files cannot be projected.

Acceptance tests:

- partial freshness with valid journal rebuilds.
- partial freshness with unreadable journal shows needs_attention, not no_changes.

### DUR7 - Artifact Path Encoding Collision

Failure shape:

```text
long/reserved task id hashed to safe artifact path
different task id collides or same visible id reused
```

Risk:

- wrong task reads another task's events.

Required behavior:

- encoded artifact path may be hashed, but every journal line must include full `taskId`;
- reader must validate event.taskId matches requested taskId;
- collision should produce diagnostic and skip mismatched lines.

Acceptance tests:

- forced artifact collision fixture with mismatched taskId skips wrong events.
- Windows reserved task ids still read/write.

## IPC And Durability Stop-Ship Gates

Add these to the merge gate:

1. Orchestrator accepts arbitrary deliveryContextPath in strict UI mode.
2. Delivery context file has no expected hash in command body.
3. Temp context read failure can become stable no_changes.
4. Unsupported delivery context schema falls back to compatible attribution.
5. New UI can silently talk to old orchestrator and believe snapshot evidence is active.
6. Delivery context can include prompt/file/patch content.
7. Stale bundle can be trusted despite journalStamp mismatch.
8. Corrupt bundle can hide valid journal events.
9. Missing blob can crash reader or enable auto-review.
10. Partial freshness can be treated as final clean result.
11. Writer lock stale steal lacks notice.
12. Artifact path collision can show another task's events.

## Teammate Worktree And Centralized Ledger Risk Drilldown

This feature must be correct in shared repos and in teammate worktree isolation.
The current ledger already has optional worktree metadata:

```text
file.worktreePath
file.worktreeBranch
file.baseWorkspaceRoot
scope.worktreePaths
scope.worktreeBranches
scope.baseWorkspaceRoots
CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR
```

That is the right direction, but OpenCode hybrid evidence adds a stricter rule:

```text
artifact storage root and mutation target are different concepts
```

In teammate isolation:

```text
artifact storage root = leader project .board-task-changes
workspaceRoot = teammate worktree root
filePath = absolute path inside teammate worktree
OpenCode snapshot gitdir hash input = OpenCode project.worktree for that teammate worktree
```

If any code mixes those values, the UI can show a correct-looking row but mutate the wrong checkout.
That is a release blocker.

### WT1 - Centralized ledger root confused with worktree mutation root

Risk:

- the ledger bundle is stored under the leader project through `CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR`;
- the event `workspaceRoot` and `filePath` belong to a teammate worktree;
- apply/reject, snapshot lookup, or path normalization accidentally use the leader root because that is where artifacts live.

Bad outcome:

- the Changes panel shows a teammate worktree change, but Accept/Reject mutates the leader repo;
- hash guards may still pass if the same file exists in both roots with similar content;
- users think the isolated teammate changed main.

Required behavior:

- `projectDir` is only an artifact storage root;
- `workspaceRoot` is the only root used for relative path derivation and path safety checks;
- `filePath` is the only mutation target for review actions;
- review actions must never substitute `baseWorkspaceRoot` or the current UI project root when `filePath` is missing or stale;
- snapshot evidence for OpenCode worktree sessions must use the OpenCode project worktree, not the centralized artifact root.

Implementation guard:

```ts
type LedgerStorageRoot = string
type WorkspaceMutationRoot = string

interface LedgerPathContext {
  artifactProjectDir: LedgerStorageRoot
  workspaceRoot: WorkspaceMutationRoot
  absoluteFilePath: string
  worktreePath?: string
  baseWorkspaceRoot?: string
}

function assertMutationTargetInWorkspace(ctx: LedgerPathContext): void {
  // Must check against workspaceRoot/worktreePath.
  // Must not check against artifactProjectDir/baseWorkspaceRoot.
}
```

Acceptance tests:

- centralized bundle lives under leader `.board-task-changes`, but file row points to teammate worktree path;
- reject modifies only the teammate worktree file;
- leader repo file with the same relative path remains byte-identical;
- missing teammate worktree returns `unavailable` or `conflict`, never fallback-to-main.

### WT2 - Worktree removed before review

Current cleanup rules intentionally keep dirty teammate worktrees and remove clean ones.
That is correct, but review can happen after a restart, TeamDelete, manual cleanup, or external `git worktree remove`.

Risk:

- ledger events are durable and still visible;
- the target worktree no longer exists;
- UI tries to be helpful and resolves the relative file path in the leader repo.

Bad outcome:

- a historical row mutates the wrong checkout;
- a missing isolated workspace becomes an apparent main-repo change.

Required behavior:

- the Changes panel may still display historical ledger metadata;
- full text diff may render from ledger blobs when available;
- apply/reject must fail closed with a typed error:

```text
code: unavailable
message: worktree target no longer exists
```

- no fallback to current cwd;
- no fallback to `baseWorkspaceRoot`;
- no implicit `git worktree add` recreation.

Acceptance tests:

- create a worktree event, delete the worktree directory, then open Changes;
- assert rows still display if bundle has enough ledger data;
- assert Accept/Reject are disabled or return `unavailable`;
- assert leader repo has no mutation after failed action.

### WT3 - Worktree path or branch reused for a later teammate run

Worktree paths and branch names are stable-ish slugs:

```text
team-${safeTeam}-${safeName}-${shortId}
worktree-team-${safeTeam}-${safeName}-${shortId}
```

That is good for readability, but a stale ledger decision can outlive the actual checkout.

Risk:

- worktree path is deleted and recreated;
- branch is force-reset;
- same relative path exists in the new checkout;
- previous ledger event still has an absolute path that now points to a new working tree.

Bad outcome:

- Reject from an old task writes old content into a new task's checkout.

Required behavior:

- store and preserve at least one immutable or semi-immutable workspace fingerprint for worktree events:

```text
worktreeHeadCommit at spawn time
worktreeGitDir realpath when available
worktreeBranch
worktreePath
baseWorkspaceRoot
```

- before auto apply/reject in a worktree, verify the current worktree still matches the expected identity enough to be safe;
- if identity cannot be verified, return `conflict` or `manual-review-required`;
- this check is especially important for metadata-only or before-unavailable OpenCode events.

Pragmatic minimum for this plan:

```ts
interface LedgerWorktreeIdentity {
  worktreePath: string
  worktreeBranch?: string
  worktreeHeadCommit?: string
  worktreeGitDirRealpath?: string
}
```

Acceptance tests:

- produce a ledger event in worktree A;
- delete and recreate the path with a different HEAD;
- attempt reject;
- expected result is conflict/manual-only, not a write.

### WT4 - Dirty leader warning hidden or treated as harmless

Teammate worktrees are created from current committed `HEAD`.
Uncommitted leader changes do not automatically exist in the worktree.

Risk:

- leader has dirty changes that the user expects teammate to see;
- teammate worktree starts from clean `HEAD`;
- the task result differs because context was missing;
- Changes page looks precise but does not explain that base context was not included.

Required behavior:

- preserve `dirtyLeaderWarning` in ledger scope and file summaries when present;
- render it as diagnostics, not as a file change;
- never use dirty leader files as baseline for teammate worktree diffs;
- tests must assert dirty leader warnings survive journal -> bundle -> UI reader.

Acceptance tests:

- dirty leader repo plus teammate worktree event;
- bundle contains dirty leader warning;
- UI displays diagnostic;
- diff baseline comes from worktree/snapshot evidence only.

### WT5 - Same relative path in multiple worktrees collapses into one visible row

The ledger relation key already includes `worktreePath` for relation grouping in some paths.
OpenCode source import and UI projection must follow the same rule.

Risk:

- teammate Alice and Bob both edit `src/app.ts`;
- centralized ledger stores both task events in one project artifact area;
- UI groups by relative path only;
- decisions, collapsed state, or review key from one worktree affects the other.

Bad outcome:

- duplicate hiding;
- wrong accept/reject state;
- stale decision persistence after provenance upgrade;
- confusing single row with mixed before/after content.

Required behavior:

- source import key includes workspace identity:

```text
taskId
memberName or laneId
sessionId
workspaceRoot or worktreePath
relativePath
operation
sourceEventId
```

- UI `changeKey` and review decision identity include ledger provenance hash or worktree identity;
- relation grouping may show a friendly grouped rename/copy, but internal keys remain worktree-scoped.

Acceptance tests:

- two worktrees, same task, same relative path, different content;
- Changes page shows two distinct rows or one intentionally grouped row with distinct identities;
- accepting one does not mutate the other;
- persisted collapsed/review state for one row does not apply to the other.

### WT6 - OpenCode snapshot path uses leader root for worktree session

OpenCode snapshot storage is keyed by:

```text
Global.Path.data/snapshot/{project.id}/{Hash.fast(project.worktree)}
```

For teammate worktree isolation, `project.worktree` must be the teammate worktree path.

Risk:

- bridge runs from leader UI context and uses the leader root as snapshot hash input;
- OpenCode actually wrote snapshots under teammate worktree hash;
- snapshot lookup fails and downgrades to metadata-only;
- or worse, lookup finds a leader snapshot with a matching session id collision.

Required behavior:

- delivery context for OpenCode must carry the launched OpenCode cwd/worktree;
- session reader should prefer OpenCode's own project/worktree identity if available;
- snapshot reader must not use `baseWorkspaceRoot`, current UI cwd, or artifact project dir as fallback when worktree metadata exists;
- if OpenCode project.worktree cannot be established, do not claim snapshot evidence.

Acceptance tests:

- leader repo and teammate worktree both have OpenCode snapshot roots;
- event from teammate session resolves only teammate snapshot;
- forced leader snapshot with same relative path is ignored.

### WT7 - Dirty or hook-based worktree deleted before user review

Hook-based worktrees may not be normal git worktrees.
They can represent Perforce, Mercurial, custom monorepo checkout, or a scripted copy.

Risk:

- cleanup assumes git cleanliness;
- hook-based worktree without reliable dirty check is removed;
- ledger points to files that no longer exist;
- user loses the only copy of teammate edits.

Required behavior:

- dirty, unknown, failed cleanliness check, and hook-based worktrees are preserved;
- TeamDelete must not force-remove unknown/dirty worktrees;
- stale cleanup only removes clean ephemeral git worktrees with verified HEAD and no untracked changes;
- plan should explicitly reject any "force cleanup all teammate worktrees" path.

Acceptance tests:

- hook-based worktree with no WorktreeRemove hook remains after cleanup;
- dirty git worktree remains after teammate completion;
- failed git status leaves worktree preserved;
- clean git worktree is removable only after ledger finalized.

### WT8 - Mixed runtime teams share one ledger but not one evidence policy

A centralized task ledger can contain:

```text
Claude exact Edit/Write events
Codex shell snapshots
OpenCode SQLite toolparts
OpenCode snapshot evidence
manual metadata-only fallback
warning-only notices
```

Risk:

- OpenCode projection rules are accidentally applied to non-OpenCode events;
- metadata-only OpenCode fallback overwrites exact Claude before/after blobs;
- strict delivery context for OpenCode causes normal shell changes to be skipped;
- UI source labels imply the whole task is low confidence when only one OpenCode event is low confidence.

Required behavior:

- evidence upgrade is source-scoped and event-scoped;
- exact file-tool ledger events stay authoritative;
- OpenCode snapshot upgrade can replace only its own OpenCode placeholder event or add a paired source event with identical identity;
- warnings are attached to the affected event/source, not blindly lifted to whole task severity unless all visible rows are degraded.

Acceptance tests:

- one task with Claude exact edit and OpenCode metadata-only edit for different files;
- Claude row remains full diff and auto-reviewable if safe;
- OpenCode row remains manual-only until snapshot evidence upgrades it;
- no duplicate row after upgrade;
- task-level diagnostics distinguish "some OpenCode evidence degraded" from "all changes unavailable".

### WT9 - In-process worktree cwd override leaks into later turns

In-process teammate worktrees use a cwd override rather than global `process.chdir`.
That is safer, but any missed async boundary can leak worktree cwd or ledger context.

Risk:

- OpenCode bridge/backfill runs after the override ends and sees leader cwd;
- background operation inherits previous teammate worktree context;
- two teammates in process write ledger events with swapped workspaceRoot.

Required behavior:

- cwd/worktree/ledger context must be carried explicitly into async backfill requests;
- strict UI backfill must use delivery context and stored workspace identity, not ambient cwd;
- tests should run two concurrent in-process teammate contexts and assert distinct worktree roots.

Acceptance tests:

- mixed in-process teammates Alice and Bob edit same relative path in different worktrees;
- ledger events preserve distinct `workspaceRoot` and `worktreePath`;
- after both complete, ambient cwd is unchanged;
- OpenCode backfill for Alice cannot import Bob's toolparts.

### WT10 - Resume fallback to parent cwd hides missing worktree

Current resume code can fall back to parent cwd when stored worktree path no longer exists.
That can be acceptable for conversation continuation, but it is unsafe for review mutation.

Risk:

- resumed agent continues in parent cwd;
- task ledger still contains old worktree rows;
- future comments/logs make it look like same workspace;
- Changes apply/reject targets parent cwd because the resumed runtime lost worktree metadata.

Required behavior:

- resume fallback must emit a clear diagnostic/notice into task/team context when a worktree is missing;
- ledger review must keep old rows bound to their original `worktreePath`;
- new events after fallback must not reuse old worktree identity;
- UI should not present missing-worktree rows as normal main-repo changes.

Acceptance tests:

- resume with missing worktree;
- new event writes without old worktree metadata or with explicit missing-worktree warning;
- old worktree rows remain unavailable for auto-review;
- no row silently changes target root.

## Worktree And Mixed Runtime Options

Top 3 design options for this risk area:

1. Strict worktree-scoped ledger identity + no main fallback - 🎯 9.0   🛡️ 9.5   🧠 6.5 - roughly 500-1100 LOC.

   This is the correct production direction. Every event identity and review decision includes workspace/worktree identity where relevant. Missing/stale worktree blocks auto mutation. Snapshot lookup uses OpenCode project.worktree. Centralized storage remains only storage.

2. Display worktree changes but disable auto apply/reject when worktree identity is stale - 🎯 8.4   🛡️ 9.7   🧠 3.0 - roughly 180-450 LOC.

   This is the safest short-term patch if implementation time is constrained. It does not solve all duplicate/grouping issues, but it prevents wrong-repo mutation. It is acceptable as a temporary stop-gap, not as the full final design.

3. Fallback to leader/main repo when worktree is missing - 🎯 2.5   🛡️ 1.8   🧠 2.0 - roughly 80-180 LOC.

   Reject this. It is simple but violates isolation. It can corrupt the main checkout from an old teammate decision and would make the Changes UI actively dangerous.

Chosen policy:

```text
use option 1 for final implementation
allow option 2 only as a temporary safety gate if option 1 is incomplete
never implement option 3
```

## Worktree And Mixed Runtime Stop-Ship Gates

Add these to the merge gate:

1. Apply/reject can fall back from missing worktree path to leader repo.
2. Snapshot lookup for a worktree session can use `baseWorkspaceRoot` or centralized artifact root.
3. Same relative path in two worktrees can collapse into one decision identity.
4. OpenCode source import key lacks workspace/worktree identity.
5. Dirty leader warning is dropped from journal -> bundle -> UI.
6. Dirty teammate worktree can be auto-deleted before review.
7. Hook-based or unknown-cleanliness worktree can be force-removed.
8. Mixed OpenCode and Claude/Codex events share one global evidence policy.
9. Worktree path reuse can apply an old decision to a new checkout.
10. Resume missing-worktree fallback can retarget old ledger rows to parent cwd.
11. Review UI hides worktree provenance for worktree-scoped changes.
12. Centralized ledger storage root is used for path safety or mutation checks.
13. OpenCode snapshot upgrade can overwrite exact non-OpenCode ledger blobs.
14. Failed/killed teammate with dirty worktree loses path/branch metadata.
15. Windows drive-case or separator normalization can merge two distinct worktree identities.

## UI Review State, Async Upgrade, And Renderer Risk Drilldown

The ledger can be correct and still produce unsafe UX if renderer state is keyed too weakly.
The current UI has several useful safeguards:

```text
getFileReviewKey(file) = file.changeKey ?? file.filePath
decisionScopeToken includes provenance.sourceFingerprint when available
persisted decisions are saved under team + scope + scopeToken
hunk decisions use reviewKey:index
TaskChangeLedgerReader preserves ledger worktree metadata
ReviewApplierService has ledger-native strict guards
```

Those are good, but OpenCode hybrid evidence introduces a new high-risk transition:

```text
same task + same file + same visible changeKey
metadata-only event first
full-text snapshot evidence later
renderer already has persisted decisions, collapsed state, file content cache, and async requests in flight
```

This section defines the risks that must be covered before default-on behavior.

### UI1 - Metadata-only decision survives full-text evidence upgrade

Risk:

- user opens Changes while OpenCode only has metadata-only fallback;
- user clicks Accept, Reject, or hunk-level decision state is persisted;
- later snapshot evidence upgrades the same file to full-text;
- `changeKey` stays intentionally stable so the row does not duplicate;
- persisted decision is loaded for a semantically different diff.

Bad outcome:

- an old manual-review or empty/no-op decision is applied to a newly precise diff;
- hunk reject uses indices from a previous content shape;
- UI says pending count is resolved when the new full-text diff was never reviewed.

Required behavior:

- evidence upgrade must invalidate file and hunk decisions unless both content identity and provenance identity match;
- metadata-only -> full-text is always a review reset for that file;
- full-text -> stronger full-text can preserve only if all of these are equal:

```text
reviewKey
latestBeforeHash
latestAfterHash
contentAvailability
reviewability
sourceFingerprint or eventEvidenceFingerprint
worktreePath identity
relation identity
```

Recommended model:

```ts
interface ReviewDecisionIdentity {
  reviewKey: string
  evidenceFingerprint: string
  beforeHash: string | null
  afterHash: string | null
  contentAvailability: 'full-text' | 'partial-text' | 'metadata-only' | 'hash-only'
  reviewability: 'full-text' | 'partial-text' | 'metadata-only'
  worktreePath?: string
  relationKey?: string
}
```

Acceptance tests:

- load metadata-only fixture, persist reject decision;
- load upgraded full-text fixture with same `changeKey`;
- expected: no file decision and no hunk decisions;
- pending count reflects new hunks;
- applying review without new user action is skipped.

### UI2 - `sourceFingerprint` does not change when evidence changes

Current decision scope is safe only if `provenance.sourceFingerprint` changes whenever the effective review content changes.

Risk:

- orchestrator rebuilds bundle with better evidence;
- journal stamp stays equivalent because event count did not change or upgrade happened by rewriting a bundle/projection;
- UI token remains stable;
- stale decisions load.

Required behavior:

- `sourceFingerprint` must include evidence generation, not just event count;
- if a metadata event is upgraded or paired with snapshot evidence, fingerprint must include:

```text
journalStamp
bundle schema version
event ids
event sourceImportKey
latest before/after states
blob refs or blob hashes
contentAvailability/reviewability
relation
worktree identity
projection generation
```

- if upgrade happens without journal append, freshness/bundle stamp still needs a projection generation hash;
- stale bundle and rebuilt bundle cannot share the same source fingerprint if visible content differs.

Acceptance tests:

- same journal events, different snapshot-derived full text;
- source fingerprint changes;
- persisted decision scope token changes;
- old persisted decision is not loaded.

### UI3 - Collapsed state is keyed by task, not by evidence identity

Current collapsed file state is stored under a task/team key and pruned by `filePath`.
That is fine for pure UI convenience, but risky when the file identity changes while path stays the same.

Risk:

- metadata-only row is collapsed;
- full-text row replaces it with the same filePath;
- user never sees newly available hunks;
- two worktrees contain the same absolute-looking or normalized path and collapse state leaks.

Required behavior:

- collapsed state should be keyed by review identity, not raw filePath;
- at minimum, collapsed state must reset on `decisionScopeToken` change;
- worktree-scoped rows must include worktree identity in collapse key;
- relation rows should use relation review key, not just new path.

Acceptance tests:

- collapse metadata-only row, upgrade to full-text, row opens by default;
- collapse worktree A row, worktree B same relative path remains unaffected;
- rename relation collapse survives only if relation identity is unchanged.

### UI4 - File content cache is keyed by filePath only

Many renderer paths naturally use `filePath` as the lookup key.
That is dangerous when evidence for the same path changes.

Risk:

- `fileContents[filePath]` contains old metadata-only, disk-current, or legacy reconstructed content;
- activeChangeSet upgrades to ledger snapshot full text;
- UI renders one source label but applies another source's content;
- hunk context hashes are computed from stale fileContent.

Required behavior:

- file content cache must be invalidated when active change set identity changes;
- cache keys should include reviewKey or evidence fingerprint where practical;
- `fileContentVersionByPath` must be bumped on provenance/sourceFingerprint change;
- applying review must use file contents resolved for the same active decision token.

Acceptance tests:

- load legacy/git fallback content for a path;
- then load ledger snapshot content for same path;
- expected: content source label and actual fileContent match ledger snapshot;
- hunk context hashes are recomputed.

### UI5 - Late async response overwrites fresher detailed evidence

The UI can issue multiple requests:

```text
summary presence request
delayed task detail auto-load
manual open Changes
background OpenCode backfill
ledger reread after import
```

Risk:

- request A returns summary/no files;
- request B returns detailed ledger snapshot;
- late A overwrites B or resets activeChangeSet;
- UI shows `No file changes recorded` after changes were imported.

Required behavior:

- every change request must carry a monotonic request id and request signature;
- responses can update state only if they are still current for:

```text
teamName
taskId
includeDetails
requestSignature
ledger project dir
sourceFingerprint freshness
```

- detailed response must dominate older summary response for the same task;
- a lower-integrity response cannot replace a higher-integrity response unless it has a newer source fingerprint and explicit diagnostics.

Acceptance tests:

- force summary empty response to resolve after detailed has_changes response;
- expected: UI keeps detailed changes;
- force stale full-text response to arrive after newer regenerated bundle;
- expected: stale response is dropped.

### UI6 - `needs_attention` and metadata-only rows create misleading actions

The UI previously had cases where warning-only presence looked like a normal Changes action.
Hybrid evidence adds more diagnostic states.

Risk:

- unsupported OpenCode shape emits diagnostics only;
- task row shows normal Changes button/count;
- user opens diff expecting file rows and sees an empty state;
- or metadata-only row shows Accept/Reject as if it were full diff.

Required behavior:

- `has_changes` means visible file events exist;
- `needs_attention` means diagnostics without safe file rows;
- metadata-only file event can show Changes, but actions are manual-only or mark-reviewed, not unsafe reject;
- warning-only state must never inflate file count.

Acceptance tests:

- unsupported OpenCode shape -> needs_attention, no file count;
- metadata-only write -> Changes count 1, manual review row;
- full snapshot write -> Changes count 1, diff row with normal safe controls.

### UI7 - Relation string parsing is not safe as a durable identity format

Current review alias normalization parses relation-like strings:

```text
rename:old->new
copy:old->new
path:file
```

This is convenient, but paths can contain `->`, colons, backslashes, unicode normalization differences, or Windows drive prefixes.

Risk:

- persisted review state for a relation is parsed into the wrong old/new path;
- Windows path `C:\repo\a.ts` or a filename containing `->` collides with relation syntax;
- copy and rename state aliases normalize to the same key.

Required behavior:

- durable review identity should be opaque or length-prefixed, not parsed from display strings;
- keep display `changeKey` human-readable if useful, but persist decisions against an encoded review id;
- relation fields should be structured:

```ts
interface DurableReviewKey {
  kind: 'path' | 'rename' | 'copy'
  workspaceIdentity?: string
  oldPath?: string
  newPath: string
  eventIdentity: string
}
```

Acceptance tests:

- filename contains `->`;
- Windows drive path relation;
- unicode decomposed/composed path pair;
- persisted decision reload maps to exactly one intended row.

### UI8 - Hunk indices shift after CodeMirror or formatter changes

Hunk decisions currently use `reviewKey:index` plus context hashes.
That is acceptable only when context hashes are mandatory for any persisted hunk decision.

Risk:

- file changed on disk;
- formatter ran;
- evidence upgraded;
- hunk index still exists but refers to different content;
- partial reject applies wrong inverse patch.

Required behavior:

- persisted hunk decisions require matching context hash;
- if context hash missing, duplicated, or changed, hunk decision is cleared or blocked;
- partial reject for ledger snapshot must use inverse patch only after current hash guard passes;
- metadata-only, binary, relation, symlink, and missing-content hunks stay manual-only.

Acceptance tests:

- same hunk index with changed context hash clears decision;
- duplicated context hash blocks partial apply;
- formatter changes current disk hash, partial reject returns conflict.

### UI9 - Recent review writes and external change markers collide across worktrees

External file change detection and recent write suppression are often keyed by normalized file path.

Risk:

- two worktrees have paths that normalize the same on case-insensitive logic;
- a write in one suppresses external-change warning in another;
- UI misses a real conflict.

Required behavior:

- external change and recent write keys should include workspace/worktree identity where available;
- Windows drive-case normalization must not merge different volumes or WSL paths;
- review apply conflict remains hash-based, not watcher-based.

Acceptance tests:

- worktree A and B same relative file;
- review write in A does not suppress external change marker in B;
- case-only path pair on Windows fixture does not cross-clear if roots differ.

### UI10 - Apply result is counted as success for a no-op metadata decision

Accepting a metadata-only change can be semantically "leave current disk as is".
Rejecting it is not safe without before content.

Risk:

- UI sends an accepted metadata-only row;
- backend skips it;
- UI clears decisions and marks review complete;
- user thinks the change was actively applied or verified.

Required behavior:

- accepted metadata-only row may be `skipped` or `marked-reviewed`, but UI copy must not imply file mutation;
- rejected metadata-only row returns `manual-review-required`;
- bulk "Accept all" must distinguish full-text applied rows from metadata-only acknowledged rows.

Acceptance tests:

- accept all on mixed full-text + metadata-only rows;
- result shows applied count for full-text rows and manual/ack count for metadata-only rows;
- reject all returns manual-review-required for metadata-only row.

### UI11 - Detailed snippets missing but summary rows exist

TaskChangeLedgerReader can return a summary bundle when the journal is unavailable.
This preserves visibility, but it may not have enough snippets for review.

Risk:

- UI shows a file row from summary;
- fileContent resolver attempts to build diff from missing snippets;
- Accept/Reject buttons appear because a file exists;
- user sees an empty file section and assumes no changes.

Required behavior:

- summary-only file rows are displayable but not auto-reviewable unless full text refs are present and resolvable;
- UI must render "summary available, details unavailable" as a degraded state;
- action availability comes from `reviewability`, not from `files.length > 0`.

Acceptance tests:

- bundle exists, journal missing;
- row renders with diagnostics;
- reject returns manual-review-required or unavailable;
- no generic "No text changes" message for ledger summary-only rows.

### UI12 - Source labels become stale after upgrade

The renderer labels content as:

```text
Task Ledger
Ledger Snapshot
Reconstructed
Git Fallback
Current Disk
Content unavailable
```

Risk:

- metadata-only OpenCode fallback upgrades to snapshot;
- stale fileContent remains labeled `Content unavailable`;
- or full snapshot content is shown under generic `Task Ledger`;
- user cannot tell why a row is safe or manual-only.

Required behavior:

- source label must be derived from active snippet/content provenance, not previous cache;
- full-text OpenCode snapshot rows should label as `Ledger Snapshot`;
- exact file tool rows should label as `Task Ledger`;
- metadata-only should label as manual review with reason.

Acceptance tests:

- metadata-only -> snapshot upgrade updates label;
- exact Claude ledger row remains `Task Ledger`;
- fallback reconstructed row never appears for ledger-primary OpenCode task unless ledger is absent.

## UI Review State Options

Top 3 options:

1. First-class evidence identity in renderer state - 🎯 9.1   🛡️ 9.4   🧠 7.2 - roughly 800-1600 LOC.

   Add explicit evidence identity to review keys, content cache invalidation, decision scope, collapsed state, and async response guards. Best long-term design. Required before claiming very high confidence for automatic review actions after evidence upgrade.

2. Conservative reset on any sourceFingerprint/content hash change - 🎯 8.5   🛡️ 9.0   🧠 3.5 - roughly 250-600 LOC.

   Easier and safe. Reset decisions, hunk hashes, file content cache, and collapsed state whenever source fingerprint or file hash set changes. This is less polished, but it prevents stale actions. Good first implementation if speed matters.

3. Keep path/changeKey state and rely on current scope token only - 🎯 5.0   🛡️ 5.5   🧠 2.0 - roughly 0-150 LOC.

   Reject this for default-on hybrid evidence. It is too easy to keep stale decisions when metadata-only rows become full-text rows with the same visible identity.

Chosen policy:

```text
implement option 2 as the minimum safety gate
move toward option 1 for durable production polish
do not ship option 3 as default-on behavior
```

## UI Review State Stop-Ship Gates

Add these to the merge gate:

1. Metadata-only persisted decision can survive full-text snapshot upgrade.
2. `sourceFingerprint` can stay unchanged while visible review content changes.
3. Collapsed state can hide newly upgraded full-text hunks.
4. File content cache can mix legacy/git fallback content with ledger snapshot rows.
5. Late summary/no_changes response can overwrite fresher detailed has_changes response.
6. `needs_attention` can render as a normal file-change count.
7. Metadata-only Reject button is enabled.
8. Relation durable key is parsed from ambiguous display text.
9. Hunk decision can apply without matching context hash.
10. External change marker suppression crosses worktree identity.
11. Summary-only ledger row shows normal auto-review actions.
12. Content source label can remain stale after evidence upgrade.
13. Bulk accept clears metadata-only rows as if they were applied file mutations.
14. Worktree path or provenance is omitted from decision identity.
15. UI request cache key ignores evidence mode, includeDetails, or task request signature.

## OpenCode Snapshot Git Store Lifecycle, Race, And Cost Risk Drilldown

The OpenCode snapshot source is not just a static artifact. It is an internal git store with its own lifecycle.
From inspected OpenCode source:

```text
snapshot gitdir = Global.Path.data/snapshot/<project.id>/<Hash.fast(worktree)>
snapshot enabled only when project.vcs === "git" and config.snapshot !== false
track() lazily initializes gitdir and runs git add + git write-tree
patch(hash) calls add() again before listing files
cleanup() runs git gc --prune=7.days every hour after startup delay
large untracked files over 2 MiB are excluded from snapshot indexing
ignored files are removed or hidden from snapshot output
```

This means the bridge must treat snapshot evidence as durable enough to read, but not as a database with transactional guarantees.
The safe policy is:

```text
read snapshot objects only
never mutate the OpenCode snapshot store
retry short transient races
degrade to metadata-only/manual-review when evidence is missing or unsupported
```

### SG1 - OpenCode `git gc --prune=7.days` races with our reader

Risk:

- SQLite has `step-start.snapshot` and `step-finish.snapshot`;
- OpenCode cleanup is running or has pruned unreachable objects;
- our reader starts `git diff` or `git cat-file`;
- object is missing mid-read.

Bad outcome:

- bridge reports clean no changes;
- or partially reads before from old object and after from missing object;
- or caches missing object as permanent no-history.

Required behavior:

- missing object is never `no_changes`;
- if session DB appears fresh or process may still be active, return transient diagnostic:

```text
snapshot-object-missing
snapshot-diff-read-failed
```

- retry on next detailed open or after short TTL;
- if old/pruned, degrade to metadata-only/manual-review for proven toolpart paths;
- never run `git gc`, `git fsck --lost-found`, `git init`, or OpenCode `track()` to repair evidence.

Acceptance tests:

- cat-file missing object after raw diff -> metadata-only with transient diagnostic;
- second run with object restored upgrades to full-text;
- old/pruned fixture does not retry forever and stays manual-only.

### SG2 - `patch(hash)` mutates snapshot index and must stay out of production

OpenCode `patch()` calls `add()` before computing file list.
That is useful for OpenCode's own undo flow but unsafe for our passive reader.

Risk:

- bridge calls debug or patch APIs during UI auto-backfill;
- current disk state is staged into snapshot index;
- evidence boundary is changed by the act of reading it;
- later OpenCode restore/revert behavior can be affected.

Required behavior:

- production bridge uses only read-only git commands against the snapshot gitdir;
- live smoke may call OpenCode as a user process, but the reader itself must not call:

```text
opencode debug snapshot track
opencode debug snapshot patch
git add
git write-tree
git update-index
git read-tree
git checkout-index
git gc
git init
```

- snapshot provider tests should assert a command allowlist.

Acceptance tests:

- process-spawn spy around snapshot provider sees only `git diff`, `git cat-file`, and optional read-only validation;
- UI auto-backfill path cannot invoke debug snapshot commands.

### SG3 - Session directory pathspec can hide valid writes outside cwd

OpenCode snapshot commands use `cwd: state.directory` with pathspec `"."`.
The snapshot gitdir is keyed by `state.worktree`, but diff scope may be the session directory.

Risk:

- OpenCode is launched from a subdirectory;
- toolpart writes `../parent.ts` or an absolute path in the same worktree;
- snapshot window exists, but raw diff scoped to `"."` from `session.directory` misses that file;
- bridge reports metadata-only or no changes.

Required behavior:

- do not widen scope by scanning the whole worktree unless attribution is exact;
- if toolpart proves a path outside session directory but inside project worktree, treat snapshot evidence as unsupported for that path and import metadata-only;
- diagnostics must say path was outside snapshot pathspec scope, not "no change";
- future targeted baseline can handle this better.

Acceptance tests:

- session directory is `repo/packages/a`;
- toolpart writes `repo/packages/b/file.ts`;
- no snapshot full-text upgrade;
- metadata-only event appears if strict toolpart path is proven.

### SG4 - Ignored files are intentionally removed from snapshot evidence

OpenCode checks ignore rules and removes ignored files from snapshot index/output.

Risk:

- toolpart writes `.env.local`, generated file, ignored cache, or ignored build artifact;
- OpenCode snapshot intentionally hides it;
- bridge interprets missing snapshot path as no change.

Required behavior:

- if strict-delivery toolpart path is proven, missing snapshot path becomes metadata-only/manual-review;
- diagnostic:

```text
snapshot-path-ignored-or-not-indexed
```

- do not try to bypass ignore rules by reading disk current content as full diff;
- do not auto apply/reject.

Acceptance tests:

- ignored file write with snapshot enabled imports metadata-only;
- ignored file delete imports metadata-only if lifecycle is proven;
- no broad workspace scan.

### SG5 - Large file handling differs for tracked and untracked files

OpenCode source blocks large untracked files over its limit by adding them to snapshot exclude.
Tracked large files may still flow through git depending on how they are represented.

Risk:

- untracked large file write is absent from snapshot;
- tracked large file produces a huge blob;
- our reader reads too much memory or creates an unusable diff;
- UI stalls during auto-backfill.

Required behavior:

- apply our own caps regardless of OpenCode's limit;
- do not assume OpenCode's 2 MiB policy is enough;
- before `cat-file` content read, inspect object size from batch header and enforce:

```text
maxBlobBytesPerFile
maxTotalBlobBytes
maxFilesPerBackfill
maxSnapshotDiffBytes
timeoutMs
```

- over-cap becomes metadata-only/manual-review with diagnostic.

Acceptance tests:

- untracked file above OpenCode limit -> metadata-only;
- tracked large blob above our cap -> metadata-only without loading full bytes;
- many small files hit total cap and return partial diagnostics.

### SG6 - Snapshot gitdir lazy initialization creates transient missing-gitdir state

`track()` initializes the snapshot gitdir only when snapshot is enabled and first used.
SQLite parts may exist around a time where the store is still not readable by our process.

Risk:

- UI opens Changes while OpenCode is finishing a step;
- SQLite row is visible before gitdir/object files are fully flushed;
- first backfill caches `snapshot-gitdir-missing`;
- task stays degraded after OpenCode completes.

Required behavior:

- `snapshot-gitdir-missing` is transient for fresh sessions;
- cache short TTL only;
- detailed open should retry;
- if snapshot gitdir is still missing after session age threshold, degrade stable metadata-only with diagnostic.

Acceptance tests:

- first read: DB has snapshot part, gitdir absent -> transient diagnostic, no final no_changes cache;
- second read: gitdir appears -> full-text upgrade;
- old DB with missing gitdir -> metadata-only stable diagnostic.

### SG7 - Internal OpenCode semaphore does not protect our external reader

OpenCode locks snapshot operations inside its process with an in-memory semaphore.
Our bridge runs outside that semaphore.

Risk:

- OpenCode is writing tree/index while bridge reads;
- git command returns lock error, partial data, or nonzero exit;
- bridge treats it as unsupported forever.

Required behavior:

- snapshot read failures caused by lock/nonzero git exit are transient unless repeated past TTL;
- retry with small backoff inside one backfill only when cheap;
- cap retries to avoid UI stalls;
- diagnostics include command class and exit code, not raw stderr with paths/content.

Acceptance tests:

- fake git returns lock error once, then succeeds;
- provider retries and succeeds within cap;
- repeated lock error returns transient diagnostic and metadata-only fallback.

### SG8 - Symlinks, submodules, and gitlinks are not normal text files

OpenCode config sets `core.symlinks=true`, so snapshot git can store symlinks as symlink blobs and submodules as gitlinks.

Risk:

- symlink blob content is the link target, not file contents;
- apply/reject writes link target text into a normal file;
- submodule/gitlink appears as a mode change;
- UI renders meaningless diff.

Required behavior:

- raw diff parser must inspect file mode;
- symlink mode `120000`, gitlink mode `160000`, tree/directory modes are metadata-only/manual-review;
- do not dereference symlink targets for evidence;
- do not auto apply/reject symlink or submodule snapshot rows.

Acceptance tests:

- symlink target change becomes metadata-only or explicit symlink metadata row;
- submodule pointer change becomes metadata-only;
- normal file mode `100644` and `100755` remain eligible for text if content is valid.

### SG9 - Git object id algorithm may change in future git stores

Our planned raw object reader requires 40 hex object ids.
That is correct for current OpenCode snapshot git stores, which are initialized as normal SHA-1 git repositories.

Risk:

- future OpenCode or Git uses SHA-256 object format;
- raw diff contains 64-char ids;
- bridge rejects all full-text evidence.

Required behavior:

- current implementation may fail closed on non-40 ids;
- diagnostic should be explicit:

```text
snapshot-object-id-algorithm-unsupported
```

- do not silently truncate 64-char ids;
- do not accept abbreviated ids;
- future support can add object-format detection with tests.

Acceptance tests:

- 64-char raw id fixture returns unsupported algorithm diagnostic;
- 12-char abbreviated id returns malformed raw diff diagnostic;
- no file event is imported as full-text from unsupported ids.

### SG10 - Snapshot store disk growth can become a product issue

No feature flag means new OpenCode sessions will write snapshots by default.
OpenCode docs already warn that large repos and many submodules can make indexing slow and disk-heavy.

Risk:

- users see app slowdown and blame task changes;
- background OpenCode snapshot indexing competes with UI backfill;
- snapshot store grows beyond expectations;
- disabling snapshot later regresses full diffs.

Required behavior:

- do not hide this as implementation detail;
- add diagnostics and release notes:

```text
snapshot enabled for OpenCode git sessions
large/ignored/unsupported files degrade to manual review
snapshot store size may grow under OpenCode data dir
```

- add internal debug summary with counts, not content:

```text
snapshotGitdirExists
snapshotWindowCount
rawDiffFileCount
fullTextImportedCount
metadataOnlyCount
capExceededCount
durationMs
```

- do not auto-delete OpenCode snapshot stores from our app.

Acceptance tests:

- stress fixture records cap diagnostics;
- diagnostic summary redacts paths/content where required;
- no cleanup command mutates OpenCode snapshot store.

### SG11 - Snapshot evidence can be older than current disk

Snapshot blobs represent OpenCode step boundaries, not current disk.
That is exactly what we need for review, but apply/reject must compare against current disk before mutating.

Risk:

- snapshot row shows exact before/after;
- user or another agent changed file after OpenCode step;
- UI applies reject based on old snapshot after content;
- current changes are overwritten.

Required behavior:

- ReviewApplier must use ledger `afterState.sha256` as current disk guard;
- if current disk hash differs, return conflict;
- if current file missing and afterState says exists, conflict unless operation-specific already-missing success is explicitly safe;
- current disk must not be used to "refresh" snapshot evidence.

Acceptance tests:

- snapshot full-text row, current file changed -> reject conflict;
- snapshot create row, file already deleted -> reject success only for create delete policy;
- snapshot delete row, file recreated -> conflict.

### SG12 - Snapshot-only files are tempting but must remain diagnostic-only

The snapshot diff can contain files changed by formatter hooks, background writes, or other tools within the same OpenCode step.
If no supported toolpart proves the path, importing those files is false attribution.

Risk:

- snapshot diff contains `src/b.ts`;
- toolpart proves only `src/a.ts`;
- bridge imports `src/b.ts` because it is in the same snapshot window;
- user sees unrelated changes under the task.

Required behavior:

- snapshot-only paths are diagnostics only;
- imported file must be both:

```text
strict-delivery matched toolpart candidate
present in raw snapshot diff for the same window
```

- future delivery-window git snapshot layer can cover hook/formatter files, but this OpenCode bridge should not.

Acceptance tests:

- snapshot diff has two paths, toolpart proves one;
- imported rows contain one path only;
- diagnostics mention excluded snapshot-only path count without raw content.

## Snapshot Git Store Options

Top 3 options for this layer:

1. Strict read-only snapshot git provider with transient retry and caps - 🎯 9.0   🛡️ 9.3   🧠 7.6 - roughly 900-1800 LOC.

   Best. It treats OpenCode snapshot store as an external read-only artifact, handles races, enforces caps, and degrades safely.

2. Use OpenCode debug/patch/diff commands for production evidence - 🎯 4.0   🛡️ 4.2   🧠 5.5 - roughly 600-1200 LOC.

   Reject for production. It is tempting because OpenCode exposes commands, but `patch()` can mutate snapshot state and output is not a stable machine contract.

3. Ignore snapshot lifecycle races and rely on one-shot read - 🎯 5.3   🛡️ 5.0   🧠 2.5 - roughly 200-500 LOC.

   Too weak for default-on. It will create persistent false negatives when UI opens Changes while OpenCode is still writing or gc/pack operations are running.

Chosen policy:

```text
implement option 1
never use option 2 in UI auto-backfill
do not ship option 3 as default-on
```

## Snapshot Git Store Stop-Ship Gates

Add these to the merge gate:

1. Production snapshot provider can run mutating git or OpenCode snapshot commands.
2. Missing snapshot object is cached as final no_changes.
3. Snapshot gitdir missing for fresh session is cached as permanent unsupported.
4. Ignored or large proven toolpart path disappears instead of metadata-only.
5. Snapshot reader reads blobs before checking per-file and total caps.
6. Symlink or gitlink snapshot row becomes auto-reviewable text.
7. Snapshot-only path without toolpart proof becomes a file event.
8. Git lock/nonzero transient error becomes stable empty result.
9. `session.directory` pathspec miss is reported as no change.
10. 64-char or abbreviated object ids are accepted without explicit algorithm support.
11. Current disk mismatch after snapshot row can still be overwritten by reject.
12. Diagnostics include raw file content, prompt text, or patch body.
13. Our app attempts to repair or cleanup OpenCode snapshot gitdir.
14. Stress fixture can exceed UI auto-backfill time or memory caps.
15. Snapshot store size/cost has no developer-facing diagnostic summary.

## Additional Stop-Ship Gates From Task Lifecycle And Recovery Review

Add these to the merge gate:

1. Task display id reuse can attach old OpenCode events to a new task.
2. App restart can cause fallback to selected/current UI task.
3. Assistant comment text can create a file row.
4. Owner change after delivery can hide real delivery-matched events.
5. Owner change after delivery can scan unrelated members in strict UI mode.
6. Multiple active scopes can produce duplicate file events.
7. Related/blocked tasks can inherit file changes from the subject task.
8. Backfill timeout can cache empty terminal result without ledger reread.
9. Empty task logs can prevent OpenCode ledger backfill.
10. Reopen/review cache does not invalidate stale completed summary.
11. Changes section is hidden for completed/review tasks with unknown presence.
12. Loading summary state is rendered as final count `0`.
13. Warning-only `needs_attention` is rendered as a normal diff action.
14. Negative presence cache survives a successful ledger import.
15. Summary-only response can become active detailed change set.

### No-Feature-Flag Merge Gate

Because there is no feature flag and no legacy default path, merge must be blocked unless all of this is true:

1. Default UI request no longer sends `chain-only`.
2. Orchestrator default OpenCode backfill calls `readSessionEvidence`.
3. `snapshotBoundary` is ignored for full-text production evidence.
4. Managed OpenCode config writes `snapshot:true` for new sessions.
5. Auth-independent SQLite + snapshot gitdir fixture proves full-text path.
6. Metadata-first then snapshot-upgrade fixture shows one visible UI row.
7. Renderer persisted decisions reset on hash/provenance change.
8. Non-OpenCode task ledger tests pass unchanged.
9. Windows path fixture matrix passes.
10. `git diff --check` passes in both repos.

If any gate is not true:

```text
do not merge default-on behavior
finish the missing gate first
```

Live OpenCode model smoke:

- Should be run before declaring 9.5+ confidence.
- CI can skip it without auth.
- Local/manual release gate should require it once credentials are available.
- If auth returns 401, that blocks only the 9.5+ confidence claim, not the auth-independent fixture gate.

### Updated Risk-Weighted Options

1. **Implement full projection and default snapshot path now** - 🎯 8.7   🛡️ 9.1   🧠 8.8 - ~3200-5600 LOC.
   Best if we accept a larger test surface. This gives Cursor-like full diffs where OpenCode snapshots exist and keeps metadata-only for unsupported cases.

2. **Implement only snapshot reader, keep metadata-only imports non-upgradable** - 🎯 7.2   🛡️ 8.3   🧠 6.4 - ~1800-3200 LOC.
   Lower risk but leaves old degraded events stuck. Not good enough for the user-visible problem where opening Changes too early can permanently lock in manual-review.

3. **Delay snapshot path and build targeted gitless baseline first** - 🎯 6.8   🛡️ 8.8   🧠 9.0 - ~3000-6000 LOC.
   Safer for non-git eventually, but it ignores OpenCode's own snapshot facts and takes longer to get proper full diffs for git projects.

Recommended remains option 1, but only with the P0/P1 gates above.

## Enricher Rules

Direct full-text upgrade:

| Candidate operation | Snapshot row | Required |
| --- | --- | --- |
| create | added | `beforeState.exists === false`, `afterContent` present |
| modify | modified | `beforeContent` and `afterContent` present |
| delete | deleted | `beforeContent` present, `afterState.exists === false` |

Inverse upgrade:

| Candidate | Anchor | Required |
| --- | --- | --- |
| edit metadata-only | snapshot afterContent | unique `newString`, reverse verifies forward |
| apply_patch update | snapshot afterContent | hunks reverse exactly once and forward verify |

Forbidden:

- operation mismatch;
- path not in touched set;
- snapshot row only, no reconstructed candidate;
- more than one reconstructed candidate for the same `(snapshotWindow, relativePath)` unless a future composer proves the chain exactly;
- repeated snippet;
- binary row;
- large row;
- outside workspace;
- case-colliding path group.

### Same Path Multiple Toolparts

Snapshot diff is window-level, not toolpart-level. If two or more OpenCode toolparts touch the same relative path inside one snapshot window, then the snapshot before/after is cumulative for the whole window.

V1 rule:

```text
snapshot full-text upgrade requires exactly one reconstructed candidate for (windowId, relativePath)
```

If there are multiple candidates:

- keep any already exact chain-derived events as-is;
- keep metadata-only events manual-only;
- add diagnostic `snapshot-window-path-ambiguous`;
- do not assign the window-level snapshot diff to one arbitrary toolpart.

Future option:

**Window path composer** - 🎯 7.8   🛡️ 8.8   🧠 8.4 - ~700-1400 LOC.
Compose ordered toolpart changes for the same path and verify final content equals snapshot `afterContent`. Only then emit one cumulative event or a verified sequence. Do not include this in the next implementation unless tests show same-window multi-touch is common.

## OpenCode Snapshot Limitations

### Git Only

OpenCode snapshots return disabled when project VCS is not git.

Therefore:

```text
non-git OpenCode full diffs require future targeted baseline layer
```

Variant 1 metadata-only still helps non-git.

### Large Files

OpenCode source has `limit = 2 * 1024 * 1024` and blocks large untracked files from snapshot index. Our ledger cap can be lower or equal.

Plan:

- cap at existing ledger text blob size;
- if OpenCode snapshot does not contain file text, metadata-only;
- do not try to recover large files from disk.

### Renames

OpenCode `diffFull` uses `--no-renames`.

Plan:

- first implementation follows OpenCode: treat rename as delete/create or metadata-only;
- do not invent semantic rename.

### Binary

OpenCode marks binary through `numstat` `- -`.

Plan:

- binary metadata-only;
- manual review required.

## Remove `snapshotBoundary` From Production Evidence

Current `OpenCodeSnapshotBoundary` is status-only and was useful while the bridge had no source-driven snapshot reader. It should not remain in the production evidence path.

Final rule:

```text
SQLite step windows are the only snapshot boundary used for OpenCode full-text evidence.
```

Implementation:

- stop passing `snapshotBoundary` into `OpenCodeChangeEvidenceEnricher`;
- delete or quarantine `readBoundaryEvidence` tests;
- keep old delivery records readable, but ignore their `snapshotBoundary` field for full-text evidence;
- diagnostics should explain missing SQLite windows directly, not via `snapshot-disabled` boundary status.

Why:

- `snapshotBoundary` does not prove exact OpenCode step timing;
- `snapshotBoundary` status can be stale relative to SQLite;
- keeping two boundary sources increases ambiguity and duplicate test surface;
- removing it matches the no-legacy product decision.

## Implementation Phases

### Phase 0 - Update Tests For Source-Driven Plan

Add tests that assert:

- old status-only `snapshotBoundary` records are ignored for full-text evidence;
- step-start/step-finish parts can unlock full-text when provider proves content;
- no snapshot window for source message keeps metadata-only;
- snapshot row without reconstructed candidate is ignored.

Files:

```text
src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts
src/services/opencode/OpenCodeLedgerBridgeService.test.ts
src/services/opencode/OpenCodeOfflineSessionReader.test.ts
```

### Phase 1 - Extract Snapshot Parts In Offline Reader

Modify:

```text
src/services/opencode/OpenCodeOfflineSessionReader.ts
```

Add:

```ts
snapshotStepParts: OpenCodeSnapshotStepPart[]
patchParts: OpenCodePatchPart[]
snapshotWindows: OpenCodeSnapshotWindow[]
sessionIdentity: OpenCodeSqliteSessionIdentity | null
```

SQL additions:

```sql
select id, project_id, directory from session where id = ?
select id, worktree, vcs from project where id = ?
```

Use a single read transaction for all rows:

```text
BEGIN
read session identity
read project identity
read bounded message rows
read bounded part rows
COMMIT
```

Do not read identity outside the transaction. Otherwise a newly created session can race with message/part reads and produce a snapshot gitdir for a different DB state.

Need guard:

- if `session` or `project` table missing, history shape remains supported but snapshot evidence unsupported with diagnostic;
- do not fail whole OpenCode backfill because snapshot identity is missing.
- if `session.project_id` references a missing project row, keep toolpart reconstruction and mark snapshot evidence unsupported;
- if `session.directory` is not same-or-descendant of `project.worktree`, keep toolpart reconstruction and mark snapshot evidence unsupported;
- if `record.projectPath` or trusted `workspaceRoot` differs from `project.worktree`, keep toolpart reconstruction and mark snapshot evidence unsupported;
- if `project.vcs` is null/unknown, do not assume git. Snapshot evidence is unsupported unless snapshot parts plus gitdir validation prove otherwise in a future compatibility mode.
- if part ordering has duplicate `(time_created, id)` or missing ids, keep raw toolpart reconstruction and mark only snapshot windows unsupported;
- if a toolpart lands outside all windows, keep it existing toolpart-chain result or metadata-only.

Tests:

- extracts step-start/finish.
- extracts patch part.
- builds one window per assistant message.
- malformed snapshot part diagnostic only.
- missing project table diagnostic only.
- non-git project marks snapshot unsupported.
- session/project identity is read in the same transaction as messages/parts.
- `summary_diffs` is ignored for primary evidence.
- project row missing does not mark toolpart history unsupported.
- `project.worktree` mismatch produces `snapshot-project-worktree-mismatch`.
- `session.directory` outside `project.worktree` produces `snapshot-session-directory-outside-worktree`.
- subdirectory session runs git diff with `cwd=session.directory` and raw paths stay worktree-relative.
- two step windows in one assistant message are paired by part order.
- toolpart between window A start/finish uses only window A snapshot hashes.
- toolpart outside windows is not snapshot-upgraded.
- first-start/last-finish is never used for task evidence.

### Phase 2 - Add Snapshot Git Store Reader

New file:

```text
src/services/opencode/OpenCodeSnapshotGitStoreReader.ts
src/services/opencode/OpenCodeSnapshotGitStoreReader.test.ts
```

Test without OpenCode:

- create a temp internal git dir;
- commit/tree or write trees manually;
- call reader with from/to tree hashes;
- verify create/modify/delete output.

Use git commands:

```bash
git --git-dir <gitDir> --work-tree <worktree> init
git --git-dir <gitDir> --work-tree <worktree> add --all
git --git-dir <gitDir> --work-tree <worktree> write-tree
```

This is test setup only. Production reader uses read-only commands.

Reader tests:

- modify text returns before/after.
- create returns before absent.
- delete returns after absent.
- binary returns metadata-only.
- large file cap returns metadata-only.
- path outside touched set ignored.
- timeout returns unsupported/transient diagnostic.
- invalid hash rejected.
- missing git dir unsupported.
- case collision fail closed.
- CRLF preserved exactly.
- raw `-z` parser supports spaces, unicode, tab, colon, leading dash, and newline in filenames.
- raw parser rejects abbreviated object ids unless test command explicitly uses `--abbrev=40`.
- raw parser test proves `--full-index` alone is not accepted as the object-id-width guard.
- invalid UTF-8 path bytes are skipped with diagnostic.
- raw object ids are used for blob fetch, not `tree:path` refs.
- deleted file fetches only old object id.
- created file fetches only new object id.
- typechange is metadata-only unless explicitly supported.
- symlink mode `120000` is metadata-only and never dereferenced.
- submodule/gitlink mode `160000` is metadata-only.
- chmod-only mode change is metadata-only with `snapshot-mode-only-change`.

### Phase 3 - Add Session-Part Snapshot Evidence Provider

New or updated file:

```text
src/services/opencode/OpenCodeSnapshotEvidenceProvider.ts
```

Provider input should include:

```ts
record: OpenCodeSessionRecord
offline: OpenCodeOfflineSessionReadResult
changes: ReconstructedOpenCodeToolChange[]
```

This is better than the current provider input, because provider needs snapshot windows and session identity.

Replace the old provider contract with a session-aware contract. Do not keep `readBoundaryEvidence` in production.

Required interface shape:

```ts
export type SnapshotSessionEvidenceInput = {
  workspaceRoot: string
  sessionRecord: OpenCodeSessionRecord
  offline: OpenCodeOfflineSessionReadResult
  changes: ReconstructedOpenCodeToolChange[]
  touchedRelativePaths: string[]
}

export interface OpenCodeSnapshotEvidenceProvider {
  readonly adapterVersion: number
  probe(input: SnapshotProbeInput): Promise<OpenCodeSnapshotProbeResult>
  readSessionEvidence(input: SnapshotSessionEvidenceInput): Promise<OpenCodeSnapshotEvidenceResult>
}
```

Migration rule:

- `readSessionEvidence` is the production path.
- `OpenCodeChangeEvidenceEnricher` must not require `isCapturedSnapshotBoundary()` when `offline.snapshotWindows` exist.
- status-only `snapshotBoundary` is removed from the production provider path.

Provider algorithm:

```ts
const changesByMessage = group changes by sourceMessageId
for each messageId:
  window = offline.snapshotWindows.find(w => w.messageId === messageId)
  if no window: continue
  read git diff from window.fromSnapshot to window.toSnapshot
  filter to touched paths for that message
  produce evidence files
```

Diagnostics:

- `snapshot-window-missing`
- `snapshot-project-identity-missing`
- `snapshot-project-not-git`
- `snapshot-project-worktree-mismatch`
- `snapshot-session-directory-outside-worktree`
- `snapshot-gitdir-missing`
- `snapshot-diff-read-failed`
- `snapshot-path-not-touched`
- `snapshot-window-path-ambiguous`
- `snapshot-mode-only-change`

### Phase 4 - Wire Provider Into Ledger Bridge

Modify:

```text
src/services/opencode/OpenCodeLedgerBridgeService.ts
src/services/opencode/OpenCodeChangeEvidenceEnricher.ts
```

Current flow:

```ts
const enrichedChanges = await this.evidenceEnricher.enrich({
  changes: reconstructed.changes,
  workspaceRoot,
  sessionRecord: record,
  evidenceMode,
  snapshotBoundary: getSnapshotBoundaryForRecord(deliveryContext, record),
  snapshotProvider: this.snapshotEvidenceProvider,
})
```

Update:

```ts
const enrichedChanges = await this.evidenceEnricher.enrich({
  changes: reconstructed.changes,
  workspaceRoot,
  sessionRecord: record,
  offline,
  snapshotProvider: this.snapshotEvidenceProvider,
  evidenceMetadata,
  diagnostics: result.diagnostics,
})
```

Only run provider when:

```text
strict delivery mode has matched records
offline.snapshotWindows.length > 0
changes.length > 0
```

Important current-code change:

```text
remove old requirements:
  isCapturedSnapshotBoundary(snapshotBoundary)
  evidenceMode === 'snapshot-auto'

replace with direct default:
  offline snapshot window evidence
```

Expected priority:

1. `readSessionEvidence` from SQLite step windows.
2. Toolpart-chain reconstruction where it already proves full text.
3. Metadata/manual-review fallback.

If provider throws:

```text
diagnostic + original reconstructed changes
```

### Phase 4.5 - Evidence Upgrade Projection

Modify:

```text
src/services/taskChangeLedger/TaskChangeLedgerService.ts
src/services/taskChangeLedger/TaskChangeLedgerService.test.ts
```

Goal:

```text
metadata-only first import can be upgraded to snapshot full-text without duplicate UI rows
```

Implementation:

1. Extend existing-source lookup from `Set<string>` to projected metadata:

```ts
type ExistingSourceImportProjection = {
  sourceImportKey: string
  eventId: string
  evidenceProof?: OpenCodeEvidenceProof
  evidenceRank: number
  taskId: string
  relativePath: string
  sourceSessionId?: string
  sourcePartId?: string
  sourceMessageId?: string
  operation: TaskChangeOperation
}
```

2. Add upgrade decision:

```ts
function shouldAppendEvidenceUpgrade(existing, incoming): boolean {
  return incoming.evidenceRank > existing.evidenceRank &&
    sameSourceIdentity(existing, incoming) &&
    compatibleOperation(existing, incoming)
}
```

3. Append upgrade event with `supersedesEventId`.

4. Update bundle projection to collapse same `sourceImportKey` to the strongest event.

5. Move duplicate/upgrade decision inside the task writer lock:

```ts
export async function importTaskChangeLedgerEvents(params) {
  const safeChanges = await validateAndMaterialize(params.changes)
  let result = emptyImportResult()

  await enqueueTaskWrite(params.scope.taskId, async () => {
    await runTaskLedgerWrite({
      scope: params.scope,
      sessionId: params.sessionId,
      agentId: params.agentId,
      toolUseId: safeChanges[0]?.toolUseId ?? 'opencode-import',
      projectDir,
      write: async () => {
        const existing = await readExistingSourceImportProjection(params.scope.taskId, projectDir)
        const planned = await planOpenCodeImportEvents(existing, safeChanges)
        for (const event of planned.events) {
          await appendEvent(event, projectDir)
        }
        result = planned.result
      },
    })
  })

  return result
}
```

Do not read existing `sourceImportKey` state before the lock for final duplicate decisions. Pre-lock reads are allowed only for cheap diagnostics that cannot affect append/skip behavior.

6. Make upgrade event ids stable and distinct:

```ts
function buildImportedUpgradeEventId(input: {
  sourceImportKey: string
  evidenceProof: string
  snapshotId?: string
  beforeSha?: string
  afterSha?: string
  revision: number
}): string {
  return `opencode-import-upgrade-${sha256(JSON.stringify(input)).slice(0, 32)}`
}
```

7. Project before summary grouping:

```ts
const projection = projectTaskChangeEventsForSummary(events)
const summaryEvents = projection.events

for (const event of summaryEvents) {
  addToAccumulator(event)
}
```

8. Keep audit fields explicit:

```ts
type TaskChangeSummaryBundleV2 = {
  eventCount: number              // raw journal event count
  projectedEventCount?: number    // visible/projected event count
}

type TaskChangeSummaryFileV2 = {
  eventCount: number              // projected event count for this visible row
  journalEventCount?: number      // raw grouped event count if different
}
```

If adding optional counts is too much for this phase, document that bundle `eventCount` is raw and file `eventCount` is projected. Do not silently mix semantics.

Keep journal append-only. Do not rewrite old journal entries.

Extra tests:

- duplicate decision happens inside writer lock, proven by concurrent import test.
- upgrade id differs from base id and survives journal dedupe.
- `sourceImportKey` projection does not touch non-OpenCode events.
- `projectedEventCount` and line stats do not double count superseded events.
- malformed base event plus valid upgrade still projects upgrade.
- weaker event after stronger event is ignored.
- operation mismatch emits diagnostic and does not upgrade.

### Phase 5 - UI Uses New Default Path

UI/main process changes:

```text
remove OPEN_CODE_AUTO_BACKFILL_EVIDENCE_MODE = 'chain-only'
remove CLAUDE_TEAM_OPENCODE_EVIDENCE_MODE handling if it exists
ChangeExtractorService always requests OpenCode default evidence path
```

Expected command contract:

```ts
opencode.backfillTaskLedger({
  attributionMode: 'strict-delivery',
  // no evidenceMode field, or evidenceMode is ignored/deleted in orchestrator
})
```

Renderer behavior:

- Changes section loads through the same default auto-backfill path.
- No UI toggle.
- No hidden env flag.
- If full-text evidence is unavailable, UI sees the same metadata-only/manual-review ledger shape as today.

Tests:

- `ChangeExtractorService` no longer sends `chain-only`.
- UI fixture with snapshot evidence renders full-text diff.
- UI fixture with missing snapshot evidence renders manual-review metadata state.
- Existing non-OpenCode ledger fixture still renders unchanged.

Decision-state tests:

- Open metadata-only fixture, persist a file decision, then load upgraded fixture with the same `changeKey` and different hashes. Decision state must be empty.
- Open full-text fixture twice with the same source fingerprint. Decision state must persist.
- Open upgraded fixture where only task-level warning count changed and file hashes did not change. Hunk decisions must persist.
- Open upgraded fixture where hunk context hashes changed. Hunk decisions must reset even if file path and `changeKey` stayed the same.

UI source fingerprint requirement:

```text
sourceFingerprint must change when projected OpenCode winner changes
sourceFingerprint must not change only because raw superseded journal event order changed
```

That means fingerprint should be based on projected summary identity, not raw journal line order alone:

```ts
sourceFingerprint = sha256(JSON.stringify({
  journalStamp,
  projectedFiles: files.map(file => ({
    changeKey: file.changeKey,
    latestBeforeHash: file.latestBeforeHash,
    latestAfterHash: file.latestAfterHash,
    reviewability: file.reviewability,
    contentAvailability: file.contentAvailability,
    sourceImportKeys: file.ledgerSummary?.sourceImportKeys,
  })),
}))
```

If `sourceImportKeys` are not exposed to UI, use projected event ids in bundle provenance. Do not use raw event ids that include superseded events as the only identity.

### Phase 6 - Live E2E

Existing:

```text
src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

Upgrade it from debug-only to source-driven proof:

1. Create isolated temp HOME/XDG/APPDATA.
2. Enable `snapshot: true`.
3. Run real OpenCode command that writes/edits one file.
4. Read SQLite directly through `OpenCodeOfflineSessionReader`.
5. Assert `step-start.snapshot` and `step-finish.snapshot` parts exist.
6. Resolve snapshot gitdir from session/project/worktree.
7. Use `OpenCodeSnapshotGitStoreReader` to read before/after.
8. Assert synthetic file diff is exact.

Gated command:

```bash
OPENCODE_LEDGER_LIVE_E2E=1 \
OPENCODE_LEDGER_SNAPSHOT_PROBE=1 \
bun test src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

This test is the real proof. Debug `patch/diff` can remain secondary smoke only.

Live E2E skip/fail policy:

- if `opencode` binary is missing, skip with explicit message;
- if provider auth is missing or returns 401, skip unless `OPENCODE_LEDGER_LIVE_E2E_REQUIRE_AUTH=1`;
- if OpenCode runs but SQLite lacks snapshot parts while config says `snapshot:true`, fail;
- if snapshot gitdir exists but object-id reader cannot read exact before/after, fail;
- if the only passing path is debug CLI text parsing, fail.

Add a second auth-independent fixture E2E that builds a realistic SQLite session DB plus snapshot gitdir directly. This does not replace the live test, but it gives CI deterministic coverage without model credentials.

Auth-independent fixture should include:

```text
opencode.db
  session row with project_id/directory
  project row with worktree/vcs=git
  message row for assistant message
  part rows for step-start, tool, step-finish, patch

snapshot/<project.id>/<sha1(worktree)>/
  internal gitdir with from/to trees
```

The fixture must be generated by helper code, not hand-written JSON, so schema mistakes are caught.

## Test Plan

### Default-Path Acceptance Bar

Because there is no feature flag, tests must exercise the actual default behavior:

1. UI `ChangeExtractorService` calls `opencode.backfillTaskLedger` without `chain-only`.
2. Orchestrator backfill reads OpenCode SQLite snapshot parts by default.
3. Snapshot provider tries `readSessionEvidence` by default.
4. Ledger imports either full-text snapshot evidence or metadata-only fallback.
5. UI `TaskChangeLedgerReader` reads the produced bundle without fixture-specific repair.
6. Renderer review state resets decisions if projected content hashes changed.

Minimum default-path E2E:

```text
generated OpenCode SQLite + snapshot gitdir
  -> default opencode.backfillTaskLedger
  -> task ledger journal
  -> rebuilt bundle/freshness
  -> UI reader
  -> full-text diff visible
```

Second default-path E2E:

```text
same task first imports metadata-only
  -> second default backfill finds snapshot full-text
  -> append upgrade event
  -> bundle projects one visible row
  -> UI decisions reset because hashes changed
```

### Risk-Specific Acceptance Tests

These tests are not optional nice-to-haves. They are the concrete proof that the weak spots above are controlled.

| Risk group | Required test |
| --- | --- |
| SQLite transient read | DB/WAL fingerprint changes during read, result is not cached as final no-changes. |
| SQLite partial history | cap exceeded returns partial diagnostics and imports no unproven files. |
| Snapshot window | two step windows in one assistant message choose exact containing window. |
| Snapshot extra file | raw diff has extra file not in toolparts, no event imported for it. |
| Raw diff parser | newline filename works through `-z` raw parser and object ids, not `patch.files`. |
| Object id width | abbreviated raw ids are rejected. |
| Cat-file caps | oversized blob becomes metadata-only and does not abort other files. |
| Source key collision | same sourceImportKey with different path skips unsafe group. |
| Upgrade race | two concurrent backfills append at most one upgrade. |
| Projection | metadata + upgrade gives one visible file and one set of line stats. |
| UI stale decisions | persisted decisions reset after evidence hash change. |
| Apply/reject | upgraded full-text still requires current disk hash match. |
| Privacy | diagnostics snapshot contains no file content, prompt, patch body, oldString, or newString. |
| Non-OpenCode regression | existing shell/file-write/worktree ledger fixtures remain byte-for-byte equivalent where schema allows. |

### Orchestrator Unit

```bash
bun test \
  src/services/opencode/OpenCodeOfflineSessionReader.test.ts \
  src/services/opencode/OpenCodeSnapshotGitStoreReader.test.ts \
  src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts \
  src/services/opencode/OpenCodeLedgerBridgeService.test.ts \
  src/services/opencode/OpenCodeToolpartChangeReconstructor.test.ts \
  src/services/opencode/OpenCodeApplyPatchEvidenceParser.test.ts
```

### Orchestrator Fixture E2E

Extend:

```text
src/services/opencode/OpenCodeLedgerBridge.fixture-e2e.test.ts
```

Fixtures:

```text
step-window-modify
step-window-create
step-window-delete
step-window-multiple-steps-one-assistant-message
step-window-same-path-multiple-toolparts-no-upgrade
subdirectory-session-cwd-scope
step-window-cross-task-same-session
step-window-missing
project-not-git
snapshot-gitdir-missing
snapshot-binary
snapshot-large
same-relative-path-two-worktrees
metadata-first-rerun-default-snapshot
patch-files-newline-path-corrupt-but-raw-diff-safe
raw-diff-abbrev-rejected
raw-diff-abbrev40-accepted
project-worktree-drive-case
project-worktree-forward-slash-patch-files
session-directory-outside-worktree
```

### Task Ledger Regression

```bash
bun test \
  src/services/taskChangeLedger/TaskChangeLedgerService.test.ts \
  src/services/taskChangeLedger/GitChangePathProvider.test.ts \
  src/services/taskChangeLedger/TaskChangeWriterLock.test.ts
```

### UI

```bash
pnpm exec vitest run \
  test/main/services/team/ChangeExtractorService.test.ts \
  test/main/services/team/OpenCodeReadinessBridge.test.ts \
  test/main/services/team/OpenCodeBridgeCommandContract.test.ts \
  test/main/services/team/taskChangeLedgerFixtures.integration.test.ts
```

## Cross-Platform Requirements

Windows:

- compute SHA-1 over the exact OpenCode `project.worktree` string from SQLite, byte-for-byte after JS string decoding, not normalized display path;
- use normalized/native path comparisons only after the hash has already been computed;
- compare workspace paths with Windows case-insensitive rules;
- use `spawn`/`execFile` args, never shell;
- support `%APPDATA%`, `%LOCALAPPDATA%`, `USERPROFILE` in live tests;
- preserve CRLF exactly;
- reject path escapes and reserved/device paths;
- test same relative path in two worktrees.
- test forward-slash `patch.files` against native backslash `project.worktree`.
- test drive-letter case mismatch does not change hash input but does affect safe path comparison.

macOS/Linux:

- use XDG paths from managed profile;
- do not assume case-insensitive filesystem;
- do not follow symlinks unless future realpath proof is added.

All:

- no workspace scan;
- no debug CLI output parser;
- no current disk historical anchor;
- no raw content diagnostics.
- no symlink realpath expansion for evidence unless a future phase adds explicit symlink ownership proof.
- all path matching uses the same normalization helper as `OpenCodeBridgePath`.

## Performance Limits

Recommended:

```ts
const SNAPSHOT_MAX_FILES = 200
const SNAPSHOT_MAX_TEXT_BYTES_PER_FILE = 1024 * 1024
const SNAPSHOT_MAX_TOTAL_BYTES = 16 * 1024 * 1024
const SNAPSHOT_GIT_TIMEOUT_MS = 5000
const SNAPSHOT_STDOUT_MAX_BYTES = 32 * 1024 * 1024
const SNAPSHOT_STDERR_MAX_BYTES = 256 * 1024
```

Behavior on cap:

```text
affected file -> metadata-only/manual-review
other files -> continue
task -> no hard failure
```

## Diagnostics

Allowed:

```text
diagnostic code
sessionId
messageId
partId
projectId
relativePath
sizeBytes
sha256
opencodeVersion
snapshot tree hash
adapterVersion
```

Forbidden:

```text
raw file content
raw patch body
raw prompt
raw assistant text
env vars
auth tokens
API keys
```

Codes:

```text
snapshot-window-missing
snapshot-project-identity-missing
snapshot-project-not-git
snapshot-project-worktree-mismatch
snapshot-session-directory-outside-worktree
snapshot-gitdir-missing
snapshot-diff-read-failed
snapshot-provider-unavailable
snapshot-window-path-ambiguous
snapshot-mode-only-change
snapshot-file-large
snapshot-file-binary
snapshot-path-outside-workspace
snapshot-path-not-touched
snapshot-case-collision
inverse-edit-ambiguous
apply-patch-ambiguous
```

## Failure Matrix

| Failure | Required behavior |
| --- | --- |
| No strict delivery context | `no-attribution`, no scan |
| No source message id match | metadata-only |
| No step-start/finish snapshot | metadata-only |
| Project not git | metadata-only |
| Snapshot gitdir missing | metadata-only |
| Git reader fails | metadata-only |
| Snapshot row path not touched by candidate | ignored |
| Multiple candidates touch same path in one snapshot window | no snapshot upgrade |
| Binary file | metadata-only |
| Large file | metadata-only |
| Operation mismatch | metadata-only |
| Case collision | skip unsafe group |
| Enricher throws | original reconstructed changes |
| Blob write fails | downgrade/skip file |
| DB/WAL changed during SQLite read | mark transient, no stable empty cache |
| SQLite snapshot shape unsupported | `skipped-capability`, no broad scan |
| Malformed unrelated part | skip/diagnostic, do not poison valid toolparts |
| Raw diff parser desync | fail closed to metadata-only for snapshot provider |
| Raw object id not 40 hex | reject entry/provider result |
| `cat-file` timeout/cap | affected file metadata-only, task continues |
| Snapshot extra file without toolpart candidate | ignored with diagnostic |
| Same source key different identity | skip unsafe source key group |
| Upgrade same rank different hashes | diagnostic, no overwrite |
| Upgrade event id duplicates base id | test failure, block merge |
| UI has stale persisted decision after hash change | clear decisions before apply |
| Review apply current hash mismatch | conflict |
| Diagnostic contains content/prompt/patch | test failure, block merge |
| Old bundle without new fields | reader compatibility required |

## Implementation Order Without Feature Flags

Even without feature flags, implement in internal slices so each commit can be tested. The final merged behavior is default-on for OpenCode, but no partial slice should be left with broken default UI behavior.

### Slice 1 - Data Extraction And Snapshot Reader

Implement:

- `OpenCodeOfflineSessionReader` typed snapshot parts, windows, session/project identity.
- `OpenCodeSnapshotGitStoreReader`.
- auth-independent SQLite + snapshot gitdir fixture E2E.

Default UI behavior can still be unchanged inside this intermediate commit, but this slice is not the final deliverable.

### Slice 2 - Provider And Default Backfill

Implement:

- session-aware provider only;
- no `readBoundaryEvidence`;
- no `evidenceMode` flag in UI request;
- OpenCode managed config `snapshot:true` for new sessions;
- default OpenCode auto-backfill calls the provider.

### Slice 3 - Evidence Upgrade Projection

Implement:

- append-only upgrade events;
- strongest-evidence projection before path accumulators;
- duplicate/upgrade tests;
- UI review decision reset when content hashes change.

### Slice 4 - Live And Cross-Platform Proof

Implement:

- gated real OpenCode E2E;
- Windows path fixture matrix;
- large repo/submodule stress fixture;
- non-OpenCode regression suite.

Not ready to merge if:

- we need debug CLI text to get file contents;
- project id/worktree cannot be resolved;
- snapshot gitdir cannot be found reliably;
- snapshot rows cannot be tied to source message id;
- provider imports files not reconstructed from strict toolparts.
- evidence upgrade can create duplicate visible rows;
- UI default still sends `chain-only`;
- managed OpenCode config still writes `snapshot:false` for new sessions.

## Concrete Next Step

Do this next:

1. Extend `OpenCodeOfflineSessionReader` to extract `step-start`, `step-finish`, `patch`, and session/project identity.
2. Add fixture/unit tests proving extraction works and malformed snapshot parts are diagnostic-only.
3. Build `OpenCodeSnapshotGitStoreReader` with synthetic internal git fixture.
4. Replace old provider contract with `readSessionEvidence`.
5. Change UI auto-backfill to the new default path.
6. Add evidence upgrade projection before enabling final merge.
7. Upgrade live E2E to prove source-driven path.

Do **not** start with debug CLI parsing. Do **not** keep `chain-only` or `readBoundaryEvidence` as production behavior.

## Final Recommendation

The safest and strongest next implementation is the **session-part snapshot bridge**.

It uses facts OpenCode already persists for every step, keeps task attribution strict, avoids brittle debug CLI output, and naturally degrades to Variant 1 metadata-only behavior for non-git, unsupported, large, binary, ambiguous, or old sessions.
