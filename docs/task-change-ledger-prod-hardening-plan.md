# Task Change Ledger Prod Hardening Plan

Status: draft  
Scope: `agent_teams_orchestrator` + `claude_team`  
Mode: shared worktree, no `git worktree` isolation in this iteration  
Primary goal: make task-scoped change tracking reliable, fast, and explicit enough for prod without claiming stronger attribution than shared-worktree reality allows.

## 1. Executive Summary

This revision tightens the previous plan in three important ways:

1. it adds a **per-task cross-process writer lock**, because incremental summary updates are unsafe if multiple orchestrator processes can touch the same task ledger concurrently
2. it makes **summary bundle v2 sufficient for `summaryOnly` reads** without needing journal access for normal summary rendering
3. it adds explicit **per-agent attribution summaries** so the frontend can quickly show which agent changed which files in which task

This revision also fixes three subtle problems that were still under-specified:

4. journal stamp comparison must be stronger than `size + mtime`, otherwise rare false fast-path hits remain possible
5. writer lock must be a **lease with heartbeat**, otherwise long rebuilds can be incorrectly stolen
6. summary bundle must expose **reviewability/capture quality**, otherwise the UI still has to infer too much from partial metadata
7. grouped rename/copy changes need a **stable UI identity** separate from actionable `filePath`, otherwise review state keys drift
8. metadata-only create/delete/binary cases must stay **non-textual**, otherwise UI can accidentally render fake `0/+0` diffs as if content were known
9. a task with **warnings/notices but no visible files** must still return a ledger result, otherwise ambiguity signals disappear from the product
10. task-list/card **presence state** cannot stay binary if warning-only ledger results should remain visible outside the dialog

Chosen direction:

- journal is the only canonical truth
- orchestrator is the only writer
- summary bundle is a compact materialized read model
- UI summary path uses bundle fast-path when valid
- UI detail path reads journal directly
- apply/reject remains ledger-native and strict
- on doubt, we block, degrade to read-only, or show warnings instead of guessing

This gives us the best achievable product behavior in shared-worktree mode:

- fast task summary
- reliable detailed diff
- explicit agent/task attribution where evidence exists
- changes panel reflects **net effect**, not cumulative noise
- changes panel reflects **ledger-expected task result**, not whatever the disk happens to contain later
- logs/activity remain the place for full mutation history
- no frontend reconstruction as primary truth
- no second writer
- no unsafe auto-merge behavior

## 2. Decision Snapshot

### Option A - Journal truth + summary bundle v2 + journal-backed detail + per-task lock ✅ Chosen

`🎯 9.5   🛡️ 9.5   🧠 7.9`  
Estimated size: `~1700-2600 LOC`, a large fraction tests and fixtures.

Why this is the right option:

- fixes the real architectural bug: detail correctness currently depends on bundle materialization
- keeps one writer only
- allows summary reads to stay fast without storing full `events[]`
- preserves a clean future path to isolation/worktree
- closes a critical race that the earlier plan did not address: **incremental summary update is not safe without a cross-process lock**
- gives UI a first-class per-agent summary without forcing journal parse on every summary render

Main tradeoffs:

- more moving parts than a naive bundle-only approach
- still cannot prove exclusive authorship against concurrent external writers in a shared worktree

### Option B - Journal truth + summary bundle v2, but no cross-process lock

`🎯 6.9   🛡️ 7.2   🧠 6.8`  
Estimated size: `~1400-2200 LOC`.

Why it is weaker:

- full rebuilds are mostly safe, but incremental update becomes race-prone across processes
- last writer can publish a stale incremental bundle that omits another process's append
- UI journal fallback would save correctness, but summary freshness would flap and reliability would drop in real multi-process scenarios

This is acceptable only if we explicitly assume one orchestrator process per project, which is weaker than I want for prod hardening.

### Option C - Journal truth + SQLite/materialized index

`🎯 6.3   🛡️ 9.1   🧠 9.4`  
Estimated size: `~2400-3800 LOC`.

Why not now:

- architecturally strong
- too much new infrastructure for this iteration
- introduces a new persistence subsystem, migration path, and debugging surface before we have evidence that summary bundle v2 is insufficient

## 3. What Was Weak In The Previous Plan

The previous version of the plan was directionally right, but had these important gaps:

- summary bundle v2 was still carrying `eventIds[]`, which keeps bundle growth larger than necessary
- summary bundle did not include enough scope metadata to reliably build `TaskChangeSetV2.scope` for `summaryOnly` reads
- delete/create/copy semantics at summary level were underspecified
- it did not close the cross-process race around incremental bundle update
- it did not explicitly solve the user's original product need: **frontend should quickly understand which agent contributed what inside a task**
- it did not clearly say what happens when bundle exists but journal is missing, or when blob references are missing
- journal stamp design was still too weak if it relied only on file size and `mtimeMs`
- lock design did not account for long rebuilds, lock stealing, or lease renewal
- actor identity was still muddled between `agentId`, optional `memberName`, and the existing `scope.memberName` field in shared UI types
- grouped rename/copy changes still had no explicit stable identity distinct from an actionable disk path
- metadata-only file states could still be misread by UI code as text diffs with zero lines
- notices-only tasks could still be accidentally collapsed to "no result", hiding the exact ambiguity signals we want users to see
- task presence caches and kanban badges were still too binary for warning-only ledger outcomes
- it was still unclear which `filePath`-keyed review stores must remain on actionable disk paths and which should migrate to logical `reviewKey`
- it did not account for self-generated `.board-task-changes` artifact churn in consumer-side watchers like `TeamLogSourceTracker`

This version fixes those gaps.

## 4. Current State Observed In Code

### Orchestrator today

`src/services/taskChangeLedger/TaskChangeLedgerService.ts` currently:

- appends `events.jsonl`
- appends `notices.jsonl`
- rebuilds bundle into `.board-task-changes/bundles/<taskId>.json`
- writes freshness to `.board-task-change-freshness/<taskId>.json`
- serializes writes only inside one process via `enqueueTaskWrite(...)`

Strong parts already present:

- append-only journal
- deterministic `eventId` / `noticeId`
- exact file-tool capture for Edit/Write/Notebook/Bash simulated cases
- shell snapshot path with before/after git path discovery
- rename/copy relation metadata from git
- multi-scope ambiguity already degrades to notices instead of guessing
- post-hook mutation already recognized as "final disk truth differs from raw tool result"

Weak parts:

- bundle still stores full `events[]`
- summary and detail are coupled to the same materialized artifact
- current writer queue is process-local only
- freshness does not express journal provenance or integrity state

### UI today

`claude_team/src/main/services/team/TaskChangeLedgerReader.ts` currently:

- reads bundle only
- expects `events[]`
- builds both summary and detail from bundle
- loads blobs for full contents

`ChangeExtractorService` currently:

- tries ledger reader first
- falls back to legacy extraction if reader fails or returns null
- also has persisted summary cache logic for finished tasks, but that cache is based on legacy log fingerprints, not ledger journal state

`ReviewApplierService` already has the right baseline direction:

- strict hash-guarded create/delete/modify reject logic
- rename reject with explicit path/hash checks
- snapshot partial reject using inverse hunk patch, not unsafe snippet replacement

### Main implication

The central architectural problem is still:

⚠️ **bundle currently carries too much authority**

The product becomes much safer if:

- journal is truth
- bundle is only a read model
- summary and detail are separated as different read paths

## 5. Product Goal

For the user, the target experience should be:

- task change summary opens quickly
- files are grouped deterministically
- rename/copy is shown as one coherent change group
- each task can show which agents contributed changes
- each file can show which agent(s) touched it
- changes panel shows the **current net diff attributable to the task**
- logs/activity panel shows the **full mutation history**
- detailed review opens from ledger truth, not frontend reconstruction
- apply/reject either succeeds safely or returns a concrete reason code
- binary/large files are shown honestly as metadata-only or read-only
- ambiguous attribution becomes a visible warning, not invented certainty

This is the closest practical path to "Cursor-like change review" without worktree isolation.

## 6. Non-Goals And Honesty Boundaries

This iteration does **not** do:

- `git worktree`
- per-task sandboxed filesystem isolation
- binary blob capture for arbitrary binary restore
- semantic rename inference beyond git-reported relations
- UI-side repair writes
- a new SQLite/indexed storage subsystem

This iteration also does **not** claim:

- proof of exclusive mutation ownership in a shared worktree
- perfect separation between task A and task B if an external writer changes the same file during the same window

What we can truthfully provide:

- exact attribution when file tools explicitly return before/after content
- strong task scoping when a single active scope exists
- guarded reject/apply based on current disk hashes
- summary and detail correctness from ledger truth even if bundle is stale or missing
- a clean separation between:
  - `changes`: net effect
  - `logs/activity`: cumulative event history
- a clean separation between:
  - `ledger expected final state`
  - `live disk drift overlay`

## 7. Core Design Principles

### Hard invariants

1. Orchestrator is the only ledger writer.
2. Journal is canonical truth.
3. Summary bundle is derived state.
4. Freshness is an invalidation signal, not canonical data.
5. `summaryOnly` must be satisfiable from bundle v2 alone in the common case.
6. Detail/review correctness must not depend on bundle presence.
7. Incremental summary update is allowed **only** under a per-task cross-process lock.
8. If current disk state does not match expected ledger state, apply/reject blocks as `conflict`.
9. If required content was not captured, apply/reject blocks as `manual-review-required` unless the operation is still provably safe via hash-only semantics.
10. If multiple active scopes exist for the same actor, we emit notices and skip file attribution.
11. The task **changes** surface is a **net-effect projection**, not an activity ledger.
12. The task **changes** surface is projected from **ledger final state vs task baseline**, not from current disk bytes.

### Honesty rules

- no second writer
- no magical merge
- no silent downgrade from strong ledger evidence to heuristic legacy extraction
- no pretending bundle is enough for detail correctness
- no claiming stronger authorship proof than shared-worktree mode can actually deliver

## 8. Chosen Architecture

### 8.1 Artifact roles

Keep these artifacts:

- `.board-task-changes/events/<taskId>.jsonl`
- `.board-task-changes/notices/<taskId>.jsonl`
- `.board-task-changes/blobs/...`
- `.board-task-changes/bundles/<taskId>.json`
- `.board-task-change-freshness/<taskId>.json`
- `.board-task-changes/locks/<taskId>.lock/` (new lock directory)

Their responsibilities:

- `events.jsonl` / `notices.jsonl`: canonical truth
- `blobs/`: canonical text payload storage referenced by journal
- `bundles/`: compact summary projection for fast UI reads
- `freshness/`: invalidation and liveness signal for watchers/UI caches
- `locks/`: per-task cross-process materialization lock

### 8.2 Schema strategy

- journal event/notice lines stay `schemaVersion: 1` with additive fields only
- summary bundle becomes `schemaVersion: 2`
- freshness signal becomes `schemaVersion: 2`

Reason:

- summary bundle semantics materially change
- old and new bundle shapes should not share one version number
- compatibility is cleanest when the reader can branch explicitly

### 8.3 Summary bundle v2 must be sufficient for summary reads

This is the single biggest change to the previous plan.

Bundle v2 must contain enough data to build:

- `TaskChangeSetV2.files`
- `TaskChangeSetV2.scope`
- bundle-level warnings
- per-agent contribution summary

without reading journal in the normal `summaryOnly` fast path.

### 8.4 Summary bundle v2 shape

```ts
type JournalFileStamp = {
  bytes: number
  mtimeMs: number
  tailSha256: string | null
}

type TaskChangeJournalStamp = {
  events?: JournalFileStamp
  notices?: JournalFileStamp
}

type TaskChangeContributorSummaryV2 = {
  actorKey: string
  agentId?: string
  memberName?: string
  eventCount: number
  noticeCount: number
  touchedFileCount: number
  visibleFileCount: number
  toolUseCount: number
  cumulativeLinesAdded: number
  cumulativeLinesRemoved: number
  firstTimestamp: string
  lastTimestamp: string
}

type TaskChangeSummaryScopeV2 = {
  confidence: {
    tier: 1 | 2 | 3 | 4
    label: 'high' | 'medium' | 'low' | 'fallback'
    reason: string
  }
  primaryActorKey?: string
  primaryAgentId?: string
  primaryMemberName?: string
  agentIds: string[]
  memberNames?: string[]
  startTimestamp: string
  endTimestamp: string
  toolUseIds: string[]
  toolUseCount: number
  toolUseIdsTruncated?: boolean
  phaseSet: Array<'work' | 'review'>
  executionSeqRange?: { start: number; end: number }
  confidenceBreakdown?: {
    capture: 'exact' | 'high' | 'medium' | 'low'
    attribution: 'high' | 'medium' | 'low' | 'ambiguous'
    reviewability: 'full-text' | 'mixed' | 'metadata-only'
  }
  visibleFileCount: number
  contributors: TaskChangeContributorSummaryV2[]
}

type TaskChangeSummaryFileV2 = {
  changeKey: string
  filePath: string
  relativePath: string
  displayPath?: string
  linesAdded: number
  linesRemoved: number
  diffStatKnown: boolean
  eventCount: number
  firstTimestamp: string
  lastTimestamp: string
  latestOperation: 'create' | 'modify' | 'delete'
  createdInTask: boolean
  deletedInTask: boolean
  baselineExists?: boolean
  finalExists?: boolean
  latestBeforeHash: string | null
  latestAfterHash: string | null
  latestBeforeState?: ContentStateRef
  latestAfterState?: ContentStateRef
  contentAvailability: 'full-text' | 'hash-only' | 'metadata-only'
  reviewability: 'full-text' | 'partial-text' | 'metadata-only'
  relation?: {
    kind: 'rename' | 'copy'
    oldPath: string
    newPath: string
  }
  primaryActorKey?: string
  agentIds: string[]
  memberNames?: string[]
  executionSeqRange?: { start: number; end: number }
  warnings?: string[]
}

type TaskChangeSummaryBundleV2 = {
  schemaVersion: 2
  source: 'task-change-ledger'
  bundleKind: 'summary'
  taskId: string
  generatedAt: string
  journalStamp: TaskChangeJournalStamp
  integrity: 'ok' | 'recovered' | 'partial'
  eventCount: number
  noticeCount: number
  scope: TaskChangeSummaryScopeV2
  files: TaskChangeSummaryFileV2[]
  totalLinesAdded: number
  totalLinesRemoved: number
  diffStatCompleteness: 'complete' | 'partial'
  totalFiles: number
  confidence: 'high' | 'medium' | 'low'
  warningCount: number
  warnings: string[]
}
```

Important bundle v2 rules:

- **no `events[]`**
- **no `notices[]`**
- **no `eventIds[]`**
- contributor summary is bundle-level, not per-event

Why remove `eventIds[]`:

- they inflate bundle size with little summary value
- detail path no longer depends on bundle
- file summary only needs aggregate state, not a replay index

Why add `contentAvailability` and `reviewability`:

- summary UI can render honest badges without reverse-engineering state fields
- review UI can disable unsupported actions before detailed content is opened
- users can distinguish "full diff available" from "hash-only visible" from "metadata-only visible"

Why add `baselineExists` and `finalExists`:

- projector semantics become explicit for create/delete/noop cases
- UI can explain whether a file existed at task start vs task end
- it removes ambiguity when hashes are missing but existence transitions are still known

### 8.4.1 Net-effect projection semantics

This must be explicit, because the user-facing product already has separate surfaces for logs and changes.

Rules:

- `logs/activity` = cumulative event history
- `changes` = net effect relative to the task-scoped starting baseline
- `changes` are projected from the ledger's best-known **task final state**, not from current disk bytes

For bundle v2 and `summaryOnly` reads:

- `files[]` contains only **visible net-effect files**
- `linesAdded` / `linesRemoved` are **net diff** counts, not cumulative edit volume
- `totalLinesAdded` / `totalLinesRemoved` are sums across visible net-effect files

Examples:

- modify file, then revert to original in the same task:
  - appears in logs/activity
  - does **not** appear in changes
- create file, then delete it in the same task:
  - appears in logs/activity
  - does **not** appear in changes
- rename file A -> B, then rename B -> A in the same task:
  - appears in logs/activity
  - does **not** appear in changes

This is the only sane mapping if the changes panel is also used for review/apply/reject.

### 8.4.1.1 Stable change identity

This was still too fuzzy in the earlier versions of the plan.

The UI needs two different identifiers:

- `filePath` = actionable disk path used for file-content resolution and apply/reject
- `changeKey` = stable logical identity used for React keys, review decision keys, selection persistence, and rename/copy grouping

Rules:

- do **not** overload `filePath` as the stable UI identity for grouped relation changes
- `filePath` should continue to point at the actionable path:
  - modify/create -> final path
  - delete -> deleted/original path
  - rename -> new path
  - copy -> new path
- `changeKey` should be derived from the logical net-visible change:
  - plain modify -> `path:<normalized-final-path>`
  - create -> `create:<normalized-final-path>`
  - delete -> `delete:<normalized-baseline-path>`
  - rename -> `rename:<normalized-baseline-path>-><normalized-final-path>`
  - copy -> `copy:<normalized-source-path>-><normalized-target-path>`

For rename chains:

- A -> B -> C in one task should materialize as one visible rename with:
  - actionable `filePath = C`
  - `changeKey = rename:A->C`

For rename-to-original noops:

- A -> B -> A should disappear from `changes`, and therefore produce no visible `changeKey`

This keeps review state stable without breaking file operations.

### 8.4.1.2 File state machine

For each file/relation group, the projector should reason from two conceptual states:

- `baselineState` = earliest known state at the start of the task's interaction with that file
- `taskFinalState` = latest known state produced by the task in the ledger

Recommended derivation:

1. `baselineState`
   - use the earliest event's `beforeState` when available
   - otherwise derive from earliest event's `before` content ref
   - otherwise derive from earliest event semantics:
     - `create` implies `baselineExists = false`
     - `delete` implies `baselineExists = true`
   - otherwise mark baseline as unknown
2. `taskFinalState`
   - use the latest event's `afterState` when available
   - otherwise derive from latest event's `after` content ref
   - otherwise derive from latest event semantics:
     - `delete` implies `finalExists = false`
     - `create` implies `finalExists = true`
   - otherwise mark final state as unknown

Visibility is then decided from `baselineState` vs `taskFinalState`, not from current disk.

### 8.4.1.3 Path identity must be comparison-normalized, not blindly lowercased

This is a concrete low-confidence area in the current UI reader.

Observed today:

- some reader grouping code normalizes paths with `path.normalize(...).toLowerCase()`
- renderer utilities already have a safer helper: `normalizePathForComparison(...)`

Required rule:

- all logical path identity used for:
  - `changeKey`
  - relation grouping
  - review-key mapping
  - visible file sorting/deduplication
  must use one shared comparison normalization contract
- do **not** blindly lowercase all paths

Recommended contract:

- normalize separators to `/`
- lowercase only for Windows-ish paths
- preserve original casing for:
  - actionable `filePath`
  - displayed path labels
  - disk operations

Why this matters:

- unconditional lowercase can merge distinct files on case-sensitive filesystems
- mixed-case rename scenarios can be mis-grouped into false noops or false collisions
- review decision persistence becomes unstable if different layers normalize paths differently

Implementation guidance:

- use `normalizePathForComparison(...)` or an equivalent shared helper in both main and renderer layers
- do not keep a private `toLowerCase()`-based normalization path inside `TaskChangeLedgerReader`

### 8.4.2 Visibility rule for files

The projector should include a file in bundle `files[]` only when at least one of these is true:

1. ledger `taskFinalState` differs from `baselineState`
2. equality cannot be proven because states are metadata-only, but ledger still indicates a materially changed end state

The projector should omit a file when:

1. ledger `taskFinalState` is proven equal to `baselineState`
2. the file was created and deleted within the task
3. rename/copy operations net out to no current change

This keeps changes focused on current reviewable state, not historical churn.

### 8.4.2.1 Diff-stat honesty for metadata-only files

This is another place where the product can easily become misleading.

Rules:

- `linesAdded` / `linesRemoved` must be populated from actual net text diff only
- if the projector cannot compute net text diff because required text content is unavailable, it must set:
  - `diffStatKnown = false`
- bundle-level `diffStatCompleteness` must be:
  - `complete` when every visible file has `diffStatKnown = true`
  - `partial` when at least one visible file has `diffStatKnown = false`

Interpretation:

- when `diffStatKnown = false`, `linesAdded` / `linesRemoved` are **not authoritative**
- if numeric fields must stay non-null for compatibility, they may stay `0`, but UI must not interpret `0/+0` as "no change"
- instead, UI should render metadata-only/reviewability badges and treat line totals as partial when `diffStatCompleteness = 'partial'`

This is especially important for:

- binary files
- oversized files
- delete/create events where existence is known but bytes were not captured
- missing blob cases

### 8.4.2.2 Ledger final state vs live disk

This is critical and should not be left implicit.

For the changes panel:

- bundle/journal describe the **ledger-expected final state of the task**
- they do **not** describe the current disk state after unrelated later edits

For live conflict detection:

- current disk is checked separately
- live disk mismatch is an overlay, not a replacement for the ledger projection

Consequences:

- a file can remain visible in changes even if the current worktree has drifted away
- review/apply/reject must use live disk hash guards before mutating
- summary path should not eagerly read disk just to recompute the visible change set

This avoids a bad product failure mode where later unrelated edits make the task's change set "disappear".

### 8.4.3 Actor identity format

`actorKey` should be explicit and stable. Recommended priority:

1. `member:<memberName>` when member name is known
2. `agent:<agentId>` when only agent id is known
3. `session:<sessionId>` as final fallback

Why:

- it gives frontend one stable grouping key
- it avoids overloading optional `agentId` and `memberName`
- it supports current runtime realities where some paths may lack one or the other

#### 8.4.3.1 Member identity source priority

This can now be specified more concretely from the current orchestrator runtime.

Recommended writer-side source priority:

1. `getAgentName()` when available from teammate runtime context
2. parse deterministic swarm `agentId` in the format `agentName@teamName`
3. leave `memberName` unset when the actor is not a swarm teammate or the identity is not trustworthy

Recommended writer-side `agentId` handling:

- preserve the raw `agentId` as emitted by runtime
- do not rewrite UUID-style subagent ids into fake member names
- only derive `memberName` from `agentId` when the format is the deterministic swarm form

Reason:

- current codebase already exposes `getAgentName()` and deterministic teammate ids
- this gives us a better-quality `memberName` than `agentId` string reuse
- it avoids labeling generic agent-tool subagents as if they were team members

### 8.5 Freshness v2 shape

```ts
type TaskChangeFreshnessSignalV2 = {
  schemaVersion: 2
  source: 'task-change-ledger'
  taskId: string
  updatedAt: string
  journalStamp: TaskChangeJournalStamp
  eventCount: number
  noticeCount: number
  integrity: 'ok' | 'recovered' | 'partial'
  bundleSchemaVersion: 2
  bundleKind: 'summary'
}
```

Freshness rules:

- freshness is the cache invalidation key
- freshness is written even when bundle materialization fails, if possible
- freshness never replaces journal truth

### 8.6 Additive journal metadata upgrades

Keep event/notice schema v1, but add optional fields where needed.

#### Content state

```ts
type ContentStateRef = {
  exists?: boolean
  sha256?: string
  sizeBytes?: number
  contentKind?: 'text' | 'binary' | 'unknown'
  blobRef?: string
  unavailableCode?:
    | 'binary'
    | 'too-large'
    | 'read-error'
    | 'not-captured'
    | 'blob-missing'
  unavailableReason?: string
}
```

#### Notice code

```ts
type TaskChangeNoticeV1 = {
  ...
  code?: 'multi-scope-skipped' | 'journal-recovered' | 'writer-lock-stolen'
}
```

#### Event warning codes

Optional improvement:

```ts
warningCodes?: string[]
```

Examples:

- `failed-after-mutation`
- `background-killed-after-mutation`
- `post-hook-mutation`
- `git-path-cap`
- `git-timeout`
- `binary-state`
- `too-large`

This is not mandatory for v1 compatibility, but it is useful for structured telemetry and UI capability logic.

## 9. Shared Type Changes In UI

The current shared types are slightly too weak for ledger-native summary and per-agent attribution.

Recommended additive changes in `claude_team/src/shared/types/review.ts`:

```ts
export interface LedgerContentState {
  exists?: boolean
  sha256?: string
  sizeBytes?: number
  contentKind?: 'text' | 'binary' | 'unknown'
  blobRef?: string
  unavailableCode?: 'binary' | 'too-large' | 'read-error' | 'not-captured' | 'blob-missing'
  unavailableReason?: string
}

export interface FileChangeSummary {
  ...
  changeKey?: string
  diffStatKnown?: boolean
  ledgerSummary?: {
    latestOperation?: 'create' | 'modify' | 'delete'
    createdInTask?: boolean
    deletedInTask?: boolean
    contentAvailability?: 'full-text' | 'hash-only' | 'metadata-only'
    reviewability?: 'full-text' | 'partial-text' | 'metadata-only'
    relation?: LedgerChangeRelation
    beforeState?: LedgerContentState
    afterState?: LedgerContentState
    primaryActorKey?: string
    agentIds?: string[]
    memberNames?: string[]
    executionSeqRange?: { start: number; end: number }
  }
}

export interface TaskChangeScope {
  ...
  primaryActorKey?: string
  primaryAgentId?: string
  primaryMemberName?: string
  memberName: string // compatibility field populated from primaryMemberName ?? primaryAgentId ?? primaryActorKey
  agentIds?: string[]
  memberNames?: string[]
  toolUseCount?: number
  toolUseIdsTruncated?: boolean
  phaseSet?: Array<'work' | 'review'>
  executionSeqRange?: { start: number; end: number }
  confidenceBreakdown?: {
    capture: 'exact' | 'high' | 'medium' | 'low'
    attribution: 'high' | 'medium' | 'low' | 'ambiguous'
    reviewability: 'full-text' | 'mixed' | 'metadata-only'
  }
  contributors?: Array<{
    actorKey: string
    agentId?: string
    memberName?: string
    eventCount: number
    noticeCount: number
    touchedFileCount: number
    visibleFileCount: number
    toolUseCount: number
    cumulativeLinesAdded: number
    cumulativeLinesRemoved: number
    firstTimestamp: string
    lastTimestamp: string
  }>
}

export interface TaskChangeSet {
  ...
  diffStatCompleteness?: 'complete' | 'partial'
}
```

Why this matters:

- summary bundle can then project directly into shared UI types
- UI can show per-file and per-task agent attribution without journal parse
- delete/create/copy state becomes explicit even in summary-only mode
- we stop overloading `scope.memberName` as the only identity field
- we preserve backwards compatibility by continuing to populate `memberName` deterministically

Compatibility mapping rule:

- `TaskChangeScope.memberName = primaryMemberName ?? primaryAgentId ?? primaryActorKey`
- `FileChangeSummary.isNewFile = createdInTask && latestOperation !== 'delete' && relation?.kind !== 'rename'`

This keeps existing UI assumptions working while the richer actor fields are adopted incrementally.

Additional projection rule:

- `FileChangeSummary.linesAdded/linesRemoved` must always reflect **ledger net diff**, never live disk diff
- `FileChangeSummary.changeKey` must be the stable logical identity, while `filePath` remains the actionable path
- `FileChangeSummary.diffStatKnown = false` means UI must not render line counts as authoritative text diff

Additional shared-contract recommendation:

- extend `SnippetDiff.ledger` with an additive optional field such as:
  - `textAvailability?: 'patch-text' | 'full-text' | 'unavailable'`
- optionally extend `FileChangeWithContent` or its resolver-internal representation with:
  - `materialization?: { original: 'full-text' | 'synthetic-empty-side' | 'unavailable'; modified: ... }`

Reason:

- the renderer currently receives plain strings and has to infer whether `''` means "truly empty" or "unknown"
- making availability explicit reduces the chance of future regressions back into fake diff rendering

### 9.0 Task-change provenance contract

This became one of the lowest-confidence areas after checking the current `claude_team` code.

Observed today:

- persisted task-change summary cache already stores `sourceFingerprint`
- but `TaskChangeSetV2` itself does **not** carry a canonical provenance field
- renderer stale detection therefore falls back to weaker signals such as:
  - `computedAt`
  - `fingerprintChangeSet(...)` over visible files

That is the wrong layering.

`computedAt` is display metadata.
It is not source provenance.

Required rule:

- every `TaskChangeSetV2` returned from main must carry explicit provenance

Recommended additive shape:

```ts
type TaskChangeProvenance = {
  sourceKind: 'ledger' | 'legacy'
  sourceFingerprint: string
  journalStamp?: TaskChangeJournalStamp
  bundleSchemaVersion?: number
  integrity?: 'ok' | 'recovered' | 'partial'
}

interface TaskChangeSetV2 extends TaskChangeSet {
  ...
  provenance?: TaskChangeProvenance
}
```

Source rules:

- ledger path:
  - `sourceKind = 'ledger'`
  - `sourceFingerprint` derived from canonical serialization of `journalStamp`
  - include `journalStamp`
  - include bundle integrity/schema info when summary fast-path was used
- legacy fallback path:
  - `sourceKind = 'legacy'`
  - `sourceFingerprint` derived from the existing log-source fingerprint

Behavior rules:

1. stale review/apply refresh should compare `provenance.sourceFingerprint` first
2. `fingerprintChangeSet(...)` becomes only a compatibility fallback when provenance is absent
3. persisted review decisions should bind to `provenance.sourceFingerprint`, not to renderer-recomputed visible-file fingerprints when provenance exists
4. `computedAt` must never be used as a correctness/freshness surrogate for ledger-backed results

Why this matters:

- it removes a class of renderer-only heuristics from stale detection
- it lets decision persistence and apply/reject reason about the same source identity
- it makes ledger and legacy paths look consistent to the renderer even though their backing evidence differs

Migration note:

- persisted task-change summary cache may keep its wrapper-level `sourceFingerprint` during rollout
- but the summary object itself should also carry provenance so downstream code does not need cache-specific knowledge to make freshness decisions

### 9.1 Review-key migration bridge

This needs to be explicit because the current UI uses `filePath` pervasively for:

- selected file state
- file-level decisions
- hunk decision keys
- collapsed/open state
- viewed markers
- persisted review decision files

Recommended migration:

- keep `filePath` as the actionable disk path everywhere actions touch disk
- introduce a derived helper:

```ts
const reviewKey = file.changeKey ?? file.filePath
```

- move **state identity** to `reviewKey`
- keep **IO identity** on `filePath`

Phase this carefully:

1. schema/type phase:
   - add `changeKey?: string`
   - add helper utilities `getReviewKey(file)` and `getReviewKeyFromPath(filePath, changeKey?)`
2. renderer/store phase:
   - migrate `fileDecisions` and `hunkDecisions` keys to `reviewKey`
   - if explicit selected-review-item state is still needed, migrate that logical selection to `selectedReviewKey`
   - do **not** replace `activeFilePath` scroll/editor state with `reviewKey`
   - keep callback payloads and main-process IPC payloads on `filePath`
3. persistence phase:
   - `ReviewDecisionStore` reads both old filePath-keyed data and new reviewKey-keyed data
   - on successful save, persist only the new key shape plus a small mapping:
     - `filePathByReviewKey`
4. compatibility phase:
   - for files without `changeKey`, `reviewKey === filePath`, so old non-ledger and simple ledger cases continue to work unchanged

This is a much safer migration than trying to rename every `filePath` prop in the review UI.

#### 9.1.1 Review-key blast radius and strictness

Not every `filePath`-keyed store has the same migration bar.

Must be strict and backward-compatible:

- persisted reject/accept decisions
- in-memory `fileDecisions`
- in-memory `hunkDecisions`
- selected file identity in review store/dialog

May be best-effort / lossy:

- viewed markers in localStorage
- collapsed-section localStorage state
- scroll-spy active item state

Reason:

- losing viewed/collapsed UI sugar is acceptable
- losing persisted review decisions is not

Recommended rule:

- decision persistence must have explicit dual-read compatibility
- viewed/collapsed storage may simply reset when a file now has a non-filePath `changeKey`

### 9.1.2 Persisted review-decision schema v2

This part needs a stricter contract than the previous draft.

Current persisted data is effectively:

- `fileDecisions[filePath]`
- `hunkDecisions[${filePath}:${index}]`
- `hunkContextHashesByFile[filePath]`

That is insufficient once grouped rename/copy changes have a stable `reviewKey` different from actionable `filePath`.

Recommended persisted shape:

```ts
type ReviewDecisionsDataV2 = {
  version: 2
  scopeDescriptor: {
    mode: 'task' | 'agent'
    teamName: string
    taskId?: string
    memberName?: string
    requestSignature?: string
  }
  sourceFingerprint?: string
  fileDecisions: Record<string, HunkDecision> // keyed by reviewKey
  hunkDecisions: Record<string, HunkDecision> // keyed by `${reviewKey}:${index}`
  hunkContextHashesByReviewKey?: Record<string, Record<number, string>>
  filePathByReviewKey: Record<string, string>
  updatedAt: string
}
```

Important migration nuance:

- `ReviewDecisionStore` alone does **not** know the active change set
- therefore it cannot safely convert legacy filePath keys to `reviewKey` on its own

Recommended split of responsibility:

1. store layer:
   - load raw persisted payload
   - preserve schema version
   - support both:
     - legacy unversioned / v1 filePath-keyed data
     - v2 reviewKey-keyed data
2. renderer normalization layer:
   - after active change set loads, build:
     - `reviewKey -> file`
     - `filePath -> reviewKey`
   - normalize raw persisted decisions against the current file list
   - drop only entries that cannot be mapped to any visible file
3. save path:
   - after a successful normalize/load cycle, persist only v2 shape
   - do not rewrite files during a failed or partial migration

Why this is safer:

- old filePath keys can only be interpreted correctly once the current visible file set is known
- store-level blind conversion would guess incorrectly for grouped rename/copy cases
- renderer normalization already has the active files needed for deterministic mapping

### 9.1.2.1 Decision persistence must be bound to request signature and source fingerprint

This is one of the lowest-confidence rollout areas after reading the current renderer code.

Observed today:

- `decisionScopeKey` is currently very coarse:
  - task mode: effectively `task-${taskId}`
  - agent mode: effectively `agent-${memberName}`
- but task review requests already carry a richer `TaskChangeRequestOptions` signature
- the actual visible change set can differ for the same `taskId` depending on:
  - owner
  - status
  - intervals
  - `since`
  - `stateBucket`

That means persisted decisions can bleed between different logical review scopes if the payload is keyed only by task id or member name.

Required rule:

- persisted review decisions must be valid only for the logical review scope that produced them
- that scope must include:
  - stable namespace:
    - task id or member name
  - request signature:
    - for task mode, derived from `TaskChangeRequestOptions`
  - source fingerprint:
    - ideally ledger `journalStamp`
    - fallback to change-set fingerprint when journal provenance is unavailable

Recommended policy:

1. payload **must** include:
   - `scopeDescriptor`
   - `sourceFingerprint`
2. load path replays decisions only when:
   - namespace matches
   - request signature matches current logical scope
   - source fingerprint is compatible with current change set
3. otherwise:
   - keep the stored file on disk
   - treat the loaded decisions as stale/inapplicable for this session
   - do not blindly inject them into current store state

Why this matters:

- this prevents approved/rejected hunks from a previous filtered review variant from leaking into a different variant of the same task
- it also narrows the blast radius when a task is reopened later with a materially different ledger state
- compatibility remains manageable because the file namespace does not have to explode into one file per stamp unless we decide that is worth it later

### 9.1.2.2 Persisted decisions must be staged before activation

This is a separate contract from scope binding.

Observed today:

- persisted review decisions can be loaded asynchronously before the active change set has finished loading
- renderer code can then write those decisions directly into live store state

That creates two bad failure modes:

1. stale decisions flash in the UI before normalization
2. stale filePath-keyed decisions can temporarily exist in active state for a different file set

Required rule:

- loading persisted decisions must be a **two-step flow**
  1. load raw persisted payload into a pending/staged slot
  2. only after active change set is installed and normalized:
     - validate scopeDescriptor/requestSignature/sourceFingerprint
     - map to current visible files
     - activate into live `fileDecisions` / `hunkDecisions`

Recommended renderer contract:

- keep a separate in-memory field such as:

```ts
pendingPersistedDecisions?: {
  scopeToken: string
  payload: ReviewDecisionsDataV2 | LegacyReviewDecisionsData
}
```

- on scope switch or dialog close:
  - clear pending staged decisions
  - clear live decisions unless they already belong to the new scope
- do **not** set raw persisted decisions directly into active review state on load completion

Why this matters:

- normalization depends on the current visible file set
- direct-install behavior is exactly how stale decisions leak across quick task switches and reopen flows
- a staging barrier makes the migration and compatibility path deterministic

### 9.1.2.3 One coarse decision file per task/member is not enough

This is a correction to the weaker recommendation from earlier drafts.

After checking the real UI code, a single coarse file like:

- `task-<taskId>.json`
- `agent-<memberName>.json`

is not enough once we want reliable persistence for:

- multiple filtered variants of the same task
- reopened reviews across different ledger source epochs
- agent/task scopes that can coexist across quick switching

Reason:

- even if the payload contains `requestSignature` and `sourceFingerprint`
- a single coarse file still becomes **last-write-wins**
- variant B will overwrite variant A's persisted decisions even if both are valid and should coexist

Required rule:

- decision persistence storage must be scoped by **logical review scope**, not only by coarse task/member namespace

Recommended layout:

```ts
review-decisions/
  v2/
    task/<encodedTaskId>/<requestSignature>/<sourceFingerprint>.json
    agent/<encodedMemberOrActorKey>/<sourceFingerprint>.json
```

If path length or filesystem-safety is a concern:

- keep directory segments readable where possible
- hash long dynamic segments
- store the full human-readable `scopeDescriptor` inside the payload

Load policy:

1. resolve the current exact logical scope:
   - mode
   - task/member identity
   - request signature
   - source fingerprint
2. load only the matching v2 file for that scope
3. if no exact v2 file exists:
   - optionally probe legacy coarse file for migration
4. never let one scope silently overwrite another scope's persisted decisions

Retention / GC policy:

- keep the newest `8-16` source fingerprints per task/member namespace
- prune older v2 entries in a best-effort background pass
- do not block dialog open on GC

Why separate files are better than one coarse envelope:

- no hidden last-write-wins overwrite between valid variants
- simpler corruption boundaries
- easier manual debugging
- easier rollout because legacy coarse file can stay as a fallback probe, not as the primary store

### 9.1.3 Review identity ownership matrix

The previous plan still left too much room to over-migrate everything to `reviewKey`.

Current review UI has two different classes of state:

1. **logical review identity**
   - grouped visible change
   - persisted decisions
   - hunk acceptance/rejection state
2. **disk-path / editor-runtime identity**
   - external file watching
   - lazy content loading
   - editor instances
   - edited draft buffers
   - reload/save/apply operations

Recommended ownership split:

- move to `reviewKey`:
  - `fileDecisions`
  - `hunkDecisions`
  - persisted review decision payloads
  - any future explicit selected-review item state
  - React list keys for grouped visible changes
- keep on actionable `filePath`:
  - `fileContents`
  - `fileContentsLoading`
  - `fileContentVersionByPath`
  - `reviewExternalChangesByFile`
  - `editedContents`
  - `activeFilePath` used by continuous scroll and keyboard navigation
  - file watching subscriptions
  - reload/save/apply request payloads

Why:

- watcher events and editor instances are emitted for real disk paths, not logical grouped changes
- overloading them onto `reviewKey` would add a reverse-mapping layer to every live IO path
- grouped change identity matters most for decision persistence and stable UI grouping, not for disk IO

Practical implication:

- keep the review UI in a **two-contour model**:
  - `selectedReviewKey` or equivalent logical selection when needed
  - `activeFilePath` for scroll/editor/watch operations

Important note about current code:

- `selectedReviewFilePath` in the store is now mostly legacy/compatibility state
- the active review dialog is primarily driven by `activeFilePath` from scroll-spy

So the migration priority should be:

1. decision identity
2. persistence identity
3. optional cleanup/removal of legacy selected-file store

and **not** a broad rename of every `filePath`-keyed field in the review UI.

### 9.1.4 Path-relation rendering must prefer ledger metadata

Current review UI still has heuristic path-label logic that tries to infer deleted/moved/renamed relationships from loaded file contents.

That was a reasonable legacy fallback, but it should no longer be the primary path once ledger summary exposes relation metadata.

Recommended rule:

- if `FileChangeSummary.ledgerSummary.relation` is present:
  - derive rename/copy/move badges directly from ledger metadata
  - do not wait for full file contents to infer path relationships
- keep heuristic inference only as a legacy fallback when:
  - relation metadata is absent
  - the change set came from non-ledger extraction

Reason:

- relation metadata is more reliable than content-hash guessing
- avoids false rename/move labels on delete/create pairs with matching content
- lets the file tree/header show relation badges in summary mode before content hydration
- reduces unnecessary dependence on `fileContents` just to annotate file rows

## 10. Writer Design In Orchestrator

### 10.1 Per-task cross-process lock

This is a new requirement.

Reason:

Without a lock, this race exists:

1. process A reads bundle stamp `S0`
2. process B reads bundle stamp `S0`
3. A appends event `E1`
4. B appends event `E2`
5. A incrementally updates from `S0` and writes bundle containing only `E1`
6. B incrementally updates from `S0` and writes bundle containing only `E2`

Journal still contains both events, but summary bundle becomes stale and lossy until a full rebuild.

That is not good enough for prod hardening.

### 10.2 Lock contract

New path:

- `.board-task-changes/locks/<taskId>.lock/owner.json`

Lock behavior:

- acquire via atomic `mkdir`
- inside the lock directory write `owner.json`
- owner payload should include:
  - `ownerId` (random UUID)
  - `pid`
  - `sessionId`
  - `taskId`
  - `startedAt`
  - `heartbeatAt`
- renew lease heartbeat while the lock is held
- use short retry loop with backoff
- stale lock can be stolen after timeout with warning
- on stale lock steal, write notice/warning code for observability

Why directory lock + lease is stronger:

- atomic `mkdir` is a simple cross-platform lock primitive
- `ownerId` avoids confusing a reused PID with the same writer
- heartbeat avoids false stale detection during long rebuilds

Suggested policy:

- wait budget: `2s`
- heartbeat interval: `5s`
- stale threshold: `30s`
- on stale lock, steal and emit `writer-lock-stolen`

### 10.3 Write transaction under lock

Inside the per-task lock:

1. stat pre-append journal files
2. read existing bundle if parseable and v2
3. append new event and/or notice lines
4. stat post-append journal files
5. materialize new bundle:
   - incremental update if previous bundle is valid and journal stamp matches pre-append
   - else full rebuild from journal
6. write bundle atomically
7. write freshness atomically
8. release lock

### 10.3.1 Internal artifact writes must not cause self-churn

This was under-specified before, and current `claude_team` code shows a real place where self-generated ledger files can create avoidable noise.

Observed behavior today:

- `TeamLogSourceTracker` watches the team project directory
- it special-cases:
  - `.board-task-log-freshness`
  - `.board-task-change-freshness`
- but it does **not** explicitly ignore:
  - `.board-task-changes/events`
  - `.board-task-changes/notices`
  - `.board-task-changes/bundles`
  - `.board-task-changes/blobs`
  - `.board-task-changes/locks`

That means ledger writes can trigger unnecessary tracker recompute cycles even when the underlying log-source generation is unchanged.

Recommended rule:

- internal ledger artifact writes must be treated as **non-source** changes by log-source/project watchers

Concrete guidance:

- keep direct task-refresh signaling on:
  - `.board-task-change-freshness/<taskId>.json`
- explicitly ignore for log-source recompute purposes:
  - `.board-task-changes/**`
  - especially `.board-task-changes/locks/**`

Reason:

- avoids self-induced recompute churn
- avoids watcher noise from ephemeral lock directory creation/removal
- avoids a future failure mode where auxiliary ledger artifacts accidentally become part of change-presence invalidation semantics

Implementation note:

- this belongs in the consumer side as well, not only in orchestrator
- update watcher/filter logic in `claude_team` so the UI side treats freshness as the signal and treats the rest of ledger storage as internal plumbing
- prefer watcher-level ignore configuration for `.board-task-changes/**`, not only recompute-time branching after events are already emitted
- keep `.board-task-change-freshness/**` watched, because that is the intentional refresh signal

Notes:

- process-local `enqueueTaskWrite(...)` still stays useful
- lock is not a replacement for in-process queue, it complements it
- if bundle write succeeds but freshness write fails, the next reader should treat mismatch conservatively and prefer journal

### 10.3.2 Reuse existing `GitChangePathProvider`, do not fork git path logic

This is another low-confidence implementation hazard.

Current orchestrator code already has:

- `src/services/taskChangeLedger/GitChangePathProvider.ts`
- capped streaming `runGitCapped(...)`
- `parseGitStatusPorcelainZ(...)`
- `parseGitNameStatusZ(...)`
- `getGitStatusPathEntries(...)`
- `getGitCommittedPathEntries(...)`

That is the right place for git path discovery hardening. The plan should **not** introduce a second provider path inside `TaskChangeLedgerService`.

Rules:

- `TaskChangeLedgerService` should delegate all git working-tree path discovery to `getGitStatusPathEntries(...)`
- committed shell-diff discovery should delegate to `getGitCommittedPathEntries(...)`
- do **not** reintroduce direct `execFileNoThrowWithCwd(... maxBuffer ...)` git path collection inside ledger service
- capped output, timeout, path-cap, and partial-record warnings should flow from `GitChangePathProvider` into ledger warnings/notices unchanged

Why this matters:

- duplicate git parsing logic will drift under edge cases like rename/copy records, truncated output, and partial trailing NUL handling
- current provider already encodes the production safety constraint the user asked for: bounded output without one giant `maxBuffer`
- keeping one provider makes parser tests and shell-snapshot tests materially more trustworthy

Implementation note:

- harden the existing provider as needed
- do not replace it with a new abstraction unless it can subsume the current provider completely

### 10.4 Full rebuild projector

Full rebuild must:

- stream-parse journal line-by-line
- ignore empty lines
- tolerate corrupt trailing lines
- tolerate malformed lines with warning
- dedupe by `eventId` / `noticeId`
- project:
  - bundle totals
  - per-file aggregates
  - scope summary
  - contributor summary
  - warnings
- compute net-effect visibility by comparing earliest known baseline vs latest known final state
- set integrity:
  - `ok` when no recovery was needed
  - `recovered` when malformed lines were skipped but summary is still derived from journal

The full rebuild projector should treat relation groups as one logical file state machine for visibility, while still retaining concrete path fields for apply/reject.

### 10.4.1 Journal append order must be the canonical event order

This is a subtle but important correctness point.

Current code often gives multiple events in one batch the same timestamp, and older readers sometimes break ties with `eventId`.
That is not a reliable definition of mutation order.

Required rule:

- canonical ordering for ledger projection is **journal append order**
- timestamp is descriptive metadata, not the tie-breaker for state transitions
- `eventId` / `noticeId` are identity keys, not ordering keys

Recommended implementation:

1. journal readers assign an in-memory monotonic `readOrdinal`
2. projection order is:
   - journal line order for newly parsed journal
   - array order for compatibility reads of legacy v1 `events[]`
3. sorting by `timestamp` may still be used only for:
   - display group labels
   - human-readable summaries
   - telemetry views
   but **not** for baseline/final-state projection

Why this matters:

- identical timestamps are normal for one append batch
- lexicographic `eventId` order can reorder same-file transitions incorrectly
- net-effect projection must follow the order the writer actually appended

### 10.5 Incremental update projector

Incremental update is allowed only when:

- lock is held
- existing bundle is v2
- existing bundle parses
- existing bundle `journalStamp` matches the pre-append journal stamp exactly
- append batch is in-memory

If any condition fails, do full rebuild.

Incremental update must preserve the same **net-effect projection semantics** as full rebuild.

That means it cannot merely append counters. It must update per-file state machines so that:

- reverted files disappear from visible `files[]`
- created-then-deleted files disappear
- contributor `visibleFileCount` stays correct
- bundle totals remain net totals, not cumulative activity totals
- ledger final state remains distinct from any later live disk drift

### 10.5.1 Journal stamp strength

Do **not** rely on only `bytes + mtimeMs`.

Recommended journal stamp:

- `bytes`
- `mtimeMs`
- `tailSha256` of the last `4096` bytes, or the whole file if shorter

Why:

- two appends can theoretically preserve size parity across files
- some filesystems have coarse timestamp granularity
- `tailSha256` makes false fast-path acceptance dramatically less likely without forcing full-file hashing

### 10.5.2 Shell snapshot committed-diff discovery must survive HEAD rewrites

This was missing from the previous draft, and the current orchestrator code already hints at the right behavior.

Observed today:

- shell snapshot stores `beforeHead`
- committed diff path discovery is attempted only if `beforeHead` is an ancestor of `afterHead`
- on non-descendant head change, committed diff is skipped with a warning

That is the correct direction and should be made explicit in the plan.

Required rule:

- non-descendant `beforeHead -> afterHead` is a warning-only condition, not a ledger failure
- shell snapshot must still project changes from:
  - before working-tree status
  - after working-tree status
  - before/after disk or git-blob content evidence
- committed diff path discovery is an optimization, not a correctness prerequisite

Concrete policy:

1. if `beforeHead === afterHead`:
   - normal uncommitted/status-based path
2. if `beforeHead` is ancestor of `afterHead`:
   - allow committed diff path discovery
3. if `beforeHead` is **not** ancestor of `afterHead`:
   - skip committed diff discovery
   - keep status/disk evidence path
   - emit structured warning such as:
     - `git-head-rewritten`
     - or `committed-diff-skipped-non-descendant`

Why this matters:

- users do rebase, amend, reset, checkout, and detach HEAD while long-running shell commands are still active
- we should not turn that into a false "no changes" result
- we also should not pretend committed diff evidence exists when history was rewritten underneath us

Reviewability rule:

- rename/copy relation inferred only from committed diff must be treated as unavailable when committed diff was skipped
- plain before/after content/existence evidence remains valid

### 10.6 Bundle caps

To avoid reintroducing bundle growth through summary metadata:

- bundle `warnings`: max `128` unique values
- file `warnings`: max `16` unique values per file
- `scope.toolUseIds`: max `256` unique values
- if `toolUseIds` are truncated, set:
  - `toolUseCount`
  - `toolUseIdsTruncated: true`

Do **not** cap:

- files list
- contributor list

Those are core summary artifacts and should stay complete unless we hit a catastrophic size problem, in which case we should prefer journal fallback over silent truncation.

### 10.7 Integrity semantics

`integrity: 'ok'`

- bundle exactly matches journal stamp
- no recovery path was needed

`integrity: 'recovered'`

- bundle was rebuilt from journal
- malformed/trailing lines were skipped
- resulting summary is still the best truthful projection from journal

`integrity: 'partial'`

- journal append succeeded
- bundle materialization or bundle write failed
- UI must bypass bundle and use journal directly

### 10.8 Failure matrix

| Failure point | Canonical truth lost? | UI behavior | Telemetry |
| --- | --- | --- | --- |
| append event fails | yes, that event is not recorded | no new change visible | hard error |
| append notice fails | notice lost, event may still exist | missing warning only | hard error |
| bundle rebuild fails after append | no | use journal path | `task_change_ledger_bundle_write_failed` |
| bundle write fails | no | use journal path | `task_change_ledger_bundle_write_failed` |
| freshness write fails | no | data eventually visible, live refresh may lag | hard error + warning |
| lock acquire times out | no | write delayed or skipped | `task_change_ledger_lock_timeout` |
| stale lock stolen | no | normal write continues | `task_change_ledger_lock_stolen` |
| stamp collision avoided by tail hash | n/a | correct rebuild instead of false fast-path | n/a |

### 10.9 Concrete orchestrator file targets

Most changes should land in or around:

- `src/services/taskChangeLedger/TaskChangeLedgerService.ts`
- `src/services/taskChangeLedger/GitChangePathProvider.ts`
- new helper modules under `src/services/taskChangeLedger/`
  - `TaskChangeJournalReader.ts`
  - `TaskChangeSummaryProjector.ts`
  - `TaskChangeWriterLock.ts`
  - `taskChangeBundleV2.ts`

Goal:

- reduce `TaskChangeLedgerService.ts` from one giant implementation file into smaller owned pieces

## 11. Reader Design In UI

### 11.1 Split summary and detail paths on purpose

One reader should not try to do both from one artifact.

New model:

- summary path optimizes for speed
- detail path optimizes for correctness

### 11.2 Summary path

When `includeDetails === false`:

1. read freshness v2 if present
2. read bundle v2 if present
3. if bundle and freshness agree on:
   - `journalStamp`
   - `eventCount`
   - `noticeCount`
   - `bundleSchemaVersion`
   - integrity not equal to `partial`
   then use bundle fast-path
4. otherwise build summary from journal in memory
5. cache summary result in bounded in-memory LRU

Important:

- summary path must not read blobs
- summary path must not parse journal unless fast-path fails
- bundle v2 must already contain enough scope and contributor data
- summary path must still return a non-null result when files are empty but ledger notices/warnings exist

If freshness v2 is missing but journal files exist:

- compute actual journal stamp from disk
- allow bundle fast-path only if bundle `journalStamp` matches actual journal stamp
- otherwise fall back to journal summary

If both freshness and journal are missing but bundle v2 exists:

- allow degraded read-only summary from bundle
- mark result with warning that live validation could not be performed

### 11.2.1 Bundle/freshness coherence must act like a commit barrier

This is another subtle low-confidence area.

Even when both artifacts are written atomically, readers can still observe:

- old bundle + new freshness
- new bundle + old freshness
- valid bundle while writer is between journal append and bundle rebuild

Required rule:

- freshness is an invalidation signal only
- freshness is **not** proof that the currently loaded bundle is the matching generation
- bundle fast-path is allowed only when bundle/freshness provenance matches exactly

Recommended read policy:

1. load freshness
2. load bundle
3. verify they describe the same generation:
   - `journalStamp`
   - `eventCount`
   - `noticeCount`
   - bundle schema / integrity
4. on mismatch:
   - retry once after a short delay
   - if still mismatched and journal is available, fall back to journal
   - if journal is unavailable, return degraded read-only state with an explicit warning
5. never compose one response from fields taken from two different generations

Why this matters:

- otherwise the UI can transiently trust a stale bundle right after a freshness tick
- those failures are rare, but they create exactly the "sometimes changes show up, sometimes not" behavior the user described
- a strict coherence check turns this into a deterministic fallback instead of flaky correctness

### 11.2.2 Legacy bundle v1 compatibility mode must not reuse v1 summary semantics

This is easy to get wrong during rollout.

Current v1 bundle shape contains:

- full `events[]`
- cumulative `files[]`
- cumulative totals derived from append history

That means v1 `files[]` are **not** compatible with the target net-effect semantics of bundle v2.

Required rule:

- new UI may read v1 bundles for compatibility
- but it must treat v1 bundle as a **legacy event container**, not as a trusted summary projection

Safe compatibility behavior:

1. if journal exists:
   - prefer journal
   - do not use v1 bundle `files[]` as summary fast-path
2. if journal is missing but v1 bundle exists:
   - derive summary/detail from `events[]` / `notices[]` inside the v1 bundle
   - ignore v1 `files[]` and cumulative totals for target summary semantics
   - mark the result as compatibility/degraded

Why this matters:

- otherwise rollout can silently regress back to cumulative-churn summaries under old orchestrator writers
- v1 `events[]` are still useful evidence
- v1 `files[]` are the wrong abstraction for the new product contract

### 11.3 Detail path

When `includeDetails === true`:

1. read journal directly
2. stream-parse events/notices
3. read referenced text blobs
4. build snippets/timeline/grouping from ledger truth
5. optionally compare current disk for drift/conflict overlay
6. cache parsed journal and blobs in bounded in-memory LRU

Bundle may still contribute top-level warnings if available, but it is not authoritative for detail correctness.

### 11.4 Journal parsing in UI

Use streaming parse instead of unconditional `readFile(...)` for journal detail path and journal summary fallback.

Reason:

- large tasks should not force full-file memory spikes in Electron main process
- streaming parser keeps logic closer to orchestrator rebuild behavior

### 11.5 Missing journal but valid bundle

This case was not covered well in the previous plan.

Recommended behavior:

- if bundle v2 exists but journal is missing:
  - summary path may return **degraded read-only summary** from bundle with warning
  - detail path must not pretend full ledger detail is available
  - review/apply/reject must be disabled for that result

This preserves visibility without lying about reconstructability.

### 11.6 Missing blob references

If journal references `blobRef` but blob is missing:

- keep the file/event visible
- mark related content state with `unavailableCode: 'blob-missing'`
- degrade detailed content to metadata-only where necessary
- review actions follow capability rules and usually become manual-only

### 11.6.1 Ledger snippet bodies must not invent text when bytes are unavailable

This is distinct from full-file content materialization.

Current reader code is prone to constructing snippet fields like:

- `oldString = beforeContent ?? ''`
- `newString = afterContent ?? ''`

That is unsafe when the empty string means "unavailable", not "truly empty".

Required rule:

- ledger snippet rendering must distinguish:
  - patch text explicitly captured by the tool result
  - full-file text loaded from blob
  - unavailable text
- `SnippetDiff.oldString/newString` must not be silently synthesized as `''` just because blob/full-text content was unavailable

Recommended approaches:

1. preferred:
   - add explicit text availability metadata to snippet/ledger payloads
2. minimum acceptable:
   - use empty string only when the snippet side is semantically empty by lifecycle
   - otherwise keep the snippet marked unavailable and disable text-hunk rendering for that fragment

Why this matters:

- otherwise metadata-only create/delete/binary states can leak back in through snippet rendering even if `FileContentResolver` is fixed
- snippet-level fake text can corrupt line counts, hunk hashes, and partial-review affordances

### 11.6.2 Notices-only tasks

If journal/bundle indicates:

- zero visible files
- but one or more ledger notices/warnings for the task

then the reader should still return a `TaskChangeSetV2` result with:

- `files = []`
- `warnings` populated
- `scope` populated as best-effort from notices

It must **not** return `null`.

Reason:

- multi-scope ambiguity and similar notices are product-important
- collapsing them to "no result" hides the exact reason why task changes were not attributed

### 11.6.3 Task-mode file-content fallback identity

Current `claude_team` task review flows still have some best-effort fallback paths that may ask for file content with only:

- `teamName`
- `taskId`
- `filePath`

and no explicit member name.

Target behavior:

- ledger detail path should make task-mode review independent from member-log history in the normal case
- if a fallback still needs a member identity, use:
  1. explicit request `memberName`
  2. `TaskChangeScope.primaryMemberName`
  3. compatibility `TaskChangeScope.memberName`
  4. empty string only as last resort

Reason:

- this reduces accidental degradation when task review is opened without an explicit member context
- it matches the current code reality where some fallback resolvers still accept `memberName`

### 11.7 Interaction with `ChangeExtractorService`

Source precedence should be:

1. bundle v2 fast-path for summary-only requests
2. journal summary fallback
3. journal detail path
4. legacy extraction only when ledger artifacts are unavailable or unusable

Rules:

- no silent downgrade without warning
- when ledger succeeds, it is authoritative
- ledger-derived summaries should **not** go into the existing persisted `JsonTaskChangeSummaryCacheRepository`
- `changes` computed from ledger should stay net-effect based even if legacy fallback remains cumulative/heuristic

Why not use persisted task-change summary cache for ledger:

- bundle v2 itself is already the persisted summary
- the existing repository is keyed around legacy log source fingerprints
- duplicating summary persistence adds another stale-data layer for little value

Additional rule:

- when ledger freshness or bundle v2 is present for a task, skip loading persisted legacy summary cache for that task

### 11.7.1 Presence state must become tri-state plus unknown

Current task-presence surfaces in `claude_team` are effectively:

- `has_changes`
- `no_changes`
- `unknown`

That is too weak once ledger can return warning-only / notices-only task results.

Recommended target:

```ts
type TaskChangePresenceState =
  | 'has_changes'
  | 'needs_attention'
  | 'no_changes'
  | 'unknown'
```

Rules:

- `has_changes`
  - at least one visible net-effect file exists
- `needs_attention`
  - no visible files
  - but ledger produced warnings/notices that the user should still be able to discover from the task surface
- `no_changes`
  - no visible files
  - no important warnings/notices
  - result confidence is sufficient to state that honestly
- `unknown`
  - ledger artifacts are missing, stale beyond validation, or otherwise insufficient to classify

This affects:

- in-memory `taskHasChanges` / negative caches in `changeReviewSlice`
- persisted task-change presence index
- kanban/task-card affordances
- task detail dialog presence resolution
- browser-mode / preload API typings that currently expose only `has_changes | no_changes | unknown`

Migration recommendation:

1. add `needs_attention` to shared `TaskChangePresenceState`
2. replace boolean `taskHasChanges: Record<string, boolean>` with:

```ts
taskChangePresenceByKey: Record<string, TaskChangePresenceState>
```

3. keep a derived helper for old call sites:
   - `hasVisibleChanges(presence) => presence === 'has_changes'`
4. bump task-change presence cache schema version
5. treat old persisted values as:
   - `has_changes` -> `has_changes`
   - `no_changes` -> `no_changes`
6. never persist `needs_attention` as `no_changes`
7. do not populate negative presence cache for a `needs_attention` result
8. update all result-classification helpers so they use:
   - `files.length > 0` -> `has_changes`
   - `files.length === 0 && warnings.length > 0` -> `needs_attention`
   - `files.length === 0 && confidence high/medium && warnings.length === 0` -> `no_changes`

UI rule:

- `needs_attention` should still render an entry affordance for opening task changes
- visually it should not look identical to `has_changes`, but it must not disappear like `no_changes`

Minimal product contract:

- kanban/task-card action gating should no longer be `presence === 'has_changes'`
- it should allow entry for both:
  - `has_changes`
  - `needs_attention`

### 11.7.1.1 Presence classification must be centralized

This is a real low-confidence area in the current UI, because presence classification logic is duplicated.

Today the renderer has more than one helper that effectively maps:

- `files.length > 0` -> `has_changes`
- otherwise `confidence` high/medium -> `no_changes`

That duplication is already fragile, and it becomes wrong once `warnings/notices` must surface as `needs_attention`.

Recommended fix:

- add one pure shared classifier, for example:

```ts
classifyTaskChangePresence({
  visibleFileCount,
  warningCount,
  confidence,
}: {
  visibleFileCount: number
  warningCount: number
  confidence: 'high' | 'medium' | 'low'
}): TaskChangePresenceState
```

- use that classifier in:
  - `changeReviewSlice`
  - `TaskDetailDialog`
  - warm/presence prefetch paths
  - presence-cache writer path in main process where applicable

Negative-cache rule:

- negative TTL cache should be written **only** for `no_changes`
- do **not** negative-cache:
  - `needs_attention`
  - `unknown`

Reason:

- `needs_attention` is not a "negative" result, it is a visible warning state
- caching it as negative would hide exactly the tasks the user still needs to inspect

### 11.7.1.2 Presence mirror consistency across task stores

This is another concrete rollout hazard in current code.

Observed asymmetry:

- direct single-task update path updates:
  - `teamDataCacheByName`
  - `selectedTeamData`
  - `globalTasks`
- bulk refresh path updates only:
  - `teamDataCacheByName`
  - `selectedTeamData`

That means task cards and global surfaces can drift from the selected-team dialog after presence refresh.

Recommended rule:

- all presence mutations must go through one reducer/helper that updates all task mirrors atomically

Recommended helper shape:

```ts
applyTaskChangePresenceMap(
  teamName: string,
  presenceByTaskId: Record<string, TaskChangePresenceState>
)
```

It should update in one state transition:

- `teamDataCacheByName[teamName].tasks`
- `selectedTeamData.tasks` when selected
- `globalTasks`

Strictness:

- no direct custom per-surface presence writes outside this helper
- `setSelectedTeamTaskChangePresence` should delegate to the same helper with a one-task map
- `refreshTeamChangePresence` should use the same helper for bulk updates

This is required to avoid UI disagreement after `needs_attention` rollout.

### 11.7.1.3 Presence repository schema and API chain

This migration is not complete unless the whole presence pipeline accepts the new state.

Current low-confidence spots:

- shared type currently exposes only:
  - `has_changes | no_changes | unknown`
- IPC handler return type is still hardcoded to that union
- preload/browser-mode/http-client stubs also hardcode the old union
- persisted presence repository currently writes only:
  - `has_changes | no_changes`

Required migration points:

- `src/shared/types/team.ts`
- `src/main/ipc/teams.ts`
- `src/preload/index.ts`
- `src/renderer/api/httpClient.ts`
- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/cache/taskChangePresenceCacheTypes.ts`
- `src/main/services/team/cache/taskChangePresenceCacheSchema.ts`
- `src/main/services/team/cache/JsonTaskChangePresenceRepository.ts`

Repository rules:

- persisted presence should still exclude only `unknown`
- after migration, allowed persisted values become:
  - `has_changes`
  - `needs_attention`
  - `no_changes`
- schema version must bump so old readers do not silently normalize `needs_attention` away

Rollout rule:

- do not ship renderer-only `needs_attention` handling before the shared type/API chain accepts it end to end
- otherwise the new state will be narrowed back to `unknown` or dropped on round-trip

Writer-side classification rule:

- update `ChangeExtractorService.recordTaskChangePresence(...)` to use the same centralized classifier as the renderer-facing path
- do **not** keep a parallel writer rule of:
  - `files.length > 0 ? has_changes : no_changes`

Reason:

- current main-process write path still reduces presence to `has_changes | no_changes`
- if left unchanged, the persisted presence index would silently erase warning-only ledger outcomes even after the shared type migration

### 11.7.1.4 Presence cache migration must dual-read v1 and v2

This needs to be called out explicitly because current repository behavior is harsher than it looks.

Observed today:

- `taskChangePresenceCacheSchema.ts` normalizes only schema version `1`
- `JsonTaskChangePresenceRepository.readIndex(...)` unlinks the cache file when normalization fails

That means a naive schema bump can accidentally treat a still-valid older cache file as corruption and delete it on first read.

Required migration rule:

- presence cache normalization must support:
  - legacy v1 shape
  - new v2 shape with `needs_attention`
- older supported schema must be upgraded in memory, not deleted as invalid
- repository should unlink only:
  - unreadable JSON
  - structurally impossible payloads
- repository should **not** unlink merely because the payload is from a previous supported schema version

Recommended migration flow:

1. read raw JSON
2. try normalize as v2
3. if that fails, try normalize as legacy v1
4. if v1 succeeds:
   - keep it as a valid loaded cache
   - rewrite to v2 only on the next successful save/upsert path
5. only if both fail due to true structural invalidity should the file be discarded

Why this matters:

- presence cache is an optimization, but deleting valid old data during rollout creates avoidable UI churn
- this is especially risky in staggered desktop deployments where old and new binaries can coexist for a while
- the goal is compatibility, not cache purging

### 11.8 UI caches

Recommended in-memory caches:

- parsed journal cache:
  - key: `projectDir + taskId + journalStamp + includeDetails`
  - size: `32-64` tasks
- blob content cache:
  - key: `projectDir + blobRef`
  - size: `128-256` blobs with byte budget
- bundle summary cache:
  - key: `projectDir + taskId + journalStamp`
  - short-lived, small, optional

### 11.8.1 Freshness invalidation must be stamp-based, not boot-time heuristic

Current renderer code still has a weak heuristic in places like:

- "result was restored before current session boot, so revalidate"

That is not a reliable freshness model once ledger introduces explicit:

- `journalStamp`
- freshness v2
- integrity states

Required rule:

- revalidation decisions must be driven by ledger freshness/journal provenance
- do **not** use `computedAt < appBootTime` as a correctness signal for ledger-backed summaries

Why this matters:

- a valid summary created before app boot is still valid
- an invalid/stale summary created after boot is still invalid
- boot-time heuristics create both unnecessary reloads and missed stale-state cases

Recommended action:

- retire `wasRestoredBeforeCurrentSession(...)`-style heuristics from ledger-backed paths
- keep any such heuristic only as a best-effort legacy fallback where no journal/freshness evidence exists

### 11.8.2 Async review-state loads must be scope-token guarded

This is another concrete low-confidence area in current renderer state.

Observed today:

- review decision loads are async
- they can write directly into store state after the active scope has already changed

Required rule:

- async loads for:
  - task change sets
  - persisted review decisions
  - resolved file contents
  must be bound to the currently active review scope/request token
- stale async completions must be dropped instead of mutating current scope state

Minimum contract:

- derive a stable `reviewScopeToken` from:
  - team
  - task/member scope
  - request options
  - change-set epoch or equivalent
- every async completion checks that token before calling `set(...)`

Coverage note:

- this must cover **all** review-scope-changing async paths, not only task fetches:
  - `fetchTaskChanges(...)`
  - `fetchAgentChanges(...)`
  - `loadDecisionsFromDisk(...)`
  - `fetchFileContent(...)`
  - stale-refresh fetches before apply

Why this matters:

- otherwise a slow load from the previous task can overwrite decisions or content for the current task
- these bugs are rare and hard to reproduce, but very damaging when they happen

### 11.8.3 Review-decision persistence debounce must be scope-bound

This is a separate race from async loading.

Observed today:

- the renderer uses a debounced persistence path for review decisions
- current debounce state is effectively global, not isolated per active review scope

That creates two risks:

1. a pending save for scope A can fire after the user already switched to scope B
2. clearing decisions for one scope can race with a delayed save from another scope

Required rule:

- decision persistence debounce must be keyed by logical review scope
- scope changes must:
  - cancel or flush the previous scope's pending write intentionally
  - never allow an orphaned timer to write stale decisions into a new scope

Recommended implementation direction:

- replace one global debounce timer with either:
  - a per-scope timer map, or
  - a scope-token-validated single timer payload
- before executing the debounced save:
  - re-read the current active scope token
  - verify it still matches the timer payload
- on dialog close / scope switch:
  - explicitly cancel pending timers for the old scope

Why this matters:

- without this, decision persistence can become non-deterministic under quick task switching
- these bugs tend to look like "randomly restored stale review decisions", which is exactly the class of bug we are trying to remove

### 11.9 Concrete UI file targets

Most changes should land in or around:

- `src/main/services/team/TaskChangeLedgerReader.ts`
- new helper modules under `src/main/services/team/`
  - `TaskChangeJournalReader.ts`
  - `TaskChangeSummaryProjector.ts`
  - `TaskChangeBlobReader.ts`
  - `taskChangeLedger/featureGates.ts`
- `src/main/services/team/ChangeExtractorService.ts`
- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/TeamLogSourceTracker.ts`
- `src/main/services/team/cache/JsonTaskChangePresenceRepository.ts`
- `src/shared/types/review.ts`
- `src/shared/types/team.ts`
- `src/shared/utils/taskChangeState.ts`
- `src/shared/utils/taskChangePresence.ts` (new)
- `src/main/ipc/teams.ts`
- `src/preload/index.ts`
- `src/main/services/team/cache/taskChangePresenceCacheTypes.ts`
- `src/main/services/team/cache/taskChangePresenceCacheSchema.ts`
- `src/renderer/store/slices/changeReviewSlice.ts`
- `src/renderer/store/slices/teamSlice.ts`
- `src/renderer/components/team/review/ChangeReviewDialog.tsx`
- `src/renderer/components/team/review/ReviewFileTree.tsx`
- `src/renderer/components/team/review/ContinuousScrollView.tsx`
- `src/renderer/hooks/useViewedFiles.ts`
- `src/renderer/utils/diffViewedStorage.ts`
- `src/renderer/components/team/dialogs/TaskDetailDialog.tsx`
- `src/renderer/components/team/kanban/KanbanTaskCard.tsx`
- `src/renderer/api/httpClient.ts`

## 12. Review / Apply / Reject Design

### 12.1 Baseline direction stays correct

Current `ReviewApplierService` is already on the right track and should remain strict-by-default.

### 12.1.1 Split apply engine into strict ledger lane vs legacy lane

This is one of the remaining low-confidence areas in the current codebase, because `ReviewApplierService` still contains both:

- ledger-native guarded operations
- older fallback machinery such as `diff3`-style merge behavior

That mixed implementation is acceptable only if the lane boundary is explicit.

Recommended rule:

1. classify the review request **before any mutation attempt**
2. choose exactly one lane:
   - `ledger-native`
   - `legacy-extracted`
3. once the ledger lane is selected, it must be terminal:
   - success
   - `conflict`
   - `manual-review-required`
   - `unavailable`
   - `io-error`
4. do **not** fall through from a failed/incomplete ledger attempt into:
   - `diff3Merge(...)`
   - snippet-level replacement
   - member-log reconstruction heuristics

Suggested lane selection rule:

- use `ledger-native` when the change set source is the task ledger, or the file carries ledger metadata sufficient to identify the operation/state
- use `legacy-extracted` only for non-ledger historical/fallback change sets

Why this matters:

- mixed fallback defeats the safety promise of strict hash-guarded ledger review
- incomplete ledger content should produce an explicit block, not silently route into a weaker merge strategy
- this keeps current legacy compatibility for old non-ledger paths without contaminating the ledger-native path

Implementation note:

- keep `diff3` support only inside the legacy lane
- if product owners later want to remove the legacy lane entirely, that becomes a contained follow-up instead of a risky rewrite

### 12.2 Add capability derivation

Add a dedicated capability helper derived from ledger metadata:

```ts
type LedgerReviewCapabilities = {
  canRejectWholeFile: boolean
  canRejectSelectedHunks: boolean
  requiresManualReview: boolean
  readOnly: boolean
  reasonCodes: Array<
    | 'rename-partial-unsupported'
    | 'copy-partial-unsupported'
    | 'binary'
    | 'too-large'
    | 'missing-before-content'
    | 'missing-after-content'
    | 'blob-missing'
    | 'snapshot-only'
    | 'journal-missing'
  >
}
```

Renderer should use this to disable unsafe actions before the user clicks them.

### 12.3 Operation rules

#### Modify

- full reject: write `before` only if current disk hash matches expected `after`
- partial reject: allowed for text only, using inverse hunk patch when full text exists and hash guard passes

#### Create

- full reject: delete file if current hash matches `afterState.sha256`
- this can still be safe for binary/large create cases if the `after` hash exists even when text content is unavailable
- partial reject: usually manual-only unless captured full text exists

#### Delete

- full reject: restore `before` only if original content exists and current file is absent
- for binary/large deletes without stored bytes, this remains manual-only in this iteration

#### Rename

- display as one grouped change
- full reject: restore old path and delete new path under strict guards
- partial reject: manual-only

#### Copy

- display as one grouped change
- full reject: guarded delete of new path only
- old path remains untouched
- partial reject: manual-only

### 12.3.1 Review surface rule

Review actions operate on the **net visible change set**, not on all historical events.

That means:

- a file hidden by net-noop projection is not reviewable in the changes panel
- historical activity for that file remains visible only in logs/timeline
- a visible file remains reviewable even if current disk has drifted, but actions block on conflict until the user resolves that drift

### 12.4 No snippet-level magic for snapshot paths

For shell/post-hook snapshot changes:

- whole-file reject: strict hash-guarded restore
- partial reject: inverse hunk patch only if full text exists and hash matches
- otherwise: `manual-review-required`

### 12.4.1 No fake text for metadata-only lifecycle states

This point should be explicit because current UI helper code is prone to synthesizing empty strings for create/delete.

Rules:

- `originalFullContent` / `modifiedFullContent` should stay `null` whenever bytes are unavailable or content is non-text
- create/delete semantics may still be shown from `beforeState.exists` / `afterState.exists`
- lifecycle visibility is allowed without text payload
- text diff rendering is **not** allowed without text payload

Narrow exception:

- a synthetic empty side is allowed **only** when the opposite side is real full text and the missing side is semantically empty because of lifecycle, not because bytes were unavailable

Allowed examples:

- text create with captured `after` text:
  - original side may be materialized as `''`
  - modified side is real full text
- text delete with captured `before` text:
  - modified side may be materialized as `''`
  - original side is real full text

Disallowed examples:

- binary create where only `afterState.sha256` is known
- delete where existence is known but original blob is missing
- oversized text file where content capture was skipped
- any create/delete where the "empty" side would only be masking `blob-missing` / `not-captured` / `binary` / `too-large`

Examples:

- binary create with known `afterState.sha256`:
  - visible in changes
  - reject-whole-file may be allowed by guarded delete
  - no text diff
- binary delete with known existence but no stored bytes:
  - visible in changes
  - reject requires manual restore
  - no text diff
- oversized text file with no captured blob:
  - metadata-only row, warning badge, manual review path

### 12.4.2 `FileContentResolver` needs explicit materialization states

To make the rule above enforceable, `FileContentResolver` should stop returning only raw strings plus implicit conventions.

Recommended internal contract:

```ts
type DiffSideMaterialization =
  | { kind: 'full-text'; text: string }
  | { kind: 'synthetic-empty-side'; text: '' }
  | {
      kind: 'unavailable'
      text: null
      reasonCode: 'binary' | 'too-large' | 'blob-missing' | 'not-captured' | 'read-error'
    }

type ResolvedFileDiffContent = {
  original: DiffSideMaterialization
  modified: DiffSideMaterialization
}
```

Rules:

- hunk generation and CodeMirror diff rendering are allowed only when:
  - both sides are `full-text`, or
  - one side is `full-text` and the other is `synthetic-empty-side`
- `unavailable` must stay `null`, never `''`
- line counting and snippet extraction must follow the same materialization contract
- `reviewability: 'metadata-only'` must short-circuit downstream hunk generation
- line-stat recomputation from resolved full contents is allowed only when:
  - both sides are `full-text`, or
  - one side is `full-text` and the other is `synthetic-empty-side`
- otherwise keep ledger-projected stats and `diffStatKnown = false` semantics instead of recomputing from partial materialization

Why this is worth making explicit:

- today the dangerous bug is not only display correctness, but contract ambiguity between resolver, diff builder, and review actions
- once materialization kind is first-class, downstream code can stop reverse-engineering intent from `''` and `null`
- this prevents metadata-only lifecycle changes from regressing back into fake text diffs later

### 12.5 Concrete file targets

- `src/main/services/team/ReviewApplierService.ts`
- `src/main/services/team/FileContentResolver.ts`
- `src/main/services/team/ReviewDecisionStore.ts`
- `src/renderer/store/slices/changeReviewSlice.ts`
- `src/renderer/components/team/review/ChangeReviewDialog.tsx`
- `src/renderer/components/team/review/CodeMirrorDiffUtils.ts`
- renderer review UI files that enable/disable actions based on derived capabilities

## 13. Edge Cases And Their Intended Behavior

### 13.1 Multiple active task scopes

- no file event attribution
- emit warning notices to all active scopes
- UI shows notice even if file list is empty

Implementation note:

- use existing `RuntimeBoardTaskExecutionStore.getActiveScopes(...)` as the single ambiguity source
- do not add a second scope-counting mechanism inside ledger writer code
- this keeps task ambiguity semantics aligned with the rest of board-task execution state

### 13.2 Failed tool after mutation

- keep change
- keep tool status
- surface warning

### 13.3 Background tool completion

- record against task scope active for that execution context
- if scope is ambiguous by completion time, emit notice and skip unsafe attribution

### 13.4 Post-hook mutation

- ledger stores final disk content
- warning says post-hook changed the file after tool result

### 13.5 Corrupt trailing journal line

- ignore malformed trailing line
- full rebuild yields `integrity: 'recovered'`
- warning survives into summary/UI

### 13.6 Bundle stale or missing

- summary path: journal fallback
- detail path: journal direct
- no UI repair write

### 13.7 Bundle write failed after append

- freshness should still write `integrity: 'partial'` if possible
- UI bypasses bundle
- next successful write can regenerate summary

### 13.8 Freshness write failed

- journal remains truth
- live refresh may lag until next successful freshness write or manual refresh
- do not add direct journal watchers just to patch this

### 13.9 Binary or oversized file

- capture metadata and hashes when possible
- no fake text diff
- no unsafe partial reject
- create-reject may still be safe by guarded delete if `after` hash exists
- delete-reject remains manual if original bytes are unavailable

### 13.10 Rename without git relation evidence

- treat as separate changes
- do not invent semantic rename

### 13.11 Unicode, spaces, newline in path

- keep using NUL-delimited git parsing
- no line-based path parsing

### 13.12 Multiple orchestrator processes touching same task

- lock serializes bundle/freshness materialization
- journal append and summary publication remain coherent
- stale-lock recovery is observable

### 13.13 Journal missing but bundle present

- summary-only may degrade to read-only bundle summary with warning
- detail/review actions disabled

### 13.14 Blob missing but journal present

- keep metadata visible
- mark content unavailable
- capabilities downgrade accordingly

### 13.15 Task reopened across execution sequences

- scope and file summaries keep `executionSeqRange`
- UI can show one task summary spanning multiple work intervals without pretending it was one uninterrupted run

### 13.16 Multi-agent task contributions

- bundle-level contributors summarize each agent's contribution
- per-file `agentIds` tell frontend which agents touched a file
- `TaskChangeScope.primaryAgentId` is best-effort only
- if `memberName` is available at write time, store it; otherwise UI should fall back to agent identity display
- `visibleFileCount` may be lower than `touchedFileCount` when an actor's changes net out to no current diff

### 13.17 External concurrent writer in shared worktree

⚠️ This remains the hard honesty boundary.

Without isolation, we still cannot prove that an overlapping external file mutation belongs to our task.

What we can still do well:

- exact file-tool attribution when tool returns explicit before/after
- safe apply/reject via current disk hash guards
- honest ambiguity notices

What we still cannot prove:

- exclusive authorship of overlapping changes in shared files
- perfect separation between task A and task B under concurrent external mutation

### 13.18 Ledger-visible change with later disk drift

Behavior:

- file stays visible in changes because ledger says the task produced a net change
- detail/review surface may show drift/conflict badge after comparing current disk
- apply/reject blocks until hash guard conditions are satisfied

This is the correct product behavior. The task's change history should not disappear just because the workspace moved later.

## 14. Observability And Telemetry

Track these structured events:

- `task_change_ledger_bundle_stale`
- `task_change_ledger_bundle_corrupt`
- `task_change_ledger_journal_fallback`
- `task_change_ledger_bundle_write_failed`
- `task_change_ledger_freshness_write_failed`
- `task_change_ledger_lock_timeout`
- `task_change_ledger_lock_stolen`
- `task_change_ledger_apply_conflict`
- `task_change_ledger_manual_review_required`
- `task_change_ledger_multi_scope_skipped`

Additional useful counters:

- summary fast-path hit rate
- journal summary fallback rate
- detail parse time percentile
- blob-missing rate
- degraded bundle-only summary rate

Success signal after rollout:

- journal fallback exists but is not the dominant path
- apply conflicts are understandable and correspond to real disk drift, not false positives

## 15. Rollout, Compatibility, And Rollback

### 15.1 Compatibility matrix

| UI | Orchestrator | Expected behavior |
| --- | --- | --- |
| old | old | current baseline |
| new | old | compatibility mode - prefers journal, may read v1 bundle `events[]`, must not trust v1 `files[]` as target summary semantics |
| new | new | target behavior |
| old | new | degraded / not supported for ledger v2 fast-path |

That means deployment order matters.

### 15.2 Deployment order

1. ship UI that can read:
   - old v1 full bundles
   - new v2 summary bundles
   - journal fallback
2. ship orchestrator that writes:
   - journal v1
   - summary bundle v2
   - freshness v2

### 15.2.1 Presence-state rollout order

`needs_attention` is a cross-layer contract change, not just a renderer tweak.

Recommended order:

1. update shared type + IPC/preload/browser stubs
2. update main-process presence cache schema/repository read-write
3. update renderer stores/components to consume the new state
4. only then start emitting `needs_attention` from ledger-backed classification paths

Reason:

- current code has several places that still narrow to the old union
- partial rollout would silently degrade the new state before it reaches task cards/dialogs

### 15.3 Feature gates

Recommended gates:

#### UI

- `CLAUDE_TEAM_TASK_CHANGE_LEDGER_ENABLED`
  - default `true`
  - when disabled, bypass ledger-first path and use legacy extraction

#### Orchestrator

- `CLAUDE_TEAM_TASK_CHANGE_LEDGER_BUNDLE_V2_ENABLED`
  - default `true` only after new UI is shipped
  - temporary rollout/rollback gate

- `CLAUDE_TEAM_TASK_CHANGE_LEDGER_LOCK_ENABLED`
  - default `true`
  - only disable for emergency debugging, not standard rollout

This write gate should be treated as temporary rollout safety, not a permanent dual-mode product feature.

### 15.4 Rollback policy

If new UI logic causes problems:

- disable `CLAUDE_TEAM_TASK_CHANGE_LEDGER_ENABLED`
- UI falls back to legacy extraction

If writer rollout causes problems:

- disable `CLAUDE_TEAM_TASK_CHANGE_LEDGER_BUNDLE_V2_ENABLED`
- revert to previous bundle behavior temporarily while keeping journal truth intact

Rollback principle:

- prefer turning off fast-paths, not deleting ledger artifacts

## 16. Implementation Slices

### Slice 1 - Contracts and shared types

`🎯 9.2   🛡️ 9.3   🧠 5.8`  
Estimated size: `~200-350 LOC`.

Do:

- define bundle v2 and freshness v2 contracts
- extend shared types additively
- add temporary feature gates
- define actor identity and reviewability fields explicitly
- add `needs_attention` task presence state and cache-schema migration
- define `reviewKey = changeKey ?? filePath` migration helpers
- version persisted review decisions for `reviewKey` identity
- add a centralized task-change presence classifier and route all presence state through it
- define the ownership matrix for `reviewKey` state vs `filePath` runtime state

Likely commit shape:

- `feat(ledger): add v2 task change bundle contracts`

### Slice 2 - Orchestrator writer lock and materialization split

`🎯 9.1   🛡️ 9.5   🧠 7.8`  
Estimated size: `~350-650 LOC`.

Do:

- implement `TaskChangeWriterLock`
- split journal reader/projector helpers
- implement full rebuild and incremental update under lock
- write freshness v2
- add lease heartbeat and stale-lock steal behavior
- strengthen journal stamp with tail hash
- keep `GitChangePathProvider.ts` as the single bounded git path collector and harden it in place instead of duplicating git parsing in `TaskChangeLedgerService`

Likely commit shape:

- `feat(ledger): add locked v2 bundle materialization`

### Slice 3 - UI reader split: bundle summary fast-path + journal detail

`🎯 9.3   🛡️ 9.4   🧠 7.4`  
Estimated size: `~350-700 LOC`.

Do:

- refactor `TaskChangeLedgerReader`
- add journal reader
- add bundle summary projector
- add missing-journal degraded mode
- make `ChangeExtractorService` ledger path explicit
- bypass persisted legacy summary cache when ledger artifacts exist
- migrate presence resolution so warning-only tasks become `needs_attention`, not `no_changes`
- dual-read presence cache v1/v2 and rewrite to v2 only on successful next save
- migrate review state identity from raw `filePath` keys to derived `reviewKey`
- keep viewed/collapsed localStorage migration best-effort, not blocking
- unify bulk/single presence updates so `globalTasks`, selected team, and cache stay in sync
- keep file watching, lazy content loading, edited drafts, and active scroll selection on actionable `filePath`
- ignore `.board-task-changes/**` in `TeamLogSourceTracker` watcher configuration while keeping `.board-task-change-freshness/**` as the refresh signal

Likely commit shape:

- `feat(ui): read task changes from bundle summary and journal detail`

### Slice 4 - Review capability surfacing

`🎯 8.9   🛡️ 9.2   🧠 6.0`  
Estimated size: `~180-320 LOC`.

Do:

- capability helper
- renderer disable logic
- binary/create/delete/copy nuance

Likely commit shape:

- `feat(review): surface ledger review capabilities`

### Slice 5 - Fixtures, integration tests, smoke

`🎯 9.4   🛡️ 9.6   🧠 6.7`  
Estimated size: `~500-900 LOC`.

Do:

- real temp-repo tests
- cross-repo golden fixtures
- lock recovery tests
- v1/v2 compatibility tests

Likely commit shape:

- `test(ledger): add task change bundle v2 integration coverage`

## 17. Test Plan

### 17.1 Orchestrator tests

Add/expand `bun:test` coverage for:

- Edit exact modify
- Write create
- Write rewrite
- Bash create/delete
- PowerShell snapshot
- background completion
- failed tool after mutation
- post-hook mutation
- rename relation
- copy relation
- binary metadata-only
- large file metadata-only
- multiple active scopes -> notices only
- stale bundle -> full rebuild
- malformed trailing journal -> recovered summary
- same-timestamp events preserve journal append order for projection and do not rely on `eventId` ordering
- bundle write failure -> freshness partial
- lock contention across two writers
- stale lock steal
- lease heartbeat prevents false stale steal during long rebuild
- incremental update only under matching pre-stamp
- journal stamp mismatch by tail hash forces rebuild even when size and mtime are unchanged
- non-descendant `HEAD` rewrite during shell snapshot falls back to status/disk evidence with warning only
- `.board-task-changes/**` writes do not trigger self-invalidating log-source churn in consumers
- `TaskChangeLedgerService` continues to use `GitChangePathProvider` for both working-tree and committed shell path discovery
- existing `RuntimeBoardTaskExecutionStore.getActiveScopes(...)` drives multi-scope ambiguity handling without a shadow scope counter

### 17.2 UI tests

Add/expand Vitest coverage for:

- valid bundle v2 summary fast-path
- legacy v1 bundle compatibility derives from `events[]`, not from cumulative `files[]`
- stale bundle -> journal summary fallback
- corrupt bundle -> journal summary fallback
- detail path always reads journal
- ledger-backed stale detection/revalidation uses freshness or journal stamp, not app boot time
- `TaskChangeSetV2.provenance.sourceFingerprint` drives stale-review detection before renderer-side visible-file fingerprint fallback
- visible ledger change remains visible even when mocked current disk differs
- grouped rename/copy uses stable `changeKey` while `filePath` remains actionable
- review decisions keyed by `reviewKey` survive grouped rename/copy without colliding with actionable `filePath`
- viewed/collapsed localStorage can reset for new `changeKey` files without breaking review decisions
- journal missing + bundle present -> degraded summary only
- blob missing -> metadata-only downgrade
- v1 full bundle compatibility
- notices-only tasks
- presence state maps warning-only result to `needs_attention`, not `no_changes`
- `taskHasChanges` boolean call sites migrate to tri-state presence without false negatives
- negative presence TTL cache is written only for `no_changes`, not `needs_attention`
- centralized classifier is used consistently by summary fetch, warm path, and task dialog
- presence cache v1 payload loads and survives migration to v2 without being deleted as corruption
- persisted review decisions are ignored when request signature/source fingerprint do not match the current review scope
- exact-scope decision files for two filtered variants of the same task can coexist without overwriting each other
- persisted decisions load into a staged buffer first and are activated only after current change-set normalization
- file watching and draft/edit state remain filePath-keyed while review decisions migrate to `reviewKey`
- rename/copy/move badges prefer ledger relation metadata and do not require full file-content hydration
- rename grouping
- copy grouping
- per-agent contributor projection
- net-noop files are omitted from visible changes but still reflected in contributor touched counts
- reviewability/contentAvailability projection
- freshness missing + bundle stamp matches actual journal -> fast-path still allowed
- no silent legacy downgrade without warning
- `FileContentResolver` returns `synthetic-empty-side` only for true text create/delete lifecycle cases
- `FileContentResolver` keeps binary / too-large / blob-missing lifecycle sides as unavailable, not empty string
- `TeamLogSourceTracker` ignores `.board-task-changes/**` at watcher level while still reacting to `.board-task-change-freshness/**`
- path grouping/change identity uses shared comparison normalization and does not collapse case-distinct paths on case-sensitive paths
- snippet rendering does not synthesize `oldString/newString = ''` for unavailable ledger text
- stale async decision/content loads for an old review scope are dropped and do not overwrite current scope state
- pending debounced decision save from an old scope is canceled or ignored after scope switch
- agent-mode fetches are request-token guarded the same way as task-mode fetches
- bundle/freshness generation mismatch causes retry or journal fallback, not a stale fast-path read

### 17.3 Review tests

Cover:

- create reject guarded delete
- binary create reject guarded delete still allowed when hash exists
- delete reject restore when original bytes exist
- delete reject manual-only when original bytes unavailable
- metadata-only create/delete never synthesize text diff content
- rename full reject success/conflict
- copy full reject semantics
- partial reject manual-only for rename/copy
- snapshot partial reject via inverse hunk patch
- ledger-native lane never falls through to `diff3` or snippet replacement after hash/content guard failure
- legacy non-ledger lane can still use compatibility merge behavior without affecting ledger-backed files
- old persisted filePath-keyed decisions can still be loaded and mapped onto new `reviewKey` state
- versioned review-decision payload v2 survives load/save without store-level blind key rewriting
- metadata-only snippets do not produce hunk hashes or partial-review affordances from fake empty text
- line-stat recomputation happens only for `full-text` / `synthetic-empty-side` materialization and not for unavailable metadata-only states
- task-mode decision persistence respects `TaskChangeRequestOptions` signature and does not replay decisions across different filtered variants of the same task
- agent/task stale refresh compares explicit provenance fingerprint first and falls back to renderer-side change fingerprint only when provenance is absent

### 17.4 Cross-repo fixtures

Create golden fixture directories from real orchestrator output:

- v1 full bundle case
- v2 summary bundle case
- notices-only case
- rename case
- copy case
- binary case
- missing-blob case
- recovered journal case

These fixtures should be consumed by UI tests so the reader is validated against real artifact shapes.

### 17.5 Manual smoke matrix

Before rollout, manually verify:

- edit existing file
- create file
- delete file
- shell rename
- shell copy
- binary create
- binary delete
- large file change
- failed shell after write
- formatter/post-hook mutation
- concurrent external edit conflict on reject
- two orchestrator processes contending on same task
- ambiguous multi-scope task
- refresh task presence and confirm selected-team surface and global task cards stay in sync
- warning-only task shows `needs_attention` affordance end to end

## 18. Verification Commands

### Orchestrator

```bash
bun test src/services/taskChangeLedger/GitChangePathProvider.test.ts
bun test src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.test.ts
bun test src/services/boardTaskActivity/BoardTaskTranscriptPersistence.test.ts
bun run build:dev
```

Add dedicated task-change-ledger integration tests and include them once created.

### UI

```bash
pnpm test -- TaskChangeLedgerReader ReviewApplierService FileContentResolver ChangeExtractorService
pnpm typecheck
```

### Both repos

```bash
git diff --check
```

## 19. Acceptance Criteria

This plan is done only when all of the following are true:

1. New writes no longer store full `events[]` inside bundle.
2. Bundle v2 is sufficient to produce `summaryOnly` task changes without journal in the common case.
3. Detail/review path still works correctly when bundle is missing or stale.
4. Incremental summary update is guarded by a per-task cross-process lock.
5. UI can show per-task contributor summary and per-file agent attribution from ledger data.
6. Grouped rename/copy changes expose a stable `changeKey` distinct from actionable `filePath`.
7. Journal stamp uses a stronger signature than only `bytes + mtimeMs`.
8. Long-running rebuilds do not lose the lock due to stale-lease false positives.
9. Apply/reject never mutates when hash guards fail.
10. Binary/large cases are honest and capability-gated.
11. Missing journal or blob states degrade to read-only/metadata-only with warnings, not fake detail.
12. Multi-scope ambiguity produces notices and no unsafe attribution.
13. Changes panel semantics are net-effect based, not cumulative history based.
14. Changes panel is projected from ledger baseline vs ledger final state, not live disk bytes.
15. Notices-only tasks still return a non-null ledger result with warnings.
16. Metadata-only lifecycle changes never masquerade as text diffs.
17. Task presence surfaces can represent warning-only results as `needs_attention`, not only `has_changes` / `no_changes`.
18. Review state migration uses `reviewKey = changeKey ?? filePath` without breaking actionable file operations.
19. Review decision persistence is backward-compatible across old filePath keys and new `reviewKey` keys.
20. Non-critical viewed/collapsed UI persistence may reset for new grouped changes without affecting correctness.
21. Real temp-repo and cross-repo fixture tests cover the listed scenarios.
22. There is no UI-side repair writer.
23. `needs_attention` survives the shared type -> IPC -> preload/API -> renderer pipeline without being collapsed or dropped.
24. Presence refresh keeps `teamDataCacheByName`, `selectedTeamData`, and `globalTasks` consistent.
25. Persisted review-decision migration normalizes legacy filePath keys only after the active change set is known.
26. Internal ledger artifact writes do not cause avoidable log-source tracker churn in consumers.
27. Review decision identity uses `reviewKey`, while file watching/editor/draft state stays on actionable `filePath`.
28. Path relation badges prefer ledger metadata and do not depend on content-guessing in the common ledger path.
29. Ledger-native apply/reject is a terminal lane and never silently falls through to legacy merge/snippet behavior.
30. `FileContentResolver` distinguishes `full-text`, `synthetic-empty-side`, and `unavailable` so metadata-only lifecycle changes cannot masquerade as text diffs.
31. `GitChangePathProvider` remains the single bounded git path collector for ledger path discovery, and `TaskChangeLedgerService` does not reintroduce direct maxBuffer-based git parsing.
32. Presence cache migration dual-reads supported legacy schema and does not delete older valid cache files as corruption during rollout.
33. `TeamLogSourceTracker` ignores `.board-task-changes/**` at watcher level while still using `.board-task-change-freshness/**` as the refresh signal.
34. Legacy v1 bundle compatibility uses `events[]` as evidence and does not reuse v1 cumulative `files[]` semantics for the new summary contract.
35. Logical path identity uses shared comparison normalization instead of unconditional lowercasing, so case-sensitive paths do not collide.
36. Ledger snippet rendering never synthesizes unavailable text as empty-string patch content.
37. Ledger projection uses journal append order as the canonical event order and does not rely on timestamp or `eventId` tie-breaking for state transitions.
38. Ledger-backed freshness/revalidation uses journal/freshness provenance instead of app-boot-time heuristics.
39. Async loads for change sets, decisions, and file content are scope-token guarded so stale completions cannot overwrite the current review scope.
40. Line-stat recomputation from resolved content happens only for authorized materialization states and never from unavailable metadata-only content.
41. Persisted review decisions are bound to logical review scope via request signature and source fingerprint, so different filtered variants of the same task do not replay each other's decisions.
42. Debounced review-decision persistence is scope-bound and cannot write stale decisions after a scope switch or dialog close.
43. Persisted decisions are staged and normalized against the current visible change set before they enter live review state.
44. Request-token guarding covers agent fetches, task fetches, file-content loads, and stale-refresh fetches consistently.
45. `TaskChangeSetV2` carries explicit provenance, and stale detection prefers `provenance.sourceFingerprint` over renderer-side visible-file fingerprints whenever provenance is present.
46. Review-decision persistence can store and reload multiple logical variants of the same task/member scope without last-write-wins overwrite between valid variants.
47. Summary readers treat bundle and freshness as one coherent generation boundary and never trust a mismatched pair as current truth.
48. Shell snapshot change projection remains truthful across non-descendant `HEAD` rewrites by degrading to status/disk evidence instead of silently dropping change attribution.

## 20. Residual Risks After This Plan

Even after implementation, these risks remain:

- external concurrent writers in a shared worktree can still overlap our attribution window
- binary delete restore remains manual without captured bytes
- old UI with new writer remains a deployment-order hazard
- freshness write failure can delay live refresh until the next successful signal
- actor labels may still be partial when runtime cannot provide stable member identity at write time
- some users may still expect cumulative activity in the changes panel, so the product should keep logs/timeline clearly available for that need

Expected shared-worktree posture after this plan:

- UX reliability: `🎯 9.1`
- storage and replay safety: `🛡️ 9.5`
- attribution proof ceiling without isolation: `7.3-7.8`
- operational complexity: `🧠 7.9`

That attribution ceiling is not a ledger bug. It is a property of the no-isolation execution model.

## 21. Final Recommendation

Implement **Option A** exactly as:

- journal truth
- summary bundle v2
- per-task cross-process writer lock
- UI summary fast-path from bundle
- UI detail from journal
- strict ledger-native apply/reject
- no second writer

Do **not** spend this iteration on:

- UI-side repair writes
- SQLite index
- binary byte-store restore
- worktree isolation

If we want this feature to feel fast, stable, and honest in prod, this is the right base architecture.
