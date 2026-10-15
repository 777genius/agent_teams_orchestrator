import { isOriginalTerminalProof, type OriginalTerminalProof } from './OpenCodeV2TerminalSettlement.js'
import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import * as lockfile from '../../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../../utils/atomicWrite.js'
import { assertIntentIdentity, assertSessionAuthority, canonicalExecutionJSON, executionAssert,
  executionHash, executionRecord, type AdmissionRecord, type IntentIdentity, type SessionAuthority } from './OpenCodeV2ExecutionContracts.js'

type Creation = { state: 'reserved' | 'submitting' | 'unknown' | 'accepted' | 'not_submitted'; revision: number }
type Snapshot = {
  schema: 1; generation: 'v2'; authority: SessionAuthority; revision: number; tombstone: boolean
  creation: Creation; admissions: AdmissionRecord[]; slot: string | null
  terminalSettlements?: OriginalTerminalProof[]
  parkedSeries: { requestId: string; intentHash: string }[] | null
}
const MAX_BYTES = 1024 * 1024
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  executionAssert(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'store_unknown')
}
function validate(raw: unknown): Snapshot {
  const s = executionRecord(raw)
  keys(s, ['schema', 'generation', 'authority', 'revision', 'tombstone', 'creation', 'admissions', 'slot', 'parkedSeries'], ['terminalSettlements'])
  executionAssert(s.schema === 1 && s.generation === 'v2', 'store_unknown')
  const authority = s.authority as SessionAuthority
  assertSessionAuthority(authority)
  executionAssert(Number.isSafeInteger(s.revision) && Number(s.revision) >= 0 && typeof s.tombstone === 'boolean', 'store_unknown')
  const c = executionRecord(s.creation)
  keys(c, ['state', 'revision'])
  executionAssert(['reserved', 'submitting', 'unknown', 'accepted', 'not_submitted'].includes(String(c.state)) && Number.isSafeInteger(c.revision) && Number(c.revision) >= 0, 'store_unknown')
  executionAssert(Array.isArray(s.admissions) && s.admissions.length <= 128 && (s.slot === null || typeof s.slot === 'string'), 'store_unknown')
  executionAssert(s.parkedSeries === null || (Array.isArray(s.parkedSeries) && s.parkedSeries.length === 3 && new Set(s.parkedSeries.map(raw => executionRecord(raw).requestId)).size === 3 && s.parkedSeries.every(raw => { const item = executionRecord(raw); keys(item, ['requestId', 'intentHash']); return typeof item.requestId === 'string' && /^[a-f0-9]{64}$/.test(String(item.intentHash)) })), 'store_unknown')
  const ids = new Set<string>(), nativeIDs = new Set<string>()
  for (const rawRecord of s.admissions) {
    const r = executionRecord(rawRecord)
    keys(r, ['identity', 'payloadHash', 'authority', 'state', 'disposition', 'beforeCursor', 'beforeUserIDs', 'cursor', 'complete', 'revision'], ['returnedInboxID', 'projectedUserID', 'nativePayloadHash'])
    const identity = r.identity as IntentIdentity
    assertIntentIdentity(identity); assertSessionAuthority(r.authority as SessionAuthority)
    executionAssert(executionHash(r.authority) === executionHash(authority) && /^[a-f0-9]{64}$/.test(String(r.payloadHash)), 'store_unknown')
    executionAssert(!ids.has(identity.requestId) && !nativeIDs.has(identity.nativeInputID), 'store_unknown')
    ids.add(identity.requestId); nativeIDs.add(identity.nativeInputID)
    executionAssert(['prepared', 'submitting', 'not_submitted', 'accepted', 'unknown'].includes(String(r.state)) &&
      ['accepted', 'pending', 'cancelled', 'rejected', 'unknown'].includes(String(r.disposition)), 'store_unknown')
    executionAssert(typeof r.complete === 'boolean' && Number.isSafeInteger(r.revision) && Number(r.revision) >= 0 &&
      (r.cursor === null || (Number.isSafeInteger(r.cursor) && Number(r.cursor) >= 0)), 'store_unknown')
    executionAssert((r.beforeCursor === null || (Number.isSafeInteger(r.beforeCursor) && Number(r.beforeCursor) >= 0)) && Array.isArray(r.beforeUserIDs) && r.beforeUserIDs.length <= 1600 && r.beforeUserIDs.every(id => typeof id === 'string'), 'store_unknown')
    executionAssert(r.returnedInboxID === undefined || r.returnedInboxID === identity.nativeInputID, 'store_unknown')
    executionAssert(r.nativePayloadHash === undefined || /^[a-f0-9]{64}$/.test(String(r.nativePayloadHash)), 'store_unknown')
    executionAssert(r.projectedUserID === undefined || /^msg_[a-zA-Z0-9]+$/.test(String(r.projectedUserID)), 'store_unknown')
  }
  if (s.terminalSettlements !== undefined) {
    executionAssert(Array.isArray(s.terminalSettlements) && s.terminalSettlements.length <= 128, 'store_unknown')
    const settled = new Set<string>()
    for (const rawProof of s.terminalSettlements) {
      const proof = executionRecord(rawProof)
      keys(proof, ['authorityHash', 'identityHash', 'requestId', 'nativeInputID', 'payloadHash', 'nativePayloadHash', 'projectedUserID', 'expectedRevision', 'cursor', 'cutHash', 'state'])
      const original = (s.admissions as AdmissionRecord[]).find(row => row.identity.requestId === proof.requestId)
      executionAssert(original && !settled.has(original.identity.requestId) &&
        proof.authorityHash === executionHash(authority) && proof.identityHash === executionHash(original.identity) &&
        proof.nativeInputID === original.identity.nativeInputID && proof.payloadHash === original.payloadHash &&
        proof.nativePayloadHash === original.nativePayloadHash && proof.projectedUserID === original.projectedUserID &&
        Number.isSafeInteger(proof.expectedRevision) && Number(proof.expectedRevision) >= 0 &&
        Number.isSafeInteger(proof.cursor) && Number(proof.cursor) >= 0 && /^[a-f0-9]{64}$/.test(String(proof.cutHash)) &&
        ['succeeded', 'failed', 'cancelled'].includes(String(proof.state)), 'store_unknown')
      settled.add(original.identity.requestId)
    }
  }
  executionAssert(s.slot === null || ids.has(s.slot as string), 'store_unknown')
  return raw as Snapshot
}

/** A generation companion in the caller's managed data root. No default HOME,
 * registry adoption, migrations or stale submission replay. Locks protect short
 * local transactions only; HTTP never runs under a filesystem lock. */
export class OpenCodeV2AdmissionStore {
  private constructor(private readonly directory: string, private readonly file: string, private readonly authority: SessionAuthority) { this.authority = structuredClone(authority) }
  static async open(managedDataRoot: string, authority: SessionAuthority): Promise<OpenCodeV2AdmissionStore> {
    // Keep validation, directory identity and durable authority on the same
    // snapshot even if the caller changes its input while filesystem work waits.
    authority = structuredClone(authority)
    assertSessionAuthority(authority)
    executionAssert(path.isAbsolute(managedDataRoot) && await realpath(managedDataRoot) === managedDataRoot)
    const parts = ['opencode', 'v2', 'execution', executionHash({ pin: authority.host.pin, profileEpoch: authority.host.profileEpoch,
      hostInstanceId: authority.host.hostInstanceId, sessionID: authority.sessionID })]
    let directory = managedDataRoot
    for (const part of parts) {
      directory = path.join(directory, part)
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const info = await lstat(directory)
      executionAssert(info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory, 'store_unknown')
    }
    return new OpenCodeV2AdmissionStore(directory, path.join(directory, 'admission.json'), authority)
  }
  assertAuthority(authority: SessionAuthority): void { executionAssert(executionHash(authority) === executionHash(this.authority), 'authority_conflict') }
  get filePath(): string { return this.file }
  private async read(): Promise<Snapshot | null> {
    let leaf
    try { leaf = await lstat(this.file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    executionAssert(leaf.isFile() && !leaf.isSymbolicLink() && leaf.size <= MAX_BYTES, 'store_unknown')
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      executionAssert(stat.dev === leaf.dev && stat.ino === leaf.ino && stat.size <= MAX_BYTES, 'store_unknown')
      const bytes = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      executionAssert(bytesRead <= MAX_BYTES, 'store_unknown')
      const result = validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))))
      executionAssert(executionHash(result.authority) === executionHash(this.authority), 'authority_conflict')
      return result
    } finally { await handle.close() }
  }
  private async transaction<T>(action: (s: Snapshot) => T, initialize = false): Promise<T> {
    const lockPath = path.join(this.directory, 'slot.lock')
    await writeFile(lockPath, '', { flag: 'ax', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    executionAssert((await lstat(lockPath)).isFile() && !(await lstat(lockPath)).isSymbolicLink(), 'store_unknown')
    let compromised = false
    const release = await lockfile.lock(lockPath, { retries: 0, stale: 30_000, update: 10_000, onCompromised: () => { compromised = true } })
    try {
      let s = await this.read()
      if (!s) {
        executionAssert(initialize, 'session_not_reserved')
        s = { schema: 1, generation: 'v2', authority: this.authority, revision: 0, tombstone: false,
          creation: { state: 'reserved', revision: 0 }, admissions: [], slot: null, parkedSeries: null }
      }
      const result = action(s)
      s.revision++
      validate(s)
      executionAssert(Buffer.byteLength(canonicalExecutionJSON(s)) <= MAX_BYTES, 'store_full')
      await writeJsonFileAtomic(this.file, s, { mode: 0o600, assertCommitEligible: () => executionAssert(!compromised, 'lock_compromised') })
      // A sent journal must survive process death before the first request.
      const handle = await open(this.file, process.platform === 'win32' ? 'r+' : 'r')
      try { await handle.sync() } finally { await handle.close() }
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
      executionAssert(!compromised, 'lock_compromised')
      return structuredClone(result)
    } finally { await release() }
  }
  async snapshot(): Promise<Readonly<Snapshot>> { const s = await this.read(); executionAssert(s, 'session_not_reserved'); return s }
  async reserveSession(): Promise<Creation> { return this.transaction(s => s.creation, true) }
  async markCreation(expected: number, state: Creation['state']): Promise<Creation> {
    return this.transaction(s => {
      executionAssert(s.creation.revision === expected && !s.tombstone, 'creation_conflict')
      executionAssert(s.creation.state === 'reserved' || s.creation.state === 'submitting' || s.creation.state === 'unknown', 'creation_conflict')
      s.creation = { state, revision: expected + 1 }; return s.creation
    })
  }
  async reserveParkedSeries(intents: readonly { identity: IntentIdentity; payloadHash: string }[]): Promise<void> {
    intents = structuredClone(intents)
    await this.transaction(s => {
      executionAssert(!s.tombstone && s.creation.state === 'accepted' && s.slot === null && s.admissions.length === 0 && s.parkedSeries === null, 'session_fenced')
      executionAssert(intents.length === 3 && new Set(intents.map(i => i.identity.requestId)).size === 3)
      s.parkedSeries = intents.map(i => { assertIntentIdentity(i.identity); return { requestId: i.identity.requestId, intentHash: executionHash(i) } })
    })
  }
  async reserve(identity: IntentIdentity, payloadHash: string, boundary: { beforeCursor: number | null; beforeUserIDs: string[] } = { beforeCursor: null, beforeUserIDs: [] }): Promise<AdmissionRecord> {
    identity = structuredClone(identity)
    boundary = structuredClone(boundary)
    assertIntentIdentity(identity)
    keys(executionRecord(boundary), ['beforeCursor', 'beforeUserIDs'])
    return this.transaction(s => {
      const existing = s.admissions.find(r => r.identity.requestId === identity.requestId || r.identity.nativeInputID === identity.nativeInputID)
      if (existing) {
        executionAssert(executionHash(existing.identity) === executionHash(identity) && existing.payloadHash === payloadHash, 'intent_conflict')
        return existing
      }
      const previous = s.admissions.find(r => r.identity.requestId === s.slot)
      const seriesIndex = s.parkedSeries?.findIndex(i => i.requestId === identity.requestId) ?? -1
      const seriesNext = seriesIndex > 0 && s.parkedSeries?.[seriesIndex - 1]?.requestId === s.slot && previous?.state === 'accepted' && ['accepted', 'pending'].includes(previous.disposition)
      executionAssert(!s.tombstone && s.creation.state === 'accepted' && (s.slot === null || seriesNext), 'session_fenced')
      if (s.parkedSeries) executionAssert(seriesIndex === s.admissions.length && s.parkedSeries[seriesIndex]?.intentHash === executionHash({ identity, payloadHash }), 'parked_series_conflict')
      executionAssert(/^[a-f0-9]{64}$/.test(payloadHash))
      const record: AdmissionRecord = { identity, payloadHash, authority: this.authority, state: 'prepared', disposition: 'pending',
        beforeCursor: boundary.beforeCursor, beforeUserIDs: boundary.beforeUserIDs, cursor: null, complete: false, revision: 0 }
      s.admissions.push(record); s.slot = identity.requestId; return record
    })
  }
  async submitting(requestId: string, expected: number): Promise<AdmissionRecord> {
    return this.transaction(s => {
      const r = s.admissions.find(r => r.identity.requestId === requestId)
      executionAssert(r && r.revision === expected && r.state === 'prepared' && s.slot === requestId && !s.tombstone, 'admission_conflict')
      r.state = 'submitting'; r.revision++; return r
    })
  }
  async update(requestId: string, expected: number, patch: Pick<AdmissionRecord, 'state' | 'disposition' | 'complete'> &
    Partial<Pick<AdmissionRecord, 'returnedInboxID' | 'projectedUserID' | 'nativePayloadHash' | 'cursor'>>): Promise<AdmissionRecord> {
    patch = structuredClone(patch)
    keys(executionRecord(patch), ['state', 'disposition', 'complete'], ['returnedInboxID', 'projectedUserID', 'nativePayloadHash', 'cursor'])
    return this.transaction(s => {
      const r = s.admissions.find(r => r.identity.requestId === requestId)
      executionAssert(r && r.revision === expected && (s.slot === requestId || r.state === 'accepted'), 'admission_conflict')
      executionAssert(patch.cursor === undefined || patch.complete, 'incomplete_cursor')
      executionAssert(patch.cursor === undefined || r.cursor === null || (patch.cursor !== null && patch.cursor >= r.cursor), 'cursor_regression')
      executionAssert(patch.nativePayloadHash === undefined || r.nativePayloadHash === undefined || patch.nativePayloadHash === r.nativePayloadHash, 'native_payload_conflict')
      Object.assign(r, patch); r.revision++
      // Native cancellation-before-delivery/rejection has no task settlement.
      // Every admitted input retains its slot until a separate qualified terminal
      // owner resolves it. This slice never turns acceptance into settlement.
      if (s.slot === requestId && (r.state === 'not_submitted' || r.disposition === 'cancelled')) s.slot = null
      return r
    })
  }
  async settleOriginalTerminal(proof: OriginalTerminalProof): Promise<AdmissionRecord> {
    executionAssert(isOriginalTerminalProof(proof), 'terminal_proof_not_owned')
    return this.transaction(s => {
      const original = s.admissions.find(row => row.identity.requestId === proof.requestId)
      executionAssert(original && proof.authorityHash === executionHash(this.authority) &&
        proof.identityHash === executionHash(original.identity) && proof.nativeInputID === original.identity.nativeInputID &&
        proof.payloadHash === original.payloadHash && proof.nativePayloadHash === original.nativePayloadHash &&
        proof.projectedUserID === original.projectedUserID, 'terminal_identity_conflict')
      // An old proof or old observation cannot release the successor's slot.
      if (s.terminalSettlements?.some(row => row.requestId === proof.requestId)) return original
      executionAssert(!s.tombstone && original.revision === proof.expectedRevision && original.state === 'accepted' &&
        original.disposition === 'accepted' && original.complete && s.slot === proof.requestId &&
        proof.cursor >= (original.cursor ?? 0), 'terminal_revision_conflict')
      s.terminalSettlements ??= []; s.terminalSettlements.push({ ...proof }); s.slot = null
      return original
    })
  }
  async fenceStop(): Promise<readonly string[]> {
    return this.transaction(s => {
      s.tombstone = true
      for (const r of s.admissions) if (r.state === 'prepared') { r.state = 'not_submitted'; r.disposition = 'cancelled'; r.revision++ }
      if (s.admissions.find(r => r.identity.requestId === s.slot)?.state === 'not_submitted') s.slot = null
      // Validated terminal settlements already bind this exact original input.
      // Native inbox cancellation only accepts inputs that remain pending.
      return s.admissions.filter(r => r.state !== 'not_submitted' &&
        !s.terminalSettlements?.some(proof => proof.requestId === r.identity.requestId)).map(r => r.identity.nativeInputID)
    })
  }
}
