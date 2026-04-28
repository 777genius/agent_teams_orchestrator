import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  importTaskChangeLedgerEvents,
  type ImportedOpenCodeFileChange,
} from '../taskChangeLedger/TaskChangeLedgerService.js'
import { areSameOpenCodeWorkspace } from './OpenCodeBridgePath.js'
import {
  DEFAULT_OPENCODE_EVIDENCE_PIPELINE_MODE,
  type OpenCodeEvidencePipelineMode,
  type OpenCodeSnapshotBoundary,
  type OpenCodeSnapshotCaptureStatus,
  type OpenCodeSnapshotEvidenceProvider,
} from './OpenCodeChangeEvidence.js'
import { OpenCodeChangeEvidenceEnricher } from './OpenCodeChangeEvidenceEnricher.js'
import { openCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeSnapshotEvidenceProviderService } from './OpenCodeSnapshotEvidenceProvider.js'
import {
  OpenCodeToolpartChangeReconstructor,
  type OpenCodeDeliveryContextV1,
  type OpenCodeLedgerAttributionMode,
  type OpenCodeTaskRef,
  type ReconstructedOpenCodeToolChange,
} from './OpenCodeToolpartChangeReconstructor.js'

import type { OpenCodeSessionRecord } from './types.js'

export type OpenCodeLedgerBackfillOutcome =
  | 'imported'
  | 'duplicates-only'
  | 'no-history'
  | 'no-attribution'
  | 'manual-only'
  | 'skipped-capability'
  | 'transient-error'
  | 'unsafe-input'

export type OpenCodeLedgerBridgeBackfillResult = {
  schemaVersion: 1
  providerId: 'opencode'
  opencodeTaskLedgerEvidenceContractVersion: number
  teamName: string
  taskId?: string
  projectDir?: string
  workspaceRoot?: string
  dryRun: boolean
  attributionMode: OpenCodeLedgerAttributionMode
  evidenceMode: OpenCodeEvidencePipelineMode
  scannedSessions: number
  scannedToolparts: number
  strictWindowCandidateCount?: number
  openCodeDbFingerprint?: string
  deliveryLedgerFingerprint?: string
  snapshotShapeFingerprint?: string
  retryAfterReason?: string
  candidateEvents: number
  importedEvents: number
  skippedEvents: number
  outcome: OpenCodeLedgerBackfillOutcome
  notices: Array<{ severity: 'warning'; message: string; code: string }>
  diagnostics: string[]
}

type BackfillParams = {
  teamId?: string
  teamName: string
  taskId?: string
  taskDisplayId?: string
  memberName?: string
  laneId?: string
  projectDir?: string
  workspaceRoot?: string
  deliveryContextPath?: string
  deliveryContextHash?: string
  attributionMode?: OpenCodeLedgerAttributionMode
  evidenceMode?: unknown
  dryRun?: boolean
}

type SessionStorePort = Pick<typeof openCodeSessionStore, 'list'>

const MAX_SCANNED_RECORDS = 50
const MAX_METADATA_TEXT_BLOB_BYTES = 1024 * 1024
const DELIVERY_CONTEXT_FILE_NAME = 'delivery-context.json'
const DELIVERY_CONTEXT_TEMP_PREFIX = 'claude-team-opencode-ledger-context-'
export const OPENCODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION = 1

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asBoundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    return undefined
  }
  return value
}

function asSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function asSnapshotCaptureStatus(value: unknown): OpenCodeSnapshotCaptureStatus | undefined {
  return value === 'captured' ||
    value === 'pending' ||
    value === 'snapshot-disabled' ||
    value === 'unsupported-shape' ||
    value === 'capture-failed' ||
    value === 'not-terminal' ||
    value === 'not-configured'
    ? value
    : undefined
}

function normalizeSnapshotBoundary(value: unknown): OpenCodeSnapshotBoundary | null {
  const record = asRecord(value)
  const captureStatus = asSnapshotCaptureStatus(record?.captureStatus)
  if (!record || record.schemaVersion !== 1 || !captureStatus) {
    return null
  }
  const rawDiagnostics = Array.isArray(record.diagnostics) ? record.diagnostics : []
  return {
    schemaVersion: 1,
    captureStatus,
    ...(asBoundedString(record.preDeliverySnapshotHash, 256)
      ? { preDeliverySnapshotHash: asBoundedString(record.preDeliverySnapshotHash, 256) }
      : {}),
    ...(asBoundedString(record.postDeliverySnapshotHash, 256)
      ? { postDeliverySnapshotHash: asBoundedString(record.postDeliverySnapshotHash, 256) }
      : {}),
    ...(asSafeInteger(record.snapshotAdapterVersion) !== undefined
      ? { snapshotAdapterVersion: asSafeInteger(record.snapshotAdapterVersion) }
      : {}),
    ...(asBoundedString(record.opencodeVersion, 128)
      ? { opencodeVersion: asBoundedString(record.opencodeVersion, 128) }
      : {}),
    diagnostics: rawDiagnostics
      .map(item => asBoundedString(item, 512))
      .filter((item): item is string => !!item)
      .slice(0, 20),
  }
}

function isTaskRef(value: unknown): value is OpenCodeTaskRef {
  const record = asRecord(value)
  return (
    typeof record?.taskId === 'string' &&
    record.taskId.length > 0 &&
    typeof record.teamName === 'string' &&
    record.teamName.length > 0 &&
    (record.displayId === undefined || typeof record.displayId === 'string')
  )
}

function normalizeDeliveryContext(value: unknown): OpenCodeDeliveryContextV1 | null {
  const record = asRecord(value)
  if (record?.schemaVersion !== 1 || typeof record.teamName !== 'string' || !Array.isArray(record.records)) {
    return null
  }
  const records: OpenCodeDeliveryContextV1['records'] = []
  for (const item of record.records) {
    const itemRecord = asRecord(item)
    if (!itemRecord || typeof itemRecord.memberName !== 'string' || !Array.isArray(itemRecord.taskRefs)) {
      continue
    }
    const taskRefs = itemRecord.taskRefs.filter(isTaskRef)
    if (taskRefs.length === 0) {
      continue
    }
    records.push({
      memberName: itemRecord.memberName,
      ...(asString(itemRecord.laneId) ? { laneId: asString(itemRecord.laneId) } : {}),
      runtimeSessionId: asString(itemRecord.runtimeSessionId) ?? null,
      inboxMessageId: asString(itemRecord.inboxMessageId) ?? null,
      deliveredUserMessageId: asString(itemRecord.deliveredUserMessageId) ?? null,
      observedAssistantMessageId: asString(itemRecord.observedAssistantMessageId) ?? null,
      prePromptCursor: asString(itemRecord.prePromptCursor) ?? null,
      postPromptCursor: asString(itemRecord.postPromptCursor) ?? null,
      snapshotBoundary: normalizeSnapshotBoundary(itemRecord.snapshotBoundary),
      taskRefs,
    })
  }
  return {
    schemaVersion: 1,
    teamName: record.teamName,
    ...(asString(record.taskId) ? { taskId: asString(record.taskId) } : {}),
    records,
  }
}

function groupByTask(changes: ReconstructedOpenCodeToolChange[]): Map<string, ReconstructedOpenCodeToolChange[]> {
  const grouped = new Map<string, ReconstructedOpenCodeToolChange[]>()
  for (const change of changes) {
    const bucket = grouped.get(change.taskId) ?? []
    bucket.push(change)
    grouped.set(change.taskId, bucket)
  }
  return grouped
}

function toLedgerChange(change: ReconstructedOpenCodeToolChange): ImportedOpenCodeFileChange {
  return {
    filePath: change.filePath,
    beforeContent: change.beforeContent,
    afterContent: change.afterContent,
    source: change.sourceTool === 'write'
      ? 'opencode_toolpart_write'
      : change.sourceTool === 'edit'
        ? 'opencode_toolpart_edit'
        : 'opencode_toolpart_apply_patch',
    confidence: change.confidence,
    operation: change.operation,
    beforeState: change.beforeState,
    afterState: change.afterState,
    oldString: change.oldString,
    newString: change.newString,
    warnings: change.warnings,
    evidenceProof: change.evidenceProof,
    evidenceDiagnostics: change.evidenceDiagnostics,
    snapshotId: change.snapshotId,
    snapshotSource: change.snapshotSource,
    toolUseId: change.toolUseId,
    timestamp: change.timestamp,
    sourceImportKey: change.sourceImportKey,
    sourceRuntime: 'opencode',
    sourceSessionId: change.sessionId,
    sourcePartId: change.sourcePartId,
    sourceMessageId: change.sourceMessageId,
    parentUserMessageId: change.parentUserMessageId,
    attributionMethod: change.attributionMethod,
  }
}

function sha256Buffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function sha256String(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function isSha256Hex(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function isSameOrDescendantPath(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function sqliteFingerprintToString(fingerprint: {
  dbMtimeMs: number
  dbSizeBytes: number
  walMtimeMs?: number
  walSizeBytes?: number
}): string {
  return [
    fingerprint.dbMtimeMs,
    fingerprint.dbSizeBytes,
    fingerprint.walMtimeMs ?? 0,
    fingerprint.walSizeBytes ?? 0,
  ].join(':')
}

function looksBinary(content: Buffer): boolean {
  return content.includes(0)
}

function isValidUtf8RoundTrip(content: Buffer, text: string): boolean {
  return Buffer.compare(Buffer.from(text, 'utf8'), content) === 0
}

async function readMetadataOnlyDiskState(filePath: string): Promise<{
  afterState: NonNullable<ImportedOpenCodeFileChange['afterState']>
  warning?: string
}> {
  try {
    const fileStat = await lstat(filePath)
    if (fileStat.isSymbolicLink()) {
      return {
        afterState: {
          exists: true,
          unavailableReason: 'opencode-path-symlink-unresolved',
        },
        warning: 'OpenCode metadata-only capture found a symlink path; review is manual-only.',
      }
    }
    if (!fileStat.isFile()) {
      return {
        afterState: {
          exists: true,
          unavailableReason: 'opencode-after-path-not-regular-file',
        },
        warning: 'OpenCode metadata-only capture found a non-file path on disk; review is manual-only.',
      }
    }
    if (fileStat.size > MAX_METADATA_TEXT_BLOB_BYTES) {
      return {
        afterState: {
          exists: true,
          sizeBytes: fileStat.size,
          unavailableReason: 'opencode-after-content-too-large',
        },
        warning: 'OpenCode metadata-only capture skipped large final content; review is manual-only.',
      }
    }
    const content = await readFile(filePath)
    const sha256 = sha256Buffer(content)
    if (looksBinary(content)) {
      return {
        afterState: {
          exists: true,
          sha256,
          sizeBytes: content.byteLength,
          unavailableReason: 'opencode-after-content-binary',
        },
        warning: 'OpenCode metadata-only capture found binary final content; review is manual-only.',
      }
    }
    const text = content.toString('utf8')
    if (!isValidUtf8RoundTrip(content, text)) {
      return {
        afterState: {
          exists: true,
          sha256,
          sizeBytes: content.byteLength,
          unavailableReason: 'opencode-after-content-non-utf8',
        },
        warning: 'OpenCode metadata-only capture found non-UTF-8 final content; review is manual-only.',
      }
    }
    return {
      afterState: {
        exists: true,
        sha256,
        sizeBytes: content.byteLength,
      },
    }
  } catch (error) {
    const code = asRecord(error)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        afterState: { exists: false },
      }
    }
    return {
      afterState: {
        exists: true,
        unavailableReason: 'opencode-after-content-read-error',
      },
      warning: `OpenCode metadata-only capture could not read final disk content - ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function materializeMetadataOnlyChanges(
  changes: ReconstructedOpenCodeToolChange[],
  diagnostics: string[],
): Promise<ReconstructedOpenCodeToolChange[]> {
  const materialized: ReconstructedOpenCodeToolChange[] = []
  for (const change of changes) {
    const beforeUnavailable = change.beforeContent === null && !!change.beforeState?.unavailableReason
    const afterUnavailable = change.afterContent === null && !!change.afterState?.unavailableReason
    if (!beforeUnavailable || !afterUnavailable) {
      materialized.push(change)
      continue
    }
    const diskState = await readMetadataOnlyDiskState(change.filePath)
    diagnostics.push(
      `OpenCode metadata-only final disk state materialized for ${change.relativePath}.`,
    )
    const operation =
      change.sourceTool === 'apply_patch' &&
      change.operation === 'delete' &&
      diskState.afterState.exists !== false
        ? 'modify'
        : change.operation
    materialized.push({
      ...change,
      operation,
      afterContent: null,
      afterState: diskState.afterState,
      warnings: [
        ...(change.warnings ?? []),
        ...(operation !== change.operation
          ? ['OpenCode apply_patch requested a delete, but the final disk state still exists; ledger records this as manual-only modify evidence.']
          : []),
        ...(diskState.warning ? [diskState.warning] : []),
      ],
    })
  }
  return materialized
}

function dedupeRecords(records: OpenCodeSessionRecord[]): OpenCodeSessionRecord[] {
  const seen = new Set<string>()
  const result: OpenCodeSessionRecord[] = []
  for (const record of records) {
    const key = [
      record.profileRootKey,
      record.opencodeSessionId,
      record.laneId ?? 'primary',
      record.memberName,
    ].join('\0')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(record)
  }
  return result
}

type StrictDeliveryRecord = OpenCodeDeliveryContextV1['records'][number]

function normalizeAttributionMode(value: OpenCodeLedgerAttributionMode | undefined): OpenCodeLedgerAttributionMode {
  return value === 'strict-delivery' ? 'strict-delivery' : 'compatible'
}

function collectStrictDeliveryRecords(
  deliveryContext: OpenCodeDeliveryContextV1 | null,
  params: BackfillParams,
): StrictDeliveryRecord[] {
  if (!deliveryContext || deliveryContext.teamName !== params.teamName || !params.taskId) {
    return []
  }
  const records: StrictDeliveryRecord[] = []
  for (const record of deliveryContext.records) {
    if (params.memberName && record.memberName !== params.memberName) {
      continue
    }
    if (params.laneId && record.laneId !== params.laneId) {
      continue
    }
    if (!record.laneId) {
      continue
    }
    if (!record.deliveredUserMessageId && !record.inboxMessageId) {
      continue
    }
    const teamRefs = record.taskRefs.filter(ref => ref.teamName === params.teamName)
    if (teamRefs.length !== 1 || teamRefs[0]?.taskId !== params.taskId) {
      continue
    }
    records.push(record)
  }
  return records
}

function matchesStrictDeliveryRecord(
  record: OpenCodeSessionRecord,
  deliveryRecords: StrictDeliveryRecord[],
  allRecords: OpenCodeSessionRecord[],
): boolean {
  return deliveryRecords.some(deliveryRecord =>
    deliveryRecord.memberName === record.memberName &&
    deliveryRecord.laneId === record.laneId &&
    (
      deliveryRecord.runtimeSessionId
        ? deliveryRecord.runtimeSessionId === record.opencodeSessionId
        : allRecords.filter(candidate =>
          candidate.memberName === record.memberName &&
          candidate.laneId === record.laneId
        ).length === 1
    )
  )
}

function validateCandidateBatch(
  changes: ReconstructedOpenCodeToolChange[],
  diagnostics: string[],
): ReconstructedOpenCodeToolChange[] {
  const sourceKeyIdentities = new Map<string, string>()
  const unsafeSourceKeys = new Set<string>()
  const lowerPathIdentities = new Map<string, string>()
  const unsafeLowerPathKeys = new Set<string>()

  for (const change of changes) {
    const identity = [
      change.sessionId,
      change.sourcePartId,
      change.sourceTool,
      change.filePath,
    ].join('\0')
    const existingIdentity = sourceKeyIdentities.get(change.sourceImportKey)
    if (existingIdentity && existingIdentity !== identity) {
      unsafeSourceKeys.add(change.sourceImportKey)
    } else {
      sourceKeyIdentities.set(change.sourceImportKey, identity)
    }

    const lowerPathKey = [
      change.sessionId,
      change.relativePath.toLowerCase(),
    ].join('\0')
    const existingRelativePath = lowerPathIdentities.get(lowerPathKey)
    if (existingRelativePath && existingRelativePath !== change.relativePath) {
      unsafeLowerPathKeys.add(lowerPathKey)
    } else {
      lowerPathIdentities.set(lowerPathKey, change.relativePath)
    }
  }

  if (unsafeSourceKeys.size > 0) {
    diagnostics.push(`OpenCode evidence skipped ${unsafeSourceKeys.size} sourceImportKey collision(s).`)
  }
  if (unsafeLowerPathKeys.size > 0) {
    diagnostics.push(`OpenCode evidence skipped ${unsafeLowerPathKeys.size} case-colliding path group(s).`)
  }

  return changes.filter(change => {
    const lowerPathKey = [
      change.sessionId,
      change.relativePath.toLowerCase(),
    ].join('\0')
    return !unsafeSourceKeys.has(change.sourceImportKey) && !unsafeLowerPathKeys.has(lowerPathKey)
  })
}

export class OpenCodeLedgerBridgeService {
  constructor(
    private readonly sessionStore: SessionStorePort = openCodeSessionStore,
    private readonly offlineReader = openCodeOfflineSessionReader,
    private readonly reconstructor = new OpenCodeToolpartChangeReconstructor(),
    private readonly evidenceEnricher = new OpenCodeChangeEvidenceEnricher(),
    private readonly snapshotEvidenceProvider?: OpenCodeSnapshotEvidenceProvider,
  ) {}

  async backfill(params: BackfillParams): Promise<OpenCodeLedgerBridgeBackfillResult> {
    const attributionMode = normalizeAttributionMode(params.attributionMode)
    const evidenceMode = DEFAULT_OPENCODE_EVIDENCE_PIPELINE_MODE
    const result: OpenCodeLedgerBridgeBackfillResult = {
      schemaVersion: 1,
      providerId: 'opencode',
      opencodeTaskLedgerEvidenceContractVersion: OPENCODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
      teamName: params.teamName,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.projectDir ? { projectDir: params.projectDir } : {}),
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
      dryRun: params.dryRun === true,
      attributionMode,
      evidenceMode,
      scannedSessions: 0,
      scannedToolparts: 0,
      candidateEvents: 0,
      importedEvents: 0,
      skippedEvents: 0,
      outcome: 'no-history',
      notices: [],
      diagnostics: [],
    }

    if (params.teamId && params.teamId !== params.teamName) {
      return {
        ...result,
        outcome: 'unsafe-input',
        diagnostics: ['OpenCode ledger backfill rejected mismatched teamId/teamName.'],
      }
    }
    if (params.projectDir && !path.isAbsolute(params.projectDir)) {
      return {
        ...result,
        outcome: 'unsafe-input',
        diagnostics: ['OpenCode ledger backfill rejected relative projectDir.'],
      }
    }
    if (params.workspaceRoot && !path.isAbsolute(params.workspaceRoot)) {
      return {
        ...result,
        outcome: 'unsafe-input',
        diagnostics: ['OpenCode ledger backfill rejected relative workspaceRoot.'],
      }
    }

    const deliveryContextRead = await this.readOptionalDeliveryContext(
      params.deliveryContextPath,
      params.deliveryContextHash,
      result.diagnostics,
    )
    const deliveryContext = deliveryContextRead.context
    result.deliveryLedgerFingerprint = deliveryContextRead.fingerprint
    let strictDeliveryRecords: StrictDeliveryRecord[] = []
    if (attributionMode === 'strict-delivery') {
      if (!params.taskId) {
        return {
          ...result,
          outcome: 'no-attribution',
          diagnostics: [
            ...result.diagnostics,
            'OpenCode strict delivery attribution requires taskId.',
          ],
        }
      }
      if (!deliveryContext) {
        return {
          ...result,
          outcome: 'no-attribution',
          diagnostics: [
            ...result.diagnostics,
            'OpenCode strict delivery attribution requires delivery context.',
          ],
        }
      }
      strictDeliveryRecords = collectStrictDeliveryRecords(deliveryContext, params)
      if (strictDeliveryRecords.length === 0) {
        return {
          ...result,
          outcome: 'no-attribution',
          diagnostics: [
            ...result.diagnostics,
            'OpenCode strict delivery attribution found no usable delivery records for this task.',
          ],
        }
      }
    }

    let records = dedupeRecords((await this.sessionStore.list()).filter(record => {
      if (record.providerId !== 'opencode') {
        return false
      }
      if (record.teamId !== params.teamName && record.teamId !== params.teamId) {
        return false
      }
      if (params.memberName && record.memberName !== params.memberName) {
        return false
      }
      if (params.laneId && (record.laneId ?? 'primary') !== params.laneId) {
        return false
      }
      return true
    }))
    if (attributionMode === 'strict-delivery') {
      records = records.filter(record => matchesStrictDeliveryRecord(record, strictDeliveryRecords, records))
      if (records.length === 0) {
        return {
          ...result,
          outcome: 'no-attribution',
          diagnostics: [
            ...result.diagnostics,
            'OpenCode strict delivery attribution found no stored OpenCode session matching the delivery context.',
          ],
        }
      }
    }

    if (records.length > MAX_SCANNED_RECORDS) {
      return {
        ...result,
        outcome: 'unsafe-input',
        diagnostics: [`OpenCode ledger backfill matched ${records.length} records; narrow member/lane filters are required.`],
      }
    }
    if (records.length === 0) {
      return result
    }

    const importBatchId = `opencode-ledger-backfill-${randomUUID()}`
    for (const record of records) {
      const workspaceRoot = await this.resolveWorkspaceRoot(record, params)
      if (!workspaceRoot) {
        result.outcome = 'unsafe-input'
        result.skippedEvents += 1
        result.diagnostics.push(`OpenCode ledger backfill skipped ${record.memberName}/${record.opencodeSessionId} because workspace identity was not trusted.`)
        continue
      }

      const offline = await this.offlineReader.readSession(record)
      if (!offline) {
        result.diagnostics.push(`No OpenCode SQLite history for ${record.memberName}/${record.opencodeSessionId}.`)
        continue
      }
      result.openCodeDbFingerprint ??= sqliteFingerprintToString(offline.dbFingerprint)
      if (offline.historyShape === 'unsupported') {
        result.outcome = 'skipped-capability'
        result.diagnostics.push(...offline.diagnostics)
        continue
      }
      result.scannedSessions += 1
      result.scannedToolparts += offline.rawParts.length
      result.diagnostics.push(...offline.diagnostics)

      const reconstructed = this.reconstructor.reconstruct({
        teamName: params.teamName,
        memberName: record.memberName,
        sessionId: record.opencodeSessionId,
        projectPath: record.projectPath,
        requestedTask: params.taskId
          ? { taskId: params.taskId, displayId: params.taskDisplayId, teamName: params.teamName }
          : undefined,
        deliveryContext,
        attributionMode,
        laneId: record.laneId,
        rawMessages: offline.rawMessages,
        rawParts: offline.rawParts,
      })
      result.diagnostics.push(...reconstructed.diagnostics)
      result.notices.push(...reconstructed.notices)
      const evidenceMetadata: { snapshotShapeFingerprint?: string } = {}
      const canTrySessionSnapshotEvidence =
        attributionMode === 'strict-delivery' &&
        reconstructed.changes.length > 0
      const enrichedChanges = await this.evidenceEnricher.enrich({
        changes: reconstructed.changes,
        workspaceRoot,
        sessionRecord: record,
        offline,
        snapshotProvider: canTrySessionSnapshotEvidence ? this.snapshotEvidenceProvider : undefined,
        evidenceMetadata,
        diagnostics: result.diagnostics,
      }).catch(error => {
        result.diagnostics.push(`OpenCode evidence enrichment failed; using metadata-only fallback - ${error instanceof Error ? error.message : String(error)}`)
        return reconstructed.changes
      })
      result.snapshotShapeFingerprint ??= evidenceMetadata.snapshotShapeFingerprint
      const materializedChanges = await materializeMetadataOnlyChanges(
        enrichedChanges,
        result.diagnostics,
      )
      if (materializedChanges.length === 0) {
        continue
      }

      for (const [taskId, changes] of groupByTask(materializedChanges)) {
        if (params.taskId && taskId !== params.taskId) {
          continue
        }
        result.candidateEvents += changes.length
        if (attributionMode === 'strict-delivery') {
          result.strictWindowCandidateCount = (result.strictWindowCandidateCount ?? 0) + changes.length
        }
        const safeChanges = validateCandidateBatch(changes, result.diagnostics)
        const skippedUnsafeBeforeImport = changes.length - safeChanges.length
        result.skippedEvents += skippedUnsafeBeforeImport
        if (skippedUnsafeBeforeImport > 0) {
          result.outcome = 'unsafe-input'
        }
        if (params.dryRun === true) {
          continue
        }
        if (safeChanges.length === 0) {
          continue
        }
        const imported = await importTaskChangeLedgerEvents({
          projectDir: params.projectDir,
          scope: {
            taskId,
            task: { ref: taskId, refKind: 'canonical' },
            phase: 'work',
            executionSeq: 0,
          },
          sessionId: record.opencodeSessionId,
          memberName: record.memberName,
          workspaceRoot,
          toolStatus: 'succeeded',
          changes: safeChanges.map(change => ({
            ...toLedgerChange(change),
            importBatchId,
          })),
        })
        result.importedEvents += imported.importedEventCount
        result.skippedEvents += imported.skippedDuplicateCount + imported.skippedUnsafeCount
        if (imported.skippedUnsafeCount > 0) {
          result.outcome = 'unsafe-input'
        }
        result.diagnostics.push(...imported.diagnostics)
      }
    }

    result.outcome = this.resolveOutcome(result)
    if (result.outcome === 'transient-error' && !result.retryAfterReason) {
      result.retryAfterReason = this.resolveRetryAfterReason(result.diagnostics)
    }
    return result
  }

  private resolveOutcome(result: OpenCodeLedgerBridgeBackfillResult): OpenCodeLedgerBackfillOutcome {
    if (result.importedEvents > 0) {
      return 'imported'
    }
    if (result.dryRun && result.candidateEvents > 0) {
      return 'manual-only'
    }
    if (result.outcome === 'unsafe-input' || result.outcome === 'skipped-capability' || result.outcome === 'transient-error') {
      return result.outcome
    }
    if (result.candidateEvents === 0 && this.hasRetryableOpenCodeReadDiagnostic(result.diagnostics)) {
      return 'transient-error'
    }
    if (result.candidateEvents > 0 && result.skippedEvents > 0) {
      return 'duplicates-only'
    }
    if (result.scannedSessions === 0) {
      return result.outcome === 'unsafe-input' ? 'unsafe-input' : 'no-history'
    }
    if (result.candidateEvents === 0) {
      return 'no-attribution'
    }
    return result.outcome === 'unsafe-input' ? 'unsafe-input' : 'no-attribution'
  }

  private hasRetryableOpenCodeReadDiagnostic(diagnostics: string[]): boolean {
    return diagnostics.some(diagnostic =>
      diagnostic.includes('OpenCode SQLite file changed while snapshot was read') ||
      diagnostic.includes('OpenCode SQLite message cap exceeded') ||
      diagnostic.includes('OpenCode SQLite part cap exceeded') ||
      diagnostic.includes('sqlite-busy:') ||
      /database is (?:locked|busy)/i.test(diagnostic)
    )
  }

  private resolveRetryAfterReason(diagnostics: string[]): string {
    if (diagnostics.some(diagnostic => diagnostic.includes('sqlite-busy:') || /database is (?:locked|busy)/i.test(diagnostic))) {
      return 'sqlite-busy'
    }
    if (diagnostics.some(diagnostic => diagnostic.includes('OpenCode SQLite file changed while snapshot was read'))) {
      return 'sqlite-changed-during-read'
    }
    if (diagnostics.some(diagnostic => diagnostic.includes('OpenCode SQLite message cap exceeded') || diagnostic.includes('OpenCode SQLite part cap exceeded'))) {
      return 'sqlite-history-cap-exceeded'
    }
    return 'opencode-read-transient'
  }

  private async resolveWorkspaceRoot(
    record: OpenCodeSessionRecord,
    params: BackfillParams,
  ): Promise<string | null> {
    const workspaceRoot = params.workspaceRoot ?? record.projectPath
    if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(record.projectPath)) {
      return null
    }
    if (params.workspaceRoot && !areSameOpenCodeWorkspace({
      expectedWorkspaceRoot: params.workspaceRoot,
      recordProjectPath: record.projectPath,
    })) {
      return null
    }
    if (params.dryRun === true) {
      return workspaceRoot
    }
    try {
      const workspaceStat = await stat(workspaceRoot)
      if (!workspaceStat.isDirectory()) {
        return null
      }
    } catch {
      return null
    }
    return workspaceRoot
  }

  private async readOptionalDeliveryContext(
    deliveryContextPath: string | undefined,
    expectedHash: string | undefined,
    diagnostics: string[],
  ): Promise<{ context: OpenCodeDeliveryContextV1 | null; fingerprint?: string }> {
    if (!deliveryContextPath) {
      return { context: null }
    }
    try {
      if (!path.isAbsolute(deliveryContextPath)) {
        diagnostics.push('OpenCode delivery context path rejected because it is not absolute.')
        return { context: null }
      }
      if (path.basename(deliveryContextPath) !== DELIVERY_CONTEXT_FILE_NAME) {
        diagnostics.push('OpenCode delivery context path rejected because the file name is not delivery-context.json.')
        return { context: null }
      }
      if (!isSha256Hex(expectedHash)) {
        diagnostics.push('OpenCode delivery context expected hash is missing or invalid.')
        return { context: null }
      }
      const tempRoot = await realpath(os.tmpdir())
      const parentRealPath = await realpath(path.dirname(deliveryContextPath))
      if (
        !path.basename(parentRealPath).startsWith(DELIVERY_CONTEXT_TEMP_PREFIX) ||
        !isSameOrDescendantPath(parentRealPath, tempRoot)
      ) {
        diagnostics.push('OpenCode delivery context path rejected because it is outside the trusted app temp directory.')
        return { context: null }
      }
      const fileRealPath = await realpath(deliveryContextPath)
      if (path.dirname(fileRealPath) !== parentRealPath) {
        diagnostics.push('OpenCode delivery context path rejected because the file resolves outside its trusted temp directory.')
        return { context: null }
      }
      const parentStat = await stat(parentRealPath)
      if (process.platform !== 'win32' && (parentStat.mode & 0o077) !== 0) {
        diagnostics.push('OpenCode delivery context path rejected because the parent temp directory is not private.')
        return { context: null }
      }
      const raw = await readFile(fileRealPath, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > 512 * 1024) {
        diagnostics.push('OpenCode delivery context exceeded size cap.')
        return { context: null }
      }
      const fingerprint = sha256String(raw)
      if (fingerprint !== expectedHash.toLowerCase()) {
        diagnostics.push('OpenCode delivery context hash mismatch.')
        return { context: null, fingerprint }
      }
      const parsed = normalizeDeliveryContext(JSON.parse(raw) as unknown)
      if (!parsed) {
        diagnostics.push('unsupported-delivery-context-schema: OpenCode delivery context failed schema validation.')
      }
      return {
        context: parsed,
        fingerprint,
      }
    } catch (error) {
      diagnostics.push(`OpenCode delivery context read failed - ${error instanceof Error ? error.message : String(error)}`)
      return { context: null }
    }
  }
}

export const openCodeLedgerBridgeService = new OpenCodeLedgerBridgeService(
  openCodeSessionStore,
  openCodeOfflineSessionReader,
  new OpenCodeToolpartChangeReconstructor(),
  new OpenCodeChangeEvidenceEnricher(),
  new OpenCodeSnapshotEvidenceProviderService(),
)
