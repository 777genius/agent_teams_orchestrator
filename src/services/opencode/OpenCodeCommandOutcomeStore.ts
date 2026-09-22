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

function deliveryIdentityConflicts(
  previous: OpenCodeCommandOutcomeRecord,
  incoming: OpenCodeCommandOutcomePatch,
): boolean {
  return (['teamId', 'teamName', 'laneId', 'memberName', 'projectPath',
    'runId', 'messageId', 'payloadHash', 'deliveryAttemptId'] as const).some(field =>
    incoming[field] != null && previous[field] != null && incoming[field] !== previous[field])
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

  async upsert(patch: OpenCodeCommandOutcomePatch, options: {
    requireRetryable?: boolean
    definitelyUnsubmitted?: { runtimePromptMessageId: string }
  } = {}): Promise<OpenCodeCommandOutcomeRecord> {
    patch = structuredClone(patch)
    options = structuredClone(options)
    return this.withStoreLock(async () => {
      const { store, diagnostics } = await this.readStore()
      if ((options.requireRetryable || options.definitelyUnsubmitted !== undefined) && diagnostics.length) {
        throw new Error('OpenCode delivery admission requires readable outcome history')
      }
      const previous = store.records[patch.requestId] ?? null
      const deliveryAttemptId = patch.deliveryAttemptId ?? previous?.deliveryAttemptId
      const aliases = deliveryAttemptId
        ? Object.values(store.records).filter(record => record.deliveryAttemptId === deliveryAttemptId
          && record.requestId !== patch.requestId)
        : []
      // Delivery identity survives retryable failures and request aliases. A native
      // prompt ID is the generation owner once submission is admitted under this lock.
      for (const record of [previous, ...aliases]) {
        if (record && deliveryIdentityConflicts(record, patch)) {
          throw new Error('OpenCode delivery request identity changed')
        }
      }
      if (aliases.some(record => !safeToRetryForStatus(record.status))) {
        throw new Error('OpenCode delivery attempt already belongs to another request; query its outcome')
      }
      if (options.definitelyUnsubmitted !== undefined) {
        const messageId = options.definitelyUnsubmitted?.runtimePromptMessageId
        // This evidence is captured before native transport. Compare the complete
        // captured owner under the admission lock; omitted fields are not wildcards.
        if (patch.status !== 'failed_before_accept' || previous?.status !== 'prompt_submitting'
          || typeof messageId !== 'string' || !messageId.trim()
          || messageId !== previous.runtimePromptMessageId
          || messageId !== patch.runtimePromptMessageId
          || previous.acceptedAt !== null || previous.turnObservedAt !== null || previous.sendMessageData
          || (['requestId', 'teamId', 'teamName', 'laneId', 'memberName', 'projectPath',
            'runId', 'deliveryAttemptId', 'messageId', 'payloadHash', 'sessionId', 'runtimePid'] as const)
            .some(field => !Object.prototype.hasOwnProperty.call(patch, field)
              || patch[field] !== previous[field])) {
          throw new Error('OpenCode definitely-unsubmitted transition requires the exact submitting owner')
        }
        // Retain all native/ledger evidence rather than merging unrelated patch
        // metadata into this narrowly authorized transition. Failed writes reject
        // without releasing the persisted submission fence.
        const next: OpenCodeCommandOutcomeRecord = {
          ...previous,
          status: 'failed_before_accept',
          safeToRetry: true,
          error: patch.error ?? previous.error,
          completedAt: patch.completedAt ?? previous.completedAt,
          diagnostics: mergeDiagnostics(previous.diagnostics, patch.diagnostics),
          updatedAt: nowIso(),
        }
        store.records[patch.requestId] = next
        await this.writeStore(store)
        return next
      }
      if (options.requireRetryable && previous && !safeToRetryForStatus(previous.status)) {
        throw new Error('OpenCode delivery request already submitted; observe its existing outcome')
      }
      if (previous && !safeToRetryForStatus(previous.status)) {
        if ((['sessionId', 'runtimePid', 'prePromptCursor'] as const).some(field =>
          patch[field] != null && previous[field] != null && patch[field] !== previous[field])) {
          throw new Error('OpenCode delivery request identity changed')
        }
        if (previous.runtimePromptMessageId && patch.runtimePromptMessageId
          && previous.runtimePromptMessageId !== patch.runtimePromptMessageId) {
          throw new Error('OpenCode delivery outcome belongs to an existing prompt')
        }
      }
      if (previous?.status === 'prompt_submitting' && previous.runtimePromptMessageId
        && STATUS_RANK[patch.status] >= STATUS_RANK.prompt_accepted
        && patch.runtimePromptMessageId !== previous.runtimePromptMessageId) {
        throw new Error('OpenCode delivery acceptance requires the existing prompt owner')
      }
      if (previous?.status === 'failed_before_accept'
        && STATUS_RANK[patch.status] >= STATUS_RANK.prompt_accepted) {
        throw new Error('OpenCode delivery retry acceptance requires an admitted prompt owner')
      }
      const retryAdmission = previous?.status === 'failed_before_accept'
        && patch.status === 'prompt_submitting'
      if (retryAdmission && (!options.requireRetryable || !patch.runtimePromptMessageId
        || patch.runtimePromptMessageId === previous.runtimePromptMessageId)) {
        throw new Error('OpenCode delivery retry requires atomic admission with a new prompt owner')
      }
      const updatedAt = nowIso()
      const status = retryAdmission ? 'prompt_submitting' : chooseStatus(previous, patch.status)
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
        acceptedAt: retryAdmission ? null : previous?.acceptedAt ?? patch.acceptedAt ?? null,
        turnObservedAt: retryAdmission ? null : patch.turnObservedAt ?? previous?.turnObservedAt ?? null,
        completedAt: retryAdmission ? null : patch.completedAt ?? previous?.completedAt ?? null,
        error: retryAdmission ? null : patch.error ?? previous?.error ?? null,
        diagnostics: mergeDiagnostics(previous?.diagnostics ?? [], patch.diagnostics),
        ...(!retryAdmission && (patch.sendMessageData ?? previous?.sendMessageData)
          ? { sendMessageData: patch.sendMessageData ?? previous?.sendMessageData }
          : {}),
        createdAt: previous?.createdAt ?? updatedAt,
        updatedAt,
      }
      const sendMessageData = next.sendMessageData
      if (sendMessageData && (['memberName', 'sessionId', 'runtimePid',
        'runtimePromptMessageId', 'prePromptCursor'] as const).some(field =>
        sendMessageData[field] != null && next[field] != null
          && sendMessageData[field] !== next[field])) {
        throw new Error('OpenCode accepted result identity changed')
      }
      if (!retryAdmission && previous?.sendMessageData && patch.sendMessageData) {
        const retained = previous.sendMessageData
        const incoming = patch.sendMessageData
        if ((['memberName', 'sessionId', 'runtimePid', 'runtimePromptMessageId',
          'prePromptCursor'] as const).some(field => incoming[field] != null
          && retained[field] != null && incoming[field] !== retained[field])) {
          throw new Error('OpenCode accepted result identity changed')
        }
        next.sendMessageData = {
          ...retained,
          ...incoming,
          sessionId: retained.sessionId ?? incoming.sessionId,
          runtimePid: retained.runtimePid ?? incoming.runtimePid,
          runtimePromptMessageId: retained.runtimePromptMessageId ?? incoming.runtimePromptMessageId,
          prePromptCursor: retained.prePromptCursor ?? incoming.prePromptCursor,
        }
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
    const attemptId = deliveryAttemptId ?? byRequest?.deliveryAttemptId
    const candidates = attemptId
      ? Object.values(store.records).filter(record => record.deliveryAttemptId === attemptId)
      : []
    const owners = candidates.filter(record => !safeToRetryForStatus(record.status))
    // Old files may contain several failed aliases. Only one submitted owner is
    // authoritative; contradictory retained owners must never be ranked away.
    const ambiguous = owners.length > 1 || candidates.some(record =>
      candidates.some(other => deliveryIdentityConflicts(record, other)))
    const byAttempt = owners[0] ?? candidates.at(-1) ?? null
    if (ambiguous || (requestId && deliveryAttemptId && (!byRequest
      || byRequest.deliveryAttemptId !== deliveryAttemptId
      || (byAttempt && deliveryIdentityConflicts(byRequest, byAttempt))))) {
      return {
        record: null,
        diagnostics: [
          ...diagnostics,
          'OpenCode command outcome query matched different requestId and deliveryAttemptId records.',
        ],
      }
    }

    return {
      record: byAttempt ?? byRequest ?? null,
      diagnostics,
    }
  }

  async prune(olderThanMs: number, nowMs = Date.now()): Promise<number> {
    return this.withStoreLock(async () => {
      const { store } = await this.readStore()
      let removed = 0
      for (const [key, record] of Object.entries(store.records)) {
        if (!record.completedAt || record.status === 'prompt_submitting') {
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
