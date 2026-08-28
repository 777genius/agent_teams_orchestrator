import { createHash, randomUUID } from 'node:crypto'

import { isNativeProcessBirthToken } from '../../utils/processKill.js'
import type { OpenCodeHostReleaseReceipt } from './OpenCodeHostManager.js'
import { computeOpenCodeHostReleaseObligationIdentityDigest } from './OpenCodeHostManager.js'
import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'
import {
  OpenCodeLaunchFileJournalPersistence,
  OpenCodeLaunchJournalError,
  type OpenCodeLaunchStoreContext,
} from './OpenCodeLaunchAttemptStore.js'
import { openCodeMonotonicNow } from './OpenCodeRuntimeDeadline.js'

export type OpenCodeLaunchHostReleaseRecord = Readonly<{
  schemaVersion: 4
  obligationId: string
  reservationDigest: string
  receiptIdentityDigest: string
  attemptId: string
  payloadHash: string
  generation: number
  hostKeyIdentity: OpenCodeOpaqueIdentity
  hostKeyDigest: string
  disposition: 'dispose' | 'keep_alive' | 'unknown'
  releaseState: 'pending' | 'complete'
  receipt: OpenCodeHostReleaseReceipt
}>

export type OpenCodeLaunchHostAcquisitionObligation = Readonly<{
  schemaVersion: 4
  obligationId: string
  reservationDigest: string
  receiptIdentityDigest: null
  attemptId: string
  payloadHash: string
  generation: number
  hostKeyIdentity: OpenCodeOpaqueIdentity
  hostKeyDigest: string
  disposition: 'unknown'
  releaseState: 'pending'
  receipt: null
}>

export type OpenCodeLaunchHostCleanupRecord = OpenCodeLaunchHostReleaseRecord
  | OpenCodeLaunchHostAcquisitionObligation
export type OpenCodeLaunchHostLedgerContext = Readonly<{
  deadlineAtMs: number
  signal: AbortSignal
}>

export type OpenCodeLaunchHostLedgerPersistence = Pick<OpenCodeLaunchFileJournalPersistence,
  'read' | 'replaceAndSync' | 'replaceUnframedLegacyAndSync'
  | 'acquireExclusive' | 'readUnframedLegacy'>

type LedgerEnvelope = Readonly<{ schemaVersion: 1; records: readonly OpenCodeLaunchHostCleanupRecord[] }>
const MAX_LEDGER_BYTES = 1_048_576

function storeContext(context: OpenCodeLaunchHostLedgerContext): OpenCodeLaunchStoreContext {
  return { ...context, monotonicNow: openCodeMonotonicNow }
}

function ensureContext(context: OpenCodeLaunchHostLedgerContext): void {
  if (context.signal.aborted || openCodeMonotonicNow() >= context.deadlineAtMs) {
    throw context.signal.reason ?? new Error('OpenCode launch deadline expired')
  }
}

function launchHostReservationDigest(input: Readonly<{ obligationId: string; attemptId: string;
  payloadHash: string; generation: number; hostKeyIdentity: OpenCodeOpaqueIdentity;
  hostKeyDigest: string }>): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'opencode-host-cleanup-reservation-v1',
    obligationId: input.obligationId,
    attemptId: input.attemptId,
    payloadHash: input.payloadHash,
    generation: input.generation,
    hostKeyIdentity: input.hostKeyIdentity,
    hostKeyDigest: input.hostKeyDigest,
  })).digest('hex')
}

function launchHostReceiptIdentityDigest(input: Readonly<{ reservationDigest: string;
  hostKeyIdentity: OpenCodeOpaqueIdentity; receipt: OpenCodeHostReleaseReceipt }>): string {
  return computeOpenCodeHostReleaseObligationIdentityDigest(input)
}

function encode(records: readonly OpenCodeLaunchHostCleanupRecord[]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ schemaVersion: 1, records })}\n`)
}

function decode(bytes: Uint8Array): OpenCodeLaunchHostCleanupRecord[] {
  if (bytes.byteLength > MAX_LEDGER_BYTES) {
    throw new Error('OpenCode launch host release ledger is corrupt [redacted]')
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('OpenCode launch host release ledger is corrupt [redacted]') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'records,schemaVersion'
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || !Array.isArray((value as { records?: unknown }).records)) {
    throw new Error('OpenCode launch host release ledger is corrupt [redacted]')
  }
  const records = (value as { records: unknown[] }).records.map(validateLaunchHostCleanupRecord)
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.obligationId)) {
      throw new Error('OpenCode launch host release ledger conflicts [redacted]')
    }
    ids.add(record.obligationId)
  }
  return records.sort(compareRecords)
}

function compareRecords(left: OpenCodeLaunchHostCleanupRecord,
  right: OpenCodeLaunchHostCleanupRecord): number {
  return left.generation - right.generation || left.obligationId.localeCompare(right.obligationId)
}

function throwLedgerReadError(error: unknown): never {
  if (error instanceof OpenCodeLaunchJournalError && error.code === 'corrupt') {
    throw new Error('OpenCode launch host release ledger is corrupt [redacted]')
  }
  throw error
}

function isFramedMarker(bytes: Uint8Array): boolean {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return false }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  return Object.keys(marker).sort().join(',') === 'digest,slot,version'
    && marker.version === 1 && (marker.slot === 0 || marker.slot === 1)
    && typeof marker.digest === 'string' && /^[0-9a-f]{64}$/.test(marker.digest)
}

/**
 * Durable host cleanup authority. All publication, reads, and locking are delegated to the
 * launch journal's retained relative-persistence backend; this class never resolves a pathname.
 */
export class OpenCodeLaunchHostReleaseLedger {
  private constructor(
    private readonly persistence: OpenCodeLaunchHostLedgerPersistence,
    private readonly syntheticFixture = false,
  ) {}

  static production(persistence: OpenCodeLaunchHostLedgerPersistence): OpenCodeLaunchHostReleaseLedger {
    return new OpenCodeLaunchHostReleaseLedger(persistence)
  }

  /** Explicit synthetic-fixture seam; production code cannot obtain an implicit deadline here. */
  static forSyntheticFixture(filePath: string): OpenCodeLaunchHostReleaseLedger {
    const persistence = new OpenCodeLaunchFileJournalPersistence(filePath)
    return new OpenCodeLaunchHostReleaseLedger(persistence, true)
  }

  private context(context?: OpenCodeLaunchHostLedgerContext): OpenCodeLaunchHostLedgerContext {
    if (context) return context
    if (!this.syntheticFixture) {
      throw new TypeError('OpenCode launch host ledger context is required')
    }
    return { deadlineAtMs: openCodeMonotonicNow() + 10_000, signal: new AbortController().signal }
  }

  async reserve(input: Readonly<{ attemptId: string; payloadHash: string; generation: number;
    hostKeyIdentity: OpenCodeOpaqueIdentity; hostKeyDigest: string }>,
  context?: OpenCodeLaunchHostLedgerContext): Promise<OpenCodeLaunchHostAcquisitionObligation> {
    context = this.context(context)
    const obligationId = randomUUID()
    const obligation: OpenCodeLaunchHostAcquisitionObligation = {
      schemaVersion: 4, obligationId, ...input,
      reservationDigest: launchHostReservationDigest({ obligationId, ...input }),
      receiptIdentityDigest: null,
      disposition: 'unknown', releaseState: 'pending', receipt: null,
    }
    await this.mutate(context, records => {
      assertMonotonicLaunchHostCleanupTransition(null, obligation)
      return [...records, obligation]
    })
    return obligation
  }

  async record(record: unknown, context?: OpenCodeLaunchHostLedgerContext): Promise<void> {
    context = this.context(context)
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || (record as { schemaVersion?: unknown }).schemaVersion !== 4) {
      throw new Error('OpenCode launch host release update lacks an immutable reservation [redacted]')
    }
    let candidate = record
    const source = record as Record<string, unknown>
    if (source.receipt && typeof source.receipt === 'object'
      && typeof source.reservationDigest === 'string' && typeof source.hostKeyIdentity === 'string'
      && (source.receiptIdentityDigest === null || source.receiptIdentityDigest === undefined)) {
      candidate = { ...source, receiptIdentityDigest: launchHostReceiptIdentityDigest({
        reservationDigest: source.reservationDigest,
        hostKeyIdentity: source.hostKeyIdentity as OpenCodeOpaqueIdentity,
        receipt: source.receipt as OpenCodeHostReleaseReceipt,
      }) }
    }
    const normalized = validateLaunchHostReleaseRecord(candidate)
    await this.mutate(context, records => {
      const index = records.findIndex(item => item.obligationId === normalized.obligationId)
      const predecessor = index < 0 ? null : records[index]
      assertMonotonicLaunchHostCleanupTransition(predecessor, normalized)
      if (index < 0) return [...records, normalized]
      const next = [...records]
      next[index] = normalized
      return next
    })
  }

  private async mutate(context: OpenCodeLaunchHostLedgerContext,
    update: (records: OpenCodeLaunchHostCleanupRecord[]) => OpenCodeLaunchHostCleanupRecord[]): Promise<void> {
    ensureContext(context)
    const persistenceContext = storeContext(context)
    const release = await this.persistence.acquireExclusive(persistenceContext)
    let bodyFailure: unknown
    try {
      ensureContext(context)
      let legacy = false
      let records: OpenCodeLaunchHostCleanupRecord[]
      try {
        const bytes = await this.persistence.read(persistenceContext)
        records = bytes ? decode(bytes) : []
      } catch (error) {
        let legacyBytes: Uint8Array | null
        try { legacyBytes = await this.persistence.readUnframedLegacy(persistenceContext) }
        catch (legacyError) {
          if (legacyError instanceof OpenCodeLaunchJournalError && legacyError.code === 'corrupt') {
            throwLedgerReadError(error)
          }
          throw legacyError
        }
        if (!legacyBytes) throwLedgerReadError(error)
        let value: unknown
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(legacyBytes)) }
        catch { throwLedgerReadError(error) }
        try { records = [validateLaunchHostReleaseRecord(value)] }
        catch { throwLedgerReadError(error) }
        legacy = true
      }
      const next = update(records).sort(compareRecords)
      ensureContext(context)
      const encoded = encode(next)
      if (legacy) await this.persistence.replaceUnframedLegacyAndSync(encoded, persistenceContext)
      else await this.persistence.replaceAndSync(encoded, persistenceContext)
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      // Release starts physical reaping before its bounded, cancellation-aware wait. Preserve an
      // earlier fail-closed publication error while a timed-out reaper settles in background.
      try { await release(persistenceContext) }
      catch (error) { if (bodyFailure === undefined) throw error }
    }
  }

  private async readPhysical(context: OpenCodeLaunchHostLedgerContext,
    allowLegacy: boolean): Promise<OpenCodeLaunchHostCleanupRecord[]> {
    const persistenceContext = storeContext(context)
    try {
      const bytes = await this.persistence.read(persistenceContext)
      return bytes ? decode(bytes) : []
    } catch (error) {
      if (!allowLegacy) throw error
      let legacyBytes: Uint8Array | null
      try { legacyBytes = await this.persistence.readUnframedLegacy(persistenceContext) }
      catch (legacyError) {
        if (legacyError instanceof OpenCodeLaunchJournalError && legacyError.code === 'corrupt') {
          throwLedgerReadError(error)
        }
        throw legacyError
      }
      if (!legacyBytes) throwLedgerReadError(error)
      // A migration atomically replaces the verified legacy leaf with its framed marker. If that
      // exact transition wins between the framed read and legacy fallback, retry only after
      // recognizing the complete marker shape; arbitrary malformed/foreign bytes still fail shut.
      if (error instanceof OpenCodeLaunchJournalError && error.code === 'corrupt'
        && isFramedMarker(legacyBytes)) {
        const transitioned = await this.persistence.read(persistenceContext)
        if (!transitioned) throwLedgerReadError(error)
        return decode(transitioned)
      }
      let legacy: unknown
      try { legacy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(legacyBytes)) }
      catch { throwLedgerReadError(error) }
      try { return [validateLaunchHostReleaseRecord(legacy)] }
      catch { throwLedgerReadError(error) }
    }
  }

  private validateExpected(records: OpenCodeLaunchHostCleanupRecord[], expected: Readonly<{
    attemptId: string; payloadHash: string; generation?: number; currentGeneration?: number
  }>): OpenCodeLaunchHostCleanupRecord[] {
    for (const record of records) {
      if (record.attemptId !== expected.attemptId || record.payloadHash !== expected.payloadHash
        || (expected.generation !== undefined && record.generation > expected.generation)
        || (expected.currentGeneration !== undefined && record.generation > expected.currentGeneration)) {
        throw new Error('OpenCode launch host release receipt is foreign [redacted]')
      }
    }
    return records
  }

  private async readAll(expected: Readonly<{ attemptId: string; payloadHash: string;
    generation?: number; currentGeneration?: number }>,
  context: OpenCodeLaunchHostLedgerContext): Promise<OpenCodeLaunchHostCleanupRecord[]> {
    ensureContext(context)
    return this.validateExpected(await this.readPhysical(context, true), expected)
  }

  async read(expected: Pick<OpenCodeLaunchHostReleaseRecord,
  'attemptId' | 'payloadHash' | 'generation'>, context?: OpenCodeLaunchHostLedgerContext):
  Promise<OpenCodeLaunchHostReleaseRecord | null> {
    context = this.context(context)
    const records = (await this.readAll(expected, context)).filter(
      (record): record is OpenCodeLaunchHostReleaseRecord =>
        record.generation === expected.generation && record.receipt !== null)
    if (records.length > 1) throw new Error('OpenCode launch host release receipt is ambiguous [redacted]')
    return records[0] ?? null
  }

  async readObligation(expected: Pick<OpenCodeLaunchHostReleaseRecord,
  'attemptId' | 'payloadHash' | 'generation' | 'obligationId'>,
  context?: OpenCodeLaunchHostLedgerContext): Promise<OpenCodeLaunchHostReleaseRecord | null> {
    context = this.context(context)
    const records = (await this.readAll(expected, context)).filter(
      (record): record is OpenCodeLaunchHostReleaseRecord => record.generation === expected.generation
        && record.obligationId === expected.obligationId && record.receipt !== null)
    if (records.length > 1) throw new Error('OpenCode launch host release obligation conflicts [redacted]')
    return records[0] ?? null
  }

  async readPending(expected: Pick<OpenCodeLaunchHostReleaseRecord, 'attemptId' | 'payloadHash'> & {
    currentGeneration: number
  }, context?: OpenCodeLaunchHostLedgerContext): Promise<OpenCodeLaunchHostReleaseRecord | null> {
    context = this.context(context)
    return (await this.readAllPending(expected, context))[0] ?? null
  }

  async readAllPending(expected: Pick<OpenCodeLaunchHostReleaseRecord, 'attemptId' | 'payloadHash'> & {
    currentGeneration: number
  }, context?: OpenCodeLaunchHostLedgerContext): Promise<OpenCodeLaunchHostReleaseRecord[]> {
    context = this.context(context)
    return (await this.readAll(expected, context)).filter(
      (record): record is OpenCodeLaunchHostReleaseRecord => record.receipt !== null)
  }

  async snapshotAll(expected: Pick<OpenCodeLaunchHostReleaseRecord, 'attemptId' | 'payloadHash'> & {
    currentGeneration: number
  }, context?: OpenCodeLaunchHostLedgerContext): Promise<OpenCodeLaunchHostCleanupRecord[]> {
    context = this.context(context)
    ensureContext(context)
    const first = await this.readPhysical(context, true)
    ensureContext(context)
    const second = await this.readPhysical(context, true)
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error('OpenCode launch host release namespace changed during snapshot [redacted]')
    }
    return this.validateExpected(second, expected)
  }

  async hasUnresolvedAcquisition(expected: Pick<OpenCodeLaunchHostReleaseRecord,
  'attemptId' | 'payloadHash'> & { currentGeneration: number },
  context?: OpenCodeLaunchHostLedgerContext): Promise<boolean> {
    context = this.context(context)
    return (await this.readAll(expected, context)).some(record => record.receipt === null)
  }

  async listCleanupObligationIds(expected: Pick<OpenCodeLaunchHostReleaseRecord,
  'attemptId' | 'payloadHash'> & { currentGeneration: number },
  context?: OpenCodeLaunchHostLedgerContext): Promise<string[]> {
    context = this.context(context)
    return (await this.readAll(expected, context)).map(record => record.obligationId)
  }

  async clear(record: OpenCodeLaunchHostReleaseRecord,
    context?: OpenCodeLaunchHostLedgerContext): Promise<void> {
    context = this.context(context)
    await this.clearRecord(record, context)
  }

  async clearObligation(record: OpenCodeLaunchHostAcquisitionObligation,
    context?: OpenCodeLaunchHostLedgerContext): Promise<void> {
    context = this.context(context)
    await this.clearRecord(record, context)
  }

  private async clearRecord(record: OpenCodeLaunchHostCleanupRecord,
    context: OpenCodeLaunchHostLedgerContext): Promise<void> {
    await this.mutate(context, records => {
      const index = records.findIndex(item => item.obligationId === record.obligationId)
      if (index < 0) return records
      if (JSON.stringify(records[index]) !== JSON.stringify(record)) {
        throw new Error('OpenCode launch host release receipt changed [redacted]')
      }
      return records.filter((_, candidate) => candidate !== index)
    })
  }
}

function validateLaunchHostReleaseRecord(value: unknown): OpenCodeLaunchHostReleaseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode launch host release receipt is corrupt [redacted]')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  const legacy = record.schemaVersion === 1
    && keys === 'attemptId,generation,hostKeyIdentity,payloadHash,receipt,schemaVersion'
  const versionTwo = record.schemaVersion === 2
    && keys === 'attemptId,disposition,generation,hostKeyIdentity,payloadHash,receipt,releaseState,schemaVersion'
  const current = record.schemaVersion === 3
    && keys === 'attemptId,disposition,generation,hostKeyIdentity,obligationId,payloadHash,receipt,releaseState,schemaVersion'
  const versionFour = record.schemaVersion === 4
    && keys === 'attemptId,disposition,generation,hostKeyDigest,hostKeyIdentity,obligationId,payloadHash,receipt,receiptIdentityDigest,releaseState,reservationDigest,schemaVersion'
  if ((!legacy && !versionTwo && !current && !versionFour) || typeof record.attemptId !== 'string'
    || typeof record.payloadHash !== 'string' || !Number.isSafeInteger(record.generation)
    || typeof record.hostKeyIdentity !== 'string'
    || ((current || versionFour) && (typeof record.obligationId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(record.obligationId)))
    || (versionFour && (typeof record.reservationDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.reservationDigest)
      || typeof record.receiptIdentityDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.receiptIdentityDigest)))
    || (versionFour && (typeof record.hostKeyDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.hostKeyDigest)))
    || (!legacy && record.disposition !== 'dispose' && record.disposition !== 'keep_alive'
      && record.disposition !== 'unknown')
    || (!legacy && record.releaseState !== 'pending' && record.releaseState !== 'complete')
    || !record.receipt || typeof record.receipt !== 'object' || Array.isArray(record.receipt)) {
    throw new Error('OpenCode launch host release receipt is corrupt [redacted]')
  }
  const receipt = record.receipt as Record<string, unknown>
  const receiptKeys = Object.keys(receipt).sort().join(',')
  const receiptV1 = receipt.schemaVersion === 1
    && receiptKeys === 'hostKeyDigest,lifetime,pid,processStartedAtMs,receiptId,schemaVersion'
  const receiptV2 = receipt.schemaVersion === 2
    && receiptKeys === 'hostKeyDigest,lifetime,pid,processBirthToken,processStartedAtMs,receiptId,schemaVersion'
  if ((!receiptV1 && !receiptV2) || typeof receipt.receiptId !== 'string'
    || typeof receipt.hostKeyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.hostKeyDigest)
    || !Number.isSafeInteger(receipt.pid) || !Number.isFinite(receipt.processStartedAtMs)
    || (receiptV2 && !isNativeProcessBirthToken(receipt.processBirthToken))
    || (receipt.lifetime !== 'process' && receipt.lifetime !== 'persistent')) {
    throw new Error('OpenCode launch host release receipt is corrupt [redacted]')
  }
  const obligationId = current || versionFour ? record.obligationId as string : receipt.receiptId as string
  const reservationDigest = versionFour ? record.reservationDigest as string : launchHostReservationDigest({
    obligationId, attemptId: record.attemptId as string, payloadHash: record.payloadHash as string,
    generation: record.generation as number, hostKeyIdentity: record.hostKeyIdentity as OpenCodeOpaqueIdentity,
    hostKeyDigest: receipt.hostKeyDigest as string,
  })
  const hostKeyDigest = versionFour ? record.hostKeyDigest as string : receipt.hostKeyDigest as string
  if (hostKeyDigest !== receipt.hostKeyDigest) {
    throw new Error('OpenCode launch host release host identity is corrupt [redacted]')
  }
  const receiptIdentityDigest = launchHostReceiptIdentityDigest({ reservationDigest,
    hostKeyIdentity: record.hostKeyIdentity as OpenCodeOpaqueIdentity,
    receipt: receipt as OpenCodeHostReleaseReceipt })
  if (versionFour && record.receiptIdentityDigest !== receiptIdentityDigest) {
    throw new Error('OpenCode launch host release receipt identity is corrupt [redacted]')
  }
  return { ...(structuredClone(value) as Omit<OpenCodeLaunchHostReleaseRecord,
    'schemaVersion' | 'obligationId' | 'reservationDigest' | 'receiptIdentityDigest' | 'disposition' | 'releaseState'>),
    schemaVersion: 4, obligationId, reservationDigest, receiptIdentityDigest, hostKeyDigest,
    disposition: legacy ? 'unknown' : record.disposition,
    releaseState: legacy ? 'pending' : record.releaseState } as OpenCodeLaunchHostReleaseRecord
}

function validateLaunchHostCleanupRecord(value: unknown): OpenCodeLaunchHostCleanupRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (value as { receipt?: unknown }).receipt === null) {
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',')
        !== 'attemptId,disposition,generation,hostKeyDigest,hostKeyIdentity,obligationId,payloadHash,receipt,receiptIdentityDigest,releaseState,reservationDigest,schemaVersion'
      || record.schemaVersion !== 4 || typeof record.obligationId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(record.obligationId)
      || typeof record.attemptId !== 'string' || typeof record.payloadHash !== 'string'
      || !Number.isSafeInteger(record.generation) || typeof record.hostKeyIdentity !== 'string'
      || typeof record.reservationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.reservationDigest)
      || typeof record.hostKeyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.hostKeyDigest)
      || record.receiptIdentityDigest !== null
      || record.disposition !== 'unknown' || record.releaseState !== 'pending') {
      throw new Error('OpenCode launch host acquisition obligation is corrupt [redacted]')
    }
    const obligation = structuredClone(value) as OpenCodeLaunchHostAcquisitionObligation
    if (obligation.reservationDigest !== launchHostReservationDigest(obligation)) {
      throw new Error('OpenCode launch host acquisition reservation identity is corrupt [redacted]')
    }
    return obligation
  }
  return validateLaunchHostReleaseRecord(value)
}

function assertMonotonicLaunchHostCleanupTransition(
  predecessor: OpenCodeLaunchHostCleanupRecord | null,
  candidate: OpenCodeLaunchHostCleanupRecord,
): void {
  if (!predecessor) {
    if (candidate.receipt !== null) {
      throw new Error('OpenCode launch host release receipt has no immutable reservation [redacted]')
    }
    return
  }
  const immutable = (record: OpenCodeLaunchHostCleanupRecord) => ({
    obligationId: record.obligationId, reservationDigest: record.reservationDigest,
    attemptId: record.attemptId, payloadHash: record.payloadHash, generation: record.generation,
    hostKeyIdentity: record.hostKeyIdentity, hostKeyDigest: record.hostKeyDigest,
  })
  if (JSON.stringify(immutable(predecessor)) !== JSON.stringify(immutable(candidate))) {
    throw new Error('OpenCode launch host cleanup reservation changed [redacted]')
  }
  if (predecessor.receipt !== null && (candidate.receipt === null
    || predecessor.receiptIdentityDigest !== candidate.receiptIdentityDigest
    || JSON.stringify(predecessor.receipt) !== JSON.stringify(candidate.receipt))) {
    throw new Error('OpenCode launch host cleanup receipt identity changed [redacted]')
  }
  if (predecessor.disposition !== 'unknown' && candidate.disposition !== predecessor.disposition) {
    throw new Error('OpenCode launch host cleanup disposition changed [redacted]')
  }
  if (predecessor.releaseState === 'complete' && candidate.releaseState !== 'complete') {
    throw new Error('OpenCode launch host cleanup completion regressed [redacted]')
  }
  if (candidate.releaseState === 'complete' && candidate.receipt === null) {
    throw new Error('OpenCode launch host cleanup completed without a receipt [redacted]')
  }
}
