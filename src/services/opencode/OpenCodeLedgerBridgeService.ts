import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  importTaskChangeLedgerEvents,
  type ImportedOpenCodeFileChange,
} from '../taskChangeLedger/TaskChangeLedgerService.js'
import { areSameOpenCodeWorkspace } from './OpenCodeBridgePath.js'
import { openCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
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
  teamName: string
  taskId?: string
  projectDir?: string
  workspaceRoot?: string
  dryRun: boolean
  attributionMode: OpenCodeLedgerAttributionMode
  scannedSessions: number
  scannedToolparts: number
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
  attributionMode?: OpenCodeLedgerAttributionMode
  dryRun?: boolean
}

type SessionStorePort = Pick<typeof openCodeSessionStore, 'list'>

const MAX_SCANNED_RECORDS = 50

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
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
    source: change.sourceTool === 'write' ? 'opencode_toolpart_write' : 'opencode_toolpart_edit',
    confidence: change.confidence,
    operation: change.operation,
    beforeState: change.beforeState,
    afterState: change.afterState,
    oldString: change.oldString,
    newString: change.newString,
    warnings: change.warnings,
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
    if (!record.laneId || !record.runtimeSessionId) {
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
): boolean {
  return deliveryRecords.some(deliveryRecord =>
    deliveryRecord.memberName === record.memberName &&
    deliveryRecord.laneId === record.laneId &&
    deliveryRecord.runtimeSessionId === record.opencodeSessionId
  )
}

export class OpenCodeLedgerBridgeService {
  constructor(
    private readonly sessionStore: SessionStorePort = openCodeSessionStore,
    private readonly offlineReader = openCodeOfflineSessionReader,
    private readonly reconstructor = new OpenCodeToolpartChangeReconstructor(),
  ) {}

  async backfill(params: BackfillParams): Promise<OpenCodeLedgerBridgeBackfillResult> {
    const attributionMode = normalizeAttributionMode(params.attributionMode)
    const result: OpenCodeLedgerBridgeBackfillResult = {
      schemaVersion: 1,
      providerId: 'opencode',
      teamName: params.teamName,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.projectDir ? { projectDir: params.projectDir } : {}),
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
      dryRun: params.dryRun === true,
      attributionMode,
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

    const deliveryContext = await this.readOptionalDeliveryContext(params.deliveryContextPath, result.diagnostics)
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
      records = records.filter(record => matchesStrictDeliveryRecord(record, strictDeliveryRecords))
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
      if (reconstructed.changes.length === 0) {
        continue
      }

      for (const [taskId, changes] of groupByTask(reconstructed.changes)) {
        if (params.taskId && taskId !== params.taskId) {
          continue
        }
        result.candidateEvents += changes.length
        if (params.dryRun === true) {
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
          changes: changes.map(change => ({
            ...toLedgerChange(change),
            importBatchId,
          })),
        })
        result.importedEvents += imported.importedEventCount
        result.skippedEvents += imported.skippedDuplicateCount + imported.skippedUnsafeCount
        result.diagnostics.push(...imported.diagnostics)
      }
    }

    result.outcome = this.resolveOutcome(result)
    return result
  }

  private resolveOutcome(result: OpenCodeLedgerBridgeBackfillResult): OpenCodeLedgerBackfillOutcome {
    if (result.importedEvents > 0) {
      return 'imported'
    }
    if (result.dryRun && result.candidateEvents > 0) {
      return 'manual-only'
    }
    if (result.candidateEvents > 0 && result.skippedEvents > 0) {
      return 'duplicates-only'
    }
    if (result.outcome === 'unsafe-input' || result.outcome === 'skipped-capability' || result.outcome === 'transient-error') {
      return result.outcome
    }
    if (result.scannedSessions === 0) {
      return result.outcome === 'unsafe-input' ? 'unsafe-input' : 'no-history'
    }
    if (result.candidateEvents === 0) {
      return 'no-attribution'
    }
    return result.outcome === 'unsafe-input' ? 'unsafe-input' : 'no-attribution'
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
    diagnostics: string[],
  ): Promise<OpenCodeDeliveryContextV1 | null> {
    if (!deliveryContextPath) {
      return null
    }
    try {
      const raw = await readFile(deliveryContextPath, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > 512 * 1024) {
        diagnostics.push('OpenCode delivery context exceeded size cap.')
        return null
      }
      const parsed = normalizeDeliveryContext(JSON.parse(raw) as unknown)
      if (!parsed) {
        diagnostics.push('OpenCode delivery context failed schema validation.')
      }
      return parsed
    } catch (error) {
      diagnostics.push(`OpenCode delivery context read failed - ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
}

export const openCodeLedgerBridgeService = new OpenCodeLedgerBridgeService()
