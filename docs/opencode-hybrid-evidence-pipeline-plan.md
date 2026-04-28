# OpenCode Hybrid Evidence Pipeline Plan

## Summary

Selected direction: **Hybrid evidence pipeline for OpenCode task-change full-text recovery**.

Goal: improve OpenCode task changes from "visible metadata-only/manual review" to Cursor-like text diffs whenever full `before` and `after` can be proven, while preserving the Variant 1 guarantee: if evidence is incomplete, ambiguous, too large, binary, or stale, keep a metadata-only manual-review ledger event instead of inventing a diff.

Scores:

- 🎯 9.2 - strongest path to useful OpenCode diffs without weakening task attribution.
- 🛡️ 9.4 - safe if implemented as OpenCode-only enrichment with strict verification and fail-closed fallback.
- 🧠 7.4 - moderate/high complexity because snapshot shape, inverse patch reconstruction, and historical/current file state must be separated carefully.

Estimated implementation size: **1400-2600 LOC**, mostly tests and fixture/live-smoke coverage.

This plan does **not** change change detection for Claude Code, Codex native, shell snapshots, PowerShell snapshots, or exact tool ledger events. It only enriches OpenCode reconstructed changes before importing them into `TaskChangeLedgerService`.

### Top 3 Viable Options

1. **Hybrid evidence pipeline** - 🎯 9.2   🛡️ 9.4   🧠 7.4 - ~1400-2600 LOC.
   Best balance. It upgrades to full diffs only when a full-text anchor is proven and keeps Variant 1 metadata-only fallback everywhere else.

2. **Chain-only hardening, no snapshot reader** - 🎯 7.8   🛡️ 9.5   🧠 4.5 - ~500-900 LOC.
   Very safe and useful for `write -> edit -> edit` sequences, but many real OpenCode edits still stay manual-only because the initial file baseline is unknown.

3. **Snapshot-first bridge** - 🎯 7.4   🛡️ 7.6   🧠 8.2 - ~1600-2800 LOC.
   Potentially strongest UX, but riskier because OpenCode snapshot shape, performance, and task boundaries are not yet a stable runtime contract for us.

Chosen path: option 1. It lets us ship incremental value without betting correctness on snapshot internals before the live probe proves them.

## Confidence Gaps Fixed In This Revision

This revision intentionally tightens the places where the first draft was too optimistic.

1. **Current disk is not a safe historical anchor by itself**.
   A file on disk today may include later external edits. Reverse-applying an OpenCode `edit` to current disk can produce a plausible `before`, but that only proves "this edit could transform a synthetic before into the current file". It does not prove the current file was OpenCode's historical `after`. Therefore current disk may only be used as a full-text anchor when there is an explicit freshness proof. Otherwise it is verification-only or metadata-only.

2. **`apply_patch` update hunks do not imply full-file before/after**.
   A patch hunk can prove touched lines, but the current ledger review model expects full-file text for safe apply/reject. `Add File` can often be exact. `Delete File` can be exact only if full deleted content is available. `Update File` needs snapshot or another full-text anchor before it can become reviewable full text.

3. **OpenCode snapshots are useful but not a stable contract yet**.
   Official OpenCode config docs say snapshots are enabled by default and support undo/revert, but also warn that large repos or many submodules can cause slow indexing and significant disk usage. The plan therefore treats snapshot evidence as gated enrichment, not as a mandatory foundation. Source: [OpenCode config snapshot docs](https://opencode.ai/docs/config/#snapshot).

4. **Old `snapshot:false` sessions will not all become Cursor-like diffs**.
   That is acceptable. For old sessions, exact full-text recovery is allowed only from proven toolpart chain anchors, exact `write` content, or a later snapshot if available. Pure edit-only unknown-baseline histories remain metadata-only.

5. **Auto apply/reject must not be enabled for preview-only evidence**.
   If we ever show a "best effort" patch preview, it must not populate normal `beforeContent` / `afterContent` in a way that makes `ReviewApplierService` think the file is safely rejectable. Preview-only evidence needs a separate UI contract, so it is out of scope for this iteration.

6. **Existing ledger anchors are risky unless lineage is exact**.
   A bundle summary may be rebuilt, compacted, or contain events from prior imports. Using it as a baseline can accidentally stitch unrelated history into a new OpenCode import. First implementation should not read existing ledger anchors. Only in-memory toolpart chain anchors and snapshot anchors are allowed. Ledger anchors can be added later with explicit event-level lineage checks.

7. **Inverse reconstruction is not an evidence source by itself**.
   Reverse-applying `newString -> oldString` is only a transformation. It becomes evidence only when the `after` text is already proven by snapshot, exact toolpart chain, or future freshness proof. A later `write` toolpart does not prove the historical after-state of an earlier edit if it overwrote the file. The plan must not promise full diffs for pure edit-only old sessions without a real anchor.

8. **OpenCode exposes snapshot debug commands**.
   Local OpenCode 1.14.19 has `opencode debug snapshot track`, `opencode debug snapshot patch <hash>`, and `opencode debug snapshot diff <hash>`. The snapshot probe should prefer this supported debug surface before falling back to data-dir artifact discovery.

9. **OpenCode debug snapshot commands are not a production API yet**.
   A quick local probe showed `opencode debug snapshot track` can return `undefined` outside a real active snapshot context and can trigger a one-time SQLite migration. It also has no JSON output mode in the current help. Therefore these commands are useful for live smoke/probe only. The Changes UI path must not shell out to them.

10. **Snapshot evidence also needs a task boundary, not just file bytes**.
    A snapshot diff can be correct but still not task-scoped. If OpenCode snapshot state is session-wide or project-wide, it may include work from another task in the same teammate session. Full-text import from snapshots is allowed only when the bridge can prove the diff is bounded by the same strict delivery window as the task.

11. **Stable import keys need collision checks**.
    `sourceImportKey` should stay stable so reruns do not duplicate old events. But stable keys also need a batch-level collision guard: if two candidate changes produce the same key with different path/session/profile evidence, the bridge must skip both or keep the first and report a diagnostic. Silent collision would hide changes.

12. **SQLite rows and snapshot artifacts must come from a consistent read window**.
    A backfill can run while OpenCode is still writing SQLite rows or snapshot files. The bridge must fingerprint the OpenCode DB and snapshot metadata before/after reads. If the source changes mid-read and no transaction/snapshot guarantees consistency, fallback to metadata-only or retry once with caps.

13. **Backfill cache can hide later truth if outcomes are collapsed**.
    `no-attribution`, `transient-error`, `skipped-capability`, `duplicates-only`, and `imported` must not share one sticky "done" cache state. A strict UI auto-backfill that missed delivery context at time T must be allowed to retry after delivery records arrive.

14. **Partial artifact writes are worse than empty changes**.
    If full-text enrichment writes blobs/events partially and then crashes, the next read can show a broken diff or unlock unsafe review. The importer must either use existing atomic ledger paths or degrade to metadata-only in a way that idempotent rerun can recover.

15. **Partially recognized OpenCode toolpart shapes are dangerous**.
    A toolpart with a known-looking path but unknown content shape is not "almost supported". It can become metadata-only only when strict delivery attribution and an exact touched path are proven. Otherwise it is diagnostics-only.

16. **Snapshot enablement is session-scoped**.
    The bridge cannot assume a task has snapshot evidence because the current managed profile now says `snapshot:true`. It must use the mode recorded for the session that produced the OpenCode history.

## Current State

Variant 1 is already committed:

- Orchestrator commit: `6255cb2 feat(opencode): add gitless ledger fallback`.
- UI commit: `e48ecf66 fix(changes): keep metadata-only ledger events manual`.

What Variant 1 provides:

- Strict OpenCode delivery attribution.
- Completed `write` / `edit` / `apply_patch` toolparts are not silently lost.
- Unknown baseline becomes metadata-only/manual review.
- UI blocks unsafe apply/reject via `manual-review-required`.
- Real live E2E passed with `opencode run`.

Main limitation:

- For many `edit`, `apply_patch`, and overwrite `write` cases, the UI can show that a file changed, but cannot show a full text diff because `before` is unavailable.

Current important files:

```text
src/services/opencode/OpenCodeToolpartChangeReconstructor.ts
src/services/opencode/OpenCodeLedgerBridgeService.ts
src/services/opencode/OpenCodeOfflineSessionReader.ts
src/services/taskChangeLedger/TaskChangeLedgerService.ts
```

The managed OpenCode profile currently sets:

```ts
// src/services/opencode/OpenCodeProfileManager.ts
snapshot: false,
```

That should not be globally flipped as a blind first step.

## Core Design

Add a new OpenCode-only enrichment layer:

```text
OpenCode SQLite/session-store
  -> OpenCodeOfflineSessionReader
  -> OpenCodeToolpartChangeReconstructor
  -> OpenCodeChangeEvidenceEnricher
  -> OpenCodeLedgerBridgeService
  -> TaskChangeLedgerService.importTaskChangeLedgerEvents
  -> existing UI reader/review path
```

The new layer receives already attributed OpenCode candidate changes. It may upgrade metadata-only events to full-text events only when it can prove the exact `before` and `after`.

### Evidence Priority

Use evidence in this order:

1. Existing exact chain from toolparts.
2. OpenCode snapshot evidence, if shape is supported and live-tested.
3. Inverse reconstruction from `edit oldString/newString`, but only as a verifier/transformer on top of a proven full-text anchor.
4. Inverse reconstruction from supported `apply_patch` markers/hunks, but only as a verifier/transformer on top of a proven full-text anchor or full-file patch content.
5. Variant 1 metadata-only final disk state fallback.

The order matters. Snapshot evidence can prove historical state even when current disk has changed. Inverse reconstruction does not prove history by itself; it only verifies and expands a diff when an anchor already proves one side of the file. Metadata-only fallback remains the safety net.

### Reviewability Decision Matrix

Every candidate file event must pass through one shared decision function before it becomes a ledger event.

| Evidence | Full diff allowed | Accept/reject allowed | Result |
| --- | --- | --- | --- |
| Exact OpenCode `write` with full text and known previous text from same chain | Yes | Yes, existing ledger hash guards still apply | Full-text ledger snapshot |
| Exact OpenCode `write` with full text and unknown previous text | No for reject baseline | No | Metadata-only/manual review, unless operation is proven create |
| `edit oldString/newString` with known chain before | Yes | Yes | Full-text ledger snapshot |
| `edit oldString/newString` with unknown baseline | No | No | Metadata-only/manual review |
| `edit oldString/newString` with snapshot after anchor and verified inverse | Yes | Yes | Full-text ledger snapshot |
| `apply_patch Add File` with complete new file content | Yes for create | Yes if current hash guard matches after | Full-text create |
| `apply_patch Update File` hunk only | No | No | Metadata-only/manual review unless full anchor exists |
| `apply_patch Delete File` without deleted full text | No | No | Metadata-only/manual review |
| Snapshot diff with task delivery boundary and supported shape | Yes | Yes | Full-text ledger snapshot |
| Snapshot diff without task boundary | No | No | Diagnostics-only or metadata-only if exact touched path exists |
| Current disk only | No | No | Metadata-only final state at most |
| Binary/large/unreadable | No | No | Metadata-only/manual review |
| Attribution missing or ambiguous | No | No | Diagnostics-only, no file event |

This table should be encoded in tests, not left as prose. If a future code path bypasses it, that is a design bug.

## Non-Goals

- Do not add broad workspace scanning.
- Do not infer file changes from assistant text, task comments, logs, or natural-language claims.
- Do not make OpenCode snapshot mandatory for all users.
- Do not change apply/reject logic for non-OpenCode agents.
- Do not rewrite historical ledger events already imported.
- Do not auto-merge worktree changes into main.
- Do not treat current disk as historical `after` unless a separate freshness proof says it is still the OpenCode after-state.
- Do not add a preview-only diff UI in this iteration.

## Safety Invariants

Every full-text event must satisfy:

```text
before + operation = after
after == trusted anchor
```

Trusted anchors:

- OpenCode snapshot after-state tied to the same session/toolpart/file.
- Current disk hash only with a separate freshness proof. "Latest known OpenCode operation" is not enough because external writers are invisible without isolation.
- Previous exact in-memory toolpart chain after-state from the same OpenCode session and normalized path.
- OpenCode `write` content when its full content is present, not truncated, not binary, under blob size cap.

Non-anchors:

- A later `write` after an earlier `edit`, because the write may overwrite the edit's result.
- OpenCode assistant text or task comments.
- File mtime.
- Current disk without freshness proof.
- Ledger bundle summaries.

If any invariant fails:

```text
return metadata-only/manual-review
```

Never:

- synthesize empty `before` for an existing file;
- use a broad git status result to attribute OpenCode toolparts;
- auto apply/reject a file with unavailable `beforeState` / `afterState`;
- downgrade a conflict into success.
- promote preview or hunk-only evidence into full-file `beforeContent` / `afterContent`.

## Data Model

Add internal evidence types. These are internal to OpenCode bridge and should not become public UI contracts unless needed.

```ts
export type OpenCodeEvidenceProof =
  | 'toolpart-chain'
  | 'opencode-snapshot'
  | 'inverse-edit-chain'
  | 'inverse-apply-patch-chain'
  | 'metadata-only-fallback'

export type OpenCodeTextEvidence =
  | {
      kind: 'full-text'
      before: string
      after: string
      operation: 'create' | 'modify' | 'delete'
      proof: Exclude<OpenCodeEvidenceProof, 'metadata-only-fallback'>
      confidence: 'exact' | 'high'
      warnings?: string[]
    }
  | {
      kind: 'metadata-only'
      reason: string
      operation: 'create' | 'modify' | 'delete'
      warnings?: string[]
    }
```

Add explicit anchor types so reviewers can tell whether a full-text upgrade is safe:

```ts
export type OpenCodeTextAnchor =
  | {
      kind: 'snapshot-after'
      text: string
      sha256: string
      snapshotId: string
      sessionId: string
      partId?: string
      deliveryBoundaryId?: string
    }
  | {
      kind: 'toolpart-after'
      text: string
      sha256: string
      sessionId: string
      partId: string
    }
  | {
      kind: 'ledger-after'
      text: string
      sha256: string
      eventId: string
      sourceImportKey: string
    }
  | {
      kind: 'current-disk-fresh'
      text: string
      sha256: string
      freshnessProof: OpenCodeFreshnessProof
    }

export type OpenCodeFreshnessProof = {
  kind: 'same-delivery-window'
  sessionId: string
  taskId: string
  latestPartId: string
  // A freshness proof must be generated by the runtime delivery/backfill path, not by
  // reading arbitrary file mtimes during old history recovery.
  generatedAt: string
}
```

Add delivery-boundary snapshot metadata as optional future fields:

```ts
export type OpenCodeDeliverySnapshotBoundary = {
  schemaVersion: 1
  teamName: string
  taskId: string
  memberName: string
  laneId: string
  runtimeSessionId: string
  inboxMessageId: string
  deliveredUserMessageId: string
  preDeliverySnapshotHash?: string
  postDeliverySnapshotHash?: string
  snapshotAdapterVersion?: number
  opencodeVersion?: string
}
```

Without a boundary like this, snapshot evidence is diagnostics-only. It must not populate `beforeContent` / `afterContent`.

No `current-disk-fresh` anchor should be used until the runtime has a real freshness proof.

No `ledger-after` anchor should be used in the first production implementation. It is listed as a future type only. The safer first implementation relies only on:

- `snapshot-after`;
- `toolpart-after`;
- metadata-only fallback.

Extend `ReconstructedOpenCodeToolChange` additively:

```ts
type ReconstructedOpenCodeToolChange = {
  // existing fields
  evidenceProof?: OpenCodeEvidenceProof
  evidenceDiagnostics?: string[]
  snapshotId?: string
  snapshotSource?: 'opencode'
}
```

Extend imported event metadata additively:

```ts
type ImportedOpenCodeFileChange = {
  // existing fields
  evidenceProof?: OpenCodeEvidenceProof
  snapshotId?: string
  evidenceWarnings?: string[]
}
```

Do not change existing fields:

```ts
beforeContent
afterContent
beforeState
afterState
operation
confidence
source
```

## New Module

Create:

```text
src/services/opencode/OpenCodeChangeEvidenceEnricher.ts
```

Main API:

```ts
export type OpenCodeEvidenceEnrichmentParams = {
  workspaceRoot: string
  sessionId: string
  changes: ReconstructedOpenCodeToolChange[]
  toolparts: OpenCodeToolpartEvidenceInput[]
  snapshotReader?: OpenCodeSnapshotEvidenceReader
  existingLedgerAnchors?: never
  allowCurrentDiskFreshAnchor?: false
  mode: 'strict-delivery'
  diagnostics: string[]
}

export class OpenCodeChangeEvidenceEnricher {
  async enrich(params: OpenCodeEvidenceEnrichmentParams): Promise<ReconstructedOpenCodeToolChange[]> {
    const snapshotEvidence = await this.snapshotReader?.readEvidence(params).catch(error => {
      params.diagnostics.push(`OpenCode snapshot evidence read failed - ${formatError(error)}`)
      return null
    })

    const byFile = groupByComparisonKey(params.changes)
    const enriched: ReconstructedOpenCodeToolChange[] = []

    for (const fileChanges of byFile.values()) {
      enriched.push(...this.enrichFileTimeline(fileChanges, snapshotEvidence, params))
    }

    return enriched
  }
}
```

Important: this module must not write files. It only returns candidate ledger changes.

The first production implementation should set:

```ts
allowCurrentDiskFreshAnchor: false
```

This prevents a tempting but unsafe shortcut where old historical sessions use whatever happens to be on disk today as OpenCode's after-state.

## Snapshot Evidence Reader

Create:

```text
src/services/opencode/OpenCodeSnapshotEvidenceReader.ts
```

Initial interface:

```ts
export type OpenCodeSnapshotFilePatch = {
  sessionId: string
  partId?: string
  messageId?: string
  filePath: string
  relativePath: string
  beforeContent?: string
  afterContent?: string
  beforeSha256?: string
  afterSha256?: string
  operation?: 'create' | 'modify' | 'delete'
  snapshotId: string
  timestamp?: string
}

export interface OpenCodeSnapshotEvidenceReader {
  readEvidence(input: {
    workspaceRoot: string
    sessionId: string
    candidatePartIds: string[]
    candidatePaths: string[]
  }): Promise<{
    supported: boolean
    patches: OpenCodeSnapshotFilePatch[]
    diagnostics: string[]
  }>
}
```

### Snapshot Discovery Strategy

This must be proven before production enablement.

Phase A:

- Add a live probe test that runs OpenCode with `snapshot:true` in an isolated temp HOME.
- Use the supported debug surface first:
  - `opencode debug snapshot track`;
  - `opencode debug snapshot patch <hash>`;
  - `opencode debug snapshot diff <hash>`.
- Make OpenCode perform:
  - create file;
  - edit file;
  - apply_patch update;
  - delete if possible.
- Capture pre-delivery and post-delivery snapshot hashes around a single delivered task if OpenCode exposes a stable way to do so.
- Search OpenCode data dir only under the temp HOME.
- Capture exact artifact paths and shape.
- Assert the reader can recover full before/after for at least create/edit/update.

The probe must explicitly assert that `track` returns a parseable non-`undefined` snapshot hash after a real file-changing OpenCode run. If it returns `undefined`, snapshot production support is blocked and the plan falls back to chain-only + metadata-only behavior.

Fallback data-dir discovery is allowed only in the live probe. Production should use deterministic snapshot IDs/hashes from the proven metadata path. Production must not call `opencode debug snapshot ...` during Changes loading because it is human-oriented, has no JSON contract, and may trigger migrations or expensive work.

Phase B:

- Implement reader only for the proven shape.
- Require a task-scoped snapshot boundary before returning reviewable full-text evidence.
- If the shape is missing or changed, return:

```ts
{
  supported: false,
  patches: [],
  diagnostics: ['unsupported-opencode-snapshot-shape']
}
```

No exception should escape into UI read path.

### Snapshot Probe Decision Matrix

The live probe decides what can be built. Do not continue to production snapshot reader if the proof is weak.

| Probe result | Decision |
| --- | --- |
| `track` returns `undefined` after real file-changing run | Keep `snapshotEvidenceMode: off`; do not implement production snapshot reader |
| `track` returns hash, but `patch/diff` output cannot be tied to session/message/part/path | Keep metadata-only for snapshot path |
| Snapshot output is session/project-wide and no pre/post delivery boundary exists | Diagnostics-only, no full-text ledger events |
| `patch/diff` provides only human unified diff without full before/after and no stable artifact path | Do not create auto-reviewable full-file ledger events |
| Stable snapshot hash plus deterministic artifact path with full before/after | Implement version-gated reader |
| Shape works on macOS but not Windows path cases | Keep reader disabled on Windows until fixture passes |

This matrix is intentionally conservative. A weaker snapshot result may still be useful for diagnostics later, but not for `beforeContent` / `afterContent`.

### Snapshot Task Boundary Contract

Snapshot evidence is allowed to become full-text ledger evidence only if all are true:

- The snapshot boundary is captured for the same `teamName`, `taskId`, `memberName`, `laneId`, and `runtimeSessionId`.
- The boundary is tied to the same inbound/delivered app message IDs used by strict delivery attribution.
- The snapshot diff can be computed between pre-delivery and post-delivery states, or the proven OpenCode API has equivalent semantics.
- Every returned file path normalizes inside the same workspace root.
- The file path also appears in the strict-delivery matched OpenCode toolparts for that task, unless the future runtime explicitly records exact touched paths.

If the snapshot only exposes a current session/project diff without a pre/post task boundary, it is not task-safe. Keep it diagnostics-only.

### Snapshot Boundary Persistence Contract

The weakest part of snapshot-based evidence is not reading bytes. It is proving that the bytes belong to the task being opened. Persist the boundary as a delivery-side contract, not as a UI reconstruction trick.

Boundary record:

```ts
export type OpenCodeDeliverySnapshotBoundary = {
  schemaVersion: 1
  teamName: string
  taskId: string
  memberName?: string
  laneId?: string
  runtimeSessionId?: string
  deliveredUserMessageId: string
  inboxMessageId?: string
  workspaceRoot: string
  opencodeVersion?: string
  snapshotAdapterVersion?: number
  preDeliverySnapshotHash?: string
  postDeliverySnapshotHash?: string
  captureStatus:
    | 'captured'
    | 'pending'
    | 'snapshot-disabled'
    | 'unsupported-shape'
    | 'capture-failed'
    | 'not-terminal'
    | 'not-configured'
  diagnostics?: string[]
  createdAt: string
}
```

Persistence rules:

- Store this next to the existing OpenCode delivery ledger/session metadata, not inside UI state.
- The record must contain only identifiers, hashes, version metadata, and diagnostics. No file content.
- The record must be written before and after delivery around the same inbound app message.
- Boundary capture failure must not block teammate execution or task delivery.
- Missing or failed boundary means snapshot evidence can still produce diagnostics, but cannot populate `beforeContent` / `afterContent`.
- The boundary writer must use atomic write and bounded retry, matching the existing ledger artifact style.
- The bridge must reject a boundary if `workspaceRoot`, `teamName`, `taskId`, `memberName/laneId/sessionId`, or message IDs do not match the strict delivery context.

Do not infer boundary from comments, task logs, assistant text, file mtimes, or current disk contents. Those are useful for diagnostics, not for reviewable full-text evidence.

Example validation:

```ts
function isSnapshotBoundaryUsable(
  boundary: OpenCodeDeliverySnapshotBoundary | undefined,
  request: StrictDeliveryBackfillRequest,
): boundary is OpenCodeDeliverySnapshotBoundary & {
  captureStatus: 'captured'
  preDeliverySnapshotHash: string
  postDeliverySnapshotHash: string
} {
  if (!boundary) return false
  if (boundary.captureStatus !== 'captured') return false
  if (!boundary.preDeliverySnapshotHash || !boundary.postDeliverySnapshotHash) return false
  if (boundary.teamName !== request.teamName) return false
  if (boundary.taskId !== request.taskId) return false
  if (boundary.deliveredUserMessageId !== request.deliveredUserMessageId) return false
  return true
}
```

### Snapshot Shape Contract

The production reader must be versioned around the exact shape proven by the live probe.

```ts
export type OpenCodeSnapshotShapeSupport =
  | { supported: true; adapterVersion: 1; shapeFingerprint: string }
  | { supported: false; code: 'unsupported-opencode-snapshot-shape'; diagnostics: string[] }
```

The live probe must persist a small golden fixture documenting:

- where the artifact lives relative to the OpenCode data dir;
- how it links to session/message/part/file;
- what `opencode debug snapshot track` returns before and after a tool run;
- how snapshot hash maps to `debug snapshot patch` / `debug snapshot diff`;
- whether it contains full before text, full after text, or only patches;
- how create/delete/update are represented;
- whether line endings are byte-preserved;
- whether binary files are represented as content, hashes, or metadata.

Production code must not discover arbitrary files with a recursive broad search every time the user opens Changes. Discovery is allowed in the gated live probe. Runtime reader should use deterministic paths or indexed metadata from the proven shape.

### OpenCode Version Gate

Snapshot evidence must be gated by the OpenCode version and adapter version.

```ts
export type OpenCodeSnapshotAdapterSupport = {
  opencodeVersion: string
  adapterVersion: 1
  supported: boolean
  reason?: 'version-too-old' | 'debug-command-missing' | 'shape-mismatch'
}
```

Rules:

- The live probe records the exact OpenCode version, currently observed locally as `1.14.19`.
- Production reader enables snapshot parsing only for versions and shapes covered by tests.
- If OpenCode upgrades and the shape fingerprint changes, return `unsupported-opencode-snapshot-shape` and keep metadata-only fallback.
- The bridge must not fail task changes just because snapshot support is unavailable.

This makes OpenCode upgrades safe by default: worse diffs, not wrong diffs.

### Snapshot Performance Gate

OpenCode docs warn that snapshots can cause slow indexing and significant disk usage on large repositories or many submodules. Because of that:

- Do not enable `snapshot:true` for existing teams automatically.
- Do not enable `snapshot:true` just because OpenCode supports it.
- Add a runtime/config flag before production enablement.
- If enabled later, record diagnostics when repo size, submodule count, or snapshot artifact growth crosses caps.
- Keep Variant 1 metadata-only fallback even when snapshots are enabled.

### Snapshot Resource Preflight

Before allowing `snapshotEvidenceMode: 'auto'`, perform a cheap preflight:

```ts
export type OpenCodeSnapshotPreflight = {
  allowed: boolean
  reason?: 'not-git' | 'too-many-files' | 'too-many-submodules' | 'workspace-too-large' | 'unknown'
  fileCount?: number
  submoduleCount?: number
}
```

Preflight rules should be conservative and bounded:

- Never recursively scan an entire huge repo on the UI path.
- Prefer existing git metadata when available, with timeout/caps.
- If git is unavailable, do not enable snapshot auto purely to discover repo size.
- If preflight is uncertain, leave snapshot evidence off and rely on inverse/toolpart/metadata fallback.

This keeps the feature from making a large workspace sluggish just because the user opened a team.

### Snapshot Config

Do not blindly change all managed profiles from `snapshot:false` to `snapshot:true`.

Preferred rollout:

```ts
type OpenCodeSnapshotEvidenceMode = 'off' | 'probe-only' | 'auto'
```

Defaults:

- `off` for existing teams until smoke proves stable.
- `probe-only` in dev/test.
- `auto` only after real live smoke and performance bounds.

Managed config can later become:

```ts
snapshot: options.snapshotEvidenceMode === 'auto' ? true : false
```

But the bridge must also support old `snapshot:false` sessions through exact toolpart-chain reconstruction where possible and metadata-only fallback everywhere else. Inverse reconstruction helps only when a real full-text anchor exists.

### Managed Config And Probe Changes

Current code treats any managed config value other than `snapshot: false` as a mismatch. Variant 2 must update that contract carefully:

```ts
const expectedSnapshot =
  snapshotEvidenceMode === 'auto'
    ? true
    : false

if (config.snapshot !== expectedSnapshot) {
  diagnostics.push(
    `Managed snapshot mismatch (${String(config.snapshot ?? 'unset')} instead of ${String(expectedSnapshot)})`,
  )
}
```

Affected areas:

```text
src/services/opencode/OpenCodeProfileManager.ts
src/services/opencode/OpenCodeProvisioningProbe.ts
src/services/opencode/OpenCodeBridgePreconditions.ts
src/services/opencode/OpenCodeProfileManager.test.ts
src/services/opencode/OpenCodeProvisioningProbe.test.ts
src/services/opencode/OpenCodeBridgePreconditions.test.ts
```

Do not make `snapshotEvidenceMode: 'auto'` part of launch preconditions until the snapshot reader is proven. Otherwise an older running OpenCode host could be rejected for a feature that is not required yet.

### Host Rollout And Existing Sessions

Changing snapshot mode is a host/runtime behavior change. Treat it like a profile capability rollout, not a transparent reader upgrade.

Rules:

- Do not force-restart active OpenCode teammates only to enable snapshot evidence.
- Apply `snapshotEvidenceMode` only to newly launched or explicitly restarted OpenCode teammates.
- Existing sessions launched with `snapshot:false` remain valid and should continue through strict delivery plus chain/metadata fallback.
- Store optional profile/session metadata so future diagnostics can explain why full diffs were unavailable.
- If managed config fingerprint changes because snapshot mode changed, surface it as "restart needed for snapshot evidence", not as a hard readiness failure.
- If old and new OpenCode hosts run concurrently, the bridge must evaluate each session using the mode recorded for that session.
- If the session metadata lacks snapshot mode, assume old behavior and fail closed to chain/metadata.

Suggested additive fields:

```ts
export type OpenCodeSessionRecord = {
  // existing fields...
  snapshotEvidenceMode?: 'off' | 'probe-only' | 'auto'
  snapshotBoundarySupport?: 'unsupported' | 'probe-only' | 'enabled'
  managedConfigFingerprint?: string
  opencodeVersion?: string
}
```

This prevents a subtle production bug: the UI opens an older task after the rollout and expects snapshot evidence that could not have existed when the teammate ran.

## Inverse Edit Reconstruction

This covers completed OpenCode `edit` toolparts with `oldString` and `newString`.

### Toolpart Chain Semantics

The in-memory file state is a per-session, per-normalized-path state machine.

```text
unknown-existing -> write(full text) -> known-after-write
known-after-write -> edit(old/new verified once) -> known-after-edit
known-after-edit -> write(full text) -> known-after-write
metadata-only -> edit(...) -> metadata-only
```

Important consequences:

- A full `write` seeds the state after that write.
- Edits after a known full state can become exact through forward verification.
- Edits before a later write cannot be reconstructed from that later write.
- A metadata-only state cannot become a full-text state through an edit alone.
- A later full `write` can seed future edits, but it does not repair earlier unknown before-content.

### Forward Reconstruction When Previous Text Is Known

Already exists conceptually:

```ts
const before = previousFullText
if (countOccurrences(before, oldString) !== 1) downgrade()
const after = before.replace(oldString, newString)
```

Keep this strict.

### Reverse Reconstruction When A Proven Anchor Text Is Known

Useful when we know `after` from snapshot after-state, exact current toolpart chain state, or a future runtime freshness proof. Do not use arbitrary current disk as this anchor for historical backfill. Do not use existing ledger bundles as anchors in the first production implementation.

Important: an exact later `write` toolpart is not an anchor for an earlier edit. It is only an anchor for itself and for later edits that are applied to that write's known content.

```ts
function reverseOpenCodeEdit(input: {
  after: string
  oldString: string
  newString: string
}): { before: string; after: string } | null {
  if (input.oldString === input.newString) return null
  if (countOccurrences(input.after, input.newString) !== 1) return null

  const before = input.after.replace(input.newString, input.oldString)
  if (countOccurrences(before, input.oldString) !== 1) return null

  const forward = before.replace(input.oldString, input.newString)
  if (forward !== input.after) return null

  return { before, after: input.after }
}
```

Strict downgrade cases:

- `newString` appears zero or multiple times in anchor.
- `oldString` appears zero or multiple times in reconstructed before.
- old/new are empty in an unsupported way.
- content too large.
- binary or invalid UTF-8.
- toolpart was not `completed`.
- `metadata.truncated === true`.

## Inverse Timeline Reconstruction

For a file with multiple toolparts, reconstruct from the end backward.

Example:

```text
T1 write unknown overwrite existing
T2 edit old=A new=B
T3 edit old=B new=C
proven anchor contains C
```

Reverse chain:

```text
anchor C -> reverse T3 -> B -> reverse T2 -> A
```

Then verify forward:

```text
A -> T2 -> B -> T3 -> C == anchor
```

But T1 remains metadata-only unless snapshot/toolpart gives before.

Pseudocode:

```ts
function reconstructFileTimeline(input: {
  changes: ReconstructedOpenCodeToolChange[]
  finalAnchor: OpenCodeTextAnchor | null
}): Map<string, OpenCodeTextEvidence> {
  if (!input.finalAnchor) return new Map()

  let cursor = input.finalAnchor.text
  const reversed = new Map<string, { before: string; after: string }>()

  for (const change of [...input.changes].reverse()) {
    if (change.sourceTool === 'edit') {
      const result = reverseOpenCodeEdit({
        after: cursor,
        oldString: change.oldString ?? '',
        newString: change.newString ?? '',
      })
      if (!result) break
      reversed.set(change.sourceImportKey, result)
      cursor = result.before
      continue
    }

    if (change.sourceTool === 'write') {
      if (change.afterContent && change.afterContent === cursor) {
        // We can anchor this write's after, but before is still unknown unless previous chain/snapshot proves it.
        break
      }
      break
    }

    if (change.sourceTool === 'apply_patch') {
      const result = reverseApplyPatch(change.patch, cursor)
      if (!result) break
      reversed.set(change.sourceImportKey, result)
      cursor = result.before
      continue
    }
  }

  if (!verifyForward(input.changes, reversed, input.finalAnchor.text)) {
    return new Map()
  }

  return toEvidenceMap(reversed)
}
```

Important: if the reverse chain breaks halfway, only use the contiguous verified suffix. Do not upgrade earlier events.

### Anchor Selection Rules

Allowed anchors in the first production implementation:

1. Snapshot after-state from a supported snapshot reader.
2. Exact OpenCode `write` content as the current timeline state for that write and edits after it.

Disallowed anchors in the first production implementation:

1. Current disk read during old task backfill.
2. File mtime alone.
3. Assistant text claiming the final content.
4. Git status/diff output from the leader repo.
5. Existing ledger bundle or journal events.
6. Later `write` content used to reconstruct edits that happened before the write.

This means pure edit-only old sessions stay metadata-only until snapshot support proves a real after-state. That is better than showing a plausible but wrong diff.

## Apply Patch Reconstruction

OpenCode `apply_patch` uses a patch text. Variant 1 currently only extracts touched paths.

Variant 2 should add a strict parser for the known patch format.

Supported markers:

```text
*** Begin Patch
*** Add File: path
*** Update File: path
*** Delete File: path
*** End Patch
```

Supported line prefixes inside file sections:

```text
  context
- removed
+ added
```

Potential movement marker:

```text
*** Move to: newPath
```

If move/rename exists and shape is proven, support later. In first implementation, treat move as unsupported and keep metadata-only unless snapshot proves before/after.

### Add File

Can be exact create only if:

- path normalizes inside workspace;
- patch contains complete added file content;
- no binary markers;
- after reconstructed from patch equals trusted after anchor when anchor exists;
- before is absent.

```ts
beforeContent = null
beforeState = { exists: false, sizeBytes: 0 }
afterContent = parseAddedFileContent(patch)
afterState = contentStateForText(afterContent)
operation = 'create'
confidence = 'exact'
```

### Delete File

Can be exact delete only if:

- patch contains complete deleted file content, or snapshot gives before;
- after is absent from snapshot/current trusted anchor;
- forward delete verification passes.

Otherwise metadata-only.

### Update File

Can be exact modify only if:

- there is a full-text before anchor or full-text after anchor;
- all hunks apply exactly once to before, or reverse apply exactly once to after;
- context lines match;
- no ambiguous hunk placement;
- forward verification returns exact after.

If not, metadata-only. A hunk alone is not enough for normal ledger full-file review because the UI/review applier expects full file contents for safe reject.

### Apply Patch Operation Matrix

| Patch operation | Full-text upgrade without snapshot | Full-text upgrade with snapshot/full anchor | Default fallback |
| --- | --- | --- | --- |
| `Add File` | Yes, if the patch contains full added content and before is proven absent | Yes | Metadata-only if malformed/large/binary |
| `Delete File` | Only if patch contains complete deleted content and after absence is proven | Yes | Metadata-only |
| `Update File` | No, unless a full before/after anchor exists from toolpart chain | Yes | Metadata-only |
| `Move to` / rename | No in first pass | Only if snapshot proves old/new paths and contents | Metadata-only relation later |

### Parser Risk

Do not write a casual regex patch parser for all cases.

Better:

- implement a small line-based parser for the proven OpenCode patch dialect;
- cap patch bytes and lines;
- require begin/end markers;
- reject nested or malformed sections;
- reject duplicate sections for same path unless each section can be sequentially verified.

## Current Disk Anchor Rules

Reading current disk can help old `snapshot:false` sessions, but it is dangerous if later changes happened.

Updated decision: **do not use current disk as a full-text historical anchor in the first production implementation**.

Current disk can still be used for:

- metadata-only final state, as Variant 1 already does;
- optional diagnostics;
- future freshness-proven live backfill, once the runtime can prove the file is still the OpenCode after-state.

It must not be used to populate reviewable `beforeContent` / `afterContent` for old task backfill.

Allowed future current disk anchor, after a real freshness proof exists:

- file exists;
- text, UTF-8, <= 1MB;
- candidate event is the latest known OpenCode touch for that file in the selected session;
- no later candidate event for same file is unknown/metadata-only;
- runtime generated a same-delivery-window freshness proof;
- current hash matches the expected post-tool state if one is available.

Not allowed:

- multi-session cross-file reconstruction;
- if workspace root does not match stored OpenCode session project path;
- if current file missing and operation is not a proven delete;
- if file is binary/large/non-regular.
- for old sessions opened from UI with no fresh runtime proof.

Pseudocode:

```ts
async function readCurrentTextAnchor(change: ReconstructedOpenCodeToolChange): Promise<TextAnchor | null> {
  const stat = await lstat(change.filePath).catch(() => null)
  if (!stat?.isFile()) return null
  if (stat.size > MAX_TEXT_BLOB_BYTES) return null
  const bytes = await readFile(change.filePath)
  if (bytes.includes(0)) return null
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null
  return {
    text,
    sha256: sha256(text),
    source: 'current-disk',
  }
}
```

This helper belongs behind a disabled-by-default gate:

```ts
if (params.allowCurrentDiskFreshAnchor !== true) {
  return null
}
```

## Ledger Import Behavior

When evidence is full-text:

```ts
{
  beforeContent: evidence.before,
  afterContent: evidence.after,
  beforeState: contentStateForText(evidence.before),
  afterState: contentStateForText(evidence.after),
  confidence: evidence.confidence,
  evidenceProof: evidence.proof,
}
```

For create:

```ts
beforeContent: null
beforeState: { exists: false, sizeBytes: 0 }
afterContent: evidence.after
afterState: contentStateForText(evidence.after)
```

For delete:

```ts
beforeContent: evidence.before
beforeState: contentStateForText(evidence.before)
afterContent: null
afterState: { exists: false, sizeBytes: 0 }
```

When evidence is not full-text:

Keep Variant 1 behavior:

```ts
beforeContent: null
afterContent: null
beforeState.unavailableReason = '...'
afterState = materialized final disk state when safe
confidence = 'medium'
```

### Preview-Only Evidence

Do not add preview-only evidence to normal ledger fields in this iteration.

Bad:

```ts
beforeContent = approximateBefore
afterContent = approximateAfter
beforeState = contentStateForText(approximateBefore)
afterState = contentStateForText(approximateAfter)
```

That would make `ReviewApplierService` treat the event as safely rejectable.

If a future UI wants patch previews, use separate fields:

```ts
previewDiff?: {
  kind: 'unreviewable-hunk-preview'
  unifiedPatch: string
  reason: string
}
```

And keep:

```ts
beforeState.unavailableReason = 'preview-only-before-unavailable'
afterState.unavailableReason = 'preview-only-after-unavailable'
```

This keeps apply/reject blocked.

### Backfill Outcome Semantics

Do not let enrichment change the meaning of existing backfill outcomes.

Rules:

- `imported`: at least one new ledger event was appended.
- `duplicates-only`: candidate events existed in the same strict-delivery window, but every one was already imported or safely skipped as duplicate.
- `manual-only`: dry-run found candidate events but did not write.
- `no-attribution`: no usable strict delivery context or no candidate event tied to this task.
- `skipped-capability`: OpenCode history/snapshot shape is unsupported.

Enrichment must not convert `no-attribution` into `manual-only`. If attribution is not proven, no candidate event exists.

Enrichment must not make `duplicates-only` cache as a positive "changes are visible" signal unless the candidate events are in the requested strict delivery window.

This matters because the UI auto-backfill cache can otherwise suppress later correct recovery.

### Backfill Cache Contract

The UI and bridge should cache only what is safe to cache.

Recommended cache key:

```ts
type OpenCodeBackfillCacheKey = {
  teamName: string
  taskId: string
  memberName?: string
  laneId?: string
  runtimeSessionId?: string
  deliveredUserMessageId?: string
  attributionMode: 'strict-delivery' | 'compatible'
  evidenceMode: OpenCodeEvidencePipelineMode
}
```

Cache rules:

- `imported`: cache as positive until task ledger freshness changes.
- `duplicates-only`: cache as positive only if candidate events existed inside the strict delivery window.
- `manual-only`: cache briefly, but allow retry after ledger freshness or OpenCode DB fingerprint changes.
- `no-attribution`: do not long-cache. Retry after delivery ledger changes, task comments/logs persistence changes, or app reload.
- `skipped-capability`: cache per OpenCode version + shape fingerprint, not per task forever.
- `transient-error`: never long-cache.

Suggested result shape:

```ts
type OpenCodeBackfillResult = {
  outcome:
    | 'imported'
    | 'duplicates-only'
    | 'manual-only'
    | 'no-attribution'
    | 'skipped-capability'
    | 'transient-error'
  candidateCount: number
  strictWindowCandidateCount?: number
  openCodeDbFingerprint?: string
  deliveryLedgerFingerprint?: string
  snapshotShapeFingerprint?: string
  retryAfterReason?: string
}
```

This makes "no changes yet" different from "we looked at the correct evidence and there are no new changes".

### Partial Toolpart Shape Policy

Unknown OpenCode schema must fail closed.

Rules:

- If toolpart kind is unknown, do not import file events.
- If toolpart kind is known but required fields are missing, return diagnostic with `unsupported-opencode-toolpart-shape`.
- If exact touched path is proven but content shape is unsupported, import metadata-only only when strict delivery attribution is proven.
- If path is extracted from assistant text, log text, or an untrusted string field, do not import file events.
- If one file in a multi-file toolpart is unsupported, keep other independently verified files.
- Do not add broad "best effort" parsers for new OpenCode fields without fixtures.

Required diagnostic payload should be small and content-free:

```ts
{
  code: 'unsupported-opencode-toolpart-shape',
  toolpartKind: 'edit',
  missingFields: ['oldString'],
  sessionId,
  partId,
}
```

## UI Impact

Minimal UI changes.

The UI already understands:

- full text ledger snapshots;
- metadata-only manual review;
- strict apply/reject conflicts;
- `manual-review-required`.

Optional additive UI display:

- Show evidence badge:
  - `OpenCode Snapshot`
  - `Inverse Verified`
  - `Manual Review`

Do not change apply/reject behavior. The existing hash guard remains the final safety gate.

### UI Contract Boundary

The UI must not know how to reconstruct OpenCode diffs. It should only render ledger facts:

- if ledger has full `before/after`, render normal diff;
- if ledger has unavailable state, render manual review;
- if ledger has optional `evidenceProof`, render a small label only.

Do not add OpenCode SQLite reads, snapshot reads, or patch parsing to the UI. All evidence construction stays in orchestrator.

### Shared Contract Backward Compatibility

The UI/shared contract must stay additive. This is important because old bundles, old desktop builds, and old orchestrator artifacts can coexist.

Rules:

- Keep ledger schema version compatible unless a real breaking read change is unavoidable.
- Add optional metadata fields only:
  - `evidenceProof?`
  - `evidenceMode?`
  - `snapshotBoundary?` as redacted metadata only, never content.
- Existing UI readers must ignore unknown evidence metadata.
- `ReviewApplierService` must make decisions only from existing ledger `before`, `after`, `beforeState`, `afterState`, and hash guards.
- A preview-only diff field must never unlock accept/reject.
- Metadata-only OpenCode events must continue to return `manual-review-required`.

Suggested metadata shape:

```ts
export type LedgerEvidenceProof =
  | {
      kind: 'opencode-toolpart-chain'
      confidence: 'high'
      verifier: 'forward-edit' | 'inverse-edit'
      adapterVersion: number
    }
  | {
      kind: 'opencode-snapshot-boundary'
      confidence: 'high'
      adapterVersion: number
      opencodeVersion?: string
      boundaryStatus: 'captured'
    }
  | {
      kind: 'metadata-only'
      confidence: 'medium' | 'low'
      reason: string
    }
```

Do not put raw prompt text, tool arguments with secrets, or file content into `evidenceProof`.

## Why This Should Not Break Other Agents

The enrichment pipeline is OpenCode-only:

```ts
if (change.sourceRuntime !== 'opencode') return change
if (!change.source.startsWith('opencode_toolpart_')) return change
```

Non-OpenCode sources remain unchanged:

```text
file_edit
file_write
notebook_edit
shell_snapshot
powershell_snapshot
post_tool_hook_snapshot
```

No shared `TaskChangeLedgerService` reconstruction logic should be moved or generalized in this iteration.

Safe boundaries:

- `TaskChangeLedgerService` only receives already enriched imported events.
- Existing exact tool events keep their current behavior.
- Existing shell/git snapshot provider keeps its current behavior.
- UI reader continues to consume the same ledger schema.

## Current Code Integration Map

This section pins the plan to the current orchestrator code. It should be updated before implementation if these files move.

### Existing Runtime Touch Points

Current code already has the right boundaries:

```text
src/services/opencode/OpenCodeBridgeCommandHandler.ts
  runSendMessage
  runObserveMessageDelivery
  opencode.backfillTaskLedger command

src/services/opencode/OpenCodeLedgerBridgeService.ts
  OpenCodeLedgerBridgeService.backfill
  normalizeDeliveryContext
  collectStrictDeliveryRecords
  materializeMetadataOnlyChanges
  toLedgerChange

src/services/opencode/OpenCodeToolpartChangeReconstructor.ts
  OpenCodeDeliveryContextV1
  ReconstructedOpenCodeToolChange
  lookupStrictDeliveryRefs
  buildSourceImportKey

src/services/opencode/OpenCodeSessionStore.ts
  OpenCodeSessionStore.upsert/list

src/services/opencode/types.ts
  OpenCodeSessionRecord
```

Do not implement snapshot/task boundary logic in UI code. The UI should keep calling `opencode.backfillTaskLedger` and reading ledger artifacts.

### Additive Type Deltas

`OpenCodeDeliveryContextV1` currently stores `prePromptCursor` and `postPromptCursor`, but not snapshot boundary hashes. Extend records additively:

```ts
export type OpenCodeDeliveryContextV1 = {
  schemaVersion: 1
  teamName: string
  taskId?: string
  records: Array<{
    // existing fields...
    prePromptCursor?: string | null
    postPromptCursor?: string | null
    snapshotBoundary?: {
      schemaVersion: 1
      captureStatus:
        | 'captured'
        | 'pending'
        | 'snapshot-disabled'
        | 'unsupported-shape'
        | 'capture-failed'
        | 'not-terminal'
      preDeliverySnapshotHash?: string
      postDeliverySnapshotHash?: string
      snapshotAdapterVersion?: number
      opencodeVersion?: string
      diagnostics?: string[]
    }
  }>
}
```

`OpenCodeSessionRecord` currently has no snapshot mode. Extend it additively:

```ts
export type OpenCodeSessionRecord = {
  // existing fields...
  snapshotEvidenceMode?: 'off' | 'probe-only' | 'auto'
  snapshotBoundarySupport?: 'unsupported' | 'probe-only' | 'enabled'
  managedConfigFingerprint?: string
  opencodeVersion?: string
}
```

`OpenCodeLedgerBridgeBackfillResult` currently has `outcome`, counts, diagnostics and notices. Extend it additively:

```ts
export type OpenCodeLedgerBridgeBackfillResult = {
  // existing fields...
  evidenceMode?: OpenCodeEvidencePipelineMode
  strictWindowCandidateCount?: number
  openCodeDbFingerprint?: string
  deliveryLedgerFingerprint?: string
  snapshotShapeFingerprint?: string
  retryAfterReason?: string
}
```

Keep `schemaVersion: 1` unless old readers cannot tolerate the optional fields. Existing callers should be able to ignore them.

### Delivery Context Normalization

`OpenCodeLedgerBridgeService.normalizeDeliveryContext` currently rebuilds each record from a whitelist of fields. If we add `snapshotBoundary` but do not update this function, backfill will silently lose the boundary.

Required changes:

- Parse and preserve `snapshotBoundary` additively.
- Validate `captureStatus` against the known enum.
- Validate snapshot hashes as bounded strings, not arbitrary payload.
- Cap diagnostics count and string size.
- Do not reject the whole delivery context if one record has an invalid boundary. Keep the record for strict delivery attribution, but mark its boundary unsupported.
- Keep the existing 512 KB delivery context file cap unless tests prove it is too small.

Example:

```ts
function normalizeSnapshotBoundary(value: unknown): SnapshotBoundary | null {
  const record = asRecord(value)
  if (!record) return null
  const captureStatus = asSnapshotCaptureStatus(record.captureStatus)
  if (!captureStatus) return null
  return {
    schemaVersion: 1,
    captureStatus,
    preDeliverySnapshotHash: asBoundedString(record.preDeliverySnapshotHash, 256),
    postDeliverySnapshotHash: asBoundedString(record.postDeliverySnapshotHash, 256),
    snapshotAdapterVersion: asSafeInteger(record.snapshotAdapterVersion),
    opencodeVersion: asBoundedString(record.opencodeVersion, 128),
    diagnostics: asBoundedStringArray(record.diagnostics, { maxItems: 20, maxBytesPerItem: 512 }),
  }
}
```

Test this directly. A fixture with a valid boundary must survive `readOptionalDeliveryContext`, and a fixture with a malformed boundary must still preserve strict delivery task attribution.

### Delivery Boundary Capture Hook

The safest hook is app-message delivery, not UI backfill.

Pseudo-flow in `runSendMessage`:

```ts
const prePromptCursor = deliveryRecord.lastCanonicalCursor ?? null
const preSnapshot = await snapshotBoundaryCapture.capturePre({
  record: deliveryRecord,
  mode: deliveryRecord.snapshotEvidenceMode,
})

await openCodeSessionBridge.promptAsync(deliveryRecord, ...)

const reconciled = await reconcileSession(...)
const responseObservation = observeOpenCodeDeliveryResponse(...)

const postSnapshot = await snapshotBoundaryCapture.capturePostIfTerminal({
  record: reconciled.record,
  preSnapshot,
  responseObservation,
  summary: reconciled.summary,
})

await openCodeDeliveryBoundaryStore.upsert({
  teamName: teamId,
  taskId,
  memberName,
  laneId,
  runtimeSessionId: deliveryRecord.opencodeSessionId,
  inboxMessageId,
  deliveredUserMessageId: responseObservation.deliveredUserMessageId,
  prePromptCursor,
  postPromptCursor: reconciled.record.lastCanonicalCursor,
  snapshotBoundary: combine(preSnapshot, postSnapshot),
})
```

Critical rule: `postSnapshot` is usable only if delivery observation is terminal enough. If the assistant/tool run is still pending, blocked, running, retrying, or reconcile failed, store:

```ts
captureStatus: 'not-terminal'
```

and do not allow snapshot full-text evidence.

`runObserveMessageDelivery` may later complete the post boundary after the session becomes terminal. It may update the boundary record with `postDeliverySnapshotHash`, but it must not change task attribution fields.

`opencode.backfillTaskLedger` should read this boundary. It should not shell out to `opencode debug snapshot` on the normal UI path.

### Terminal Delivery States

Conservative first-pass terminal states:

```text
responded_visible_message
responded_plain_text
responded_tool_call only if no running tool calls remain after the delivered user message
responded_non_visible_tool only if no running tool calls remain after the delivered user message
tool_error only if no running tool calls remain after the delivered user message
```

Non-terminal or unsafe states:

```text
pending
permission_blocked
session_stale
session_error
reconcile_failed
prompt_not_indexed
not_observed
empty_assistant_turn
```

For unsafe states, keep chain/metadata fallback. Do not treat "we sent the prompt" as proof that file changes are complete.

### Backfill Integration Point

Current `OpenCodeLedgerBridgeService.backfill` reconstructs, materializes metadata-only disk state, then imports:

```ts
const reconstructed = this.reconstructor.reconstruct(...)
const materializedChanges = await materializeMetadataOnlyChanges(reconstructed.changes, result.diagnostics)
await importTaskChangeLedgerEvents(...)
```

Variant 2 should insert enrichment between reconstruction and metadata-only materialization:

```ts
const reconstructed = this.reconstructor.reconstruct(...)
const enriched = await this.evidenceEnricher.enrich({
  changes: reconstructed.changes,
  deliveryContext,
  sessionRecord: record,
  workspaceRoot,
  attributionMode,
  evidenceMode,
  diagnostics: result.diagnostics,
})
const materializedChanges = await materializeMetadataOnlyChanges(enriched, result.diagnostics)
```

Do not move `materializeMetadataOnlyChanges` before enrichment. Snapshot/chain enrichment needs to see why the event was metadata-only before final disk state is sampled.

### Worktree And Centralized Ledger Identity

OpenCode teammates may run inside isolated worktrees while task-change artifacts are written into the leader project directory. The plan must keep those identities separate.

Definitions:

```text
projectDir = where .board-task-changes artifacts are written, usually leader project dir
workspaceRoot = where OpenCode actually edited files, possibly teammate worktree
record.projectPath = OpenCode session workspace, should equal workspaceRoot for strict backfill
filePath = absolute path to the edited file in workspaceRoot
relativePath = path relative to workspaceRoot
```

Rules:

- Never treat `projectDir` as the edited workspace.
- Never rewrite worktree file paths back to the leader/main repo.
- Ledger event `filePath` must point at `workspaceRoot`, not `projectDir`.
- Snapshot boundary must include `workspaceRoot`, `profileRootKey`, `hostKey`, and `opencodeSessionId`.
- Snapshot evidence is usable only when boundary `workspaceRoot`, session record `projectPath`, and backfill `workspaceRoot` all match under `areSameOpenCodeWorkspace`.
- If two worktrees share the same relative path, they are different files unless their workspace identity matches.
- Centralized ledger location is storage identity only. It is not evidence of file ownership.
- UI apply/reject must keep targeting the ledger event's absolute `filePath`, so review actions mutate the teammate worktree, not the leader repo.

Do not use leader repo git status/diff for OpenCode worktree evidence. The current plan intentionally avoids git in OpenCode enrichment.

Required tests:

- two worktrees with the same `src/app.ts` but different `workspaceRoot` do not share snapshot anchors.
- `projectDir` under leader repo and `workspaceRoot` under teammate worktree still writes artifacts centrally and targets worktree file paths.
- backfill with mismatched `workspaceRoot` rejects snapshot full-text evidence and falls back to no-attribution/metadata depending on strict delivery proof.
- UI fixture preserves absolute worktree `filePath` and does not rewrite it to leader repo.

### Path Identity, Symlinks, And Case Collisions

`normalizeOpenCodeFilePath` is intentionally lexical. That is good for rejecting obvious outside-workspace paths, but it does not prove filesystem identity.

Rules:

- Lexical inside-workspace is required before any evidence is considered.
- For disk reads in `materializeMetadataOnlyChanges`, use `lstat` before `readFile`.
- If the path is a symlink, do not follow it for full-text or hash capture in the first implementation.
- Symlink paths should become metadata-only with `unavailableReason: 'opencode-path-symlink-unresolved'`.
- A future implementation may follow symlinks only if both workspace root and target realpaths are resolved and target remains inside the real workspace root.
- Snapshot evidence must report canonical path identity if OpenCode exposes it. If not, use lexical path plus workspace identity and keep symlink files metadata-only.
- On case-insensitive filesystems, two differently cased paths can refer to the same file. Detect same-batch collisions by comparing both lexical relative path and a platform-aware comparison key.
- On macOS, do not assume POSIX path means case-sensitive. If filesystem case-sensitivity cannot be cheaply proven, detect duplicate lower-case relative paths within the same candidate batch and fail closed for those paths.

Required tests:

- symlink inside workspace pointing outside is not read and never becomes full-text.
- symlink inside workspace pointing inside is still metadata-only in first implementation.
- `src/Foo.ts` and `src/foo.ts` in one OpenCode batch produce a collision diagnostic on case-insensitive/unknown filesystems.
- Windows drive-case differences still resolve to the same comparison key.
- UNC workspace and non-UNC file path mismatch remains rejected.

### Snapshot Evidence Provider Abstraction

The normal Changes path must not shell out to `opencode debug snapshot`. Keep snapshot access behind an adapter interface.

```ts
export interface OpenCodeSnapshotEvidenceProvider {
  readonly adapterVersion: number
  probe(input: SnapshotProbeInput): Promise<SnapshotProbeResult>
  readBoundaryEvidence(input: SnapshotBoundaryReadInput): Promise<SnapshotEvidenceResult>
}
```

Provider rules:

- `DebugCliSnapshotEvidenceProvider` is allowed only in gated live probe tests.
- Production reader must use deterministic artifact paths or indexed metadata discovered by the probe.
- If no production-safe provider exists, keep `snapshotEvidenceMode: 'probe-only'` and do not ship `snapshot-auto`.
- Provider result must include `shapeFingerprint`, `opencodeVersion`, `adapterVersion`, and source artifact fingerprint.
- Provider must never return full-text evidence without a validated delivery boundary.

This avoids coupling the UI path to a human-oriented debug command whose output shape may change.

## Implementation Plan

### Step 0 - Lock The Safety Contract

Before adding new evidence sources, add tests that prove the existing safe behavior stays intact:

- OpenCode metadata-only events still return `manual-review-required`.
- Non-OpenCode exact `Write` / `Edit` behavior is unchanged.
- Shell and PowerShell snapshot tests are unchanged.
- OpenCode enrichment is not called for non-OpenCode sources.
- UI auto-backfill outcome cache still distinguishes `no-attribution`, `duplicates-only`, and `imported`.

This step is small but important because it prevents the enrichment work from accidentally broadening behavior.

### Step 1 - Evidence Enricher Skeleton

Add:

```text
src/services/opencode/OpenCodeChangeEvidenceEnricher.ts
src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts
```

Start with:

- exact pass-through;
- metadata-only pass-through;
- no current disk full-text anchor;
- no snapshot reader;
- diagnostic counters.
- no existing-ledger anchors.

```ts
if (change.beforeContent !== null || change.beforeState?.exists === false) {
  return { ...change, evidenceProof: 'toolpart-chain' }
}
return { ...change, evidenceProof: 'metadata-only-fallback' }
```

This gives a safe integration point.

### Step 2 - Toolpart Chain Audit

Before adding snapshot support, tighten the existing in-memory chain rules and tests.

What is allowed:

- exact `write` content seeds full-text state for that write;
- later `edit` events after that write can be exact through forward reconstruction;
- later `write` events replace the current timeline state.

What is not allowed:

- later `write` content must not be used to reconstruct edits that happened before that write;
- pure edit-only old sessions without snapshot/freshness stay metadata-only.

Tests:

- write create -> edit is exact.
- write overwrite unknown existing -> edit after write can be exact only from the write forward, while the overwrite itself remains manual for reject.
- edit before later write remains metadata-only.
- later write does not become reverse anchor for earlier edit.
- repeated `oldString` rejected.
- truncated edit rejected.
- no current disk anchor by default.
- no ledger anchor by default.

### Step 3 - Snapshot Shape Live Probe

Add a gated live test:

```text
src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

Env:

```bash
OPENCODE_LEDGER_LIVE_E2E=1
OPENCODE_LEDGER_SNAPSHOT_PROBE=1
```

Test flow:

```ts
test('discovers OpenCode snapshot artifacts for file tool changes', async () => {
  const home = tempHome()
  const workspace = tempWorkspace()
  const config = buildManagedConfig(null, { snapshotEvidenceMode: 'auto' })
  await writeOpenCodeConfig(home, config)

  const pre = await tryCaptureSnapshotHash({ home, workspace })

  await runOpenCode([
    'run',
    '--pure',
    '--dir',
    workspace,
    '--model',
    LIVE_MODEL,
    '--dangerously-skip-permissions',
    'Create a.ts, edit it, then apply_patch update it.',
  ], env)

  const post = await tryCaptureSnapshotHash({ home, workspace })
  expect(pre.supported && post.supported).toBe(true)
  expect(post.hash).not.toBe(pre.hash)

  const patch = await runOpenCode(['debug', 'snapshot', 'patch', post.hash], env)
  const diff = await runOpenCode(['debug', 'snapshot', 'diff', post.hash], env)
  expect(patch.status).toBe(0)
  expect(diff.status).toBe(0)

  const evidence = await new OpenCodeSnapshotEvidenceReader().readEvidence(...)
  expect(evidence.supported).toBe(true)
  expect(evidence.patches.some(p => p.beforeContent && p.afterContent)).toBe(true)
})
```

Acceptance:

- If no artifact shape is found, do not implement production snapshot reader yet.
- If debug snapshot commands do not expose enough information, keep Variant 1 metadata-only behavior and document the exact blocker.
- If pre/post snapshot boundaries cannot be captured around one delivered task, snapshot full-text import stays disabled.

### Step 4 - Snapshot Reader

Only after Step 3 proves shape.

Tests:

- supported snapshot shape returns before/after.
- snapshot reader refuses full-text output without delivery boundary.
- snapshot reader refuses files not touched by strict-delivery matched toolparts.
- missing snapshot returns unsupported diagnostic.
- changed shape returns unsupported diagnostic.
- snapshot path outside workspace rejected.
- snapshot part/session mismatch rejected.
- snapshot large/binary content rejected to metadata-only.

### Step 5 - Inverse Edit From Snapshot Anchors

Implement reverse edit only when snapshot or exact chain proves the anchor text.

Tests:

- single edit exact reverse from snapshot after-state.
- chained edits exact reverse from snapshot after-state.
- repeated `newString` rejected.
- repeated `oldString` rejected after reverse.
- oldString/newString same rejected/no-op.
- truncated edit rejected.
- no current disk anchor by default.
- no ledger anchor by default.
- only verified suffix upgraded.

### Step 6 - Strict Apply Patch Parser

Add parser:

```text
src/services/opencode/OpenCodeApplyPatchEvidenceParser.ts
```

Tests:

- add file full content.
- delete file full content only when content/absence is proven.
- update file simple hunk with full anchor.
- update file without full anchor remains metadata-only.
- multiple hunks.
- spaces/unicode/newline-safe paths.
- malformed begin/end rejected.
- duplicate path rejected or sequentially verified.
- ambiguous context rejected.
- move marker unsupported fallback.
- outside workspace rejected.

### Step 7 - Integrate In OpenCodeLedgerBridgeService

Change:

```ts
const reconstructed = this.reconstructor.reconstruct(...)
const enrichedChanges = await this.evidenceEnricher.enrich({
  workspaceRoot,
  sessionId: record.opencodeSessionId,
  changes: reconstructed.changes,
  toolparts: reconstructed.toolparts,
  snapshotReader,
  mode: attributionMode,
  diagnostics: result.diagnostics,
})
const materializedChanges = await materializeMetadataOnlyChanges(enrichedChanges, result.diagnostics)
```

If enrichment throws:

```ts
diagnostics.push('OpenCode evidence enrichment failed; using metadata-only fallback.')
use reconstructed.changes
```

Do not let enrichment failure break the entire changes panel.

### Step 8 - Future Current Disk Freshness Proof

Do not implement this until a runtime-layer proof exists.

Possible future proof:

- backfill is triggered by the same OpenCode delivery completion;
- delivery ledger has pre/post cursor;
- the file's latest known toolpart belongs to this delivery;
- no other active task scope for the same workspace/member;
- no existing ledger event after this toolpart for the same file;
- current file hash is sampled immediately before import.

Even then, this should initially produce high-confidence diagnostics and remain behind a feature flag.

### Step 9 - Optional UI Evidence Badge

Small additive UI:

- `evidenceProof === 'opencode-snapshot'` -> `OpenCode Snapshot`
- `evidenceProof === 'inverse-edit-chain'` -> `Inverse Verified`
- no proof or unavailable -> existing manual review.

This can be deferred. Functional correctness does not require it.

## Test Plan

### Orchestrator Unit

```bash
bun test \
  src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts \
  src/services/opencode/OpenCodeApplyPatchEvidenceParser.test.ts \
  src/services/opencode/OpenCodeToolpartChangeReconstructor.test.ts \
  src/services/opencode/OpenCodeLedgerBridgeService.test.ts \
  src/services/opencode/OpenCodeOfflineSessionReader.test.ts \
  src/services/opencode/OpenCodeBridgePath.test.ts
```

Required cases:

- exact pass-through unchanged.
- metadata-only unchanged when no proof.
- single inverse edit upgrades to full text only from a proven anchor.
- chained inverse edits upgrade to full text only from a proven anchor.
- ambiguous inverse edit remains metadata-only.
- apply_patch add upgrades only when full content proven.
- apply_patch update upgrades only when hunk verifies against a full anchor.
- apply_patch delete upgrades only when before and absent after proven.
- snapshot evidence is preferred over any future current-disk freshness anchor.
- unsupported snapshot shape falls back.
- thrown snapshot reader falls back.
- current disk binary/large/non-UTF8 remains metadata-only.
- current disk without freshness proof is never used as a full-text anchor.
- outside workspace remains skipped.
- source import key collisions do not create wrong attribution.
- unstable SQLite/snapshot reads fall back without full-text evidence.
- backfill cache distinguishes `no-attribution`, `transient-error`, `skipped-capability`, and positive `duplicates-only`.
- unsupported partial toolpart shape imports metadata-only only when strict path attribution is proven.
- full-text blob write failure cannot append an event pointing at missing content.
- interrupted import rerun is idempotent.
- delivery boundary capture records `not-terminal` for pending/blocked/reconcile-failed deliveries.
- `runObserveMessageDelivery` can complete a pending post boundary without changing task/member/session attribution.
- backfill refuses snapshot full-text when boundary status is `pending` or `not-terminal`.
- enrichment runs before `materializeMetadataOnlyChanges`.
- `normalizeDeliveryContext` preserves valid `snapshotBoundary` optional fields.
- malformed `snapshotBoundary` does not break strict delivery attribution for the rest of the record.
- centralized ledger `projectDir` is not used as edited workspace identity.
- worktree `workspaceRoot` mismatch disables snapshot full-text evidence.
- symlink paths are not followed for content/hash capture.
- case-colliding paths in one OpenCode batch fail closed.
- production snapshot provider does not shell out to `opencode debug snapshot`.

### Orchestrator Fixture E2E

Extend:

```text
src/services/opencode/OpenCodeLedgerBridge.fixture-e2e.test.ts
```

New fixtures:

- `snapshot-supported`.
- `snapshot-supported-with-delivery-boundary`.
- `snapshot-supported-without-delivery-boundary`.
- `snapshot-cross-task-same-session`.
- `inverse-edit-toolpart-anchor`.
- `inverse-edit-chain`.
- `apply-patch-update`.
- `apply-patch-update-no-anchor`.
- `apply-patch-ambiguous`.
- `snapshot-shape-unsupported`.

Assertions:

- imported bundle has full-text reviewability for verified cases.
- imported bundle has metadata-only for rejected cases.
- idempotency still works.
- strict delivery still required.
- old `snapshot:false` pure edit-only fixture remains metadata-only, not a fake diff.
- snapshot diff from another task in the same OpenCode session is not imported.
- duplicate/collision fixtures do not create duplicate file rows.
- source instability fixture produces diagnostic and metadata-only fallback.
- cache-outcome fixture proves strict UI retry is not suppressed after early `no-attribution`.
- partial artifact failure fixture proves journal/bundle recovery does not expose broken full-text review.
- unsupported-shape-with-path fixture produces metadata-only only with strict delivery context.
- delivery-boundary-terminal fixture produces snapshot-eligible evidence.
- delivery-boundary-not-terminal fixture stays metadata-only/diagnostics.
- observe-message-completes-boundary fixture updates only snapshot fields, not task attribution identity.
- malformed-boundary-valid-delivery fixture proves strict attribution still works but snapshot evidence is disabled.
- centralized-ledger-worktree fixture proves artifacts are stored under leader `projectDir` while file paths target teammate `workspaceRoot`.
- same-relative-path-two-worktrees fixture proves snapshot anchors do not cross workspace identity.
- symlink-path fixture proves content is not read through symlinks.
- case-collision fixture proves colliding paths do not produce unsafe full-text events.

### Live E2E

Keep existing:

```bash
OPENCODE_LEDGER_LIVE_E2E=1 bun test src/services/opencode/OpenCodeLedgerBridge.live-e2e.test.ts
```

Add snapshot live:

```bash
OPENCODE_LEDGER_LIVE_E2E=1 OPENCODE_LEDGER_SNAPSHOT_PROBE=1 bun test src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

This must be gated because it calls real OpenCode/model.

### CI And Platform Policy

Snapshot support must not depend on one developer machine.

CI split:

- Always run fixture and unit tests for macOS/Linux/Windows path normalization.
- Run live OpenCode snapshot smoke only when OpenCode credentials and `OPENCODE_LEDGER_LIVE_E2E=1` are present.
- On Windows CI, prefer fixture/probe tests first. Enable live snapshot smoke only after path/separator/reserved-name cases pass.
- If live smoke is unavailable, CI should not fail by default, but it must print a skipped reason.
- The production snapshot reader must be disabled on a platform/version pair that has no passing fixture or live probe.

Windows-specific cases:

- drive letter case normalization;
- backslash and slash mixed paths;
- reserved names in task/team/member IDs;
- paths with spaces and Unicode;
- CRLF preservation in full-text anchors;
- OpenCode data dir under `%APPDATA%` or custom config home.

This avoids shipping a macOS-only snapshot reader that later creates wrong review paths on Windows.

### Task Ledger Regression

```bash
bun test \
  src/services/taskChangeLedger/TaskChangeLedgerService.test.ts \
  src/services/taskChangeLedger/GitChangePathProvider.test.ts \
  src/services/taskChangeLedger/TaskChangeWriterLock.test.ts \
  src/services/boardTaskActivity/BoardTaskTranscriptPersistence.test.ts
```

Purpose: prove non-OpenCode agents are not impacted.

### UI

Only needed if evidence metadata is displayed:

```bash
pnpm exec vitest run \
  test/main/services/team/TaskChangeLedgerReader.test.ts \
  test/main/services/team/ReviewApplierService.test.ts \
  test/main/services/team/FileContentResolver.test.ts \
  test/main/services/team/ChangeExtractorService.test.ts
```

If no UI badge is added, only run existing regression.

### Build

```bash
bun run build:dev
pnpm typecheck
git diff --check
```

## Performance Constraints

Hard caps:

- text blob: 1 MB, same as current ledger behavior.
- patch text: 1 MB.
- max patch lines: 50k.
- max files per toolpart: 200.
- max enriched file timelines per backfill: 500.
- max total enrichment CPU wall time per backfill: bounded timeout, target 2-5 seconds before falling back.
- max evidence operations per session: existing scan caps, do not widen.
- no recursive filesystem walk.
- no git status/diff in OpenCode evidence enrichment.

Snapshot reader must:

- only inspect OpenCode data dirs for the selected session/profile;
- avoid reading full blobs until candidate path/part/session is matched;
- use bounded file reads;
- surface diagnostics instead of throwing.

If any cap is exceeded:

```text
fallback to metadata-only for the affected file/toolpart, continue other files
```

Do not fail the whole task changes panel because one file is large or one patch is pathological.

## Consistency And Race Handling

OpenCode history and snapshot artifacts can change while the UI requests Changes.

### SQLite Read Consistency

Rules:

- Keep using a read-only SQLite path.
- Use a bounded busy timeout.
- Read message/part rows in one transaction when possible.
- Capture DB stat/fingerprint before and after reading.
- If the DB changes during read but the transaction was stable, keep the transaction result and add a diagnostic.
- If the transaction cannot start or rows are inconsistent, return `transient-error` or metadata-only fallback, not partial full-text evidence.

### Snapshot Read Consistency

Snapshot reader must capture:

- OpenCode version;
- snapshot adapter version;
- pre/post snapshot hashes;
- snapshot artifact stat/fingerprint before and after reading;
- delivery boundary id.

If any snapshot artifact changes during read:

```text
discard snapshot evidence for that file/task, fallback to metadata-only
```

Do not mix SQLite toolparts from one read window with snapshot artifacts from another unless the boundary explicitly links them.

### Retry Policy

At most one short retry is allowed for transient source changes.

No unbounded polling.

If the second read is still unstable:

```text
diagnostic + metadata-only/no-attribution, depending on whether toolpart attribution was already proven
```

## Edge Cases

### External Writer After OpenCode

If current disk changed after OpenCode:

- current disk anchor may be wrong.
- snapshot evidence can still be valid historical evidence.
- apply/reject later must hash-guard current disk.

Rule:

```text
Use current disk only with explicit runtime freshness proof. Otherwise fallback.
```

### Multiple OpenCode Sessions Same Member

Do not carry file state across sessions.

Session A exact write should not become Session B baseline unless a future source proves continuity.

### Repeated Strings

If `oldString` or `newString` appears multiple times in the relevant text, reverse edit is unsafe.

Fallback.

### Multi-File Patch

Each file is independently verified.

One ambiguous file must not poison other verified files.

If the same patch has one exact `Add File` and one ambiguous `Update File`, import the add as full-text and the update as metadata-only. Do not drop the entire toolpart unless path parsing itself is unsafe.

### Delete Followed By Recreate

Can be exact only if timeline proves absent state between operations.

Otherwise metadata-only.

### Rename/Move

Do not support semantic rename in first pass unless snapshot shape clearly exposes old/new path and before/after.

Fallback to per-path metadata-only.

If OpenCode patch contains `Move to`, do not infer deletion/create pairs unless the snapshot reader proves both sides. Wrong rename handling is worse than metadata-only because reject can delete the wrong path.

### Binary/Large

Never text diff.

Keep metadata-only and manual review.

### CRLF/LF

Do not normalize line endings silently.

Evidence verification compares exact strings. If OpenCode patch dialect normalizes line endings, snapshot proof must confirm final bytes.

### Windows Paths

Use existing `normalizeOpenCodeFilePath`.

Tests must cover:

- drive-letter case-insensitive paths;
- reserved names;
- mixed POSIX/Windows absolute path rejection;
- `..` escape rejection;
- spaces/unicode.

### Duplicate Imports And Upgrades

Do not mutate or delete existing imported ledger events.

If a metadata-only event was already imported by Variant 1 and a later run discovers stronger evidence:

- default behavior: skip as duplicate, keep existing event;
- optional future behavior: write an additive enrichment event only if `sourceImportKey` can be linked and UI reader knows how to collapse it;
- do not overwrite JSONL lines in place.

For this iteration, prefer not upgrading already imported events. Rebuild safety matters more than retroactive polish.

### Source Import Key Stability

Keep `sourceImportKey` stable for a given OpenCode toolpart/path.

Do not include these in `sourceImportKey`:

- evidence proof type;
- adapter version;
- snapshot hash;
- confidence;
- import batch id.

Why: changing the key would duplicate the same toolpart as a second ledger event. That is worse than leaving an older metadata-only event untouched.

If future retroactive enrichment is needed, use a separate additive event type with explicit `enrichesSourceImportKey`, and teach the reader how to collapse it. Do not silently append a second normal file-change event.

Required tests:

- importing metadata-only and then rerunning with stronger evidence remains duplicate/skipped in this iteration;
- no duplicate file appears in bundle;
- source import key is identical across `metadata-only`, `chain-only`, and `snapshot-auto` modes for the same toolpart/path.

### Source Import Key Collision Guard

Before calling `importTaskChangeLedgerEvents`, validate the candidate batch:

```ts
type SourceImportKeyCollision = {
  sourceImportKey: string
  first: { sessionId: string; profileRootKey?: string; path: string; partId: string }
  second: { sessionId: string; profileRootKey?: string; path: string; partId: string }
}
```

Rules:

- Same key + same normalized identity is fine.
- Same key + different normalized identity is unsafe.
- Unsafe collision should skip the later candidate and emit diagnostic, or skip both if order is uncertain.
- Do not change the key format as a quick fix, because that would duplicate already imported Variant 1 events.

Required tests:

- two identical candidates dedupe cleanly;
- two different candidates with same forced key produce a diagnostic and no wrong attribution;
- profile/session metadata is included in collision diagnostics but not file content.

Future key format changes need a migration plan:

```text
sourceImportKeyV1 = opencode\0sessionId\0partId\0comparisonPath
sourceImportKeyV2 = opencode\0profileRootKey\0sessionId\0partId\0comparisonPath
```

Do not introduce V2 until the reader/importer can recognize V1 as an alias.

### Ledger Source Ordering

OpenCode enrichment should run before `importTaskChangeLedgerEvents`.

It should not read task bundles and reinterpret unrelated ledger sources. Existing ledger anchors are out of scope for the first implementation.

If they are added later, they must be constrained to:

- same `taskId`;
- same `sourceRuntime: 'opencode'`;
- same `sourceSessionId`;
- same normalized path;
- exact full-text event with matching source import lineage.

### Storage, Privacy, And Retention

Snapshot/full-text evidence can increase project artifact size. Keep the storage model explicit.

Rules:

- Full file contents belong only in existing task-change ledger blob storage under the project artifact directory.
- Global/user config may store pointers, fingerprints, and diagnostics only. No file contents.
- Snapshot boundary records must remain content-free.
- Diagnostics must never include raw tool arguments, raw prompt text, patch bodies, file contents, or environment variables.
- Diagnostics may include stable ids, normalized relative paths, sizes, hashes, adapter versions, and capped error codes.
- If enriched blobs exceed the existing ledger retention policy, reuse that policy. Do not create a second long-lived storage system.
- If snapshot probe creates temporary HOME/config/data dirs, cleanup must run in `finally` and tests must assert no large temp dirs remain.
- If cleanup fails, emit a diagnostic path to developer logs only, not to task UI.

Redaction helper should be shared:

```ts
function redactOpenCodeEvidenceDiagnostic(input: unknown): RedactedDiagnostic {
  return {
    code: extractCode(input),
    sessionId: extractSessionId(input),
    partId: extractPartId(input),
    path: extractSafeRelativePath(input),
    sizeBytes: extractSize(input),
  }
}
```

Never add a "dump raw OpenCode row" debug mode to the normal app. If deeper debugging is needed, keep it behind an explicit local developer command and document that it can expose file content.

### Atomic Import And Recovery Contract

Full-text enrichment must not create half-valid ledger artifacts.

Rules:

- Build all candidate events in memory before calling `importTaskChangeLedgerEvents`.
- Validate source import key collisions before any write.
- For each full-text event, ensure blob write and event write follow the existing ledger atomic pattern.
- If full-text blob write fails, downgrade that file to metadata-only or skip it with diagnostic. Do not append an event that points at a missing blob.
- If bundle rebuild fails after journal append, the reader should recover from journal on next open, as existing ledger behavior expects.
- Rerunning the same backfill after a crash must be idempotent.
- Do not rewrite historical JSONL entries in place.

Recovery matrix:

| Failure | Required behavior |
| --- | --- |
| Enricher throws before import | Use Variant 1 reconstructed changes |
| Blob write fails for one file | Downgrade/skip that file, continue other files |
| Journal append succeeds, bundle write fails | Next read rebuilds from journal |
| Import interrupted mid-batch | Rerun dedupes already appended events by `sourceImportKey` |
| Collision detected before import | Skip unsafe candidates, emit diagnostic |
| Collision discovered after partial prior import | Keep existing event, skip new conflicting candidate |

This is the difference between "we might miss a nicer diff" and "we corrupt the review surface". Missing a nicer diff is acceptable. Corrupting reviewability is not.

## Kill Switches And Diagnostics

Add explicit runtime toggles so a production issue can be contained without rolling back the whole OpenCode bridge:

```ts
type OpenCodeEvidencePipelineMode =
  | 'off'
  | 'metadata-only'
  | 'chain-only'
  | 'snapshot-probe'
  | 'snapshot-auto'
```

Recommended defaults:

- production initial default: `chain-only` after Milestone 1 tests pass;
- snapshot default: `snapshot-probe` only in dev/test;
- emergency fallback: `metadata-only`, which is exactly Variant 1 behavior.

Mode meanings:

- `off`: do not attempt OpenCode backfill enrichment.
- `metadata-only`: keep Variant 1 behavior, no full-text upgrades beyond already exact toolpart chain.
- `chain-only`: allow existing exact toolpart chain behavior, but no snapshot reader and no current-disk anchor.
- `snapshot-probe`: run gated diagnostics/tests only, not normal UI path enrichment.
- `snapshot-auto`: allow version-gated snapshot reader after live probe and fixtures pass.

Diagnostics should include counts, not huge payloads:

- candidates scanned;
- full-text upgraded;
- metadata-only fallback;
- ambiguous edit count;
- unsupported patch count;
- snapshot unsupported count;
- cap exceeded count.

Do not log file contents.

## Rollout Plan

### Milestone 0 - Safety contract

Scope:

- tests proving non-OpenCode paths are unchanged;
- tests proving metadata-only remains manual-only;
- integration point behind OpenCode-only gate.

Expected result:

- no user-visible behavior change.

Risk:

- low.

### Milestone 1 - Chain hardening and snapshot probe

Scope:

- `OpenCodeChangeEvidenceEnricher`.
- exact in-memory toolpart chain rules.
- live `opencode debug snapshot` probe in isolated temp HOME.
- no production snapshot reader yet.
- ledger anchors are not part of this plan's first production implementation.
- no current disk historical anchor.

Expected result:

- no fake diffs; clearer proof of whether OpenCode snapshot can become the real full-text anchor source.

Risk:

- low/medium.

### Milestone 2 - Snapshot reader and inverse edit enrichment

Scope:

- production snapshot reader only for the shape proven by Milestone 1.
- inverse edit reverse/forward verification using snapshot anchors.
- unsupported snapshot shape fallback.

Risk:

- medium/high because OpenCode internals may drift.

### Milestone 3 - Apply patch enrichment

Scope:

- strict patch parser.
- create full-text when patch proves full file.
- update/delete full-text only with full anchor or snapshot.

Risk:

- medium because patch dialect must be exact.

### Milestone 4 - Optional UI evidence labels

Scope:

- display proof source.
- no behavior changes.

Risk:

- low.

## Acceptance Criteria

This is ready to merge when:

- Variant 1 behavior still passes.
- Non-OpenCode ledger tests pass unchanged.
- OpenCode enrichment can be disabled and Variant 1 behavior is restored.
- OpenCode inverse edit fixture produces full-text diff only when a snapshot/full-text anchor exists.
- Ambiguous inverse edit fixture remains metadata-only.
- OpenCode apply_patch fixture produces full-text only for verified hunk.
- Snapshot unsupported shape does not break changes panel.
- Snapshot evidence without task delivery boundary is diagnostics-only.
- Snapshot evidence for another task in same session is not imported.
- Live OpenCode smoke still passes.
- If snapshot reader is enabled, snapshot live probe passes.
- UI blocks unsafe apply/reject for all unavailable states.
- Current disk without freshness proof never produces auto-reviewable full-text ledger events.
- Old `snapshot:false` pure edit-only histories remain metadata-only unless a proven anchor exists.
- Existing ledger bundles are not used as anchors in Milestone 1.
- Enrichment cap exceedance affects only the offending file/toolpart, not the whole task.
- Source import key collision is diagnosed and does not attribute the wrong file.
- SQLite/snapshot source changes during read do not produce full-text evidence from mixed windows.
- Snapshot boundary records are additive, content-free, and missing boundary degrades to metadata/diagnostics.
- Existing running OpenCode teammates are not force-restarted by enabling snapshot evidence.
- Old session records without snapshot metadata stay readable and fail closed.
- UI ignores unknown evidence metadata and review behavior remains hash-guarded.
- Snapshot live/probe tests are platform-gated with explicit skipped diagnostics.
- UI auto-backfill cache does not long-cache `no-attribution` or `transient-error` as final empty changes.
- Partial toolpart schemas fail closed and never parse assistant text as file evidence.
- Full-text event import never references missing blobs after a simulated write failure.
- Rerunning after interrupted import is idempotent and does not duplicate files.
- Snapshot post-boundary is never trusted for non-terminal delivery observations.
- Normal UI backfill does not shell out to `opencode debug snapshot`.
- Snapshot boundary completion cannot mutate `teamName`, `taskId`, `memberName`, `laneId`, or `runtimeSessionId`.
- Centralized ledger storage never causes OpenCode worktree paths to be rewritten to the leader repo.
- Symlink paths remain manual-only unless a future realpath-inside-workspace proof is implemented.
- Case-colliding candidate paths are diagnosed and do not unlock review actions.
- `snapshot-auto` is not allowed unless a production-safe provider exists; debug CLI provider is live-probe only.

## Final Recommendation

Implement Milestone 0 and Milestone 1 first.

Why:

- It locks safety before adding any new full-text source.
- It does not require changing OpenCode managed config.
- It has no snapshot performance risk.
- It proves, with a real OpenCode run, whether snapshot can be the safe anchor source.

Then implement Milestone 2 snapshot reader/inverse edit enrichment.

Only after snapshot evidence is production-capable should `apply_patch` full-text enrichment become a priority, because `Update File` usually needs a full-file anchor.
