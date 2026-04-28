# OpenCode Hybrid Evidence Pipeline - Continuation Plan

Status: continuation plan after the safe `chain-only` OpenCode ledger bridge work.

Primary goal: move OpenCode task changes from metadata-only/manual review toward Cursor-like full text diffs, but only when the evidence is strong enough to keep attribution and apply/reject safe.

Current working branch:

```text
/Users/belief/dev/projects/claude/_worktrees/agent_teams_orchestrator_opencode_snapshot_bridge
branch: research/opencode-snapshot-ledger-bridge
```

Related UI worktree:

```text
/Users/belief/dev/projects/claude/_worktrees/claude_team_opencode_ledger_bridge
branch: feat/opencode-ledger-bridge-ui
```

## Executive Summary

The next correct step is not to enable `snapshot:true` globally and hope OpenCode's internal state can be consumed safely. The next correct step is to add a gated production snapshot evidence path with explicit delivery boundaries, source consistency checks, version/shape guards, and a hard fallback to the already implemented safe chain/metadata behavior.

Recommended path:

1. Prove the installed OpenCode snapshot behavior with a real live probe.
2. Capture content-free pre/post snapshot boundaries during OpenCode message delivery.
3. Implement a production snapshot evidence provider only for a shape that has been proven by fixtures and live smoke.
4. Use snapshot evidence only to enrich already strict-delivery-attributed OpenCode toolparts.
5. Keep UI auto-backfill default on `chain-only` until snapshot evidence passes real E2E and platform gates.
6. Never use snapshot evidence for other agents.
7. Never allow unsafe apply/reject for metadata-only or unverifiable evidence.

Current confidence:

- Safe fallback already implemented: strong.
- Full diff via snapshot: promising, not yet production-proven.
- Full diff without snapshot or targeted baseline: not reliable enough for old edit-only OpenCode sessions.

## Current State

Implemented safe layer:

- `OpenCodeChangeEvidenceEnricher` exists.
- `OpenCodeEvidencePipelineMode` exists:
  - `off`
  - `metadata-only`
  - `chain-only`
  - `snapshot-probe`
  - `snapshot-auto`
- UI auto-backfill currently sends:
  - `attributionMode: 'strict-delivery'`
  - `evidenceMode: 'chain-only'`
- `snapshot-auto` is guarded. If no provider is wired, it adds a diagnostic and falls back.
- OpenCode `write`, `edit`, and `apply_patch` toolparts can become metadata-only/manual-review ledger events instead of disappearing.
- Existing metadata-only UI behavior blocks unsafe apply/reject through `manual-review-required`.
- Existing task ledger paths for Claude Code, Codex native, shell snapshots, PowerShell snapshots, and exact tool events are not intentionally changed.

Important installed OpenCode fact:

```text
opencode --version
1.14.19

opencode debug snapshot --help
Commands:
  opencode debug snapshot track
  opencode debug snapshot patch <hash>
  opencode debug snapshot diff <hash>
```

Important caveat:

- The debug snapshot commands are human/debug surfaces.
- Current help does not expose JSON output.
- They are useful for live probe and shape discovery.
- They should not be called from the normal UI Changes path.

## What Is Still Missing

Critical missing production pieces:

1. Real live snapshot probe has not been accepted as a merge gate.
2. No production `OpenCodeSnapshotEvidenceProvider` is wired.
3. No content-free pre/post snapshot boundary is persisted in delivery records.
4. `snapshot:true` is not yet mode-gated by session and profile.
5. Snapshot evidence is not tied to a terminal delivery observation.
6. Snapshot evidence is not yet validated against strict task/member/lane/session attribution.
7. Snapshot reader does not yet prove before/after content for OpenCode edit/apply_patch full diffs.
8. Fixture matrix does not yet cover snapshot shape drift, workspace mismatch, same path in two worktrees, or cross-task same-session contamination.
9. UI does not yet expose evidence diagnostics beyond existing manual review/metadata-only behavior.
10. Windows snapshot path behavior is not proven on real runner.

## Core Principle

Full text diff is allowed only when both are true:

```text
task attribution is strict and exact
file state evidence proves before/after
```

If either is weak:

```text
metadata-only manual review or diagnostics-only
```

The system must prefer missing a nice diff over showing the wrong diff.

## Top 3 Implementation Options

1. **Probe-first production snapshot provider** - 🎯 9.1   🛡️ 9.4   🧠 8.2 - ~1800-3200 LOC.
   Best option. It is more work, but it keeps the already safe OpenCode bridge and only unlocks full diffs after real evidence. Snapshot support remains opt-in/gated until live probe and fixture proof pass.

2. **Chain-only plus stronger inverse toolpart reconstruction** - 🎯 7.8   🛡️ 9.2   🧠 5.7 - ~700-1400 LOC.
   Useful and safe, but limited. It improves cases where OpenCode writes a file and then edits it in the same session. It does not solve pure edit-only existing files because there is no trustworthy `before`.

3. **Enable `snapshot:true` globally and parse debug CLI output directly** - 🎯 4.6   🛡️ 4.2   🧠 6.5 - ~900-1800 LOC.
   Not recommended. It risks performance regressions, depends on human-oriented debug output, and can misattribute session-wide snapshot diffs to one task unless delivery boundaries are proven.

Chosen path: option 1.

## Architecture Direction

The runtime flow should become:

```text
UI opens task Changes
  -> ChangeExtractorService calls opencode.backfillTaskLedger
  -> OpenCodeLedgerBridgeService loads strict delivery context
  -> OpenCodeOfflineSessionReader reads bounded SQLite history
  -> OpenCodeToolpartChangeReconstructor reconstructs candidate file changes
  -> OpenCodeChangeEvidenceEnricher enriches candidates
       -> chain-only proofs
       -> optional snapshot provider proofs
       -> metadata-only fallback
  -> TaskChangeLedgerService imports safe events
  -> UI reads ledger bundle as primary source
```

Snapshot evidence must be an OpenCode-only enrichment source. It must not change the ledger rules for other agents.

## Non-Goals

- Do not implement broad filesystem scanning.
- Do not infer changes from assistant comments, task comments, logs, or natural language claims.
- Do not use current disk as historical `after` without a separate freshness proof.
- Do not parse `opencode debug snapshot` output in the normal UI path.
- Do not enable snapshot evidence for non-OpenCode agents.
- Do not auto-merge teammate worktrees.
- Do not rewrite old ledger journal entries in place.
- Do not enable full apply/reject for metadata-only events.
- Do not force-restart existing OpenCode teams only to enable snapshot evidence.

## Safety Invariants

### Attribution Invariant

A full-text OpenCode event must be tied to:

- same `teamName`;
- same `taskId`;
- same `memberName`;
- same `laneId`;
- same `runtimeSessionId`;
- same delivered user message or inbox message window;
- terminal delivery observation;
- normalized path inside `workspaceRoot`.

If any field is missing or ambiguous, the event can be metadata-only only if the exact touched path is already proven. Otherwise it is diagnostics-only.

### Evidence Invariant

For a full-text ledger event:

```text
beforeContent + operation = afterContent
afterContent equals a trusted anchor
```

Trusted anchors:

- exact toolpart chain state inside the same OpenCode session and same normalized file path;
- snapshot before/after evidence tied to the task delivery boundary;
- exact OpenCode `write` content when the operation is proven create or when previous state is proven by chain/snapshot.

Not trusted:

- current disk alone;
- assistant text;
- comments;
- file mtime;
- later write used as reverse proof for earlier edit;
- existing ledger bundle without explicit lineage;
- debug CLI output in normal UI path.

### Review Invariant

`ReviewApplierService` can auto accept/reject only when ledger has real full text and current disk hash guards match.

Metadata-only cases must remain:

```text
MANUAL REVIEW
manual-review-required
```

## Required Data Model Changes

The existing internal types are already close. Extend them without breaking current callers.

### Extend Snapshot Boundary

Current:

```ts
export type OpenCodeSnapshotBoundary = {
  schemaVersion: 1
  captureStatus: OpenCodeSnapshotCaptureStatus
  preDeliverySnapshotHash?: string
  postDeliverySnapshotHash?: string
  snapshotAdapterVersion?: number
  opencodeVersion?: string
  diagnostics?: string[]
}
```

Recommended:

```ts
export type OpenCodeSnapshotBoundary = {
  schemaVersion: 1
  captureStatus: OpenCodeSnapshotCaptureStatus

  preDeliverySnapshotHash?: string
  postDeliverySnapshotHash?: string

  snapshotAdapterVersion?: number
  snapshotShapeFingerprint?: string
  opencodeVersion?: string

  workspaceRoot?: string
  profileRootKey?: string
  hostKey?: string
  runtimeSessionId?: string
  memberName?: string
  laneId?: string
  deliveredUserMessageId?: string | null
  inboxMessageId?: string | null

  capturedAt?: string
  completedAt?: string
  diagnostics?: string[]
}
```

Rules:

- This record must contain no file contents.
- It may contain hashes, ids, paths, timestamps, versions, and diagnostics.
- Missing fields disable snapshot full-text evidence but must not break strict delivery attribution.

### Extend Snapshot Provider Input

Current:

```ts
export type SnapshotBoundaryReadInput = {
  workspaceRoot: string
  sessionId: string
  boundary: OpenCodeSnapshotBoundary
  touchedRelativePaths: string[]
}
```

Recommended:

```ts
export type SnapshotBoundaryReadInput = {
  workspaceRoot: string
  sessionId: string
  memberName: string
  laneId?: string
  taskId: string
  deliveryMessageIds: {
    inboxMessageId?: string | null
    deliveredUserMessageId?: string | null
    observedAssistantMessageId?: string | null
  }
  boundary: OpenCodeSnapshotBoundary
  touchedRelativePaths: string[]
  maxBytesPerFile: number
  maxFiles: number
}
```

Why:

- A snapshot diff can be correct for the session but wrong for the task.
- The provider should receive enough identity data to fail closed.

### Extend Snapshot Evidence File

Current:

```ts
export type OpenCodeSnapshotEvidenceFile = {
  relativePath: string
  afterContent?: string
  beforeContent?: string
  operation?: 'create' | 'modify' | 'delete'
  snapshotId?: string
  warnings?: string[]
}
```

Recommended:

```ts
export type OpenCodeSnapshotEvidenceFile = {
  relativePath: string
  operation: 'create' | 'modify' | 'delete'

  beforeContent?: string
  afterContent?: string

  beforeState?: {
    exists: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: string
  }
  afterState?: {
    exists: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: string
  }

  snapshotId?: string
  proofId: string
  proofKind: 'opencode-snapshot-boundary'
  warnings?: string[]
}
```

Rules:

- `beforeContent` or `afterContent` missing means the file may still be metadata-only.
- The provider must never synthesize empty `beforeContent` unless operation is proven create.
- The provider must never synthesize empty `afterContent` unless operation is proven delete.

## Implementation Plan

### Phase 0 - Preserve Current Safe Behavior

Scope: tests only, plus small diagnostics if missing.

Tasks:

1. Add tests proving `snapshot-auto` without provider does not unlock full-text evidence.
2. Add tests proving `chain-only` remains current UI default.
3. Add tests proving non-OpenCode ledger sources are unaffected.
4. Add tests proving metadata-only OpenCode events still return `manual-review-required`.
5. Add a regression test that `opencode.backfillTaskLedger` with `evidenceMode: 'snapshot-auto'` and no provider returns diagnostics but still imports safe metadata-only/chain events.

Files:

```text
src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts
src/services/opencode/OpenCodeLedgerBridgeService.test.ts
src/services/taskChangeLedger/TaskChangeLedgerService.test.ts
```

Expected code shape:

```ts
test('snapshot-auto without provider falls back to chain evidence', async () => {
  const result = await service.backfill({
    teamName: 'team-a',
    taskId: 'task-1',
    attributionMode: 'strict-delivery',
    evidenceMode: 'snapshot-auto',
    deliveryContextPath,
    projectDir,
    workspaceRoot,
  })

  expect(result.diagnostics).toContain(
    OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC,
  )
  expect(result.importedEvents).toBeGreaterThanOrEqual(0)
})
```

Acceptance:

- Existing tests continue passing.
- No production behavior change.

### Phase 1 - Run And Harden Live Snapshot Probe

Scope: gated live test and proof collection.

Existing file:

```text
src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

Strengthen it to assert:

- `opencode debug snapshot --help` exposes `track`, `patch`, and `diff`.
- Managed config with `snapshot: true` is written only to a temp HOME/config.
- A real `opencode run` changes a file.
- `track` after the run returns a non-empty hash.
- `patch <hash>` and `diff <hash>` return successful output.
- The output can be fingerprinted.
- The output is not used as production parser input.

Command:

```bash
OPENCODE_LEDGER_LIVE_E2E=1 \
OPENCODE_LEDGER_SNAPSHOT_PROBE=1 \
bun test src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

Stop conditions:

- If `track` returns `undefined` after a real file-changing run, stop snapshot production work.
- If `patch`/`diff` do not expose enough information to discover a stable underlying artifact shape, keep `snapshot-auto` disabled.
- If live run needs auth/model that is not reliably available, keep the test gated and use fixtures only for CI.

Output to record in the test diagnostics:

```ts
type LiveSnapshotProbeObservation = {
  opencodeVersion: string
  trackBefore: string | null
  trackAfter: string | null
  patchExitCode: number
  diffExitCode: number
  patchFingerprint: string
  diffFingerprint: string
  diagnostics: string[]
}
```

Do not commit raw file contents from the live run.

### Phase 2 - Add Content-Free Snapshot Boundary Capture

Scope: orchestrator runtime delivery, not UI.

Files:

```text
src/services/opencode/OpenCodeBridgeCommandHandler.ts
src/services/opencode/OpenCodePromptDeliveryLedger.ts
src/services/opencode/types.ts
src/services/opencode/OpenCodeChangeEvidence.ts
```

Goal:

- Add optional `snapshotBoundary` to delivery ledger records.
- Capture pre/post boundary around `opencode.sendMessage` and `opencode.observeMessageDelivery`.
- Do not store file contents.
- Do not fail message delivery if boundary capture fails.

New interface:

```ts
export interface OpenCodeSnapshotBoundaryPort {
  capture(input: {
    projectPath: string
    profileRootKey?: string
    runtimeSessionId?: string | null
    memberName: string
    laneId?: string
    phase: 'pre-delivery' | 'post-delivery'
  }): Promise<{
    status: 'captured' | 'snapshot-disabled' | 'unsupported-shape' | 'capture-failed'
    snapshotHash?: string
    opencodeVersion?: string
    snapshotShapeFingerprint?: string
    diagnostics?: string[]
  }>
}
```

Default implementation for production initial state:

```ts
class NoopOpenCodeSnapshotBoundaryPort implements OpenCodeSnapshotBoundaryPort {
  async capture() {
    return {
      status: 'snapshot-disabled' as const,
      diagnostics: ['OpenCode snapshot boundary capture is disabled.'],
    }
  }
}
```

Hook in `runSendMessage`:

```ts
const preSnapshot = await snapshotBoundaryPort.capture({
  projectPath,
  profileRootKey,
  runtimeSessionId: member.sessionId,
  memberName,
  laneId,
  phase: 'pre-delivery',
}).catch(error => ({
  status: 'capture-failed' as const,
  diagnostics: [formatSafeDiagnostic(error)],
}))
```

Hook after terminal delivery observation:

```ts
const postSnapshot = isTerminalDeliveryObservation(responseObservation)
  ? await snapshotBoundaryPort.capture({
      projectPath,
      profileRootKey,
      runtimeSessionId: member.sessionId,
      memberName,
      laneId,
      phase: 'post-delivery',
    }).catch(error => ({
      status: 'capture-failed' as const,
      diagnostics: [formatSafeDiagnostic(error)],
    }))
  : { status: 'not-terminal' as const }
```

Persist:

```ts
snapshotBoundary: {
  schemaVersion: 1,
  captureStatus: preSnapshot.status === 'captured' && postSnapshot.status === 'captured'
    ? 'captured'
    : postSnapshot.status === 'not-terminal'
      ? 'not-terminal'
      : 'capture-failed',
  preDeliverySnapshotHash: preSnapshot.snapshotHash,
  postDeliverySnapshotHash: postSnapshot.snapshotHash,
  opencodeVersion: postSnapshot.opencodeVersion ?? preSnapshot.opencodeVersion,
  snapshotShapeFingerprint:
    postSnapshot.snapshotShapeFingerprint ?? preSnapshot.snapshotShapeFingerprint,
  workspaceRoot: projectPath,
  profileRootKey,
  runtimeSessionId: member.sessionId,
  memberName,
  laneId,
  inboxMessageId,
  deliveredUserMessageId: responseObservation.deliveredUserMessageId,
  observedAssistantMessageId: responseObservation.assistantMessageId,
  capturedAt: preCapturedAt,
  completedAt: postCapturedAt,
  diagnostics: [...preSnapshot.diagnostics ?? [], ...postSnapshot.diagnostics ?? []],
}
```

Rules:

- If delivery is pending, boundary is `not-terminal`.
- If permission blocked after tool mutation, boundary can still be terminal only if observation proves the assistant turn ended.
- If boundary capture fails, delivery still succeeds.
- If snapshot boundary is missing, strict delivery attribution still works, but full snapshot evidence is disabled.

Tests:

- pre boundary captured for send.
- post boundary captured for terminal delivery.
- no post boundary for pending delivery.
- observeMessageDelivery can complete missing post boundary.
- boundary capture failure does not fail message delivery.
- persisted delivery record is content-free.
- malformed boundary does not break strict delivery parsing.

### Phase 3 - Add Production Snapshot Provider Interface And Guard

Scope: production provider shape, still disabled by default.

Files:

```text
src/services/opencode/OpenCodeSnapshotEvidenceProvider.ts
src/services/opencode/OpenCodeSnapshotEvidenceProvider.test.ts
src/services/opencode/OpenCodeChangeEvidence.ts
```

Implementation structure:

```ts
export class OpenCodeSnapshotEvidenceProviderV1 implements OpenCodeSnapshotEvidenceProvider {
  readonly adapterVersion = 1

  async probe(input: SnapshotProbeInput): Promise<OpenCodeSnapshotProbeResult> {
    const support = await detectSupportedSnapshotShape(input)
    if (!support.supported) {
      return {
        supported: false,
        code: 'unsupported-opencode-snapshot-shape',
        diagnostics: support.diagnostics,
      }
    }
    return {
      supported: true,
      adapterVersion: this.adapterVersion,
      shapeFingerprint: support.shapeFingerprint,
      opencodeVersion: support.opencodeVersion,
      diagnostics: support.diagnostics,
    }
  }

  async readBoundaryEvidence(
    input: SnapshotBoundaryReadInput,
  ): Promise<OpenCodeSnapshotEvidenceResult> {
    const validation = validateSnapshotBoundaryInput(input)
    if (!validation.ok) {
      return {
        supported: false,
        code: 'snapshot-boundary-unavailable',
        diagnostics: validation.diagnostics,
      }
    }

    const source = await readSupportedSnapshotArtifacts(input)
    if (!source.supported) {
      return {
        supported: false,
        code: 'unsupported-opencode-snapshot-shape',
        diagnostics: source.diagnostics,
      }
    }

    return materializeSnapshotEvidenceFiles(source, input)
  }
}
```

Important:

- `readSupportedSnapshotArtifacts` must not shell out to `opencode debug snapshot`.
- It may read OpenCode data files only after Phase 1 proves the shape.
- It must be bounded and version/shape-gated.

Guard:

```ts
function validateSnapshotBoundaryInput(input: SnapshotBoundaryReadInput) {
  const diagnostics: string[] = []

  if (!isCapturedSnapshotBoundary(input.boundary)) {
    diagnostics.push('Snapshot boundary was not captured.')
  }
  if (input.boundary.workspaceRoot && !samePath(input.boundary.workspaceRoot, input.workspaceRoot)) {
    diagnostics.push('Snapshot boundary workspaceRoot does not match backfill workspaceRoot.')
  }
  if (
    input.boundary.runtimeSessionId &&
    input.boundary.runtimeSessionId !== input.sessionId
  ) {
    diagnostics.push('Snapshot boundary runtimeSessionId does not match session record.')
  }
  if (input.touchedRelativePaths.length === 0) {
    diagnostics.push('Snapshot evidence requires already reconstructed touched paths.')
  }

  return diagnostics.length === 0
    ? { ok: true as const }
    : { ok: false as const, diagnostics }
}
```

Tests:

- missing boundary returns unsupported.
- workspace mismatch returns unsupported.
- session mismatch returns unsupported.
- empty touched paths returns unsupported.
- provider throws are caught by enricher and fallback is used.
- provider returns unsupported shape and no full-text upgrade occurs.

### Phase 4 - Discover And Implement Supported Snapshot Artifact Reader

Scope: only after Phase 1 proves where/how data can be read safely.

Possible reader sources:

1. OpenCode internal snapshot database/file store.
2. OpenCode snapshot patch artifacts.
3. OpenCode content-addressed blobs linked by snapshot hash.

Do not guess this. Implement only after a real probe identifies a stable shape.

Reader requirements:

- Read only within OpenCode profile/data directory for the matched session/profile.
- Do not recurse the workspace.
- Do not read arbitrary paths from snapshot data without workspace normalization.
- Cap all reads.
- Fingerprint artifacts before and after reading.
- If artifacts change mid-read, discard snapshot evidence for that backfill.
- Treat binary/large/unreadable content as metadata-only.

Suggested helpers:

```ts
type SnapshotArtifactFingerprint = {
  path: string
  sizeBytes: number
  mtimeMs: number
  sha256?: string
}

type SnapshotShapeSupport = {
  supported: boolean
  opencodeVersion?: string
  shapeFingerprint?: string
  diagnostics: string[]
}

async function fingerprintSnapshotArtifacts(paths: string[]): Promise<SnapshotArtifactFingerprint[]> {
  // bounded stat/hash, no raw content in diagnostics
}
```

Materialization:

```ts
function materializeSnapshotEvidenceFiles(
  source: SupportedSnapshotSource,
  input: SnapshotBoundaryReadInput,
): OpenCodeSnapshotEvidenceResult {
  const touched = new Set(input.touchedRelativePaths.map(normalizeRelativePathForComparison))
  const files: OpenCodeSnapshotEvidenceFile[] = []

  for (const patch of source.patches) {
    const relativePath = normalizeRelativePathFromSnapshot(patch.path, input.workspaceRoot)
    if (!relativePath || !touched.has(relativePath.comparisonKey)) {
      continue
    }

    const text = readTextPairUnderCaps(patch)
    if (!text.ok) {
      files.push({
        relativePath: relativePath.displayPath,
        operation: patch.operation,
        beforeState: text.beforeState,
        afterState: text.afterState,
        proofId: patch.proofId,
        proofKind: 'opencode-snapshot-boundary',
        warnings: text.warnings,
      })
      continue
    }

    files.push({
      relativePath: relativePath.displayPath,
      operation: patch.operation,
      beforeContent: text.beforeContent,
      afterContent: text.afterContent,
      beforeState: text.beforeState,
      afterState: text.afterState,
      snapshotId: input.boundary.postDeliverySnapshotHash,
      proofId: patch.proofId,
      proofKind: 'opencode-snapshot-boundary',
    })
  }

  return {
    supported: true,
    adapterVersion: 1,
    shapeFingerprint: source.shapeFingerprint,
    opencodeVersion: source.opencodeVersion,
    files,
    diagnostics: source.diagnostics,
  }
}
```

Tests:

- supported shape returns full before/after for create/modify/delete.
- unsupported shape returns diagnostic only.
- changed artifact fingerprint returns transient diagnostic and no full-text.
- path outside workspace rejected.
- symlink path stays metadata-only.
- CRLF content preserved.
- binary content metadata-only.
- large content metadata-only.
- path case collision fail closed on case-insensitive platforms.

### Phase 5 - Wire Provider Behind Explicit Mode

Scope: controlled enablement.

Files:

```text
src/services/opencode/OpenCodeLedgerBridgeService.ts
src/services/opencode/OpenCodeBridgeCommandHandler.ts
src/services/opencode/OpenCodeProfileManager.ts
src/services/opencode/OpenCodeProvisioningProbe.ts
```

Current constructor:

```ts
constructor(
  private readonly sessionStore: SessionStorePort = openCodeSessionStore,
  private readonly offlineReader = openCodeOfflineSessionReader,
  private readonly reconstructor = new OpenCodeToolpartChangeReconstructor(),
  private readonly evidenceEnricher = new OpenCodeChangeEvidenceEnricher(),
  private readonly snapshotEvidenceProvider?: OpenCodeSnapshotEvidenceProvider,
) {}
```

Keep this shape. Wire the real provider only through explicit config/env:

```ts
function createOpenCodeLedgerBridgeService() {
  const evidenceMode = normalizeOpenCodeEvidencePipelineMode(
    process.env.CLAUDE_TEAM_OPENCODE_EVIDENCE_MODE,
  )
  const snapshotProvider = evidenceMode === 'snapshot-auto'
    ? new OpenCodeSnapshotEvidenceProviderV1()
    : undefined

  return new OpenCodeLedgerBridgeService(
    openCodeSessionStore,
    openCodeOfflineSessionReader,
    new OpenCodeToolpartChangeReconstructor(),
    new OpenCodeChangeEvidenceEnricher(),
    snapshotProvider,
  )
}
```

Production default:

```text
chain-only
```

Dev/test opt-in:

```text
CLAUDE_TEAM_OPENCODE_EVIDENCE_MODE=snapshot-auto
```

UI default should remain `chain-only` until:

- live snapshot probe passes;
- fixture matrix passes;
- Windows path fixtures pass;
- production provider is wired and disabled safely when unsupported.

### Phase 6 - Managed Config Snapshot Mode

Current:

```ts
snapshot: false
```

Do not flip this globally.

Add option:

```ts
type OpenCodeSnapshotConfigMode = 'disabled' | 'enabled-for-evidence'

export function buildManagedConfig(
  appMcpConfig?: OpenCodeMcpServerConfig | null,
  options: {
    allowAutoUpdate?: boolean
    defaultModelId?: string | null
    modelOutputLimitOverrides?: OpenCodePrepareProfileOptions['modelOutputLimitOverrides']
    snapshotConfigMode?: OpenCodeSnapshotConfigMode
  } = {},
): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    default_agent: 'teammate',
    share: 'disabled',
    snapshot: options.snapshotConfigMode === 'enabled-for-evidence',
    ...
  }
}
```

Provisioning probe must expect the configured mode:

```ts
const expectedSnapshot = options.snapshotConfigMode === 'enabled-for-evidence'
if (config.snapshot !== expectedSnapshot) {
  diagnostics.push(
    `Managed snapshot mismatch (${String(config.snapshot ?? 'unset')} instead of ${expectedSnapshot})`,
  )
}
```

Rules:

- Existing teams are not force-restarted.
- New sessions can opt in when evidence mode is `snapshot-auto`.
- Old sessions with `snapshot:false` remain readable and fail closed.
- A teammate session record should record the snapshot config mode used at launch.

Suggested session metadata:

```ts
type OpenCodeSessionRecord = {
  ...
  snapshotConfigMode?: 'disabled' | 'enabled-for-evidence'
  snapshotAdapterVersion?: number
  snapshotShapeFingerprint?: string
}
```

### Phase 7 - Enricher Snapshot Full-Text Upgrade

Existing `OpenCodeChangeEvidenceEnricher` already supports provider result maps. Tighten it.

Required changes:

1. Pass expanded identity fields to provider.
2. Require snapshot operation compatibility with candidate operation.
3. Allow delete full-text only when snapshot proves `beforeContent` and `afterState.exists === false`.
4. Allow create full-text only when snapshot proves `beforeState.exists === false` and `afterContent`.
5. Allow modify full-text only when both full contents are present and exact verification passes.
6. Keep inverse edit and inverse apply_patch as transformations on snapshot anchors, not as standalone evidence.

Pseudo-code:

```ts
function canUseSnapshotAnchor(change, anchor): boolean {
  if (anchor.operation === 'create') {
    return change.operation === 'create' && anchor.beforeState?.exists === false
  }
  if (anchor.operation === 'delete') {
    return change.operation === 'delete' && anchor.afterState?.exists === false
  }
  return change.operation === 'modify' || change.operation === 'create' || change.operation === 'delete'
}
```

Upgrade direct snapshot full pair:

```ts
if (
  typeof anchor.beforeContent === 'string' &&
  typeof anchor.afterContent === 'string' &&
  canUseSnapshotAnchor(change, anchor)
) {
  return {
    ...change,
    beforeContent: anchor.beforeContent,
    afterContent: anchor.afterContent,
    beforeState: contentStateForText(anchor.beforeContent),
    afterState: contentStateForText(anchor.afterContent),
    confidence: 'high',
    evidenceProof: 'opencode-snapshot',
    snapshotId: anchor.snapshotId,
    snapshotSource: 'opencode',
  }
}
```

Upgrade inverse edit only from proven anchor:

```ts
const reversed = reverseEditFromAfter({
  after: anchorAfter,
  oldString: change.oldString,
  newString: change.newString,
})
if (!reversed) {
  keepMetadataOnly(change)
}
```

Tests:

- snapshot direct modify upgrades.
- snapshot create upgrades only with absent before.
- snapshot delete upgrades only with absent after.
- edit inverse upgrade from snapshot after.
- repeated `newString` stays metadata-only.
- apply_patch hunk inverse upgrade from snapshot after.
- snapshot anchor operation mismatch stays metadata-only.
- snapshot evidence for un-touched path ignored.

### Phase 8 - UI Contract And Default

Keep UI default:

```ts
const OPEN_CODE_AUTO_BACKFILL_EVIDENCE_MODE = 'chain-only' as const
```

Only change to `snapshot-auto` after production gates pass.

Optional UI field:

```ts
export interface OpenCodeBackfillTaskLedgerCommandData {
  ...
  snapshotShapeFingerprint?: string
  evidenceMode?: OpenCodeBackfillTaskLedgerEvidenceMode
}
```

Already present.

Optional diagnostics surface:

- Developer log: include outcome, mode, snapshot fingerprint, and diagnostic codes.
- UI Changes panel: do not show noisy debug by default.
- If the task has metadata-only OpenCode events, existing `MANUAL REVIEW` is enough for v1.
- Later: show compact badge `OpenCode Snapshot` or `Verified Chain`.

Do not add a confusing warning badge for normal metadata-only changes. The user needs to see files first.

### Phase 9 - Tests And Fixtures

#### Orchestrator Unit Tests

Add or extend:

```text
src/services/opencode/OpenCodeSnapshotEvidenceProvider.test.ts
src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts
src/services/opencode/OpenCodeLedgerBridgeService.test.ts
src/services/opencode/OpenCodeToolpartChangeReconstructor.test.ts
src/services/opencode/OpenCodeApplyPatchEvidenceParser.test.ts
```

Required cases:

- provider unavailable fallback.
- provider unsupported shape fallback.
- provider throws fallback.
- missing boundary fallback.
- non-terminal boundary fallback.
- workspace mismatch fallback.
- session mismatch fallback.
- touched paths required.
- snapshot direct modify upgrade.
- snapshot direct create upgrade.
- snapshot direct delete upgrade.
- snapshot path not in touched set ignored.
- inverse edit from snapshot after upgrade.
- inverse edit repeated string rejected.
- inverse apply_patch update from snapshot after upgrade.
- apply_patch update without anchor metadata-only.
- binary/large snapshot file metadata-only.
- CRLF exact preservation.
- source import key stable across evidence modes.
- source import key collision fail closed.
- case-colliding paths fail closed.

#### Orchestrator Fixture E2E

Extend:

```text
src/services/opencode/OpenCodeLedgerBridge.fixture-e2e.test.ts
```

Fixtures:

- `snapshot-supported-modify`
- `snapshot-supported-create`
- `snapshot-supported-delete`
- `snapshot-without-boundary`
- `snapshot-non-terminal-boundary`
- `snapshot-cross-task-same-session`
- `snapshot-workspace-mismatch`
- `snapshot-same-relative-path-two-worktrees`
- `snapshot-unsupported-shape`
- `snapshot-artifact-changed-mid-read`
- `inverse-edit-chain-with-snapshot`
- `apply-patch-update-with-snapshot`
- `apply-patch-delete-without-before`
- `binary-metadata-only`
- `large-metadata-only`

Assertions:

- full-text fixtures produce ledger snippets with `before` and `after`.
- fallback fixtures produce metadata-only/manual-review.
- cross-task fixture imports zero wrong events.
- idempotency still works.
- rerun after metadata-only does not duplicate a stronger snapshot event in this iteration.

#### Live E2E

Run manually/gated:

```bash
OPENCODE_LEDGER_LIVE_E2E=1 \
OPENCODE_LEDGER_SNAPSHOT_PROBE=1 \
bun test src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

Later, after production provider exists:

```bash
OPENCODE_LEDGER_LIVE_E2E=1 \
OPENCODE_LEDGER_SNAPSHOT_AUTO=1 \
bun test src/services/opencode/OpenCodeLedgerBridge.live-e2e.test.ts
```

Acceptance:

- real OpenCode run writes/edits file;
- backfill with strict delivery imports a full-text ledger event when snapshot evidence is enabled;
- backfill with chain-only remains safe and may stay metadata-only;
- no raw file content leaks in diagnostics.

#### UI Tests

Files:

```text
test/main/services/team/ChangeExtractorService.test.ts
test/main/services/team/OpenCodeBridgeCommandContract.test.ts
test/main/services/team/OpenCodeReadinessBridge.test.ts
test/main/services/team/taskChangeLedgerFixtures.integration.test.ts
```

Cases:

- UI default remains `chain-only`.
- cache key includes evidence mode.
- future `snapshot-auto` result does not reuse `chain-only` no-attribution cache.
- metadata-only remains manual-review-required.
- snapshot full-text fixture renders normal diff.
- unknown evidence metadata is ignored safely.

## Cross-Platform Requirements

Windows-specific:

- drive letter case normalization;
- mixed `\` and `/` separators;
- reserved filenames in task/member ids;
- paths with spaces and Unicode;
- CRLF preservation;
- OpenCode data dir under `%APPDATA%` or custom config home;
- case-insensitive path collision;
- no POSIX-only temp path assumptions.

Implementation rules:

- Use `path` helpers, not string separators.
- Reuse `normalizeOpenCodeFilePath`.
- Do not write tests that assume `/tmp`.
- Do not use shell commands for production provider.
- Do not rely on symlink behavior being the same across platforms.

CI gates:

```bash
bun test src/services/opencode/OpenCodeBridgePath.test.ts
bun test src/services/opencode/OpenCodeSnapshotEvidenceProvider.test.ts
```

Add a Windows job later for fixture/unit tests. Live OpenCode smoke can remain opt-in until credentials are available.

## Performance Requirements

Hard limits:

- no workspace recursive scan;
- max candidate files per backfill: existing caps, do not widen without reason;
- max full text blob size: same as task ledger cap;
- max patch/debug artifact read: bounded;
- max snapshot files inspected: touched paths only;
- one bounded retry for source changes;
- no long polling from UI Changes panel.

Fallback on cap:

```text
metadata-only/manual-review for affected file
continue other files
```

Do not fail the whole Changes panel because one file is large.

## Diagnostics Policy

Allowed diagnostics:

- diagnostic code;
- session id;
- member/lane;
- normalized relative path;
- file size;
- content hash;
- adapter version;
- OpenCode version;
- shape fingerprint.

Forbidden diagnostics:

- raw file content;
- raw patch body;
- raw prompt;
- environment variables;
- provider auth tokens;
- full absolute paths in UI-facing diagnostic unless already visible as workspace path.

Recommended diagnostic codes:

```text
snapshot-provider-unavailable
snapshot-boundary-unavailable
snapshot-boundary-not-terminal
snapshot-workspace-mismatch
snapshot-session-mismatch
unsupported-opencode-snapshot-shape
snapshot-artifact-changed
snapshot-file-large
snapshot-file-binary
snapshot-path-outside-workspace
snapshot-case-collision
inverse-edit-ambiguous
apply-patch-ambiguous
```

## Failure Matrix

| Failure | Behavior |
| --- | --- |
| No delivery context | `no-attribution`, no broad scan |
| Delivery context exists but no matching session | `no-attribution` |
| Snapshot boundary missing | chain/metadata fallback |
| Snapshot boundary non-terminal | chain/metadata fallback |
| Snapshot provider unavailable | diagnostic + chain/metadata fallback |
| Unsupported snapshot shape | diagnostic + chain/metadata fallback |
| Snapshot artifact changes mid-read | discard snapshot evidence, fallback |
| One file too large | metadata-only for that file |
| One file binary | metadata-only for that file |
| Path outside workspace | skip file with diagnostic |
| Source import key collision | skip unsafe candidates |
| Enricher throws | original reconstructed changes |
| Blob write fails | downgrade/skip that file, do not append broken full-text event |
| Journal append succeeds but bundle rebuild fails | existing ledger rebuild path recovers |

## Rollout Plan

### Milestone A - Current Safe Work Ready

Already mostly done.

Ship criteria:

- targeted OpenCode tests pass;
- task ledger regressions pass;
- UI command contract tests pass;
- build/typecheck pass;
- live snapshot probe remains gated/skipped unless env flags are present.

This milestone improves visibility but not all Cursor-like diffs.

### Milestone B - Snapshot Boundary Capture

Add delivery ledger snapshot boundary fields and no-op capture port.

Ship criteria:

- no user-visible behavior change;
- delivery ledger remains backward compatible;
- records are content-free;
- strict delivery attribution still works with old records.

### Milestone C - Live Snapshot Proof

Run gated live probe with installed OpenCode.

Ship criteria:

- `track` returns stable hash after real file-changing run;
- snapshot artifacts can be identified without debug CLI in normal path;
- if not proven, stop and keep `chain-only`.

### Milestone D - Production Snapshot Provider Disabled By Default

Implement provider and fixtures.

Ship criteria:

- provider is wired only when `snapshot-auto` mode is explicitly selected;
- unsupported shape fallback works;
- fixture matrix passes;
- no non-OpenCode tests regress.

### Milestone E - Dev Snapshot-Auto Trial

Enable `snapshot-auto` only in dev/test or behind explicit env/config.

Ship criteria:

- real OpenCode live E2E imports a full-text diff;
- chain-only fallback still works;
- UI cache key separates modes;
- no production default change.

### Milestone F - Production Default Decision

Only after enough real data:

Options:

1. Keep UI default `chain-only` and expose opt-in snapshot evidence - 🎯 9   🛡️ 9.4   🧠 4 - ~150-300 LOC.
2. Enable `snapshot-auto` for new OpenCode sessions only - 🎯 8.4   🛡️ 8.6   🧠 5.5 - ~250-500 LOC.
3. Enable `snapshot-auto` globally for all OpenCode teams - 🎯 5.8   🛡️ 5.5   🧠 4.5 - ~150-300 LOC.

Recommended: option 2 after live/fixture evidence, not before.

## Concrete Next Coding Tasks

### Task 1 - Add Snapshot Boundary Types To Delivery Records

Files:

```text
src/services/opencode/types.ts
src/services/opencode/OpenCodePromptDeliveryLedger.ts
src/services/opencode/OpenCodeToolpartChangeReconstructor.test.ts
```

Add optional field:

```ts
snapshotBoundary?: OpenCodeSnapshotBoundary
```

Validation:

```ts
function isOpenCodeSnapshotBoundary(value: unknown): value is OpenCodeSnapshotBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === 1 &&
    typeof record.captureStatus === 'string'
}
```

Do not require it for old records.

### Task 2 - Add No-Op Boundary Capture Port

Files:

```text
src/services/opencode/OpenCodeSnapshotBoundaryCapture.ts
src/services/opencode/OpenCodeBridgeCommandHandler.ts
```

Code:

```ts
export const noopOpenCodeSnapshotBoundaryCapture: OpenCodeSnapshotBoundaryCapturePort = {
  async capture() {
    return {
      status: 'snapshot-disabled',
      diagnostics: ['OpenCode snapshot boundary capture is disabled.'],
    }
  },
}
```

Wire into handler constructor/module scope, but keep disabled.

### Task 3 - Persist Boundary In Send/Observe

Files:

```text
src/services/opencode/OpenCodeBridgeCommandHandler.ts
src/services/opencode/OpenCodeBridgeCommandHandler.test.ts
```

Cases:

- send accepted, delivery terminal -> captured status if both sides captured;
- send accepted, delivery pending -> not-terminal;
- observe later terminal -> updates post boundary;
- capture error -> delivery still accepted with diagnostics.

### Task 4 - Implement Provider Skeleton

Files:

```text
src/services/opencode/OpenCodeSnapshotEvidenceProvider.ts
src/services/opencode/OpenCodeSnapshotEvidenceProvider.test.ts
```

Initial provider can return unsupported unless a supported shape detector is present.

This is useful because it locks the contract before real artifact parsing.

### Task 5 - Strengthen Enricher Tests

Files:

```text
src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts
```

Add mock provider fixtures for:

- direct modify;
- direct create;
- direct delete;
- unsupported provider;
- provider throws;
- workspace mismatch boundary;
- ambiguous inverse edit;
- apply_patch inverse with anchor.

### Task 6 - UI Mode Wiring Later

Keep this delayed.

Files:

```text
src/main/services/team/ChangeExtractorService.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
```

Only when ready:

```ts
const OPEN_CODE_AUTO_BACKFILL_EVIDENCE_MODE =
  process.env.CLAUDE_TEAM_OPENCODE_EVIDENCE_MODE === 'snapshot-auto'
    ? 'snapshot-auto'
    : 'chain-only'
```

Do not hardcode `snapshot-auto` as default until Milestone F.

## Verification Commands

Orchestrator targeted:

```bash
bun test \
  src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts \
  src/services/opencode/OpenCodeChangeEvidenceEnricher.test.ts \
  src/services/opencode/OpenCodeLedgerBridgeService.test.ts \
  src/services/opencode/OpenCodeToolpartChangeReconstructor.test.ts \
  src/services/opencode/OpenCodeApplyPatchEvidenceParser.test.ts
```

Orchestrator ledger regression:

```bash
bun test \
  src/services/taskChangeLedger/TaskChangeLedgerService.test.ts \
  src/services/taskChangeLedger/GitChangePathProvider.test.ts \
  src/services/taskChangeLedger/TaskChangeWriterLock.test.ts
```

Orchestrator build:

```bash
bun run build:dev
git diff --check
```

UI targeted:

```bash
pnpm exec vitest run \
  test/main/services/team/ChangeExtractorService.test.ts \
  test/main/services/team/OpenCodeReadinessBridge.test.ts \
  test/main/services/team/OpenCodeBridgeCommandContract.test.ts \
  test/main/services/team/taskChangeLedgerFixtures.integration.test.ts
```

UI build:

```bash
pnpm typecheck
git diff --check
```

Gated live snapshot:

```bash
OPENCODE_LEDGER_LIVE_E2E=1 \
OPENCODE_LEDGER_SNAPSHOT_PROBE=1 \
bun test src/services/opencode/OpenCodeSnapshotEvidence.live-e2e.test.ts
```

## Readiness Bar

Ready for production default `chain-only`:

- current safe layer tests pass;
- UI default remains `chain-only`;
- no snapshot provider required;
- metadata-only/manual review works for OpenCode changes;
- no regressions for other agents.

Ready for dev-only `snapshot-auto`:

- live probe passes locally;
- provider fixture matrix passes;
- boundary capture is persisted;
- provider returns full text only for proven boundary/touched files;
- unsupported shape fallback works.

Ready for production `snapshot-auto` for new sessions:

- live smoke passes on at least one stable CI/dev environment;
- Windows path fixture tests pass;
- snapshot config mode recorded per session;
- no old-session regressions;
- performance caps verified;
- clear kill switch exists;
- no raw content in diagnostics.

Not ready:

- if snapshot evidence depends on shelling out to debug CLI in UI path;
- if snapshot diff cannot be tied to task delivery boundary;
- if unsupported shape can silently produce empty changes;
- if current disk is used as historical after-state;
- if metadata-only events unlock reject/accept.

## What To Do Next

Recommended immediate sequence:

1. Finish and commit the current safe `chain-only` work if not committed yet.
2. Run the gated live snapshot probe on the current machine and save only fingerprints/diagnostics, not raw content.
3. Add snapshot boundary types and a no-op capture port.
4. Add tests that old delivery records without boundary still work.
5. Implement a production provider skeleton that always returns unsupported unless the shape detector is proven.
6. Add fixture tests around the provider contract before parsing real snapshot artifacts.
7. Only then implement the real snapshot artifact reader for the proven OpenCode shape.

This sequence keeps the bridge reliable at every intermediate commit.

## Final Recommendation

Do not try to solve all OpenCode diffs at once.

Ship the safe chain/metadata layer first. Then build snapshot support as a gated evidence provider with delivery boundaries. The provider can be turned on only when it proves exact file state and exact task attribution. Until then, `chain-only` is the correct production default because it is already useful and it does not create fake diffs.

