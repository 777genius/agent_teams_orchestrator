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
  // Issued only by owned admission; never changes the original launch identity.
  credentialBinding?: { version: 1; scopeToken: string; fingerprint: string }
  // Original credential retained only after a committed, same-host session transition.
  launchCredential?: OpenCodeAuthCredential
}

export type OpenCodeOAuthNativeSessionOwner = {
  record: OpenCodeSessionRecord
  baseUrl: string
  pid: number
  processStartedAtMs: number
  messageId: string
  noReply: boolean
  sessionAuthorities?: OpenCodeSessionRecord[]
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
  authorityBefore?: OpenCodeOAuthSuccessorAuthority | null
  // Publication revocation is durable even while native completion is unknown.
  publicationRevoked?: true
}

function oauthSaveReceiptPath(globalAuthPath: string): string {
  return `${globalAuthPath}.agent-teams-xai-oauth-save.json`
}

// This file is exclusively app-written under the existing auth coordination
// lock. Native auth.json files are inputs, never publication destinations.
// Its condition is checked on every fresh read, so an independent native
// replacement cannot be overwritten or silently shadowed by our publication.
type OpenCodeOAuthSuccessorAuthority = {
  // Scoped runtime writers always bind the originating publication scope.
  owner?: OpenCodeOAuthSaveOwner | null
  version: 1
  operationId: string
  sourceAuthPaths: string[]
  before: Array<OpenCodeAuthCredential | null>
  predecessor: OpenCodeAuthCredential
  successor: OpenCodeAuthCredential
  completion?: {
    managedAuthPath: string
    nativeSession?: OpenCodeOAuthNativeSessionOwner
    nativeProbe?: OpenCodeOAuthNativeProbeOwner
  }
}

export function openCodeOAuthSuccessorPath(globalAuthPath: string): string {
  return `${globalAuthPath}.agent-teams-xai-oauth-successor.json`
}

function validSuccessorAuthority(value: OpenCodeOAuthSuccessorAuthority): boolean {
  return !!value && value.version === 1 && typeof value.operationId === 'string'
    && (value.owner === undefined || value.owner === null || !!value.owner && typeof value.owner.projectPath === 'string' && path.isAbsolute(value.owner.projectPath)
      && ['launch_runtime', 'execution_probe'].includes(value.owner.purpose)
      && /^[a-f0-9]{64}$/.test(value.owner.scopeToken))
    && Array.isArray(value.sourceAuthPaths) && value.sourceAuthPaths.every(p => typeof p === 'string' && path.isAbsolute(p))
    && new Set(value.sourceAuthPaths).size === value.sourceAuthPaths.length
    && Array.isArray(value.before) && value.before.length === value.sourceAuthPaths.length
    && value.before.some(isValidOpenCodeOAuthCredential)
    && value.before.every(c => c === null || (isValidOpenCodeOAuthCredential(c)
      && c.accountId === value.predecessor?.accountId
      && isDeepStrictEqual(c, value.before.find(entry => entry !== null))))
    && isValidOpenCodeOAuthCredential(value.predecessor) && isValidOpenCodeOAuthCredential(value.successor)
    && value.predecessor.accountId === value.successor.accountId
}

async function readSuccessorAuthority(globalAuthPath: string): Promise<OpenCodeOAuthSuccessorAuthority | null> {
  const value = await readOptionalJson(openCodeOAuthSuccessorPath(globalAuthPath)) as OpenCodeOAuthSuccessorAuthority | null
  if (value !== null && (!validSuccessorAuthority(value)
    || !value.sourceAuthPaths.includes(globalAuthPath)
    || value.sourceAuthPaths.some(p => resolveOpenCodeAuthCoordinationPath(p) !== path.resolve(p)))) throw new Error('OpenCode OAuth saved successor authority is invalid')
  return value
}

function matchesSuccessorSources(authority: OpenCodeOAuthSuccessorAuthority,
  paths: readonly string[], stores: readonly OpenCodeAuthStore[]): boolean {
  return isDeepStrictEqual(authority.sourceAuthPaths, paths)
    && stores.every((store, index) => isDeepStrictEqual(store.xai ?? null, authority.before[index]))
}

export async function readOpenCodeSavedAuthStore(input: {
  sourceAuthPaths: readonly string[]
  globalAuthPath: string
  sourceStores?: readonly OpenCodeAuthStore[]
  env?: NodeJS.ProcessEnv
  admissionProjectPath?: string
}): Promise<OpenCodeAuthStore> {
  const stores = input.sourceStores ?? await Promise.all(input.sourceAuthPaths.map(readOpenCodeAuthStore))
  const merged = mergeOpenCodeManagedAuthSources({ ...input, sourceStores: stores })
  const authority = await readSuccessorAuthority(input.globalAuthPath)
  if (authority) {
    if (matchesSuccessorSources(authority, input.sourceAuthPaths, stores)) {
      // Older sidecars establish consumed inputs, but lack publication scope.
      // They may be superseded by a fresh login, never selected as authority.
      if (authority.owner === undefined) {
        throw new Error('OpenCode OAuth saved successor scope is unavailable; use fresh authentication')
      }
      // Explicit retirement survives a later restoration of the old config.
      const pending = await readOptionalJson(oauthSaveReceiptPath(input.globalAuthPath)) as OpenCodeOAuthSaveReceipt | null
      if ((pending?.publicationRevoked === true && pending.predecessor?.refresh === authority.predecessor.refresh)
        || await readOptionalJson(revokedOAuthAdmissionPath(input.globalAuthPath,
        authority.predecessor as OpenCodeOAuthCredential)) !== null) {
        throw new Error('OpenCode OAuth saved successor publication was retired; use fresh authentication')
      }
      if (authority.owner) {
        const { isOpenCodeOAuthPublicationScopeCurrent } = await import('./OpenCodeProfileManager.js')
        if (!await isOpenCodeOAuthPublicationScopeCurrent(authority.owner, authority.predecessor, input.env ?? process.env, input.admissionProjectPath)) {
          throw new Error('OpenCode OAuth saved successor scope was revoked; use fresh authentication')
        }
      }
      merged.xai = authority.successor
    } else if (merged.xai && (authority.before.some(c => isDeepStrictEqual(c, merged.xai))
      || isDeepStrictEqual(authority.predecessor, merged.xai))) {
      // A conflicting source can make the legacy expiry merge pick consumed
      // C0. Revocation is not permission to reuse that predecessor.
      throw new Error('OpenCode OAuth saved successor source was revoked; use fresh authentication')
    }
  }
  return merged
}

// Read-only evidence for the just-completed selected readiness probe. A pending
// save, legacy publication or another host's successor cannot prove continuity.
export async function readOpenCodeCommittedOAuthProbeRotation(input: {
  globalAuthPath: string
  sourceAuthPaths: readonly string[]
  managedAuthPath: string
  env: NodeJS.ProcessEnv
  predecessor: OpenCodeAuthCredential
  nativeProbe: OpenCodeOAuthNativeProbeOwner
}): Promise<{ operationId: string; predecessor: OpenCodeAuthCredential; successor: OpenCodeAuthCredential } | null> {
  const authority = await readSuccessorAuthority(input.globalAuthPath)
  const native = authority?.completion?.nativeProbe
  if (!authority || !native || !native.sessionId || !native.messageId
    || authority.owner?.purpose !== 'launch_runtime'
    || authority.owner.projectPath !== input.nativeProbe.projectPath
    || authority.owner.scopeToken !== input.nativeProbe.scopeToken
    || authority.completion?.managedAuthPath !== input.managedAuthPath
    || authority.completion.nativeSession
    || !isDeepStrictEqual(authority.predecessor, input.predecessor)
    || isDeepStrictEqual(authority.predecessor, authority.successor)
    || !isDeepStrictEqual(authority.sourceAuthPaths, input.sourceAuthPaths)
    || !isDeepStrictEqual(native, input.nativeProbe)
    || await readOptionalJson(oauthSaveReceiptPath(input.globalAuthPath)) !== null) return null
  const sources = await Promise.all(input.sourceAuthPaths.map(readOpenCodeAuthStore))
  if (!matchesSuccessorSources(authority, input.sourceAuthPaths, sources)) return null
  const saved = await readOpenCodeSavedAuthStore({ ...input, sourceStores: sources,
    admissionProjectPath: input.nativeProbe.projectPath })
  if (!isDeepStrictEqual(saved.xai, authority.successor)
    || !isDeepStrictEqual(await readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId: 'xai' }), authority.successor)
    || !isDeepStrictEqual(await readSuccessorAuthority(input.globalAuthPath), authority)
    || await readOptionalJson(oauthSaveReceiptPath(input.globalAuthPath)) !== null) return null
  return { operationId: authority.operationId, predecessor: authority.predecessor, successor: authority.successor }
}

// Canonical observation may advance these fields; none conveys launch authority.
export function sameOpenCodeOAuthSessionAuthority(left: OpenCodeSessionRecord, right: OpenCodeSessionRecord): boolean {
  const identity = (record: OpenCodeSessionRecord) => {
    const { updatedAt, lastCanonicalCursor, lastKnownRawStatus, lastKnownDurableState, ...authority } = record
    return authority
  }
  return isDeepStrictEqual(identity(left), identity(right))
}

export async function readOpenCodeCommittedOAuthSessionRotation(input: {
  globalAuthPath: string
  sourceAuthPaths: readonly string[]
  managedAuthPath: string
  env: NodeJS.ProcessEnv
  record: OpenCodeSessionRecord
}) {
  const authority = await readSuccessorAuthority(input.globalAuthPath)
  const native = authority?.completion?.nativeSession
  if (!authority || !native || authority.completion?.nativeProbe
    || authority.owner?.purpose !== 'launch_runtime'
    || authority.owner.scopeToken !== input.record.profileScope?.scopeToken
    || authority.owner.projectPath !== input.record.projectPath
    || authority.completion?.managedAuthPath !== input.managedAuthPath
    || native.record.hostKey !== input.record.hostKey
    || native.record.profileRootKey !== input.record.profileRootKey
    || native.pid !== input.record.runtimePid
    || !(native.sessionAuthorities ?? [native.record]).some(record => sameOpenCodeOAuthSessionAuthority(record, input.record))
    || await readOptionalJson(oauthSaveReceiptPath(input.globalAuthPath)) !== null) return null
  const launchCredential = authority.owner.launchCredential ?? authority.predecessor
  if (!isValidOpenCodeOAuthCredential(launchCredential)
    || launchCredential.accountId !== authority.successor.accountId) return null
  const sources = await Promise.all(input.sourceAuthPaths.map(readOpenCodeAuthStore))
  if (!matchesSuccessorSources(authority, input.sourceAuthPaths, sources)) return null
  const saved = await readOpenCodeSavedAuthStore({ ...input, sourceStores: sources,
    admissionProjectPath: input.record.projectPath })
  if (!isDeepStrictEqual(saved.xai, authority.successor)
    || !isDeepStrictEqual(await readOpenCodeAuthStore(input.managedAuthPath), { xai: authority.successor })
    || !isDeepStrictEqual(await readSuccessorAuthority(input.globalAuthPath), authority)
    || await readOptionalJson(oauthSaveReceiptPath(input.globalAuthPath)) !== null) return null
  return { operationId: authority.operationId, predecessor: launchCredential, successor: authority.successor,
    nativeSession: native }
}

function revokedOAuthAdmissionPath(globalAuthPath: string, predecessor: OpenCodeOAuthCredential): string {
  // The single-use refresh token remains fenced even if other fields change.
  // No peer enumeration: admission consults only its own predecessor's fence.
  return `${oauthSaveReceiptPath(globalAuthPath)}.revoked-${createHash('sha256').update(predecessor.refresh).digest('hex')}`
}

// Only a completed scope comparison may revoke publication. I/O errors and
// malformed ownership evidence remain failures, never permission to discard it.
export class OpenCodeOAuthPublicationRevokedError extends Error {}

// Both original execution and restart recovery retain the same receipt fence.
// Persist readable source evidence before parsing an independent authority file:
// corruption must reject, but cannot erase a replacement already observed here.
async function rememberOAuthPublicationRevocation(
  receipt: OpenCodeOAuthSaveReceipt,
  assertRetirementAuthority?: (owner: OpenCodeOAuthSaveOwner) => Promise<void>,
): Promise<void> {
  await assertRetirementAuthority?.(receipt.owner)
  receipt.publicationRevoked = true
  await writeJsonFileAtomic(oauthSaveReceiptPath(receipt.globalAuthPath), receipt, { mode: 0o600 })
}

async function rememberObservedOAuthReplacement(
  receipt: OpenCodeOAuthSaveReceipt,
  before: readonly (OpenCodeAuthCredential | null)[],
  authorityBefore: OpenCodeOAuthSuccessorAuthority | null,
  publicationAttempt?: OpenCodeOAuthSuccessorAuthority,
  assertRetirementAuthority?: (owner: OpenCodeOAuthSaveOwner) => Promise<void>,
  error?: unknown,
): Promise<void> {
  const remember = () => rememberOAuthPublicationRevocation(receipt, assertRetirementAuthority)
  if (error instanceof OpenCodeOAuthPublicationRevokedError) await remember()
  const saved = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
  if (saved.some((store, index) => !isDeepStrictEqual(store.xai ?? null, before[index]))) await remember()
  const authority = await readSuccessorAuthority(receipt.globalAuthPath)
  if (!isDeepStrictEqual(authority, authorityBefore)
    && !isDeepStrictEqual(authority, publicationAttempt)) await remember()
}

// A pre-submission native owner or terminal result, never arbitrary auth-file recovery.
// The manager supplies the exact configured sources and revalidates the complete
// originating scope against current configuration before any saved write.
export async function recoverOpenCodeOwnedOAuthSave(input: {
  globalAuthPath: string
  env?: NodeJS.ProcessEnv
  sourceAuthPaths: readonly string[]
  assertOwner: (owner: OpenCodeOAuthSaveOwner, predecessor: OpenCodeAuthCredential,
    managedAuthPath: string) => Promise<void>
  // Caller admission is separate from owner/source revocation. A foreign
  // launch cannot retire a receipt using its own differing configuration.
  assertRetirementAuthority?: (owner: OpenCodeOAuthSaveOwner) => Promise<void>
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
      || (receipt.publicationRevoked !== undefined && receipt.publicationRevoked !== true)
      || (receipt.authorityBefore != null && !validSuccessorAuthority(receipt.authorityBefore))
      || (!(receipt.before.some(c => isDeepStrictEqual(c, receipt.predecessor))
        && receipt.before.every(c => c === null || isDeepStrictEqual(c, receipt.predecessor)))
        && !(receipt.authorityBefore
          && isDeepStrictEqual(receipt.authorityBefore.successor, receipt.predecessor)
          && isDeepStrictEqual(receipt.authorityBefore.before, receipt.before)
          && isDeepStrictEqual(receipt.authorityBefore.sourceAuthPaths, receipt.sourceAuthPaths)))) {
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
      await input.assertRetirementAuthority?.(receipt.owner)
      // Revocation removes publication authority, never the denial of a
      // potentially consumed single-use predecessor. Archive terminal receipts
      // too, before freeing the active slot for an unrelated fresh credential.
      await writeJsonFileAtomic(revokedOAuthAdmissionPath(input.globalAuthPath,
        receipt.predecessor as OpenCodeOAuthCredential), receipt, { mode: 0o600 })
      await rm(receiptPath)
      return false
    }
    const rememberRevocation = () => rememberOAuthPublicationRevocation(receipt, input.assertRetirementAuthority)
    // Distinguish authority already superseded at entry from a source change
    // during native settlement (including Stop's cancellation callback).
    const entrySources = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
    let entryAuthority: OpenCodeOAuthSuccessorAuthority | null
    try { entryAuthority = await readSuccessorAuthority(input.globalAuthPath) }
    catch (error) {
      if (entrySources.some((store, index) => !isDeepStrictEqual(store.xai ?? null, receipt.before[index]))) {
        await rememberRevocation()
      }
      throw error
    }
    const entryRevoked = !isDeepStrictEqual(receipt.sourceAuthPaths, Array.from(new Set(input.sourceAuthPaths)))
      || entrySources.some((store, index) => !isDeepStrictEqual(store.xai ?? null, receipt.before[index]))
      || !isDeepStrictEqual(entryAuthority, receipt.authorityBefore ?? null)
    let publicationAttempt: OpenCodeOAuthSuccessorAuthority | undefined
    const publish = async (): Promise<boolean> => {
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
        let terminal: boolean
        try { terminal = await settled() }
        catch (error) {
          // Invalid/missing native history is not completion. Independently
          // proven source replacement may still fence this obsolete admission.
          if (entryRevoked && !receipt.publicationRevoked) {
            return retireRevokedPublication()
          }
          throw error
        }
        if (!terminal) {
          // A known native session with supported canonical history can prove
          // the armed message was never admitted after its exact writer exited.
          // PID absence alone, a live idle endpoint, or changed auth cannot
          // abandon this receipt. Never publish/restore C0 on this path.
          const unchanged = async () => isDeepStrictEqual(await readOpenCodeAuthCredential({
            authPath: receipt.managedAuthPath, providerId: 'xai',
          }), receipt.predecessor)
          if (!await unchanged() || !await settled(true)) {
            // Only replacement already present at entry can abandon an old
            // admission. A prior late revocation still requires native proof.
            if (entryRevoked && !receipt.publicationRevoked) return retireRevokedPublication()
            const saved = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
            if (saved.some((store, index) => !isDeepStrictEqual(store.xai, entrySources[index]?.xai))
              || !isDeepStrictEqual(await readSuccessorAuthority(input.globalAuthPath), entryAuthority)
              || receipt.publicationRevoked) {
              await rememberRevocation()
              throw new Error('OpenCode OAuth saved authority superseded while native operation is still pending')
            }
            try {
              await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
            } catch (error) {
              if (error instanceof OpenCodeOAuthPublicationRevokedError) return retireRevokedPublication()
              throw error
            }
            throw new Error('OpenCode OAuth native session or probe is still pending or no longer owned')
          }
          if (receipt.publicationRevoked) {
            await input.assertRetirementAuthority?.(receipt.owner)
            if (!await settled(true) || !await unchanged()) {
              throw new Error('OpenCode OAuth unsubmitted native ownership changed')
            }
            return retireRevokedPublication()
          }
          if (!isDeepStrictEqual(receipt.sourceAuthPaths, Array.from(new Set(input.sourceAuthPaths)))
            || !isDeepStrictEqual(entryAuthority, receipt.authorityBefore ?? null)) {
            return retireRevokedPublication()
          }
          await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
          if (!await settled(true) || !await unchanged()) {
            throw new Error('OpenCode OAuth unsubmitted native ownership changed')
          }
          const saved = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
          if (saved.some((store, index) => !isDeepStrictEqual(store.xai ?? null, receipt.before[index]))
            || !isDeepStrictEqual(await readSuccessorAuthority(input.globalAuthPath), entryAuthority)) {
            await rememberRevocation()
            throw new Error('OpenCode OAuth unsubmitted saved authority changed')
          }
          await input.assertRetirementAuthority?.(receipt.owner)
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
        if (!await settled()) {
          throw new Error('OpenCode OAuth native session ownership changed during settlement')
        }
        if (!isDeepStrictEqual(successor, await readOpenCodeAuthCredential({
          authPath: receipt.managedAuthPath, providerId: 'xai',
        }))) throw new Error('OpenCode OAuth native result changed during settlement')
        receipt.successor = successor
        await writeJsonFileAtomic(receiptPath, receipt, { mode: 0o600 })
      }
      if (receipt.publicationRevoked) return retireRevokedPublication()
      if (!isDeepStrictEqual(receipt.sourceAuthPaths, Array.from(new Set(input.sourceAuthPaths)))) {
        return retireRevokedPublication()
      }
      const current = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
      const matches = (credential: OpenCodeAuthCredential | undefined, index: number) =>
        isDeepStrictEqual(credential ?? null, receipt.before[index])
      if (current.some((store, index) => !isDeepStrictEqual(store.xai, entrySources[index]?.xai))) {
        await rememberRevocation()
      }
      const authority = await readSuccessorAuthority(input.globalAuthPath)
      if (current.some((store, index) => !isDeepStrictEqual(store.xai, entrySources[index]?.xai))
        || !isDeepStrictEqual(authority, entryAuthority)) {
        await rememberRevocation()
        throw new Error('OpenCode OAuth pending saved publication was superseded during settlement')
      }
      const alreadyPublished = authority?.operationId === receipt.operationId
        && isDeepStrictEqual(authority.owner, receipt.owner)
        && isDeepStrictEqual(authority.predecessor, receipt.predecessor)
        && isDeepStrictEqual(authority.successor, receipt.successor)
        && isDeepStrictEqual(authority.before, receipt.before)
        && isDeepStrictEqual(authority.sourceAuthPaths, receipt.sourceAuthPaths)
      if (!alreadyPublished && !isDeepStrictEqual(authority, receipt.authorityBefore ?? null)) {
        return retireRevokedPublication()
      }
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
      const native = await readOpenCodeAuthCredential({ authPath: receipt.managedAuthPath, providerId: 'xai' })
      if (!isDeepStrictEqual(native, receipt.successor)) {
        throw new Error('OpenCode OAuth pending native result changed')
      }
      await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
      const saved = await Promise.all(receipt.sourceAuthPaths.map(readOpenCodeAuthStore))
      if (saved.some((store, index) => !matches(store.xai, index))
        || !isDeepStrictEqual(await readSuccessorAuthority(input.globalAuthPath), authority)) {
        await rememberRevocation()
        throw new Error('OpenCode OAuth pending saved publication was superseded')
      }
      if (!isDeepStrictEqual(await readOpenCodeAuthCredential({
        authPath: receipt.managedAuthPath, providerId: 'xai',
      }), receipt.successor)) throw new Error('OpenCode OAuth pending native result changed')
      publicationAttempt = {
        version: 1, operationId: receipt.operationId, owner: receipt.owner, sourceAuthPaths: receipt.sourceAuthPaths,
        before: receipt.before, predecessor: receipt.predecessor, successor: receipt.successor,
        completion: { managedAuthPath: receipt.managedAuthPath,
          ...(receipt.nativeSession ? { nativeSession: receipt.nativeSession } : {}),
          ...(receipt.nativeProbe ? { nativeProbe: receipt.nativeProbe } : {}),
        },
      }
      await writeJsonFileAtomic(openCodeOAuthSuccessorPath(input.globalAuthPath), publicationAttempt, { mode: 0o600 })
      if (!isDeepStrictEqual((await readOpenCodeSavedAuthStore(input)).xai, receipt.successor)) {
        throw new Error('OpenCode OAuth recovered successor was not selected')
      }
      await input.assertOwner(receipt.owner, receipt.predecessor, receipt.managedAuthPath)
      await rememberObservedOAuthReplacement(receipt, receipt.before, authority, publicationAttempt,
        input.assertRetirementAuthority)
      if (receipt.publicationRevoked) throw new Error('OpenCode OAuth recovered publication was superseded')
      await rm(receiptPath)
      return true
    }
    try {
      return await publish()
    } catch (error) {
      // Remember observed replacement independently of terminal capture and
      // active-slot retirement. Retrying with restored C0 cannot revive C1,
      // and a rejected Stop must retain the exact native owner and lease.
      await rememberObservedOAuthReplacement(receipt, entrySources.map(store => store.xai ?? null),
        entryAuthority, publicationAttempt, input.assertRetirementAuthority, error)
      throw error
    }
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
  env?: NodeJS.ProcessEnv
  managedAuthPath: string
  globalAuthPath: string
  sourceAuthPaths: readonly string[]
  providerId: string
  predecessor: OpenCodeAuthCredential
  expectedOperationId?: string
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
  if (providerId !== 'xai' || !isValidOpenCodeOAuthCredential(input.predecessor)) {
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
  // Only the app-owned successor is published. Native source writers need not
  // cooperate with this lock, because their files are never overwritten.
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
    const authorityBefore = await readSuccessorAuthority(input.globalAuthPath)
    if (input.expectedOperationId && authorityBefore?.operationId !== input.expectedOperationId) {
      throw new Error('OpenCode OAuth continuation publication was superseded')
    }
    const selected = (await readOpenCodeSavedAuthStore({
      sourceAuthPaths, sourceStores: before, globalAuthPath: input.globalAuthPath, env: input.env,
    }))[providerId]
    const managed = await readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId })
    if (!isDeepStrictEqual(selected, predecessor) || !isDeepStrictEqual(managed, predecessor)) {
      throw new Error('OpenCode OAuth predecessor changed before native execution')
    }
    // An existing app successor proves the selected predecessor even though
    // native sources still contain the original C0. Otherwise every saved
    // selected-provider entry must be an exact copy of the predecessor.
    const inherited = authorityBefore && matchesSuccessorSources(authorityBefore, sourceAuthPaths, before)
      && isDeepStrictEqual(authorityBefore.successor, predecessor)
    if (!inherited && (before.every(store => !store[providerId])
      || before.some(store => store[providerId] && !isDeepStrictEqual(store[providerId], predecessor)))) {
      throw new Error('OpenCode OAuth saved sources disagree or owner is missing')
    }
    // A fresh login can replace the single successor sidecar. Preserve its
    // exact consumed inputs first, including pre-scope publications, so that
    // reintroducing an old token cannot escape denial after that replacement.
    if (input.recoveryOwner && authorityBefore && !inherited) {
      for (const consumed of [authorityBefore.predecessor, ...authorityBefore.before]) {
        if (!isValidOpenCodeOAuthCredential(consumed)) continue
        const fence = revokedOAuthAdmissionPath(input.globalAuthPath, consumed)
        if (await readOptionalJson(fence) === null) {
          await writeJsonFileAtomic(fence, authorityBefore, { mode: 0o600 })
        }
      }
      if (await readOptionalJson(revokedOAuthAdmissionPath(input.globalAuthPath, predecessor)) !== null) {
        throw new Error('OpenCode OAuth predecessor has a revoked pending native admission; use fresh authentication')
      }
    }
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
        if (!isDeepStrictEqual(await readSuccessorAuthority(input.globalAuthPath), authorityBefore)
          || !isDeepStrictEqual(native, predecessor)
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
        successor: null, authorityBefore, ...structuredClone(native),
      }
      await writeJsonFileAtomic(oauthSaveReceiptPath(input.globalAuthPath), nativeReceipt, { mode: 0o600 })
      try {
        await checkAdmission()
      } catch (error) {
        // The arm has not returned permission to submit native work yet.
        await rm(oauthSaveReceiptPath(input.globalAuthPath))
        nativeReceipt = null
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
    let publicationAttempt: OpenCodeOAuthSuccessorAuthority | undefined
    try {
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
        if (nativeReceipt) await rememberOAuthPublicationRevocation(nativeReceipt)
        throw new Error('OpenCode OAuth saved authority changed during native execution')
      }
      await input.assertOwnership()
      if (isDeepStrictEqual(successor, predecessor)) {
        if (nativeReceipt) await rm(oauthSaveReceiptPath(input.globalAuthPath))
        if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
        return value
      }
      const operationId = nativeReceipt?.operationId ?? randomUUID()
      if (input.recoveryOwner) {
        if (providerId !== 'xai') throw new Error('OpenCode owned save recovery supports xAI only')
        const receipt: OpenCodeOAuthSaveReceipt = {
          version: 1, operationId, owner: structuredClone(input.recoveryOwner),
          globalAuthPath: input.globalAuthPath, managedAuthPath: input.managedAuthPath,
          sourceAuthPaths, before: before.map(store => store[providerId] ?? null),
          predecessor, successor, authorityBefore,
          ...(nativeReceipt?.nativeSession ? { nativeSession: nativeReceipt.nativeSession } : {}),
          ...(nativeReceipt?.nativeProbe ? { nativeProbe: nativeReceipt.nativeProbe } : {}),
        }
        nativeReceipt = receipt
        await writeJsonFileAtomic(oauthSaveReceiptPath(input.globalAuthPath), receipt, { mode: 0o600 })
      }
      await input.assertOwnership()
      await input.assertPublicationOwnership?.()
      const saved = await Promise.all(sourceAuthPaths.map(readOpenCodeAuthStore))
      if (saved.some((store, index) => !isDeepStrictEqual(store[providerId], before[index][providerId]))
        || !isDeepStrictEqual(await readSuccessorAuthority(input.globalAuthPath), authorityBefore)) {
        if (nativeReceipt) await rememberOAuthPublicationRevocation(nativeReceipt)
        throw new Error('OpenCode OAuth saved predecessor changed before publication')
      }
      publicationAttempt = {
        version: 1, operationId, sourceAuthPaths, before: before.map(store => store[providerId] ?? null),
        predecessor, successor, owner: input.recoveryOwner ?? null,
        ...(input.recoveryOwner ? { completion: { managedAuthPath: input.managedAuthPath,
          ...(nativeReceipt?.nativeSession ? { nativeSession: nativeReceipt.nativeSession } : {}),
          ...(nativeReceipt?.nativeProbe ? { nativeProbe: nativeReceipt.nativeProbe } : {}),
        } } : {}),
      }
      await writeJsonFileAtomic(openCodeOAuthSuccessorPath(input.globalAuthPath), publicationAttempt, { mode: 0o600 })
      if (!isDeepStrictEqual((await readOpenCodeSavedAuthStore({ sourceAuthPaths,
        globalAuthPath: input.globalAuthPath, env: input.env }))[providerId], successor)) {
        throw new Error('OpenCode OAuth successor publication was superseded')
      }
      if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
      await input.assertPublicationOwnership?.()
      if (nativeReceipt) {
        await rememberObservedOAuthReplacement(nativeReceipt, nativeReceipt.before, authorityBefore, publicationAttempt)
        if (nativeReceipt.publicationRevoked) throw new Error('OpenCode OAuth successor publication was superseded')
      }
      if (input.recoveryOwner) await rm(oauthSaveReceiptPath(input.globalAuthPath))
      return value
    } catch (error) {
      if (nativeReceipt) {
        await rememberObservedOAuthReplacement(nativeReceipt, nativeReceipt.before, authorityBefore, publicationAttempt,
          undefined, error)
      }
      throw error
    }
  }
  return withAuthStoreWriteLock(input.globalAuthPath, run, input.abortSignal)
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    if (!raw.trim()) {
      return {}
    }
    const value: unknown = JSON.parse(raw)
    // JSON null is present corrupt evidence, not a missing receipt/fence.
    if (value === null) throw new Error('OpenCode auth JSON is invalid: null')
    return value
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
