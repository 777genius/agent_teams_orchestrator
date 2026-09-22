import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { close, fstat, read } from 'node:fs'
import { createReadStream } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { promisify } from 'node:util'
import type { HostedControlRuntimeConfig } from './HostedControlRuntimeConfig.js'

export const HOSTED_CONTROL_BOOTSTRAP_FORMAT = 'agent-teams.hosted-control.bootstrap/v1'
export const HOSTED_CONTROL_BOOTSTRAP_FD = 5
export const HOSTED_CONTROL_LAUNCHER_LEASE_FD = 3
export const HOSTED_CONTROL_LIVENESS_FD = 4
export const HOSTED_CONTROL_BOOTSTRAP_DEADLINE_MS = 5_000
export const HOSTED_CONTROL_BOOTSTRAP_MAX_HEADER_BYTES = 64 * 1024
const MAX_LEASE_ARTIFACT_BYTES = 64 * 1024
const AUTHENTICATOR_BYTES = 32

// FD5 carries exactly one frame and then EOF:
//   u32be(header length) || canonical UTF-8 JSON header || 32-byte key ||
//   HMAC-SHA256(key, format || NUL || length-prefix || header)

const closeAsync = promisify(close)

export type HostedControlLeaseEvidence = {
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  launcherLeaseId: string
  launcherArtifactDigest: string
}

export type HostedControlBootstrapBinding = {
  deploymentId: string
  bootId: string
  workspaceId: string
  mountGeneration: number
  bootstrapDigest: string
  ownerArtifactDigest: string
  proofKeyId: string
}

export type HostedApprovalActivationV2BootstrapExpectation = {
  approvalGeneration: number
  admissionOwnerGeneration: number
  approvalDigest: `sha256:${string}`
  admissionDocumentDigest: `sha256:${string}`
  ownerArtifactDigest: `sha256:${string}`
  wireCapabilityDigest: `sha256:${string}`
  signedManifest: {
    format: 'agent-teams.hosted-lifecycle-owner-admission/v4'
    manifestDigest: `sha256:${string}`
    releasePinDigest: `sha256:${string}`
    launcherKeyId: string
  }
}

export type HostedControlBootstrapHeader = {
  format: typeof HOSTED_CONTROL_BOOTSTRAP_FORMAT
  restoreGeneration: number
  teamId: string
  declaredRootHash: string
  ownerAuthority: string
  ownerGeneration: number
  ownerSessionId: string
  claudeRoot: string
  socketPath: string
  legacyKey: string
  approvalActivationV2: HostedApprovalActivationV2BootstrapExpectation
  bootstrapBinding: HostedControlBootstrapBinding
  leaseEvidence: HostedControlLeaseEvidence
}

export type HostedControlDescriptorGuard = {
  readonly lost: Promise<void>
  assertCurrent(): Promise<boolean>
  close(): Promise<void>
}

export type HostedControlBootstrapAdmission = {
  config: Omit<HostedControlRuntimeConfig, 'secretFile'>
  bootstrapBinding: HostedControlBootstrapBinding
  approvalActivationV2: HostedApprovalActivationV2BootstrapExpectation
  secret: Buffer
  guard: HostedControlDescriptorGuard
}

const HEADER_KEYS = [
  'format', 'restoreGeneration', 'teamId', 'declaredRootHash', 'ownerAuthority',
  'ownerGeneration', 'ownerSessionId', 'claudeRoot', 'socketPath', 'legacyKey',
  'approvalActivationV2', 'bootstrapBinding', 'leaseEvidence',
] as const
const BINDING_KEYS = [
  'deploymentId', 'bootId', 'workspaceId', 'mountGeneration', 'bootstrapDigest',
  'ownerArtifactDigest', 'proofKeyId',
] as const
const ACTIVATION_KEYS = [
  'approvalGeneration', 'admissionOwnerGeneration', 'approvalDigest',
  'admissionDocumentDigest', 'ownerArtifactDigest', 'wireCapabilityDigest',
  'signedManifest',
] as const
const SIGNED_MANIFEST_KEYS = [
  'format', 'manifestDigest', 'releasePinDigest', 'launcherKeyId',
] as const
const EVIDENCE_KEYS = [
  'device', 'inode', 'uid', 'gid', 'mode', 'launcherLeaseId',
  'launcherArtifactDigest',
] as const

/**
 * Admits the fixed inherited-descriptor bootstrap. FD 5 is unconditionally
 * closed before this function returns or rejects; callers may only begin
 * filesystem/runtime effects after the returned admission is available.
 */
export async function readHostedControlBootstrap(options: {
  bootstrapFd?: number
  launcherLeaseFd?: number
  livenessFd?: number
  deadlineMs?: number
} = {}): Promise<HostedControlBootstrapAdmission> {
  const bootstrapFd = options.bootstrapFd ?? HOSTED_CONTROL_BOOTSTRAP_FD
  const launcherLeaseFd = options.launcherLeaseFd ?? HOSTED_CONTROL_LAUNCHER_LEASE_FD
  const livenessFd = options.livenessFd ?? HOSTED_CONTROL_LIVENESS_FD
  const deadlineMs = options.deadlineMs ?? HOSTED_CONTROL_BOOTSTRAP_DEADLINE_MS
  let secret: Buffer | null = null
  let admitted = false
  const deadlineAt = Date.now() + deadlineMs
  try {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) fail()
    ensureBeforeDeadline(deadlineAt)
    const descriptorStats = await Promise.all([
      checkedFstat(launcherLeaseFd), checkedFstat(livenessFd), checkedFstat(bootstrapFd),
    ])
    ensureBeforeDeadline(deadlineAt)
    validateDescriptorKinds(descriptorStats)
    const frame = await readOneUseFrame(bootstrapFd, deadlineAt)
    let header: HostedControlBootstrapHeader
    try {
      if (frame.byteLength < 4 + 2 + 32 + AUTHENTICATOR_BYTES) fail()
      const headerLength = frame.readUInt32BE(0)
      if (headerLength < 2 || headerLength > HOSTED_CONTROL_BOOTSTRAP_MAX_HEADER_BYTES ||
        frame.byteLength !== 4 + headerLength + 32 + AUTHENTICATOR_BYTES) fail()
      const authenticatedBytes = frame.subarray(0, 4 + headerLength)
      const keyBytes = frame.subarray(4 + headerLength, 4 + headerLength + 32)
      const suppliedAuthenticator = frame.subarray(4 + headerLength + 32)
      const expectedAuthenticator = bootstrapAuthenticator(keyBytes, authenticatedBytes)
      const authenticated = timingSafeEqual(suppliedAuthenticator, expectedAuthenticator)
      expectedAuthenticator.fill(0)
      if (!authenticated) fail()
      header = decodeCanonicalHeader(frame.subarray(4, 4 + headerLength))
      secret = Buffer.from(keyBytes)
    } finally {
      frame.fill(0)
    }
    await validateLeaseEvidence(launcherLeaseFd, descriptorStats[0], header.leaseEvidence)
    validateBootstrapBinding(
      header.bootstrapBinding, header.approvalActivationV2, header.leaseEvidence, secret,
    )
    ensureBeforeDeadline(deadlineAt)
    const guard = createDescriptorGuard(launcherLeaseFd, livenessFd, header.leaseEvidence)
    const config: Omit<HostedControlRuntimeConfig, 'secretFile'> = {
      socketPath: header.socketPath,
      claudeRoot: header.claudeRoot,
      deploymentId: header.bootstrapBinding.deploymentId,
      bootId: header.bootstrapBinding.bootId,
      restoreGeneration: header.restoreGeneration,
      workspaceId: header.bootstrapBinding.workspaceId,
      teamId: header.teamId,
      legacyKey: header.legacyKey,
      mountGeneration: header.bootstrapBinding.mountGeneration,
      declaredRootHash: header.declaredRootHash,
      ownerAuthority: header.ownerAuthority,
      ownerGeneration: header.ownerGeneration,
      ownerSessionId: header.ownerSessionId,
    }
    const result = {
      config,
      bootstrapBinding: header.bootstrapBinding,
      approvalActivationV2: header.approvalActivationV2,
      secret,
      guard,
    }
    admitted = true
    return result
  } catch {
    fail()
  } finally {
    await closeAsync(bootstrapFd).catch(() => undefined)
    if (!admitted) {
      secret?.fill(0)
      await Promise.all([...new Set([launcherLeaseFd, livenessFd])].map(fd =>
        closeAsync(fd).catch(() => undefined),
      ))
    }
  }
}

function decodeCanonicalHeader(bytes: Buffer): HostedControlBootstrapHeader {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail() }
  let unknown: unknown
  try { unknown = JSON.parse(text) } catch { fail() }
  const raw = exactRecord(unknown, HEADER_KEYS)
  if (JSON.stringify(raw) !== text) fail()
  const binding = exactRecord(raw.bootstrapBinding, BINDING_KEYS)
  const activation = exactRecord(raw.approvalActivationV2, ACTIVATION_KEYS)
  const signedManifest = exactRecord(activation.signedManifest, SIGNED_MANIFEST_KEYS)
  const evidence = exactRecord(raw.leaseEvidence, EVIDENCE_KEYS)
  const header: HostedControlBootstrapHeader = {
    format: exactString(raw.format, /^agent-teams\.hosted-control\.bootstrap\/v1$/) as typeof HOSTED_CONTROL_BOOTSTRAP_FORMAT,
    restoreGeneration: integer(raw.restoreGeneration, 0),
    teamId: exactString(raw.teamId, /^team_[0-9a-f]{32}$/),
    declaredRootHash: exactString(raw.declaredRootHash, /^[0-9a-f]{64}$/),
    ownerAuthority: exactString(raw.ownerAuthority, /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/),
    ownerGeneration: integer(raw.ownerGeneration, 1),
    ownerSessionId: exactString(raw.ownerSessionId, /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/),
    claudeRoot: absoluteCanonicalPath(raw.claudeRoot),
    socketPath: absoluteCanonicalPath(raw.socketPath, 103),
    legacyKey: exactString(raw.legacyKey, /^[A-Za-z0-9_-]{1,128}$/),
    approvalActivationV2: {
      approvalGeneration: integer(activation.approvalGeneration, 1),
      admissionOwnerGeneration: integer(activation.admissionOwnerGeneration, 1),
      approvalDigest: exactString(activation.approvalDigest, /^sha256:[0-9a-f]{64}$/) as `sha256:${string}`,
      admissionDocumentDigest: exactString(activation.admissionDocumentDigest, /^sha256:[0-9a-f]{64}$/) as `sha256:${string}`,
      ownerArtifactDigest: exactString(activation.ownerArtifactDigest, /^sha256:[0-9a-f]{64}$/) as `sha256:${string}`,
      wireCapabilityDigest: exactString(activation.wireCapabilityDigest, /^sha256:[0-9a-f]{64}$/) as `sha256:${string}`,
      signedManifest: {
        format: exactString(signedManifest.format, /^agent-teams\.hosted-lifecycle-owner-admission\/v4$/) as 'agent-teams.hosted-lifecycle-owner-admission/v4',
        manifestDigest: exactString(signedManifest.manifestDigest, /^sha256:[0-9a-f]{64}$/) as `sha256:${string}`,
        releasePinDigest: exactString(signedManifest.releasePinDigest, /^sha256:[0-9a-f]{64}$/) as `sha256:${string}`,
        launcherKeyId: exactString(signedManifest.launcherKeyId, /^[0-9a-f]{64}$/),
      },
    },
    bootstrapBinding: {
      deploymentId: exactString(binding.deploymentId, ID),
      bootId: exactString(binding.bootId, ID),
      workspaceId: exactString(binding.workspaceId, ID),
      mountGeneration: integer(binding.mountGeneration, 1),
      bootstrapDigest: exactString(binding.bootstrapDigest, /^[0-9a-f]{64}$/),
      ownerArtifactDigest: exactString(binding.ownerArtifactDigest, /^sha256:[0-9a-f]{64}$/),
      proofKeyId: exactString(binding.proofKeyId, /^[0-9a-f]{64}$/),
    },
    leaseEvidence: {
      device: exactString(evidence.device, /^\d{1,32}$/),
      inode: exactString(evidence.inode, /^\d{1,32}$/),
      uid: integer(evidence.uid, 0), gid: integer(evidence.gid, 0),
      mode: integer(evidence.mode, 0, 0o777),
      launcherLeaseId: exactString(evidence.launcherLeaseId, ID),
      launcherArtifactDigest: exactString(evidence.launcherArtifactDigest, /^[0-9a-f]{64}$/),
    },
  }
  if (header.format !== HOSTED_CONTROL_BOOTSTRAP_FORMAT || header.claudeRoot === header.socketPath) fail()
  return header
}

function validateBootstrapBinding(
  binding: HostedControlBootstrapBinding,
  activation: HostedApprovalActivationV2BootstrapExpectation,
  evidence: HostedControlLeaseEvidence,
  secret: Buffer,
): void {
  if (binding.ownerArtifactDigest !== `sha256:${evidence.launcherArtifactDigest}` ||
    binding.proofKeyId !== createHash('sha256').update(secret).digest('hex') ||
    activation.ownerArtifactDigest !== binding.ownerArtifactDigest) fail()
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const actual = Object.keys(value as object)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail()
  return value as Record<string, unknown>
}

function exactString(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail()
  return value as string
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail()
  return value as number
}
function absoluteCanonicalPath(value: unknown, maximumBytes?: number): string {
  const path = exactString(value, /^\//)
  if (path.includes('\0') || path.includes('//') || path.split('/').some(part => part === '.' || part === '..') ||
    (maximumBytes !== undefined && Buffer.byteLength(path) > maximumBytes)) fail()
  return path
}

async function checkedFstat(fd: number): Promise<BigIntStats> {
  if (!Number.isSafeInteger(fd) || fd < 0) fail()
  try {
    return await new Promise<BigIntStats>((resolve, reject) => {
      fstat(fd, { bigint: true }, (error, stat) => error ? reject(error) : resolve(stat))
    })
  } catch { fail() }
}

function validateDescriptorKinds([lease, liveness, bootstrap]: BigIntStats[]): void {
  if (!lease.isFile() || (!liveness.isFIFO() && !liveness.isSocket()) ||
    (!bootstrap.isFIFO() && !bootstrap.isSocket())) fail()
  const identities = [lease, liveness, bootstrap].map(stat => `${stat.dev}:${stat.ino}`)
  if (new Set(identities).size !== identities.length) fail()
}

async function validateLeaseEvidence(fd: number, stat: BigIntStats, evidence: HostedControlLeaseEvidence): Promise<void> {
  const uid = safeStatNumber(stat.uid)
  const gid = safeStatNumber(stat.gid)
  const mode = safeStatNumber(stat.mode & 0o777n)
  const size = safeStatNumber(stat.size)
  if (String(stat.dev) !== evidence.device || String(stat.ino) !== evidence.inode ||
    uid !== evidence.uid || gid !== evidence.gid || mode !== evidence.mode ||
    (stat.mode & 0o077n) !== 0n || (process.getuid?.() !== undefined && uid !== process.getuid?.()) ||
    size < 1 || size > MAX_LEASE_ARTIFACT_BYTES) fail()
  const artifact = Buffer.allocUnsafe(size)
  let digest: string | null = null
  try {
    let offset = 0
    while (offset < artifact.length) {
      const count = await readAt(fd, artifact, offset, artifact.length - offset, offset)
      if (count === 0) fail()
      offset += count
    }
    const after = await checkedFstat(fd)
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.uid !== stat.uid ||
      after.gid !== stat.gid || after.mode !== stat.mode || after.size !== stat.size) fail()
    digest = createHash('sha256').update(artifact).digest('hex')
  } finally {
    artifact.fill(0)
  }
  if (digest === null || digest !== evidence.launcherArtifactDigest) fail()
}

function safeStatNumber(value: bigint): number {
  const converted = Number(value)
  if (!Number.isSafeInteger(converted) || converted < 0) fail()
  return converted
}

function createDescriptorGuard(leaseFd: number, livenessFd: number, evidence: HostedControlLeaseEvidence): HostedControlDescriptorGuard {
  let current = true
  let closed = false
  let resolveLost!: () => void
  const lost = new Promise<void>(resolve => { resolveLost = resolve })
  const markLost = () => { if (current) { current = false; resolveLost() } }
  const stream = createReadStream('', { fd: livenessFd, autoClose: true })
  const streamClosed = new Promise<void>(resolve => stream.once('close', resolve))
  stream.once('data', () => { markLost(); stream.destroy() })
  stream.once('end', markLost)
  stream.once('error', markLost)
  stream.resume()
  return {
    lost,
    async assertCurrent() {
      if (!current || closed) return false
      try {
        const stat = await checkedFstat(leaseFd)
        await validateLeaseEvidence(leaseFd, stat, evidence)
        return current && !closed
      } catch { markLost(); return false }
    },
    async close() {
      if (closed) return
      closed = true
      markLost()
      stream.destroy()
      await Promise.all([streamClosed, closeAsync(leaseFd).catch(() => undefined)])
    },
  }
}

function readAt(fd: number, buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => read(fd, buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve(bytesRead)))
}

/** Reads through EOF so the inherited bootstrap channel cannot be replayed or extended. */
async function readOneUseFrame(fd: number, deadlineAt: number): Promise<Buffer> {
  const maximum = 4 + HOSTED_CONTROL_BOOTSTRAP_MAX_HEADER_BYTES + 32 + AUTHENTICATOR_BYTES
  // The extra byte proves oversize without allocating attacker-controlled
  // chunks. Destroying the descriptor-owning stream enforces the absolute
  // deadline and makes its close event the admission barrier.
  const bytes = Buffer.allocUnsafe(maximum + 1)
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      let offset = 0
      let settled = false
      let failure: Error | null = null
      const stream = createReadStream('', { fd, autoClose: true })
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failure) {
          bytes.fill(0)
          reject(failure)
        } else {
          const frame = Buffer.from(bytes.subarray(0, offset))
          bytes.fill(0)
          resolve(frame)
        }
      }
      stream.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (offset + buffer.byteLength > maximum) {
          failure = new Error('oversize')
          buffer.fill(0)
          stream.destroy()
          return
        }
        buffer.copy(bytes, offset)
        offset += buffer.byteLength
        buffer.fill(0)
      })
      stream.once('error', error => { failure ??= error })
      stream.once('close', finish)
      const timer = setTimeout(() => {
        if (settled) return
        failure = new Error('deadline')
        stream.destroy()
      }, remainingMs(deadlineAt))
      stream.resume()
    })
  } catch { bytes.fill(0); fail() }
}

function bootstrapAuthenticator(key: Uint8Array, authenticatedBytes: Uint8Array): Buffer {
  return createHmac('sha256', key)
    .update(HOSTED_CONTROL_BOOTSTRAP_FORMAT, 'utf8')
    .update(Buffer.from([0]))
    .update(authenticatedBytes)
    .digest()
}

function remainingMs(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) fail()
  return remaining
}

function ensureBeforeDeadline(deadlineAt: number): void {
  remainingMs(deadlineAt)
}
function fail(): never { throw new Error('Hosted control bootstrap was rejected') }
