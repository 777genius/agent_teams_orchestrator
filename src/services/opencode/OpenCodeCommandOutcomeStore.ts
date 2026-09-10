import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'

import type { OpenCodeDeliveryResponseObservation } from './OpenCodeDeliveryResponseObserver.js'

export type OpenCodeCommandOutcomeStatus =
  | 'received'
  | 'preconditions_checked'
  | 'session_resolved'
  | 'mcp_ready'
  | 'prompt_submitting'
  | 'prompt_accepted'
  | 'turn_observed'
  | 'reconciled'
  | 'failed_before_accept'
  | 'failed_after_accept'

export type OpenCodeCommandOutcomeDiagnostic = {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

export type OpenCodeCommandOutcomeSendMessageData = {
  accepted: true
  sessionId?: string
  memberName: string
  runtimePid?: number
  prePromptCursor?: string | null
  runtimePromptMessageId?: string
  responseObservation?: OpenCodeDeliveryResponseObservation
  diagnostics: OpenCodeCommandOutcomeDiagnostic[]
}

export type OpenCodeCommandOutcomeRecord = {
  schemaVersion: 1
  command: 'opencode.sendMessage'
  requestId: string
  deliveryAttemptId?: string
  teamId: string
  teamName: string
  laneId: string
  memberName: string
  runId: string | null
  projectPath: string
  messageId: string | null
  payloadHash: string | null
  status: OpenCodeCommandOutcomeStatus
  safeToRetry: boolean
  sessionId: string | null
  runtimePid: number | null
  prePromptCursor: string | null
  runtimePromptMessageId: string | null
  acceptedAt: string | null
  turnObservedAt: string | null
  completedAt: string | null
  error: string | null
  diagnostics: string[]
  sendMessageData?: OpenCodeCommandOutcomeSendMessageData
  createdAt: string
  updatedAt: string
}

export type OpenCodeCommandOutcomePatch = Partial<
  Omit<
    OpenCodeCommandOutcomeRecord,
    'schemaVersion' | 'command' | 'requestId' | 'createdAt' | 'updatedAt'
  >
> & {
  status: OpenCodeCommandOutcomeStatus
  requestId: string
  teamId: string
  teamName: string
  laneId: string
  memberName: string
  projectPath: string
}

type OutcomeStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeCommandOutcomeRecord>
}

export type OpenCodeCommandOutcomeQueryInput = {
  requestId?: string | null
  deliveryAttemptId?: string | null
}

export type OpenCodeCommandOutcomeQueryResult = {
  record: OpenCodeCommandOutcomeRecord | null
  diagnostics: string[]
}

const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

const STATUS_RANK: Record<OpenCodeCommandOutcomeStatus, number> = {
  received: 10,
  preconditions_checked: 20,
  session_resolved: 30,
  mcp_ready: 40,
  prompt_submitting: 50,
  failed_before_accept: 55,
  prompt_accepted: 60,
  failed_after_accept: 65,
  turn_observed: 70,
  reconciled: 80,
}

const MAX_DIAGNOSTICS_PER_RECORD = 40

function nowIso(): string {
  return new Date().toISOString()
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function safeToRetryForStatus(status: OpenCodeCommandOutcomeStatus): boolean {
  return (
    status === 'received' ||
    status === 'preconditions_checked' ||
    status === 'session_resolved' ||
    status === 'mcp_ready' ||
    status === 'failed_before_accept'
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isStatus(value: unknown): value is OpenCodeCommandOutcomeStatus {
  return typeof value === 'string' && value in STATUS_RANK
}

function normalizeDiagnostics(diagnostics: unknown): string[] {
  if (!Array.isArray(diagnostics)) {
    return []
  }
  return diagnostics
    .filter((diagnostic): diagnostic is string => typeof diagnostic === 'string')
    .slice(-MAX_DIAGNOSTICS_PER_RECORD)
}

function validateRecord(value: unknown): OpenCodeCommandOutcomeRecord | null {
  const record = asRecord(value)
  if (!record || record.schemaVersion !== 1 || record.command !== 'opencode.sendMessage') {
    return null
  }
  if (
    !isString(record.requestId) ||
    (record.deliveryAttemptId !== undefined && !isString(record.deliveryAttemptId)) ||
    !isString(record.teamId) ||
    !isString(record.teamName) ||
    !isString(record.laneId) ||
    !isString(record.memberName) ||
    !isNullableString(record.runId) ||
    !isString(record.projectPath) ||
    !isNullableString(record.messageId) ||
    !isNullableString(record.payloadHash) ||
    !isStatus(record.status) ||
    typeof record.safeToRetry !== 'boolean' ||
    !isNullableString(record.sessionId) ||
    !isNullableNumber(record.runtimePid) ||
    !isNullableString(record.prePromptCursor) ||
    !isNullableString(record.runtimePromptMessageId) ||
    !isNullableString(record.acceptedAt) ||
    !isNullableString(record.turnObservedAt) ||
    !isNullableString(record.completedAt) ||
    !isNullableString(record.error) ||
    !isString(record.createdAt) ||
    !isString(record.updatedAt)
  ) {
    return null
  }

  return {
    schemaVersion: 1,
    command: 'opencode.sendMessage',
    requestId: record.requestId,
    ...(record.deliveryAttemptId ? { deliveryAttemptId: record.deliveryAttemptId } : {}),
    teamId: record.teamId,
    teamName: record.teamName,
    laneId: record.laneId,
    memberName: record.memberName,
    runId: record.runId,
    projectPath: record.projectPath,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    status: record.status,
    safeToRetry: record.safeToRetry,
    sessionId: record.sessionId,
    runtimePid: record.runtimePid,
    prePromptCursor: record.prePromptCursor,
    runtimePromptMessageId: record.runtimePromptMessageId,
    acceptedAt: record.acceptedAt,
    turnObservedAt: record.turnObservedAt,
    completedAt: record.completedAt,
    error: record.error,
    diagnostics: normalizeDiagnostics(record.diagnostics),
    ...(asRecord(record.sendMessageData) && record.sendMessageData.accepted === true
      ? { sendMessageData: record.sendMessageData as OpenCodeCommandOutcomeSendMessageData }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function chooseStatus(
  previous: OpenCodeCommandOutcomeRecord | null,
  incoming: OpenCodeCommandOutcomeStatus,
): OpenCodeCommandOutcomeStatus {
  if (!previous) {
    return incoming
  }
  if (
    previous.status === 'prompt_submitting' &&
    previous.runtimePromptMessageId &&
    incoming === 'failed_before_accept'
  ) {
    return previous.status
  }
  return STATUS_RANK[incoming] >= STATUS_RANK[previous.status] ? incoming : previous.status
}

function mergeDiagnostics(previous: string[], incoming: string[] | undefined): string[] {
  if (!incoming?.length) {
    return previous.slice(-MAX_DIAGNOSTICS_PER_RECORD)
  }
  return [...previous, ...incoming].slice(-MAX_DIAGNOSTICS_PER_RECORD)
}

export class OpenCodeCommandOutcomeStore {
  private readonly filePath: string
  private readonly lockPath: string

  constructor(filePath?: string) {
    const paths = resolveClaudeMultimodelPaths()
    this.filePath = filePath ?? path.join(paths.data, 'opencode', 'command-outcomes.json')
    this.lockPath = `${this.filePath}.lock`
  }

  private async ensureParentDir(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
  }

  private async ensureLockFile(): Promise<void> {
    await this.ensureParentDir()
    await writeFile(this.lockPath, '', { flag: 'a' })
  }

  private async withStoreLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureLockFile()
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.lockPath, LOCK_OPTIONS)
      return await callback()
    } finally {
      if (release) {
        await release()
      }
    }
  }

  private async readStore(): Promise<{ store: OutcomeStoreShape; diagnostics: string[] }> {
    if (!(await fileExists(this.filePath))) {
      return {
        store: {
          schemaVersion: 1,
          records: {},
        },
        diagnostics: [],
      }
    }

    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      const shape = asRecord(parsed)
      const records = asRecord(shape?.records)
      if (shape?.schemaVersion !== 1 || !records) {
        return {
          store: {
            schemaVersion: 1,
            records: {},
          },
          diagnostics: ['OpenCode command outcome store shape was invalid; treating as empty.'],
        }
      }
      const validRecords: Record<string, OpenCodeCommandOutcomeRecord> = {}
      for (const [key, value] of Object.entries(records)) {
        const record = validateRecord(value)
        if (record) {
          validRecords[key] = record
        }
      }
      return {
        store: {
          schemaVersion: 1,
          records: validRecords,
        },
        diagnostics: [],
      }
    } catch (error) {
      return {
        store: {
          schemaVersion: 1,
          records: {},
        },
        diagnostics: [
          `OpenCode command outcome store read failed - ${error instanceof Error ? error.message : String(error)}`,
        ],
      }
    }
  }

  private async writeStore(store: OutcomeStoreShape): Promise<void> {
    await writeJsonFileAtomic(this.filePath, store, { indent: 2 })
  }

  async upsert(patch: OpenCodeCommandOutcomePatch, options: { requireRetryable?: boolean } = {}): Promise<OpenCodeCommandOutcomeRecord> {
    patch = structuredClone(patch)
    options = { ...options }
    return this.withStoreLock(async () => {
      const { store, diagnostics } = await this.readStore()
      if (options.requireRetryable && diagnostics.length) {
        throw new Error('OpenCode delivery admission requires readable outcome history')
      }
      const previous = store.records[patch.requestId] ?? null
      if (options.requireRetryable && patch.deliveryAttemptId && Object.values(store.records).some(record =>
        record.deliveryAttemptId === patch.deliveryAttemptId && record.requestId !== patch.requestId
          && !safeToRetryForStatus(record.status))) {
        throw new Error('OpenCode delivery attempt already belongs to another request; query its outcome')
      }
      if (previous && !safeToRetryForStatus(previous.status) && (['teamId', 'teamName', 'laneId', 'memberName', 'projectPath',
        'runId', 'messageId', 'payloadHash', 'deliveryAttemptId'] as const).some(field =>
        patch[field] != null && previous[field] != null && patch[field] !== previous[field])) {
        throw new Error('OpenCode delivery request identity changed')
      }
      if (options.requireRetryable && previous && !safeToRetryForStatus(previous.status)) {
        throw new Error('OpenCode delivery request already submitted; observe its existing outcome')
      }
      if (previous?.runtimePromptMessageId && !safeToRetryForStatus(previous.status)
        && patch.runtimePromptMessageId && previous.runtimePromptMessageId !== patch.runtimePromptMessageId) {
        throw new Error('OpenCode delivery outcome belongs to an existing prompt')
      }
      const updatedAt = nowIso()
      const status = chooseStatus(previous, patch.status)
      const next: OpenCodeCommandOutcomeRecord = {
        schemaVersion: 1,
        command: 'opencode.sendMessage',
        requestId: patch.requestId,
        ...(patch.deliveryAttemptId ?? previous?.deliveryAttemptId
          ? { deliveryAttemptId: patch.deliveryAttemptId ?? previous?.deliveryAttemptId }
          : {}),
        teamId: patch.teamId,
        teamName: patch.teamName,
        laneId: patch.laneId,
        memberName: patch.memberName,
        runId: patch.runId ?? previous?.runId ?? null,
        projectPath: patch.projectPath,
        messageId: patch.messageId ?? previous?.messageId ?? null,
        payloadHash: patch.payloadHash ?? previous?.payloadHash ?? null,
        status,
        safeToRetry: safeToRetryForStatus(status),
        sessionId: patch.sessionId ?? previous?.sessionId ?? null,
        runtimePid: patch.runtimePid ?? previous?.runtimePid ?? null,
        prePromptCursor: patch.prePromptCursor ?? previous?.prePromptCursor ?? null,
        runtimePromptMessageId:
          patch.runtimePromptMessageId ?? previous?.runtimePromptMessageId ?? null,
        acceptedAt: patch.acceptedAt ?? previous?.acceptedAt ?? null,
        turnObservedAt: patch.turnObservedAt ?? previous?.turnObservedAt ?? null,
        completedAt: patch.completedAt ?? previous?.completedAt ?? null,
        error: patch.error ?? previous?.error ?? null,
        diagnostics: mergeDiagnostics(previous?.diagnostics ?? [], patch.diagnostics),
        ...(patch.sendMessageData ?? previous?.sendMessageData
          ? { sendMessageData: patch.sendMessageData ?? previous?.sendMessageData }
          : {}),
        createdAt: previous?.createdAt ?? updatedAt,
        updatedAt,
      }
      store.records[patch.requestId] = next
      await this.writeStore(store)
      return next
    })
  }

  async query(input: OpenCodeCommandOutcomeQueryInput): Promise<OpenCodeCommandOutcomeQueryResult> {
    const { store, diagnostics } = await this.readStore()
    const requestId = input.requestId?.trim() || null
    const deliveryAttemptId = input.deliveryAttemptId?.trim() || null
    const byRequest = requestId ? store.records[requestId] ?? null : null
    const byAttempt = deliveryAttemptId
      ? Object.values(store.records).find(record => record.deliveryAttemptId === deliveryAttemptId) ?? null
      : null

    if (byRequest && byAttempt && byRequest.requestId !== byAttempt.requestId) {
      return {
        record: null,
        diagnostics: [
          ...diagnostics,
          'OpenCode command outcome query matched different requestId and deliveryAttemptId records.',
        ],
      }
    }

    return {
      record: byRequest ?? byAttempt ?? null,
      diagnostics,
    }
  }

  async prune(olderThanMs: number, nowMs = Date.now()): Promise<number> {
    return this.withStoreLock(async () => {
      const { store } = await this.readStore()
      let removed = 0
      for (const [key, record] of Object.entries(store.records)) {
        if (!record.completedAt) {
          continue
        }
        const completedAtMs = Date.parse(record.completedAt)
        if (Number.isFinite(completedAtMs) && nowMs - completedAtMs > olderThanMs) {
          delete store.records[key]
          removed += 1
        }
      }
      if (removed > 0) {
        await this.writeStore(store)
      }
      return removed
    })
  }
}

export const openCodeCommandOutcomeStore = new OpenCodeCommandOutcomeStore()
