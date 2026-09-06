import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ExpectedSupervisedOpenCode } from '../opencode/OpenCodeSupervisedHostCustody.js'
import type { HostedControlBootstrapHeader, HostedApprovalActivationV2BootstrapExpectation } from './HostedControlBootstrap.js'

export const BOOTSTRAP_V2 = 'agent-teams.hosted-control.bootstrap/v2' as const
export const AUTH_V2 = 'agent-teams.hosted-control.opencode-server-auth/v1' as const
export const LEASE_V2 = 'agent-teams.hosted-control.launcher-lease/v2' as const
export const STATEMENT_V2 = 'agent-teams.hosted-control.bootstrap-statement/v2' as const
export const OWNER_V2_ROLES = Object.freeze({
  'sealed-launcher-lease': 3, bootstrap: 4, 'activation-v2': 5, liveness: 6,
  'private-server-auth': 7, 'raw-opencode-retention': 8, 'owner-wal-native': 9, 'executable-anchor': 11,
} as const)
export type OwnerV2Role = keyof typeof OWNER_V2_ROLES
export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T
export type PendingManifestV2 = Omit<HostedApprovalActivationV2BootstrapExpectation, 'signedManifest'> & {
  signedManifest: Omit<HostedApprovalActivationV2BootstrapExpectation['signedManifest'], 'manifestDigest'>
}
export type OwnerDescriptorV2 = Readonly<{
  role: OwnerV2Role; childFd: number; kind: 'regular-file' | 'fifo' | 'socket'
  device: string; inode: string; uid: number; gid: number; mode: number
  accessMode: 'read-only' | 'write-only' | 'read-write'; append: boolean
}>
export type OwnerDescriptorMapV2 = Readonly<{
  schemaVersion: 2; contract: 'agent-teams.hosted-owner-child-fd-map/v2'
  wrapperPid: number; wrapperStartTicks: string; wrapperStartToken: string; spawnNonce: string
  descriptors: readonly OwnerDescriptorV2[]
}>
export type SupervisorBindingV2 = Readonly<{
  supervisorPid: number; supervisorStartTicks: string; supervisorStartToken: string
  supervisorExecutableSha256: string; recipeSha256: string; ownerEntrySha256: string
  ownerPid: number; ownerStartTicks: string; ownerProcessStartToken: string
  harnessContractSha256: string; ownerProducerCapsuleSha256: string
}>
export type RawRetentionBindingV2 = Readonly<{
  format: 'agent-teams.hosted-control.opencode-raw-retention/v1'; captureId: string
  initialByteLength: number; initialSha256: string; nextSequence: number
}>
export type BootstrapHeaderV2 = Immutable<Omit<HostedControlBootstrapHeader,
  'format' | 'leaseEvidence' | 'approvalActivationV2'> & {
  format: typeof BOOTSTRAP_V2
  approvalActivationV2: PendingManifestV2
  leaseEvidence: HostedControlBootstrapHeader['leaseEvidence'] & { leaseArtifactSha256: string }
  expectedHost: ExpectedSupervisedOpenCode; supervisorBinding: SupervisorBindingV2
  descriptorMap: OwnerDescriptorMapV2; rawRetention: RawRetentionBindingV2
  serverAuthBinding: { format: typeof AUTH_V2; serverAuthId: string; expectedHostSha256: string
    descriptorMapSha256: string; authHmacSha256: string }
}>
export type ServerCredentialsV2 = Readonly<{ id: string; username: string; password: string }>
export const HEX_V2 = /^[0-9a-f]{64}$/
export const SHA_V2 = /^sha256:[0-9a-f]{64}$/
export const ID_V2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
export function requireV2(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`hosted_owner_v2_${reason}`)
}
export function recordV2(value: unknown, fields: string): Record<string, unknown> {
  requireV2(value && typeof value === 'object' && !Array.isArray(value), 'object')
  const keys = fields.split(','); const actual = Object.keys(value)
  requireV2(actual.length === keys.length && actual.every(k => keys.includes(k)), 'fields')
  return value as Record<string, unknown>
}
export function textV2(value: unknown, pattern = ID_V2): string {
  requireV2(typeof value === 'string' && pattern.test(value), 'string'); return value
}
export function integerV2(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  requireV2(Number.isSafeInteger(value) && !Object.is(value, -0) && Number(value) >= min && Number(value) <= max, 'integer')
  return value as number
}
export function decimalV2(value: unknown, ticks = false): string {
  const s = textV2(value, /^(?:0|[1-9][0-9]{0,19})$/)
  requireV2(BigInt(s) <= 0xffffffffffffffffn && (!ticks || Number.isSafeInteger(Number(s))), 'decimal')
  return s
}
export function pathV2(value: unknown, max = 4096): string {
  const p = textV2(value, /^\//)
  requireV2(Buffer.byteLength(p) <= max && !p.includes('\0') && !p.includes('//') &&
    !p.split('/').some(s => s === '.' || s === '..'), 'path'); return p
}
export function immutableV2<T>(value: T): Immutable<T> {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) immutableV2(v)
    Object.freeze(value)
  }
  return value as Immutable<T>
}
export function canonicalV2(value: unknown, depth = 0): string {
  requireV2(depth < 32, 'depth')
  if (typeof value === 'string') requireV2(Buffer.from(value).toString('utf8') === value, 'unicode')
  if (typeof value === 'number') integerV2(value, 0)
  if (Array.isArray(value)) return `[${value.map(v => canonicalV2(v, depth + 1)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b))).map(k =>
    `${canonicalV2(k, depth + 1)}:${canonicalV2((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`
  const s = JSON.stringify(value); requireV2(s !== undefined, 'json'); return s
}
export function decodeCanonicalV2(bytes: Buffer, maximum: number): unknown {
  requireV2(bytes.length >= 2 && bytes.length <= maximum, 'size')
  const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const value: unknown = JSON.parse(s)
  // Byte comparison rejects duplicate keys, BOM, -0, exponents, escapes, LF and whitespace.
  requireV2(Buffer.from(canonicalV2(value)).equals(bytes), 'canonical')
  return value
}
export function hashV2(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function macV2(key: Uint8Array, domain: string, bytes: Uint8Array): Buffer {
  return createHmac('sha256', key).update(domain).update('\0').update(bytes).digest()
}
function requireMac(key: Buffer, domain: string, bytes: Buffer, supplied: Buffer): void {
  const wanted = macV2(key, domain, bytes)
  try { requireV2(supplied.length === wanted.length && timingSafeEqual(wanted, supplied), 'hmac') }
  finally { wanted.fill(0) }
}

export function decodeHeaderV2(bytes: Buffer): BootstrapHeaderV2 {
  const r = recordV2(decodeCanonicalV2(bytes, 65536), 'format,restoreGeneration,teamId,declaredRootHash,ownerAuthority,ownerGeneration,ownerSessionId,claudeRoot,socketPath,legacyKey,approvalActivationV2,bootstrapBinding,leaseEvidence,expectedHost,supervisorBinding,descriptorMap,serverAuthBinding,rawRetention')
  requireV2(r.format === BOOTSTRAP_V2, 'format')
  integerV2(r.restoreGeneration, 0); integerV2(r.ownerGeneration)
  textV2(r.teamId, /^team_[0-9a-f]{32}$/); textV2(r.declaredRootHash, HEX_V2)
  textV2(r.ownerAuthority, /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/)
  textV2(r.ownerSessionId, /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/)
  textV2(r.legacyKey, /^[A-Za-z0-9_-]{1,128}$/)
  pathV2(r.claudeRoot); pathV2(r.socketPath, 103); requireV2(r.claudeRoot !== r.socketPath, 'paths_distinct')
  const b = recordV2(r.bootstrapBinding, 'deploymentId,bootId,workspaceId,mountGeneration,bootstrapDigest,ownerArtifactDigest,proofKeyId')
  for (const k of ['deploymentId', 'bootId', 'workspaceId']) textV2(b[k])
  integerV2(b.mountGeneration); textV2(b.bootstrapDigest, HEX_V2); textV2(b.ownerArtifactDigest, SHA_V2); textV2(b.proofKeyId, HEX_V2)
  const a = recordV2(r.approvalActivationV2, 'approvalGeneration,admissionOwnerGeneration,approvalDigest,admissionDocumentDigest,ownerArtifactDigest,wireCapabilityDigest,signedManifest')
  integerV2(a.approvalGeneration); integerV2(a.admissionOwnerGeneration)
  for (const k of ['approvalDigest', 'admissionDocumentDigest', 'ownerArtifactDigest', 'wireCapabilityDigest']) textV2(a[k], SHA_V2)
  const m = recordV2(a.signedManifest, 'format,releasePinDigest,launcherKeyId')
  requireV2(m.format === 'agent-teams.hosted-lifecycle-owner-admission/v4', 'manifest_format')
  textV2(m.releasePinDigest, SHA_V2); textV2(m.launcherKeyId, HEX_V2)
  const l = recordV2(r.leaseEvidence, 'device,inode,uid,gid,mode,launcherLeaseId,launcherArtifactDigest,leaseArtifactSha256')
  decimalV2(l.device); decimalV2(l.inode); integerV2(l.uid, 0, 0xffffffff); integerV2(l.gid, 0, 0xffffffff)
  requireV2(l.mode === 0o600, 'lease_mode'); textV2(l.launcherLeaseId)
  textV2(l.launcherArtifactDigest, HEX_V2); textV2(l.leaseArtifactSha256, HEX_V2)
  requireV2(b.ownerArtifactDigest === `sha256:${l.launcherArtifactDigest}` && a.ownerArtifactDigest === b.ownerArtifactDigest, 'artifact_binding')
  validateExpectedHost(r.expectedHost)
  const s = recordV2(r.supervisorBinding, 'supervisorPid,supervisorStartTicks,supervisorStartToken,supervisorExecutableSha256,recipeSha256,ownerEntrySha256,ownerPid,ownerStartTicks,ownerProcessStartToken,harnessContractSha256,ownerProducerCapsuleSha256')
  integerV2(s.supervisorPid, 1, 0x7fffffff); integerV2(s.ownerPid, 2, 0x7fffffff)
  decimalV2(s.supervisorStartTicks, true); decimalV2(s.ownerStartTicks, true)
  for (const k of ['supervisorStartToken', 'supervisorExecutableSha256', 'recipeSha256', 'ownerEntrySha256', 'ownerProcessStartToken', 'harnessContractSha256', 'ownerProducerCapsuleSha256']) textV2(s[k], HEX_V2)
  validateMap(r.descriptorMap)
  const auth = recordV2(r.serverAuthBinding, 'format,serverAuthId,expectedHostSha256,descriptorMapSha256,authHmacSha256')
  requireV2(auth.format === AUTH_V2, 'auth_format'); textV2(auth.serverAuthId)
  for (const k of ['expectedHostSha256', 'descriptorMapSha256', 'authHmacSha256']) textV2(auth[k], HEX_V2)
  const raw = recordV2(r.rawRetention, 'format,captureId,initialByteLength,initialSha256,nextSequence')
  requireV2(raw.format === 'agent-teams.hosted-control.opencode-raw-retention/v1', 'raw_format')
  integerV2(raw.initialByteLength, 0, 64 * 1024 * 1024); integerV2(raw.nextSequence)
  textV2(raw.captureId, HEX_V2); textV2(raw.initialSha256, HEX_V2)
  requireV2(raw.initialByteLength !== 0 || (raw.initialSha256 === hashV2('') && raw.nextSequence === 1), 'raw_prefix')
  const h = r as unknown as BootstrapHeaderV2; const e = h.expectedHost
  requireV2(e.activation.bootstrapDigest === b.bootstrapDigest && e.activation.ownerArtifactDigest === b.ownerArtifactDigest &&
    e.activation.admissionDocumentDigest === a.admissionDocumentDigest && e.activation.ownerGeneration === r.ownerGeneration &&
    e.activation.ownerSessionId === r.ownerSessionId && e.process.pid !== s.ownerPid &&
    e.serverAuthId === auth.serverAuthId && hashV2(canonicalV2(e)) === auth.expectedHostSha256 &&
    hashV2(canonicalV2(h.descriptorMap)) === auth.descriptorMapSha256, 'cross_binding')
  return immutableV2(h)
}
function validateExpectedHost(value: unknown): void {
  requireV2(Buffer.byteLength(canonicalV2(value)) <= 32768, 'expected_host_size')
  const e = recordV2(value, 'endpoint,process,executable,profile,hosted,activation,serverAuthId')
  const n = recordV2(e.endpoint, 'protocol,address,port,baseUrl'); integerV2(n.port, 1, 65535)
  requireV2(n.protocol === 'http:' && n.address === '127.0.0.1' && n.port === 4096 && n.baseUrl === `http://127.0.0.1:${n.port}` && new URL(String(n.baseUrl)).origin === n.baseUrl, 'endpoint')
  const p = recordV2(e.process, 'pid,startTicks,startIdentity,supervisorProcessStartToken,pidNamespaceInode,networkNamespaceInode')
  integerV2(p.pid, 2, 0x7fffffff); decimalV2(p.startTicks, true); integerV2(Number(p.startTicks))
  decimalV2(p.pidNamespaceInode); decimalV2(p.networkNamespaceInode); textV2(p.supervisorProcessStartToken, HEX_V2)
  requireV2(p.startIdentity === `start_${hashV2(`${p.pid}\0proc:${p.startTicks}`)}`, 'host_start')
  const x = recordV2(e.executable, 'device,inode,size,sha256,artifactManifestSha256,moduleSha256')
  for (const k of ['device', 'inode', 'size']) decimalV2(x[k])
  for (const k of ['sha256', 'artifactManifestSha256', 'moduleSha256']) textV2(x[k], HEX_V2)
  const f = recordV2(e.profile, 'projectPath,profileRootKey,profileRootPath,projectBehaviorFingerprint,managedConfigFingerprint,resolvedConfigFingerprint,sourceAuthFingerprint,managedAuthFingerprint,sourceAuthSources,toolApprovalMode')
  pathV2(f.projectPath); pathV2(f.profileRootPath); textV2(f.profileRootKey)
  for (const k of ['projectBehaviorFingerprint', 'managedConfigFingerprint', 'resolvedConfigFingerprint']) textV2(f[k], HEX_V2)
  for (const k of ['sourceAuthFingerprint', 'managedAuthFingerprint']) if (f[k] !== null) textV2(f[k], HEX_V2)
  requireV2(f.toolApprovalMode === 'manual' && Array.isArray(f.sourceAuthSources) && f.sourceAuthSources.length <= 32, 'profile')
  const paths = f.sourceAuthSources.map(v => { const a = recordV2(v, 'path,fingerprint'); if (a.fingerprint !== null) textV2(a.fingerprint, HEX_V2); return pathV2(a.path) })
  requireV2(new Set(paths).size === paths.length, 'auth_sources')
  const h = recordV2(e.hosted, 'schemaVersion,protocol,authentication,runtimeInstanceId,configGeneration')
  requireV2(h.schemaVersion === 2 && h.protocol === 'agent-teams-hosted-approval-v2' && h.authentication === 'opencode-basic', 'hosted')
  textV2(h.runtimeInstanceId, /^runtime_instance_[0-9a-f]{32}$/); textV2(h.configGeneration, /^config_generation_[0-9a-f]{32}$/)
  const a = recordV2(e.activation, 'controllerNonce,runId,stackManifestSha256,bootstrapDigest,admissionDocumentDigest,ownerArtifactDigest,ownerGeneration,ownerSessionId')
  for (const k of ['controllerNonce', 'runId', 'stackManifestSha256', 'bootstrapDigest']) textV2(a[k], HEX_V2)
  textV2(a.admissionDocumentDigest, SHA_V2); textV2(a.ownerArtifactDigest, SHA_V2); integerV2(a.ownerGeneration); textV2(a.ownerSessionId)
  textV2(e.serverAuthId)
}
function validateMap(value: unknown): void {
  requireV2(Buffer.byteLength(canonicalV2(value)) <= 8192, 'map_size')
  const m = recordV2(value, 'schemaVersion,contract,wrapperPid,wrapperStartTicks,wrapperStartToken,spawnNonce,descriptors')
  requireV2(m.schemaVersion === 2 && m.contract === 'agent-teams.hosted-owner-child-fd-map/v2', 'map_format')
  integerV2(m.wrapperPid, 1, 0x7fffffff); decimalV2(m.wrapperStartTicks, true)
  textV2(m.wrapperStartToken, HEX_V2); textV2(m.spawnNonce, HEX_V2)
  requireV2(m.wrapperStartToken === hashV2(canonicalV2({ contract: 'agent-teams.hosted-owner-wrapper-process-start/v1', pid: m.wrapperPid, startTime: m.wrapperStartTicks })), 'wrapper_token')
  requireV2(Array.isArray(m.descriptors) && m.descriptors.length === 8, 'roles')
  const rows = m.descriptors.map((v, i) => {
    const d = recordV2(v, 'role,childFd,kind,device,inode,uid,gid,mode,accessMode,append')
    const role = Object.keys(OWNER_V2_ROLES)[i] as OwnerV2Role
    requireV2(d.role === role && d.childFd === OWNER_V2_ROLES[role], 'role_fd')
    requireV2(['regular-file', 'fifo', 'socket'].includes(String(d.kind)) && ['read-only', 'write-only', 'read-write'].includes(String(d.accessMode)) && typeof d.append === 'boolean', 'descriptor')
    decimalV2(d.device); decimalV2(d.inode); integerV2(d.uid, 0, 0xffffffff); integerV2(d.gid, 0, 0xffffffff); integerV2(d.mode, 0, 0o7777)
    return d
  })
  requireV2(new Set(rows.map(d => `${d.device}:${d.inode}`)).size === 8, 'descriptor_alias')
}

/** Consumes mutable frames on success AND failure; returned key has a single new owner. */
export function decodeFramesV2(bootstrap: Buffer, auth: Buffer): {
  header: BootstrapHeaderV2; secret: Buffer; credentials: ServerCredentialsV2; bootstrapV2HeaderSha256: string
} {
  let secret: Buffer | undefined
  try {
    requireV2(bootstrap.length >= 70 && bootstrap.length <= 65604, 'frame_size')
    const n = bootstrap.readUInt32BE(0)
    requireV2(n >= 2 && n <= 65536 && bootstrap.length === n + 68, 'frame_length')
    secret = Buffer.from(bootstrap.subarray(n + 4, n + 36))
    requireMac(secret, BOOTSTRAP_V2, bootstrap.subarray(0, n + 4), bootstrap.subarray(n + 36))
    const header = decodeHeaderV2(bootstrap.subarray(4, n + 4))
    requireV2(hashV2(secret) === header.bootstrapBinding.proofKeyId, 'proof_key')
    requireV2(auth.length >= 6 && auth.length <= 8196 && auth.readUInt32BE(0) === auth.length - 4, 'auth_length')
    requireMac(secret, AUTH_V2, auth, Buffer.from(header.serverAuthBinding.authHmacSha256, 'hex'))
    const a = recordV2(decodeCanonicalV2(auth.subarray(4), 8192), 'format,bootstrapDigest,spawnNonce,expectedHostSha256,descriptorMapSha256,serverAuthId,username,password')
    const b = header.serverAuthBinding
    requireV2(a.format === AUTH_V2 && a.bootstrapDigest === header.bootstrapBinding.bootstrapDigest &&
      a.spawnNonce === header.descriptorMap.spawnNonce && a.expectedHostSha256 === b.expectedHostSha256 &&
      a.descriptorMapSha256 === b.descriptorMapSha256 && a.serverAuthId === b.serverAuthId, 'auth_binding')
    const username = textV2(a.username, /^[^:\r\n\0]+$/); const password = textV2(a.password, /^[^\r\n\0]+$/)
    requireV2(Buffer.byteLength(username) <= 128 && Buffer.byteLength(password) <= 4096, 'credentials_size')
    return { header, secret, credentials: Object.freeze({ id: b.serverAuthId, username, password }),
      bootstrapV2HeaderSha256: hashV2(bootstrap.subarray(4, n + 4)) }
  } catch { secret?.fill(0); throw new Error('hosted_owner_v2_frame_rejected') }
  finally { bootstrap.fill(0); auth.fill(0) }
}
export function verifyLeaseV2(bytes: Buffer, header: BootstrapHeaderV2): void {
  const lease = recordV2(decodeCanonicalV2(bytes, 65536), 'format,launcherLeaseId,bootstrapStatementSha256')
  const { leaseArtifactSha256, ...evidence } = header.leaseEvidence
  const statement = hashV2(`${STATEMENT_V2}\0${canonicalV2({ ...header, leaseEvidence: evidence })}`)
  requireV2(lease.format === LEASE_V2 && lease.launcherLeaseId === evidence.launcherLeaseId &&
    lease.bootstrapStatementSha256 === statement && hashV2(bytes) === leaseArtifactSha256, 'lease_statement')
}
