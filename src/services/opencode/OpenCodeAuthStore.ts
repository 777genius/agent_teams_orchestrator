import { readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { resolveOpenCodeAuthCoordinationPath, withOpenCodeAuthCoordinationLock } from './OpenCodeAuthCoordinationLock.js'
import { throwOpenCodeAbortReason } from './OpenCodeRuntimeDeadline.js'

import type { OpenCodeApiAuthInput, OpenCodeConnectedProvider, OpenCodeSessionRecord } from './types.js'

export type OpenCodeAuthCredential = Record<string, unknown>
type OpenCodeOAuthCredential = OpenCodeAuthCredential & {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}
type OpenCodeAuthEntry = OpenCodeAuthCredential
export type OpenCodeAuthStore = Record<string, OpenCodeAuthEntry>

export type OpenCodeOAuthSaveOwner = {
  projectPath: string
  purpose: 'execution_probe' | 'launch_runtime'
  scopeToken: string
}

export type OpenCodeOAuthNativeSessionOwner = {
  record: OpenCodeSessionRecord
  baseUrl: string
  pid: number
  processStartedAtMs: number
  messageId: string
  noReply: boolean
}

export type OpenCodeOAuthNativeProbeOwner = {
  projectPath: string
  scopeToken: string
  profileRootKey: string
  hostKey: string
  baseUrl: string
  pid: number
  processStartedAtMs: number
  sessionId: string
  messageId: string
  selectedModel: string
}

type OpenCodeOAuthSaveReceipt = {
  version: 1
  operationId: string
  owner: OpenCodeOAuthSaveOwner
  globalAuthPath: string
  managedAuthPath: string
  sourceAuthPaths: string[]
  before: Array<OpenCodeAuthCredential | null>
  predecessor: OpenCodeAuthCredential
  successor: OpenCodeAuthCredential | null
  nativeSession?: OpenCodeOAuthNativeSessionOwner
  nativeProbe?: OpenCodeOAuthNativeProbeOwner
}

function oauthSaveReceiptPath(globalAuthPath: string): string {
  return `${globalAuthPath}.agent-teams-xai-oauth-save.json`
}

function revokedOAuthAdmissionPath(globalAuthPath: string, predecessor: OpenCodeOAuthCredential): string {
  // The single-use refresh token remains fenced even if other fields change.
  // No peer enumeration: admission consults only its own predecessor's fence.
  return `${oauthSaveReceiptPath(globalAuthPath)}.revoked-${createHash('sha256').update(predecessor.refresh).digest('hex')}`
}

// Only a completed scope comparison may revoke publication. I/O errors and
// malformed ownership evidence remain failures, never permission to discard it.
export class OpenCodeOAuthPublicationRevokedError extends Error {}

// A pre-submission native owner or terminal result, never arbitrary auth-file recovery.
// The manager supplies the exact configured sources and revalidates the complete
// originating scope against current configuration before any saved write.
export async function recoverOpenCodeOwnedOAuthSave(input: {
  globalAuthPath: string
  sourceAuthPaths: readonly string[]
  assertOwner: (owner: OpenCodeOAuthSaveOwner, predecessor: OpenCodeAuthCredential,
    managedAuthPath: string) => Promise<void>
  isNativeSessionSettled?: (owner: OpenCodeOAuthNativeSessionOwner) => Promise<boolean>
  isNativeProbeSettled?: (owner: OpenCodeOAuthNativeProbeOwner) => Promise<boolean>
  isNativeSessionUnsubmitted?: (owner: OpenCodeOAuthNativeSessionOwner) => Promise<boolean>
  isNativeProbeUnsubmitted?: (owner: OpenCodeOAuthNativeProbeOwner) => Promise<boolean>
  sessionToRelease?: OpenCodeSessionRecord
}): Promise<boolean> {
  const receiptPath = oauthSaveReceiptPath(input.globalAuthPath)
  // Avoid creating a coordination database on ordinary read-only filesystem
  // sources when there has never been an owned pending publication.
  if (await readOptionalJson(receiptPath) === null) return false
  return withAuthStoreWriteLock(input.globalAuthPath, async () => {
    const raw = await readOptionalJson(receiptPath)
    if (raw === null) return false
    const receipt = raw as OpenCodeOAuthSaveReceipt
    if (!receipt || receipt.version !== 1 || typeof receipt.operationId !== 'string'
      || !receipt.owner || !['execution_probe', 'launch_runtime'].includes(receipt.owner.purpose)
      || typeof receipt.owner.projectPath !== 'string'
      || typeof receipt.owner.scopeToken !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.owner.scopeToken)
      || receipt.globalAuthPath !== input.globalAuthPath
      || typeof receipt.managedAuthPath !== 'string'
      || resolveOpenCodeAuthCoordinationPath(receipt.managedAuthPath) !== path.resolve(input.globalAuthPath)
      || !Array.isArray(receipt.sourceAuthPaths)
      || receipt.sourceAuthPaths.some(p => typeof p !== 'string' || !path.isAbsolute(p))
      || new Set(receipt.sourceAuthPaths).size !== receipt.sourceAuthPaths.length
      || !receipt.sourceAuthPaths.includes(input.globalAuthPath)
      || !Array.isArray(receipt.before) || receipt.before.length !== receipt.sourceAuthPaths.length
      || !isValidOpenCodeOAuthCredential(receipt.predecessor)
      || (receipt.successor === null ? (!!receipt.nativeSession === !!receipt.nativeProbe) : !isValidOpenCodeOAuthCredential(receipt.successor))
      || (receipt.successor !== null && receipt.predecessor.accountId !== receipt.successor.accountId)
      || !receipt.before.some(c => isDeepStrictEqual(c, receipt.predecessor))
      || receipt.before.some(c => c !== null && !isDeepStrictEqual(c, receipt.predecessor))) {
      throw new Error('OpenCode OAuth pending saved publication owner is invalid')
    }
    if (input.sessionToRelease) {
      const requested = input.sessionToRelease
      if (receipt.owner.scopeToken !== requested.profileScope?.scopeToken
        || receipt.owner.projectPath !== requested.projectPath) return false
      if (receipt.successor === null) {
        const native = receipt.nativeSession?.record
        if (!native || native.teamId !== requested.teamId || native.laneId !== requested.laneId
          || native.memberName !== requested.memberName || native.runId !== requested.runId
          || native.hostKey !== requested.hostKey || native.opencodeSessionId !== requested.opencodeSessionId) return false
      }
    }
    const localPaths = receipt.sourceAuthPaths.filter(p => p !== input.globalAuthPath).sort()
    if (receipt.sourceAuthPaths.some(p => resolveOpenCodeAuthCoordinationPath(p) !== path.resolve(p))) {
      throw new Error('OpenCode OAuth pending saved publication has a scoped destination')
    }
    const rootKey = `scope-${createHash('sha256').update(JSON.stringify({
      projectPath: receipt.owner.projectPath, scopeToken: receipt.owner.scopeToken,
    })).digest('hex')}`
    if (receipt.managedAuthPath !== path.join(path.dirname(input.globalAuthPath),
      'profiles', rootKey, 'data', 'opencode', 'auth.json')) {
      throw new Error('OpenCode OAuth pending saved publication managed owner is invalid')
    }
    const retireRevokedPublication = async () => {
      // A terminal receipt has no remaining native operation to fence. Pending
      // owners keep their exact admission fence; fresh resolution in a changed
      // authority must not attempt to publish their result.
      if (receipt.successor === null) {
        // Revocation forbids publishing into the new authority, but is not
        // evidence that the old native writer stopped. Preserve its receipt
        // before freeing the active slot for an unrelated fresh credential.
        await writeJsonFileAtomic(revokedOAuthAdmissionPath(input.globalAuthPath,
          receipt.predecessor as OpenCodeOAuthCredential), receipt, { mode: 0o600 })
      }
      await rm(receiptPath)
      return false
    }
    if (!isDeepStrictEqual(receipt.sourceAuthPaths, Array.from(new Set(input.sourceAuthPaths)))) {
      return retireRevokedPublication()
    }
    const publish = async (): Promise<boolean> => {
      const current = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
      const matches = (credential: OpenCodeAuthCredential | undefined, index: number) =>
        receipt.before[index] === null ? credential === undefined
          : isDeepStrictEqual(credential, receipt.predecessor) || isDeepStrictEqual(credential, receipt.successor)
      if (current.some((store, index) => !matches(store.xai, index))) {
        // A new login, logout or account/source replacement supersedes this
        // completion. Discard only the old receipt, never the current authority.
        return retireRevokedPublication()
      }
      try {
        await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
      } catch (error) {
        if (error instanceof OpenCodeOAuthPublicationRevokedError) return retireRevokedPublication()
        throw error
      }
      if (receipt.successor === null) {
        const settled = async (unsubmitted = false) => {
          const sessionCheck = unsubmitted ? input.isNativeSessionUnsubmitted : input.isNativeSessionSettled
          const probeCheck = unsubmitted ? input.isNativeProbeUnsubmitted : input.isNativeProbeSettled
          if (receipt.nativeSession) {
            const nativeOwner = receipt.nativeSession
            return !!nativeOwner.record && nativeOwner.record.profileScope?.scopeToken === receipt.owner.scopeToken
              && nativeOwner.record.projectPath === receipt.owner.projectPath
              && !!nativeOwner.record.runId && !!nativeOwner.record.opencodeSessionId
              && typeof nativeOwner.messageId === 'string' && !!nativeOwner.messageId
              && typeof nativeOwner.baseUrl === 'string' && Number.isSafeInteger(nativeOwner.pid) && nativeOwner.pid > 0
              && Number.isFinite(nativeOwner.processStartedAtMs) && nativeOwner.processStartedAtMs > 0
              && typeof nativeOwner.noReply === 'boolean'
              && !!sessionCheck && await sessionCheck(nativeOwner)
          }
          const nativeOwner = receipt.nativeProbe!
          return nativeOwner.scopeToken === receipt.owner.scopeToken && nativeOwner.projectPath === receipt.owner.projectPath
            && nativeOwner.profileRootKey === path.basename(path.dirname(path.dirname(path.dirname(receipt.managedAuthPath))))
            && !!probeCheck && await probeCheck(nativeOwner)
        }
        if (!await settled()) {
          // A known native session with supported canonical history can prove
          // the armed message was never admitted after its exact writer exited.
          // PID absence alone, a live idle endpoint, or changed auth cannot
          // abandon this receipt. Never publish/restore C0 on this path.
          const unchanged = async () => isDeepStrictEqual(await readOpenCodeAuthCredential({
            authPath: receipt.managedAuthPath, providerId: 'xai',
          }), receipt.predecessor)
          if (!await unchanged() || !await settled(true)) {
            throw new Error('OpenCode OAuth native session or probe is still pending or no longer owned')
          }
          await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
          if (!await settled(true) || !await unchanged()) {
            throw new Error('OpenCode OAuth unsubmitted native ownership changed')
          }
          const saved = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
          if (saved.some((store, index) => !isDeepStrictEqual(store.xai ?? null, receipt.before[index]))) {
            throw new Error('OpenCode OAuth unsubmitted saved authority changed')
          }
          await rm(receiptPath)
          return false
        }
        const successor = await readOpenCodeAuthCredential({ authPath: receipt.managedAuthPath, providerId: 'xai' })
        if (!isValidOpenCodeOAuthCredential(successor) || successor.accountId !== receipt.predecessor.accountId) {
          throw new Error('OpenCode OAuth pending native session did not retain its OAuth account')
        }
        // The pre-submission receipt fenced cooperating consumers while this
        // exact session ran. Only its verified terminal output becomes a saved
        // publication receipt; merely finding changed auth bytes is insufficient.
        await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
        if (!await settled()) {
          throw new Error('OpenCode OAuth native session ownership changed during settlement')
        }
        receipt.successor = successor
        await writeJsonFileAtomic(receiptPath, receipt, { mode: 0o600 })
      }
      const native = await readOpenCodeAuthCredential({ authPath: receipt.managedAuthPath, providerId: 'xai' })
      if (!isDeepStrictEqual(native, receipt.successor)) {
        throw new Error('OpenCode OAuth pending native result changed')
      }
      for (let index = 0; index < receipt.sourceAuthPaths.length; index += 1) {
        if (receipt.before[index] === null) continue
        await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
        const store = await readOpenCodeAuthStore(receipt.sourceAuthPaths[index])
        if (!matches(store.xai, index)) {
          throw new Error('OpenCode OAuth pending saved publication was superseded')
        }
        if (!isDeepStrictEqual(store.xai, receipt.successor)) {
          await writeOpenCodeAuthStore(receipt.sourceAuthPaths[index], { ...store, xai: receipt.successor })
        }
      }
      const stores = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
      if (stores.some((store, index) => receipt.before[index] === null ? store.xai !== undefined
        : !isDeepStrictEqual(store.xai, receipt.successor))
        || !isDeepStrictEqual(mergeOpenCodeManagedAuthSources({ sourceAuthPaths: receipt.sourceAuthPaths,
        sourceStores: stores, globalAuthPath: input.globalAuthPath }).xai, receipt.successor)) {
        throw new Error('OpenCode OAuth recovered successor was not selected')
      }
      await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
      await rm(receiptPath)
      return true
    }
    const lock = (index: number): Promise<boolean> => index < localPaths.length
      ? withAuthStoreWriteLock(localPaths[index], () => lock(index + 1)) : publish()
    return lock(0)
  })
}

async function withAuthStoreWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  return withOpenCodeAuthCoordinationLock({
    authPath: filePath,
    operation,
    description: 'OpenCode auth store coordination lock',
    abortSignal,
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeProviderId(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return normalized && /^[a-z0-9][a-z0-9._-]*$/i.test(normalized) ? normalized : null
}

export async function withOpenCodeOAuthRefreshLock<T>(input: {
  authPath: string
  providerId: string
  operation: () => Promise<T>
  abortSignal?: AbortSignal
}): Promise<T> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode OAuth refresh provider id is invalid')
  }

  return withOpenCodeAuthCoordinationLock({
    authPath: input.authPath,
    operation: input.operation,
    description: `OpenCode ${providerId} OAuth refresh coordination lock`,
    abortSignal: input.abortSignal,
  })
}

export function isValidOpenCodeOAuthCredential(
  credential: OpenCodeAuthCredential | null | undefined,
): credential is OpenCodeOAuthCredential {
  return credential?.type === 'oauth'
    && typeof credential.access === 'string' && credential.access.trim().length > 0
    && typeof credential.refresh === 'string' && credential.refresh.trim().length > 0
    && typeof credential.expires === 'number' && Number.isFinite(credential.expires)
    && credential.expires >= 0
}

// Internal native-operation boundary. The caller must own the exact host and
// wait for its operation to settle before returning. File change alone, outside
// this boundary, is deliberately not a refresh provenance/recovery mechanism.
export async function withOpenCodeOwnedOAuthRefresh<T>(input: {
  managedAuthPath: string
  globalAuthPath: string
  sourceAuthPaths: readonly string[]
  providerId: string
  predecessor: OpenCodeAuthCredential
  assertOwnership: () => Promise<void>
  assertPublicationOwnership?: () => Promise<void>
  operation: (armNativeSession: (owner: OpenCodeOAuthNativeSessionOwner) => Promise<void>,
    armNativeProbe: (owner: OpenCodeOAuthNativeProbeOwner) => Promise<void>) => Promise<T>
  isNativeSettled?: (value: T) => boolean
  allowNativeContinuation?: boolean
  recoveryOwner?: OpenCodeOAuthSaveOwner
  abortSignal?: AbortSignal
}): Promise<T> {
  input = {
    ...input,
    sourceAuthPaths: [...input.sourceAuthPaths],
    predecessor: structuredClone(input.predecessor),
    recoveryOwner: input.recoveryOwner ? structuredClone(input.recoveryOwner) : undefined,
  }
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId || !isValidOpenCodeOAuthCredential(input.predecessor)) {
    throw new Error('OpenCode owned refresh requires a valid OAuth predecessor')
  }
  // Copy before awaiting: callers cannot replace an expectation during a read.
  const predecessor = structuredClone(input.predecessor)
  const sourceAuthPaths = Array.from(new Set(input.sourceAuthPaths))
  if (!sourceAuthPaths.includes(input.globalAuthPath)
    || sourceAuthPaths.includes(input.managedAuthPath)
    || resolveOpenCodeAuthCoordinationPath(input.managedAuthPath) !== path.resolve(input.globalAuthPath)
    || sourceAuthPaths.some(p => resolveOpenCodeAuthCoordinationPath(p) !== path.resolve(p))) {
    throw new Error('OpenCode OAuth saved authority paths are invalid')
  }
  const check = async () => {
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    await input.assertOwnership()
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
  }
  // The app lock is always outermost, matching profile preparation/login. Local
  // saved sources use the existing writer locks too; no peer roots are read.
  const lockPaths = [input.globalAuthPath,
    ...sourceAuthPaths.filter(p => p !== input.globalAuthPath).sort()]
  const lock = (index: number): Promise<T> => index < lockPaths.length
    ? withAuthStoreWriteLock(lockPaths[index], () => lock(index + 1), input.abortSignal)
    : run()
  const run = async (): Promise<T> => {
    await check()
    if (input.recoveryOwner && await readOptionalJson(oauthSaveReceiptPath(input.globalAuthPath)) !== null) {
      throw new Error('OpenCode OAuth saved publication is pending; resolve fresh authority before native execution')
    }
    if (input.recoveryOwner && await readOptionalJson(revokedOAuthAdmissionPath(input.globalAuthPath,
      predecessor as OpenCodeOAuthCredential)) !== null) {
      throw new Error('OpenCode OAuth predecessor has a revoked pending native admission; use fresh authentication')
    }
    const before = await Promise.all(sourceAuthPaths.map(readOpenCodeAuthStore))
    const selected = mergeOpenCodeManagedAuthSources({
      sourceAuthPaths, sourceStores: before, globalAuthPath: input.globalAuthPath,
    })[providerId]
    const managed = await readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId })
    if (!isDeepStrictEqual(selected, predecessor) || !isDeepStrictEqual(managed, predecessor)) {
      throw new Error('OpenCode OAuth predecessor changed before native execution')
    }
    // Saved copies of precisely C0 form this authority. A different credential
    // is a source/account conflict even when its expiry would lose the merge.
    // Updating exact copies is necessary for equal/lower-expiry C1 to win fresh
    // resolution, and does not authorize replacing any other saved credential.
    const ownerIndices = before.flatMap((store, index) => {
      const credential = store[providerId]
      if (credential && !isDeepStrictEqual(credential, predecessor)) {
        throw new Error('OpenCode OAuth saved sources disagree')
      }
      return credential ? [index] : []
    })
    if (!ownerIndices.length) throw new Error('OpenCode OAuth saved owner is missing')
    await check()
    let nativeReceipt: OpenCodeOAuthSaveReceipt | null = null
    const armNativeOwner = async (native: Pick<OpenCodeOAuthSaveReceipt, 'nativeSession' | 'nativeProbe'>) => {
      if (!input.recoveryOwner || nativeReceipt || providerId !== 'xai') {
        throw new Error('OpenCode OAuth native admission is invalid')
      }
      const checkAdmission = async () => {
        await check()
        const current = await Promise.all(sourceAuthPaths.map(readOpenCodeAuthStore))
        const native = await readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId })
        if (!isDeepStrictEqual(native, predecessor)
          || current.some((store, index) => !isDeepStrictEqual(store[providerId], before[index][providerId]))) {
          throw new Error('OpenCode OAuth predecessor changed before native submission')
        }
        await check()
      }
      await checkAdmission()
      nativeReceipt = {
        version: 1, operationId: randomUUID(), owner: input.recoveryOwner,
        globalAuthPath: input.globalAuthPath, managedAuthPath: input.managedAuthPath,
        sourceAuthPaths, before: before.map(store => store[providerId] ?? null), predecessor,
        successor: null, ...structuredClone(native),
      }
      await writeJsonFileAtomic(oauthSaveReceiptPath(input.globalAuthPath), nativeReceipt, { mode: 0o600 })
      try {
        await checkAdmission()
      } catch (error) {
        // The arm has not returned permission to submit native work yet.
        await rm(oauthSaveReceiptPath(input.globalAuthPath))
        throw error
      }
    }
    const armNativeSession = async (owner: OpenCodeOAuthNativeSessionOwner) => {
      if (!input.recoveryOwner || owner.record.profileScope?.scopeToken !== input.recoveryOwner.scopeToken
        || owner.record.projectPath !== input.recoveryOwner.projectPath
        || !owner.record.runId || !owner.record.opencodeSessionId || !owner.messageId
        || !Number.isFinite(owner.processStartedAtMs) || owner.processStartedAtMs <= 0
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
        throw new Error('OpenCode OAuth native session admission is invalid')
      }
      await armNativeOwner({ nativeSession: owner })
    }
    const armNativeProbe = async (owner: OpenCodeOAuthNativeProbeOwner) => {
      if (!input.recoveryOwner || owner.scopeToken !== input.recoveryOwner.scopeToken
        || owner.projectPath !== input.recoveryOwner.projectPath || !owner.sessionId || !owner.messageId
        || !Number.isFinite(owner.processStartedAtMs) || owner.processStartedAtMs <= 0
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
        throw new Error('OpenCode OAuth native probe admission is invalid')
      }
      await armNativeOwner({ nativeProbe: owner })
    }
    const value = await input.operation(armNativeSession, armNativeProbe)
    if (input.isNativeSettled && !input.isNativeSettled(value)) {
      if (nativeReceipt && input.allowNativeContinuation) {
        if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
        return value
      }
      throw new Error('OpenCode native OAuth operation settlement is unconfirmed')
    }
    // Once a controlled native operation has settled, saving its successor is
    // cleanup of a potentially consumed single-use token. Cancellation still
    // rejects the caller, but must not strand C1 behind saved, consumed C0.
    // Ownership revocation is different: it always prevents publication.
    await input.assertOwnership()
    const successor = await readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId })
    if (!isValidOpenCodeOAuthCredential(successor)) {
      throw new Error('OpenCode native refresh did not retain valid OAuth')
    }
    if (predecessor.accountId !== successor.accountId) {
      throw new Error('OpenCode native refresh changed OAuth account')
    }
    const current = await Promise.all(sourceAuthPaths.map(readOpenCodeAuthStore))
    if (current.some((store, index) => !isDeepStrictEqual(store[providerId], before[index][providerId]))) {
      throw new Error('OpenCode OAuth saved authority changed during native execution')
    }
    await input.assertOwnership()
    if (isDeepStrictEqual(successor, predecessor)) {
      if (nativeReceipt) await rm(oauthSaveReceiptPath(input.globalAuthPath))
      if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
      return value
    }
    const next = current.map((store, index) => ownerIndices.includes(index)
      ? { ...store, [providerId]: successor } : store)
    const nextSelected = mergeOpenCodeManagedAuthSources({
      sourceAuthPaths, sourceStores: next, globalAuthPath: input.globalAuthPath,
    })[providerId]
    if (!isDeepStrictEqual(nextSelected, successor)) {
      throw new Error('OpenCode OAuth successor would not be selected on reopen')
    }
    if (input.recoveryOwner) {
      if (providerId !== 'xai') throw new Error('OpenCode owned save recovery supports xAI only')
      const receipt: OpenCodeOAuthSaveReceipt = {
        version: 1, operationId: nativeReceipt?.operationId ?? randomUUID(), owner: structuredClone(input.recoveryOwner),
        globalAuthPath: input.globalAuthPath, managedAuthPath: input.managedAuthPath,
        sourceAuthPaths, before: before.map(store => store[providerId] ?? null),
        predecessor, successor,
      }
      await writeJsonFileAtomic(oauthSaveReceiptPath(input.globalAuthPath), receipt, { mode: 0o600 })
    }
    await input.assertOwnership()
    for (const index of ownerIndices) {
      // Scope/auth identity necessarily changes at the first publication. Do
      // not reinterpret the old token as a successor token during this loop.
      await input.assertPublicationOwnership?.()
      // Re-read immediately before each atomic write. Unrelated provider edits
      // are retained; a changed selected-provider entry is never overwritten.
      const store = await readOpenCodeAuthStore(sourceAuthPaths[index])
      if (!isDeepStrictEqual(store[providerId], predecessor)) {
        throw new Error('OpenCode OAuth saved predecessor changed before publication')
      }
      await writeOpenCodeAuthStore(sourceAuthPaths[index], { ...store, [providerId]: successor })
    }
    const persisted = await Promise.all(sourceAuthPaths.map(readOpenCodeAuthStore))
    if (persisted.some((store, index) => !isDeepStrictEqual(store[providerId],
      ownerIndices.includes(index) ? successor : before[index][providerId]))
      || !isDeepStrictEqual(mergeOpenCodeManagedAuthSources({
      sourceAuthPaths, sourceStores: persisted, globalAuthPath: input.globalAuthPath,
    })[providerId], successor)) {
      throw new Error('OpenCode OAuth successor publication was superseded')
    }
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    await input.assertPublicationOwnership?.()
    if (input.recoveryOwner) await rm(oauthSaveReceiptPath(input.globalAuthPath))
    return value
  }
  return lock(0)
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    if (!raw.trim()) {
      return {}
    }
    return JSON.parse(raw) as unknown
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function readOpenCodeAuthStore(filePath: string): Promise<OpenCodeAuthStore> {
  const parsed = await readOptionalJson(filePath)
  if (!parsed) {
    return {}
  }

  const record = asRecord(parsed)
  if (!record) {
    throw new Error(`OpenCode auth store is not a JSON object: ${filePath}`)
  }

  const authStore: OpenCodeAuthStore = {}
  for (const [rawProviderId, rawEntry] of Object.entries(record)) {
    const providerId = normalizeProviderId(rawProviderId)
    const entry = asRecord(rawEntry)
    if (!providerId || !entry) {
      continue
    }
    authStore[providerId] = { ...entry }
  }
  return authStore
}

export async function readOpenCodeAuthCredential(input: {
  authPath: string
  providerId: string
}): Promise<OpenCodeAuthCredential | null> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  const authStore = await readOpenCodeAuthStore(input.authPath)
  const credential = authStore[providerId]
  return credential ? { ...credential } : null
}

async function writeOpenCodeAuthStore(
  filePath: string,
  authStore: OpenCodeAuthStore,
): Promise<void> {
  await writeJsonFileAtomic(filePath, authStore, { indent: 2, mode: 0o600 })
}

export function mergeOpenCodeAuthStores(input: {
  source: OpenCodeAuthStore
  managed: OpenCodeAuthStore
}): OpenCodeAuthStore {
  return {
    ...input.managed,
    ...input.source,
  }
}

function getOpenCodeOAuthExpires(credential: OpenCodeAuthCredential | undefined): number | null {
  if (credential?.type !== 'oauth') {
    return null
  }
  const expires = credential.expires
  return typeof expires === 'number' && Number.isFinite(expires) && expires >= 0
    ? expires
    : null
}

function pickFreshestOpenCodeOAuthCredential(
  current: OpenCodeAuthCredential,
  candidate: OpenCodeAuthCredential,
  preferCandidateOnTie: boolean,
): OpenCodeAuthCredential {
  const currentExpires = getOpenCodeOAuthExpires(current)
  const candidateExpires = getOpenCodeOAuthExpires(candidate)
  if (currentExpires === null || candidateExpires === null) {
    return preferCandidateOnTie ? candidate : current
  }
  if (candidateExpires === currentExpires) {
    return preferCandidateOnTie ? candidate : current
  }
  return candidateExpires > currentExpires ? candidate : current
}

export function mergeOpenCodeAuthStoresWithFreshestOAuth(input: {
  source: OpenCodeAuthStore
  managed: OpenCodeAuthStore
}): OpenCodeAuthStore {
  const merged = { ...input.managed }
  for (const [providerId, sourceCredential] of Object.entries(input.source)) {
    const managedCredential = merged[providerId]
    merged[providerId] = managedCredential?.type === 'oauth' && sourceCredential.type === 'oauth'
      ? pickFreshestOpenCodeOAuthCredential(managedCredential, sourceCredential, true)
      : sourceCredential
  }
  return merged
}

export function mergeOpenCodeManagedAuthSources(input: {
  sourceAuthPaths: readonly string[]
  sourceStores: readonly OpenCodeAuthStore[]
  globalAuthPath: string
}): OpenCodeAuthStore {
  let expected: OpenCodeAuthStore = {}
  for (const source of input.sourceStores) {
    expected = mergeOpenCodeAuthStoresWithFreshestOAuth({ source, managed: expected })
  }

  const globalSourceIndex = input.sourceAuthPaths.indexOf(input.globalAuthPath)
  const globalSourceStore = globalSourceIndex >= 0 ? input.sourceStores[globalSourceIndex] : {}
  // API credentials explicitly saved through Agent Teams belong to the app-global
  // store and must shadow stale credentials imported from the user's OpenCode store.
  // OAuth remains freshness-based because OpenCode may refresh it outside the app.
  for (const [providerId, credential] of Object.entries(globalSourceStore)) {
    if (credential.type === 'api') {
      expected[providerId] = credential
    }
  }

  return expected
}

export function doesOpenCodeAuthStoreIncludeSource(input: {
  source: OpenCodeAuthStore
  managed: OpenCodeAuthStore
}): boolean {
  for (const [providerId, sourceEntry] of Object.entries(input.source)) {
    const managedEntry = input.managed[providerId]
    if (!managedEntry || JSON.stringify(managedEntry) !== JSON.stringify(sourceEntry)) {
      return false
    }
  }
  return true
}

export async function syncOpenCodeManagedAuthStore(input: {
  sourceAuthPath: string
  managedAuthPath: string
}): Promise<void> {
  await withAuthStoreWriteLock(input.managedAuthPath, async () => {
    const source = await readOpenCodeAuthStore(input.sourceAuthPath)
    const managed = await readOpenCodeAuthStore(input.managedAuthPath)
    const merged = mergeOpenCodeAuthStores({ source, managed })

    if (JSON.stringify(merged) !== JSON.stringify(managed)) {
      await writeOpenCodeAuthStore(input.managedAuthPath, merged)
    }
  })
}

export async function reconcileOpenCodeManagedAuthStore(input: {
  sourceAuthPaths: readonly string[]
  managedAuthPath: string
}): Promise<void> {
  await withAuthStoreWriteLock(input.managedAuthPath, async () => {
    let expected: OpenCodeAuthStore = {}
    for (const sourceAuthPath of input.sourceAuthPaths) {
      expected = mergeOpenCodeAuthStores({
        source: await readOpenCodeAuthStore(sourceAuthPath),
        managed: expected,
      })
    }

    const managed = await readOpenCodeAuthStore(input.managedAuthPath)
    if (JSON.stringify(expected) !== JSON.stringify(managed)) {
      await writeOpenCodeAuthStore(input.managedAuthPath, expected)
    }
  })
}

export async function reconcileOpenCodeManagedAuthStores(input: {
  sourceAuthPaths: readonly string[]
  globalAuthPath: string
  managedAuthPath: string
  peerManagedAuthPaths?: readonly string[]
  abortSignal?: AbortSignal
}): Promise<void> {
  await withAuthStoreWriteLock(input.globalAuthPath, async () => {
    const peerManagedAuthPaths = Array.from(new Set([
      input.managedAuthPath,
      ...(input.peerManagedAuthPaths ?? []),
    ]))
    const [sourceStores, peerStores] = await Promise.all([
      Promise.all(input.sourceAuthPaths.map(readOpenCodeAuthStore)),
      Promise.all(peerManagedAuthPaths.map(readOpenCodeAuthStore)),
    ])
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)

    const expected = mergeOpenCodeManagedAuthSources({
      sourceAuthPaths: input.sourceAuthPaths,
      sourceStores,
      globalAuthPath: input.globalAuthPath,
    })

    const oauthProviderIds = Object.entries(expected)
      .filter(([, credential]) => credential.type === 'oauth')
      .map(([providerId]) => providerId)
    const recoveredProviderIds = new Set<string>()
    for (const providerId of oauthProviderIds) {
      let freshest = expected[providerId]
      for (const peerStore of peerStores) {
        const candidate = peerStore[providerId]
        if (candidate?.type === 'oauth') {
          freshest = pickFreshestOpenCodeOAuthCredential(freshest, candidate, false)
        }
      }
      if (JSON.stringify(freshest) !== JSON.stringify(expected[providerId])) {
        recoveredProviderIds.add(providerId)
      }
      expected[providerId] = freshest
    }

    const globalStore = await readOpenCodeAuthStore(input.globalAuthPath)
    const nextGlobalStore = { ...globalStore }
    for (const providerId of oauthProviderIds) {
      nextGlobalStore[providerId] = expected[providerId]
    }
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    if (JSON.stringify(nextGlobalStore) !== JSON.stringify(globalStore)) {
      await writeOpenCodeAuthStore(input.globalAuthPath, nextGlobalStore)
    }

    for (let index = 0; index < peerManagedAuthPaths.length; index += 1) {
      if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
      const authPath = peerManagedAuthPaths[index]
      const peerStore = peerStores[index]
      const nextPeerStore = authPath === input.managedAuthPath
        ? { ...expected }
        : { ...peerStore }
      const providerIdsToFanOut = authPath === input.managedAuthPath
        ? oauthProviderIds
        : Array.from(recoveredProviderIds)
      for (const providerId of providerIdsToFanOut) {
        nextPeerStore[providerId] = expected[providerId]
      }
      if (JSON.stringify(nextPeerStore) !== JSON.stringify(peerStore)) {
        await writeOpenCodeAuthStore(authPath, nextPeerStore)
      }
    }
  }, input.abortSignal)
}

export async function fanOutOpenCodeOAuthCredential(input: {
  providerId: string
  sourceAuthPath: string
  targetAuthPaths: readonly string[]
}): Promise<void> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  const targetAuthPaths = Array.from(new Set(input.targetAuthPaths))
  const coordinationPath = targetAuthPaths[0] ?? input.sourceAuthPath
  await withAuthStoreWriteLock(coordinationPath, async () => {
    const authPaths = Array.from(new Set([input.sourceAuthPath, ...targetAuthPaths]))
    const stores = await Promise.all(authPaths.map(readOpenCodeAuthStore))
    let freshest: OpenCodeAuthCredential | null = null
    for (const store of stores) {
      const candidate = store[providerId]
      if (candidate?.type !== 'oauth') {
        continue
      }
      freshest = freshest
        ? pickFreshestOpenCodeOAuthCredential(freshest, candidate, false)
        : candidate
    }
    if (!freshest) {
      return
    }

    for (let index = 0; index < authPaths.length; index += 1) {
      const authStore = stores[index]
      if (JSON.stringify(authStore[providerId]) === JSON.stringify(freshest)) {
        continue
      }
      await writeOpenCodeAuthStore(authPaths[index], {
        ...authStore,
        [providerId]: freshest,
      })
    }
  })
}

export async function upsertOpenCodeApiAuthCredential(input: {
  authPath: string
  providerId: string
  apiKey: string
  metadata?: Record<string, string> | null
}): Promise<void> {
  await upsertOpenCodeApiAuth(input.authPath, input.providerId, {
    type: 'api',
    key: input.apiKey,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  })
}

export async function upsertOpenCodeAuthCredential(input: {
  authPath: string
  providerId: string
  credential: OpenCodeAuthCredential
  abortSignal?: AbortSignal
}): Promise<void> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  const credentialType =
    typeof input.credential.type === 'string' ? input.credential.type.trim().toLowerCase() : ''
  if (!credentialType) {
    throw new Error('OpenCode auth credential type is required')
  }

  await withAuthStoreWriteLock(input.authPath, async () => {
    const authStore = await readOpenCodeAuthStore(input.authPath)
    authStore[providerId] = { ...input.credential, type: credentialType }
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    await writeOpenCodeAuthStore(input.authPath, authStore)
  }, input.abortSignal)
}

export async function materializeOpenCodeSelectedAuthCredential(input: {
  authPath: string
  providerId: string
  credential: OpenCodeAuthCredential | null
  abortSignal?: AbortSignal
}): Promise<void> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  await withAuthStoreWriteLock(input.authPath, async () => {
    const expected = input.credential ? { [providerId]: { ...input.credential } } : {}
    // A resolver snapshot owns this store. Repeated preparation must neither
    // replace an active file nor restore cached auth after a provider refresh.
    // Compare inside the same lock used by execution, including after waiting.
    let existing: unknown
    try {
      existing = JSON.parse(await readFile(input.authPath, 'utf8'))
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw new Error('OpenCode scoped authentication store is unavailable')
      }
      if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
      await writeOpenCodeAuthStore(input.authPath, expected)
      return
    }
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    if (!isDeepStrictEqual(existing, expected)) {
      throw new Error('OpenCode scoped authentication changed since scope resolution')
    }
  }, input.abortSignal)
}

export async function upsertOpenCodeApiAuth(
  authPath: string,
  rawProviderId: string,
  auth: OpenCodeApiAuthInput,
): Promise<void> {
  const providerId = normalizeProviderId(rawProviderId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }

  const apiKey = auth.key.trim()
  if (!apiKey) {
    throw new Error('OpenCode API key is required')
  }

  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(auth.metadata ?? {})) {
    const normalizedKey = key.trim()
    const normalizedValue = value.trim()
    if (normalizedKey && normalizedValue) {
      metadata[normalizedKey] = normalizedValue
    }
  }

  await withAuthStoreWriteLock(authPath, async () => {
    const authStore = await readOpenCodeAuthStore(authPath)
    authStore[providerId] = {
      type: 'api',
      key: apiKey,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }
    await writeOpenCodeAuthStore(authPath, authStore)
  })
}

export async function removeOpenCodeAuthCredential(input: {
  authPath: string
  providerId: string
  abortSignal?: AbortSignal
}): Promise<void> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }

  await withAuthStoreWriteLock(input.authPath, async () => {
    const authStore = await readOpenCodeAuthStore(input.authPath)
    if (!(providerId in authStore)) {
      return
    }
    delete authStore[providerId]
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    await writeOpenCodeAuthStore(input.authPath, authStore)
  }, input.abortSignal)
}

export async function readOpenCodeAuthProviderSummaries(
  authPath: string | null | undefined,
  credentialScopes?: Array<'managed' | 'local'>,
): Promise<OpenCodeConnectedProvider[]> {
  if (!authPath) {
    return []
  }

  const authStore = await readOpenCodeAuthStore(authPath)
  return Object.entries(authStore)
    .map(([providerId, entry]) => ({
      id: providerId,
      authHint:
        typeof entry.type === 'string' && entry.type.trim()
          ? entry.type.trim().toLowerCase()
          : null,
      source: 'credentials' as const,
      ...(credentialScopes ? { credentialScopes } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}
