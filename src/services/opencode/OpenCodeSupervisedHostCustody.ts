import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { prepareExecutingOpenCodeArtifactDigestToken,
  resolveExecutingOpenCodeArtifactDigest } from './OpenCodeArtifactDigest.js'
import { captureOpenCodeEstablishedPeerIdentity, captureOpenCodeLoopbackEndpointIdentity,
  type OpenCodeConnectedSocketIdentity } from './OpenCodeLoopbackEndpointIdentity.js'
import { assertOpenCodeRawRetentionPort, type HostedHttpOperation,
  type OpenCodeRawRetentionPort } from './OpenCodeHostedRawRetention.js'
import type { OpenCodeHostLeaseInput } from './OpenCodeHostManager.js'
import type { OpenCodePreparedProfile } from './types.js'

export type OneUseFence = { consume(): boolean }
export type ExpectedSupervisedOpenCode = Readonly<{
  endpoint: { protocol: 'http:'; address: '127.0.0.1'; port: number; baseUrl: string }
  process: { pid: number; startTicks: string; startIdentity: `start_${string}`
    supervisorProcessStartToken: string; pidNamespaceInode: string; networkNamespaceInode: string }
  executable: { device: string; inode: string; size: string; sha256: string
    artifactManifestSha256: string; moduleSha256: string }
  profile: { projectPath: string; profileRootKey: string; profileRootPath: string
    projectBehaviorFingerprint: string; managedConfigFingerprint: string
    resolvedConfigFingerprint: string; sourceAuthFingerprint: string | null
    managedAuthFingerprint: string | null
    sourceAuthSources: readonly { path: string; fingerprint: string | null }[]
    toolApprovalMode: 'manual' }
  hosted: { schemaVersion: 2; protocol: 'agent-teams-hosted-approval-v2'
    authentication: 'opencode-basic'; runtimeInstanceId: string; configGeneration: string }
  activation: { controllerNonce: string; runId: string; stackManifestSha256: string
    bootstrapDigest: string; admissionDocumentDigest: `sha256:${string}`
    ownerArtifactDigest: `sha256:${string}`; ownerGeneration: number; ownerSessionId: string }
  serverAuthId: string
}>

/** Trusted infrastructure injection, not request input. W1-B must implement this
 * at actual supervisor admission, with the independent launcher/artifact chain,
 * descriptor roles and activation lease already verified. No production source
 * exists in W1-A. In particular bootstrap-v1, config files and env cannot implement
 * this authority. expected is selected independently BEFORE receiving the bundle.
 */
export interface OpenCodeSupervisorAdmissionSource {
  readonly expected: ExpectedSupervisedOpenCode
  acquire(): Promise<{
    expected: ExpectedSupervisedOpenCode
    serverAuth: { id: string; username: string; password: string }
    rawRetention: OpenCodeRawRetentionPort
    readPreparedProfile(): Promise<OpenCodePreparedProfile>
    // These retain supervisor admission, executed module/manifest and activation
    // authority, not a caller's assertion about the process being alive.
    prepareEffectToken(): Promise<OneUseFence | null>
    prepareLeaseToken(lease: OpenCodeHostLeaseInput): Promise<OneUseFence | null>
    prepareOperationToken(operation: HostedHttpOperation): Promise<OneUseFence | null>
    readonly lost: Promise<void>
    closeOwnerResources(): Promise<void>
  }>
}

declare const custodyBrand: unique symbol
export interface TrustedOpenCodeCustody {
  readonly [custodyBrand]: true
  readonly expected: ExpectedSupervisedOpenCode
  readonly hostKey: string
  readonly rawRetention: OpenCodeRawRetentionPort
  readonly lost: Promise<void>
  readPreparedProfile(): Promise<OpenCodePreparedProfile>
  assertCurrent(): Promise<boolean>
  prepareEffectToken(): Promise<OneUseFence | null>
  prepareLeaseToken(lease: OpenCodeHostLeaseInput): Promise<OneUseFence | null>
  prepareOperationToken(operation: HostedHttpOperation): Promise<OneUseFence | null>
  authorizeConnected(connection: OpenCodeConnectedSocketIdentity): Promise<OneUseFence | null>
  authenticatedRequest(url: string, init: RequestInit): RequestInit
  retainOwnerResource(close: () => void): () => void
  closeOwnerResources(): Promise<void>
}
export type OpenCodeHostAcquisitionPolicy =
  | { mode: 'desktop' }
  | { mode: 'supervisor-adopt-only'; custody: TrustedOpenCodeCustody }

const admitted = new WeakSet<object>()
export function assertTrustedOpenCodeCustody(value: TrustedOpenCodeCustody): void {
  if (!value || !admitted.has(value)) throw new Error('OpenCode trusted supervisor custody unavailable')
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('OpenCode admission field missing')
  return encoded
}
const hex = /^[0-9a-f]{64}$/
const decimal = /^(?:0|[1-9][0-9]*)$/
function validateExpected(e: ExpectedSupervisedOpenCode): void {
  const endpoint = e.endpoint
  if (endpoint.protocol !== 'http:' || endpoint.address !== '127.0.0.1' ||
    !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
    endpoint.baseUrl !== `http://127.0.0.1:${endpoint.port}` ||
    new URL(endpoint.baseUrl).origin !== endpoint.baseUrl ||
    !Number.isSafeInteger(e.process.pid) || e.process.pid < 1 ||
    !Number.isSafeInteger(Number(e.process.startTicks)) ||
    ![e.process.startTicks, e.process.pidNamespaceInode, e.process.networkNamespaceInode,
      e.executable.device, e.executable.inode, e.executable.size].every(x => decimal.test(x)) ||
    ![e.process.supervisorProcessStartToken, e.executable.sha256, e.executable.moduleSha256,
      e.executable.artifactManifestSha256, e.activation.controllerNonce, e.activation.runId,
      e.activation.stackManifestSha256].every(x => hex.test(x)) ||
    ![e.activation.admissionDocumentDigest, e.activation.ownerArtifactDigest]
      .every(x => /^sha256:[0-9a-f]{64}$/.test(x)) ||
    !Number.isSafeInteger(e.activation.ownerGeneration) || e.activation.ownerGeneration < 1 ||
    !e.activation.ownerSessionId || !e.activation.bootstrapDigest || !e.serverAuthId ||
    !isAbsolute(e.profile.projectPath) || !isAbsolute(e.profile.profileRootPath) ||
    !e.profile.profileRootKey || e.profile.toolApprovalMode !== 'manual' ||
    ![e.profile.projectBehaviorFingerprint, e.profile.managedConfigFingerprint,
      e.profile.resolvedConfigFingerprint].every(x => hex.test(x)) ||
    ![e.profile.sourceAuthFingerprint, e.profile.managedAuthFingerprint]
      .every(x => x === null || hex.test(x)) ||
    !Array.isArray(e.profile.sourceAuthSources) || !e.profile.sourceAuthSources.every(x =>
      isAbsolute(x.path) && (x.fingerprint === null || hex.test(x.fingerprint))) ||
    e.hosted.schemaVersion !== 2 || e.hosted.protocol !== 'agent-teams-hosted-approval-v2' ||
    e.hosted.authentication !== 'opencode-basic' ||
    !/^runtime_instance_[0-9a-f]{32}$/.test(e.hosted.runtimeInstanceId) ||
    !/^config_generation_[0-9a-f]{32}$/.test(e.hosted.configGeneration)) {
    throw new Error('OpenCode supervisor expectation invalid')
  }
  const start = `start_${createHash('sha256').update(`${e.process.pid}\0proc:${e.process.startTicks}`).digest('hex')}`
  if (start !== e.process.startIdentity) throw new Error('OpenCode supervisor start identity invalid')
}

/** Synchronous currentness at the finalizer includes /proc's live executable
 * link, not only the descriptor pinned by the existing artifact fence. */
function processCurrent(e: ExpectedSupervisedOpenCode): boolean {
  if (process.platform !== 'linux') return false
  try {
    const root = `/proc/${e.process.pid}`
    const before = readFileSync(`${root}/stat`, 'utf8')
    const ticks = before.slice(before.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    const exe = statSync(`${root}/exe`, { bigint: true })
    return ticks === e.process.startTicks && exe.dev.toString() === e.executable.device &&
      exe.ino.toString() === e.executable.inode && exe.size.toString() === e.executable.size &&
      statSync(`${root}/ns/pid`, { bigint: true }).ino.toString() === e.process.pidNamespaceInode &&
      statSync(`${root}/ns/net`, { bigint: true }).ino.toString() === e.process.networkNamespaceInode
  } catch { return false }
}

/** Creates an acquisition closure in trusted composition. HTTP/session callers
 * receive only its branded result; they cannot supply expected identities,
 * credentials, authority callbacks or a structurally forged custody object.
 */
export function createOpenCodeSupervisedCustodyAcquirer(source: OpenCodeSupervisorAdmissionSource) {
  const expected = immutable(structuredClone(source.expected))
  const acquire = source.acquire.bind(source)
  validateExpected(expected)
  return async (): Promise<TrustedOpenCodeCustody> => {
    const bundle = await acquire()
    const rawRetention = bundle.rawRetention
    const readPreparedProfile = bundle.readPreparedProfile.bind(bundle)
    const prepareAuthority = bundle.prepareEffectToken.bind(bundle)
    const prepareLease = bundle.prepareLeaseToken.bind(bundle)
    const prepareOperation = bundle.prepareOperationToken.bind(bundle)
    const closeBundle = bundle.closeOwnerResources.bind(bundle)
    const bundleLost = bundle.lost
    let admittedProfileIdentity: string | undefined
    let revoked = false
    let closing: Promise<void> | undefined
    let lose!: () => void
    const lost = new Promise<void>(resolve => { lose = resolve })
    const resources = new Set<() => void>()
    const revoke = () => {
      revoked = true; lose()
      for (const closeResource of resources) {
        try { closeResource() } catch {}
      }
      resources.clear()
    }
    const close = () => {
      revoke()
      return closing ??= Promise.allSettled([
        Promise.resolve().then(() => rawRetention?.close()),
        Promise.resolve().then(closeBundle),
      ]).then(() => undefined)
    }
    try {
      assertOpenCodeRawRetentionPort(rawRetention)
      if (canonical(bundle.expected) !== canonical(expected) ||
        bundle.serverAuth.id !== expected.serverAuthId || !bundle.serverAuth.password ||
        !bundle.serverAuth.username || /[:\r\n\0]/.test(bundle.serverAuth.username)) {
        throw new Error('OpenCode supervisor admission mismatch')
      }
      // Secret stays in this closure; never in profile env, handles or raw records.
      const authorization = `Basic ${Buffer.from(`${bundle.serverAuth.username}:${bundle.serverAuth.password}`).toString('base64')}`
      void bundleLost.then(revoke, revoke)
      const current = () => {
        if (!revoked && (!rawRetention.isCurrent() || !processCurrent(expected))) revoke()
        return !revoked
      }
      const captureFence = (token: OneUseFence | null): OneUseFence | null => {
        if (!token) return null
        const consume = token.consume.bind(token)
        let used = false
        return Object.freeze({ consume() {
          if (used) return false
          used = true
          let valid = current()
          try { valid = consume() && valid } catch { valid = false }
          return valid && current()
        } })
      }
      const prepareEffectToken = async (): Promise<OneUseFence | null> => {
        if (!current()) return null
        const authority = captureFence(await prepareAuthority())
        if (!authority) return null
        const artifact = prepareExecutingOpenCodeArtifactDigestToken(expected.process.pid,
          `sha256:${expected.executable.sha256}`)
        if (!artifact) { authority.consume(); return null }
        let used = false
        return Object.freeze({ consume() {
          if (used) return false
          used = true
          let valid = current()
          try { valid = authority.consume() && valid } catch { valid = false }
          try { valid = artifact.consume() && valid } catch { valid = false }
          valid = current() && valid
          if (!valid) revoke()
          return valid
        } })
      }
      const custody = {
        expected, hostKey: `supervised::${createHash('sha256').update(canonical(expected)).digest('hex')}`,
        rawRetention, lost,
        async readPreparedProfile() {
          if (!current()) throw new Error('OpenCode supervisor custody lost')
          const profile = structuredClone(await readPreparedProfile())
          for (const key of ['projectPath', 'profileRootKey', 'profileRootPath',
            'projectBehaviorFingerprint', 'managedConfigFingerprint', 'sourceAuthFingerprint',
            'managedAuthFingerprint', 'sourceAuthSources'] as const) {
            if (canonical(profile[key]) !== canonical(expected.profile[key])) {
              throw new Error('OpenCode supervised profile mismatch')
            }
          }
          if (!current()) throw new Error('OpenCode supervisor custody lost')
          // A supervised profile never lends server credentials to ordinary consumers.
          delete profile.env.OPENCODE_SERVER_PASSWORD
          delete profile.env.OPENCODE_SERVER_USERNAME
          const verified = immutable({ ...profile, custody: 'supervisor' as const })
          // Fingerprints alone do not bind the files checked by the final fence.
          // Pin the complete admitted profile, including paths and absent sources.
          // Optional undefined profile properties have the same meaning as
          // absent ones. Required expectation fields were checked above.
          const identity = canonical(JSON.parse(JSON.stringify(verified)))
          if (admittedProfileIdentity && identity !== admittedProfileIdentity) {
            revoke()
            throw new Error('OpenCode supervised profile identity changed')
          }
          admittedProfileIdentity ??= identity
          return verified
        },
        async assertCurrent() {
          const token = await prepareEffectToken()
          return token?.consume() ?? false
        },
        prepareEffectToken,
        prepareLeaseToken: async (lease: OpenCodeHostLeaseInput) =>
          captureFence(await prepareLease(Object.freeze({ ...lease }))),
        prepareOperationToken: async (operation: HostedHttpOperation) =>
          captureFence(await prepareOperation(Object.freeze({ ...operation }))),
        async authorizeConnected(connection: OpenCodeConnectedSocketIdentity) {
          if (!current() || connection.remotePort !== expected.endpoint.port) return null
          const peer = await captureOpenCodeEstablishedPeerIdentity(expected.process.pid,
            expected.process.startIdentity, connection)
          if (!peer || peer.startIdentity !== expected.process.startIdentity) return null
          return prepareEffectToken()
        },
        authenticatedRequest(urlValue: string, init: RequestInit) {
          const url = new URL(urlValue)
          if (!current() || url.origin !== expected.endpoint.baseUrl || url.username || url.password ||
            url.hash || urlValue !== `${expected.endpoint.baseUrl}${url.pathname}${url.search}`) {
            throw new Error('OpenCode supervised request authority mismatch')
          }
          const headers = new Headers(init.headers)
          headers.set('authorization', authorization)
          headers.set('x-opencode-directory', expected.profile.projectPath)
          headers.set('accept-encoding', 'identity')
          return { ...init, headers, redirect: 'manual' as const }
        },
        retainOwnerResource(closeResource: () => void) {
          if (!current()) { closeResource(); return () => {} }
          resources.add(closeResource)
          return () => { resources.delete(closeResource) }
        },
        closeOwnerResources: close,
      } as TrustedOpenCodeCustody
      const listener = await captureOpenCodeLoopbackEndpointIdentity(expected.process.pid, expected.endpoint.port)
      if (!listener || listener.startIdentity !== expected.process.startIdentity ||
        resolveExecutingOpenCodeArtifactDigest(expected.process.pid) !== `sha256:${expected.executable.sha256}` ||
        !(await custody.assertCurrent())) throw new Error('OpenCode supervised process admission failed')
      await custody.readPreparedProfile()
      admitted.add(custody)
      return Object.freeze(custody)
    } catch {
      await close()
      throw new Error('OpenCode trusted supervisor admission failed')
    }
  }
}
