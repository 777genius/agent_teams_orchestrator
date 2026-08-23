import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { OpenCodePassiveStatusV1 } from './OpenCodePassiveStatusContract.js'
import {
  getOpenCodePassiveStatusRootDirectory,
  OpenCodePassiveStatusProductionReader,
  OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS,
} from './OpenCodePassiveStatusProductionReader.js'
import { OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS } from './OpenCodePassiveProviderDirectory.js'
import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'

const MAX_OUTCOME_STORE_BYTES = 1_048_576
const MAX_OUTCOME_RECORDS = 1_000

export type OpenCodePassiveCommandStatusOutcome = Readonly<{
  requestId: string
  deliveryAttemptId: string | null
  status: 'received' | 'preconditions_checked' | 'session_resolved' | 'mcp_ready'
    | 'prompt_submitting' | 'prompt_accepted' | 'turn_observed' | 'reconciled'
    | 'failed_before_accept' | 'failed_after_accept'
  safeToRetry: boolean
  sessionId: string | null
  runtimePid: number | null
  runtimePromptMessageId: string | null
  prePromptCursor: string | null
}>

export type OpenCodePassiveCommandStatusRouteDeps = Readonly<{
  readPassiveStatus?: (input: {
    projectPath: string
    providerIds: readonly string[]
    timeoutMs: number
    signal?: AbortSignal
  }) => Promise<OpenCodePassiveStatusV1>
  readOutcome?: (input: {
    requestId: string | null
    deliveryAttemptId: string | null
    signal: AbortSignal
  }) => Promise<OpenCodePassiveCommandStatusOutcome | null>
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => { cancel(): void }
}>

type Envelope = Readonly<{
  schemaVersion: 1
  requestId: string
  command: 'opencode.commandStatus'
  cwd: string
  timeoutMs: number
  body: Readonly<Record<string, unknown>>
}>

let defaultPassiveReader: OpenCodePassiveStatusProductionReader | null = null

export async function executeOpenCodePassiveCommandStatusEnvelope(
  input: unknown,
  deps: OpenCodePassiveCommandStatusRouteDeps = {},
): Promise<Record<string, unknown>> {
  const startedAt = safeNow(deps.now)
  const envelope = validateEnvelope(input)
  const timeoutMs = envelope.timeoutMs > 0
    ? Math.min(envelope.timeoutMs, OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS)
    : OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let ended = false
  const schedule = deps.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return { cancel: () => clearTimeout(timer) }
  })
  let resolveDeadline!: () => void
  const deadline = new Promise<void>(resolve => { resolveDeadline = resolve })
  const timer = schedule(() => {
    if (ended) return
    ended = true
    controller.abort('read_timeout')
    resolveDeadline()
  }, timeoutMs)

  const originalRequestId = boundedString(envelope.body.originalRequestId)
    ?? boundedString(envelope.body.requestId)
  const deliveryAttemptId = boundedString(envelope.body.deliveryAttemptId)
  const readPassive = deps.readPassiveStatus ?? (request => {
    defaultPassiveReader ??= new OpenCodePassiveStatusProductionReader()
    return defaultPassiveReader.reader.read(request)
  })
  const readOutcome = deps.readOutcome ?? readOpenCodeCommandOutcomeReadOnly
  const passivePromise = readPassive({
    projectPath: boundedPathString(envelope.body.projectPath) ?? envelope.cwd,
    providerIds: OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS,
    timeoutMs,
    signal: controller.signal,
  }).catch(() => null)
  const outcomePromise = originalRequestId || deliveryAttemptId
    ? readOutcome({ requestId: originalRequestId, deliveryAttemptId, signal: controller.signal }).catch(() => null)
    : Promise.resolve(null)

  const combined = Promise.all([passivePromise, outcomePromise] as const)
  const completed = await Promise.race([combined, deadline.then(() => null)])
  ended = true
  timer.cancel()
  controller.abort('passive_status_complete')
  const passive = completed?.[0] ?? null
  const outcome = completed?.[1] ?? null
  const data = buildCommandStatusData(originalRequestId, deliveryAttemptId, outcome)
  const completedAt = safeNow(deps.now)
  return {
    ok: true,
    schemaVersion: 1,
    requestId: envelope.requestId,
    command: envelope.command,
    completedAt: new Date(completedAt).toISOString(),
    durationMs: Math.max(0, completedAt - startedAt),
    runtime: {
      providerId: 'opencode',
      binaryPath: null,
      binaryFingerprint: passive?.binary.value.version
        ? `version:${passive.binary.value.version}`
        : null,
      version: passive?.binary.value.version ?? null,
      capabilitySnapshotId: null,
    },
    diagnostics: [],
    data,
  }
}

function buildCommandStatusData(
  requestId: string | null,
  deliveryAttemptId: string | null,
  outcome: OpenCodePassiveCommandStatusOutcome | null,
): Record<string, unknown> {
  if (!requestId && !deliveryAttemptId) {
    return { status: 'unknown', safeToRetry: false, accepted: false, diagnostics: ['command_status_identifier_required'] }
  }
  if (!outcome) {
    return {
      status: 'unknown', safeToRetry: false, accepted: false,
      ...(requestId ? { originalRequestId: requestId } : {}),
      ...(deliveryAttemptId ? { deliveryAttemptId } : {}),
      diagnostics: ['command_status_evidence_unavailable'],
    }
  }
  if ((requestId && requestId !== outcome.requestId)
    || (deliveryAttemptId && deliveryAttemptId !== outcome.deliveryAttemptId)) {
    return {
      status: 'precondition_mismatch', safeToRetry: false, accepted: false,
      originalRequestId: outcome.requestId,
      ...(outcome.deliveryAttemptId ? { deliveryAttemptId: outcome.deliveryAttemptId } : {}),
      diagnostics: ['command_status_precondition_mismatch'],
    }
  }
  const status = ['received', 'preconditions_checked', 'session_resolved', 'mcp_ready'].includes(outcome.status)
    ? 'received'
    : outcome.status
  const accepted = ['prompt_accepted', 'turn_observed', 'reconciled', 'failed_after_accept'].includes(status)
  return {
    status,
    safeToRetry: accepted || status === 'prompt_submitting'
      ? false
      : status === 'failed_before_accept' || outcome.safeToRetry,
    accepted,
    originalRequestId: outcome.requestId,
    ...(outcome.deliveryAttemptId ? { deliveryAttemptId: outcome.deliveryAttemptId } : {}),
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.runtimePid && outcome.runtimePid > 0 ? { runtimePid: outcome.runtimePid } : {}),
    ...(outcome.runtimePromptMessageId ? { runtimePromptMessageId: outcome.runtimePromptMessageId } : {}),
    ...(outcome.prePromptCursor !== null ? { prePromptCursor: outcome.prePromptCursor } : {}),
    diagnostics: [],
  }
}

export async function readOpenCodeCommandOutcomeReadOnly(input: {
  requestId: string | null
  deliveryAttemptId: string | null
  signal: AbortSignal
}, testHooks?: {
  afterRootRetained?: () => void | Promise<void>
  afterPathIdentityCaptured?: () => void | Promise<void>
}): Promise<OpenCodePassiveCommandStatusOutcome | null> {
  if (input.signal.aborted) return null
  const passiveRoot = getOpenCodePassiveStatusRootDirectory()
  const outcomeRootPath = path.resolve(passiveRoot, '..', '..')
  let root: OpenCodeSafePublicationDirectory | null = null
  try {
    root = await OpenCodeSafePublicationDirectory.openReadOnly(outcomeRootPath, { abortSignal: input.signal })
    const retainedIdentity = await root.stableIdentity()
    await assertVisibleOutcomeRootIdentity(outcomeRootPath, retainedIdentity)
    await testHooks?.afterRootRetained?.()
    if (input.signal.aborted) return null
    // On Windows this retains the exact regular file without delete sharing;
    // on POSIX the descriptor-relative bounded read below supplies the pin.
    await root.pinRegularFile('command-outcomes.json', true)
    const text = await root.readBoundedRegularFile(
      'command-outcomes.json', MAX_OUTCOME_STORE_BYTES, input.signal,
      { afterPathIdentityCaptured: testHooks?.afterPathIdentityCaptured },
    )
    if (text === null) return null
    await assertVisibleOutcomeRootIdentity(outcomeRootPath, retainedIdentity)
    await root.validate()
    if (input.signal.aborted || Buffer.byteLength(text) > MAX_OUTCOME_STORE_BYTES) return null
    const shape = plainRecord(JSON.parse(text))
    const records = plainRecord(shape?.records)
    if (shape?.schemaVersion !== 1 || !records) return null
    const entries = Object.values(records)
    if (entries.length > MAX_OUTCOME_RECORDS) return null
    for (const value of entries) {
      const record = decodeOutcome(value)
      if (!record) continue
      if ((input.requestId && record.requestId === input.requestId)
        || (input.deliveryAttemptId && record.deliveryAttemptId === input.deliveryAttemptId)) return record
    }
    return null
  } catch {
    return null
  } finally {
    await root?.close().catch(() => undefined)
  }
}

async function assertVisibleOutcomeRootIdentity(
  rootPath: string,
  retained: Readonly<{ dev: bigint; ino: bigint }>,
): Promise<void> {
  // The Windows safe-publication authority performs the equivalent comparison
  // through its retained native root handle. POSIX additionally binds the
  // currently visible name to the retained directory descriptor so rename and
  // replacement cannot make stale evidence authoritative.
  if (process.platform === 'win32') return
  const visible = await lstat(rootPath, { bigint: true })
  if (!visible.isDirectory() || visible.isSymbolicLink()
    || visible.dev !== retained.dev || visible.ino !== retained.ino
    || await realpath(rootPath) !== path.resolve(rootPath)) {
    throw new Error('OpenCode passive outcome root identity changed [redacted]')
  }
}

function decodeOutcome(value: unknown): OpenCodePassiveCommandStatusOutcome | null {
  const record = plainRecord(value)
  const statuses = new Set([
    'received', 'preconditions_checked', 'session_resolved', 'mcp_ready', 'prompt_submitting',
    'prompt_accepted', 'turn_observed', 'reconciled', 'failed_before_accept', 'failed_after_accept',
  ])
  if (record?.schemaVersion !== 1 || record.command !== 'opencode.sendMessage'
    || !boundedString(record.requestId) || !statuses.has(String(record.status))
    || typeof record.safeToRetry !== 'boolean') return null
  return Object.freeze({
    requestId: record.requestId as string,
    deliveryAttemptId: boundedString(record.deliveryAttemptId),
    status: record.status as OpenCodePassiveCommandStatusOutcome['status'],
    safeToRetry: record.safeToRetry,
    sessionId: boundedString(record.sessionId),
    runtimePid: Number.isSafeInteger(record.runtimePid) && (record.runtimePid as number) > 0 ? record.runtimePid as number : null,
    runtimePromptMessageId: boundedString(record.runtimePromptMessageId),
    prePromptCursor: boundedString(record.prePromptCursor),
  })
}

function validateEnvelope(input: unknown): Envelope {
  const record = plainRecord(input)
  const body = plainRecord(record?.body)
  const requestId = boundedString(record?.requestId)
  const cwd = boundedPathString(record?.cwd)
  if (record?.schemaVersion !== 1 || record.command !== 'opencode.commandStatus'
    || !requestId || !cwd || !body) throw new TypeError('Invalid opencode.commandStatus envelope')
  return {
    schemaVersion: 1,
    requestId,
    command: 'opencode.commandStatus',
    cwd,
    timeoutMs: Number.isSafeInteger(record.timeoutMs) && (record.timeoutMs as number) > 0 ? record.timeoutMs as number : 0,
    body,
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : null
}

function boundedPathString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768
    && !value.includes('\0') ? value : null
}

function safeNow(now: (() => number) | undefined): number {
  try {
    const value = (now ?? Date.now)()
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}
