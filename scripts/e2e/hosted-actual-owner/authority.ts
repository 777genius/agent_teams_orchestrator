import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants, fstatSync, lstatSync, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { HostedApprovalRuntimeAdmission } from '../../../src/services/hostedControl/HostedApprovalRuntimeAdmission.js'
import { assertNoDuplicateJsonObjectKeys } from '../../../src/services/hostedControl/ownerProof.js'
import { sandboxAnchor, type ActualOwnerAcceptanceConfig } from './contracts.js'
import { openTrustedDirectory, type SecureFileIdentity } from './secure-files.js'

const PURPOSE = 'agent-teams.hosted-actual-owner-e2e.capability/v1' as const
const MAX_RESPONSE_BYTES = 64 * 1024
const ROUTE_RUN_ID = /^run_[0-9a-f]{32}$/
const CAPTURE_FIELDS = Object.freeze([
  'browserResultsPath', 'conditionalPostLedgerPath', 'negativeResultsPath', 'openCodeTimelinePath',
  'ownerWalTimelinePath', 'productTimelinePath', 'protectedEffectLedgerPath',
] as const)

type CaptureField = (typeof CAPTURE_FIELDS)[number]
type RouteBinding = Readonly<{
  routeId: string
  sessionId: string
  routeRunId: string
  generation: string
}>
type NamespaceLease = Readonly<{
  path: string
  parentPath: string
  device: string
  inode: string
  handle: FileHandle
  rootHandle: FileHandle
}>
type FileLease = Readonly<{
  path: string
  identity: SecureFileIdentity
  handle: FileHandle
  parent: NamespaceLease
}>

type EffectAuthority = { consume(): boolean }

export function combineEffectAuthorities(
  adapter: EffectAuthority,
  acceptance: EffectAuthority,
): EffectAuthority {
  let consumed = false
  return Object.freeze({
    consume: () => {
      if (consumed) return false
      consumed = true
      let adapterCurrent = false
      let acceptanceCurrent = false
      try {
        adapterCurrent = adapter.consume()
      } finally {
        acceptanceCurrent = acceptance.consume()
      }
      return adapterCurrent && acceptanceCurrent
    },
  })
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hosted_actual_owner_capability_invalid')
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('hosted_actual_owner_capability_invalid')
  }
}

async function boundedResponse(response: Response): Promise<Buffer> {
  if (!response.ok || response.status !== 200 || !response.body ||
    response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
    throw new Error('hosted_actual_owner_capability_unavailable')
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel(); throw new Error('hosted_actual_owner_capability_oversized')
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks, bytes)
}

async function openNamespace(config: ActualOwnerAcceptanceConfig, path: string): Promise<NamespaceLease> {
  const parentPath = dirname(path)
  const parent = await openTrustedDirectory(parentPath, sandboxAnchor(config.runtime))
  return Object.freeze({
    path, parentPath, device: parent.stat.dev.toString(), inode: parent.stat.ino.toString(),
    handle: parent.handle, rootHandle: parent.rootHandle,
  })
}

async function openFileLease(config: ActualOwnerAcceptanceConfig, path: string,
  identity: SecureFileIdentity, mode: number): Promise<FileLease> {
  const parent = await openNamespace(config, path)
  try {
    const handle = await open(`/proc/self/fd/${parent.handle.fd}/${path.split('/').at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || !sameFileIdentity(stat, identity) || Number(stat.mode & 0o777n) !== mode) {
      await handle.close(); throw new Error('hosted_actual_owner_authority_file_invalid')
    }
    return Object.freeze({ path, identity, handle, parent })
  } catch (error) {
    await closeNamespace(parent); throw error
  }
}

async function closeNamespace(lease: NamespaceLease): Promise<void> {
  if (lease.handle !== lease.rootHandle) await lease.handle.close().catch(() => undefined)
  await lease.rootHandle.close().catch(() => undefined)
}

async function assertNamespace(lease: NamespaceLease): Promise<void> {
  const [descriptor, linked] = await Promise.all([
    lease.handle.stat({ bigint: true }), lstat(lease.parentPath, { bigint: true }),
  ])
  if (!descriptor.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
    descriptor.dev !== linked.dev || descriptor.ino !== linked.ino ||
    descriptor.dev.toString() !== lease.device || descriptor.ino.toString() !== lease.inode) {
    throw new Error('hosted_actual_owner_authority_namespace_rotated')
  }
}

async function assertFile(lease: FileLease): Promise<void> {
  await assertNamespace(lease.parent)
  const [descriptor, linked] = await Promise.all([
    lease.handle.stat({ bigint: true }), lstat(lease.path, { bigint: true }),
  ])
  if (!descriptor.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
    descriptor.dev !== linked.dev || descriptor.ino !== linked.ino ||
    !sameFileIdentity(descriptor, lease.identity)) {
    throw new Error('hosted_actual_owner_authority_file_rotated')
  }
}

function assertNamespaceSync(lease: NamespaceLease): void {
  const descriptor = fstatSync(lease.handle.fd, { bigint: true })
  const linked = lstatSync(lease.parentPath, { bigint: true })
  if (!descriptor.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
    descriptor.dev !== linked.dev || descriptor.ino !== linked.ino ||
    descriptor.dev.toString() !== lease.device || descriptor.ino.toString() !== lease.inode) {
    throw new Error('hosted_actual_owner_authority_namespace_rotated')
  }
}

function assertFileSync(lease: FileLease): void {
  assertNamespaceSync(lease.parent)
  const descriptor = fstatSync(lease.handle.fd, { bigint: true })
  const linked = lstatSync(lease.path, { bigint: true })
  if (!descriptor.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
    descriptor.dev !== linked.dev || descriptor.ino !== linked.ino ||
    !sameFileIdentity(descriptor, lease.identity)) {
    throw new Error('hosted_actual_owner_authority_file_rotated')
  }
}

function sameFileIdentity(stat: BigIntStats, identity: SecureFileIdentity): boolean {
  return stat.dev.toString() === identity.device && stat.ino.toString() === identity.inode &&
    stat.size.toString() === identity.size && stat.mtimeNs.toString() === identity.mtimeNs &&
    stat.ctimeNs.toString() === identity.ctimeNs && (stat.mode & 0o777n).toString() === identity.mode &&
    stat.nlink.toString() === identity.nlink && stat.uid.toString() === identity.uid
}

export class AcceptanceEffectAuthority {
  private consumed = false
  constructor(private readonly authority: AcceptanceAuthority, readonly route: RouteBinding) {}
  consume(): boolean {
    if (this.consumed) {
      throw new Error('hosted_actual_owner_effect_authority_invalid')
    }
    this.consumed = true
    this.authority.assertCurrentAtEffectEdge(this.route)
    return true
  }
}

export class AcceptanceAuthority {
  private constructor(
    private readonly config: ActualOwnerAcceptanceConfig,
    private readonly admission: HostedApprovalRuntimeAdmission,
    readonly routes: ReadonlyMap<string, RouteBinding>,
    private readonly captures: readonly NamespaceLease[],
    private readonly contract: FileLease,
    private readonly manifest: FileLease,
  ) {}

  static async acquire(config: ActualOwnerAcceptanceConfig,
    admission: HostedApprovalRuntimeAdmission): Promise<AcceptanceAuthority> {
    const validated = await queryCapability(config, admission)
    const { routes, captures: captureInput } = validated
    const captures: NamespaceLease[] = []
    let contract: FileLease | null = null; let manifest: FileLease | null = null
    try {
      for (const field of CAPTURE_FIELDS) {
        const binding = record(captureInput[field]); exact(binding, ['path', 'parentDevice', 'parentInode'])
        const path = config.runtime.capture[field]
        const lease = await openNamespace(config, path)
        if (binding.path !== path || binding.parentDevice !== lease.device || binding.parentInode !== lease.inode) {
          await closeNamespace(lease); throw new Error('hosted_actual_owner_capture_binding_invalid')
        }
        captures.push(lease)
      }
      contract = await openFileLease(config, config.runtime.contract.path, config.productContract.identity, 0o400)
      manifest = await openFileLease(config, config.runtimeManifestPath, config.runtimeManifestIdentity, 0o600)
      return new AcceptanceAuthority(config, admission, routes, Object.freeze(captures), contract, manifest)
    } catch (error) {
      await Promise.all(captures.map(closeNamespace))
      if (contract) { await contract.handle.close(); await closeNamespace(contract.parent) }
      if (manifest) { await manifest.handle.close(); await closeNamespace(manifest.parent) }
      throw error
    }
  }

  async prepareEffectToken(expected: RouteBinding): Promise<AcceptanceEffectAuthority> {
    const route = this.routes.get(expected.routeId)
    if (!route || JSON.stringify(expected) !== JSON.stringify(route)) {
      throw new Error('hosted_actual_owner_effect_route_unadmitted')
    }
    await this.assertCurrent()
    return new AcceptanceEffectAuthority(this, route)
  }

  assertCurrentAtEffectEdge(expected: RouteBinding): void {
    const route = this.routes.get(expected.routeId)
    if (!route || JSON.stringify(expected) !== JSON.stringify(route)) {
      throw new Error('hosted_actual_owner_effect_route_unadmitted')
    }
    for (const capture of this.captures) assertNamespaceSync(capture)
    assertFileSync(this.contract)
    assertFileSync(this.manifest)
  }

  async assertCurrent(): Promise<void> {
    await Promise.all([
      ...this.captures.map(assertNamespace), assertFile(this.contract), assertFile(this.manifest),
      queryCapability(this.config, this.admission).then(current => {
        if (JSON.stringify([...current.routes]) !== JSON.stringify([...this.routes])) {
          throw new Error('hosted_actual_owner_capability_rotated')
        }
        for (const [index, field] of CAPTURE_FIELDS.entries()) {
          const lease = this.captures[index]!
          const expected = { path: lease.path, parentDevice: lease.device, parentInode: lease.inode }
          if (JSON.stringify(current.captures[field]) !== JSON.stringify(expected)) {
            throw new Error('hosted_actual_owner_capability_rotated')
          }
        }
      }),
    ])
  }

  async close(): Promise<void> {
    await Promise.all([
      ...this.captures.map(closeNamespace),
      this.contract.handle.close().then(() => closeNamespace(this.contract.parent)),
      this.manifest.handle.close().then(() => closeNamespace(this.manifest.parent)),
    ])
  }
}

function parseRoutes(value: unknown, admission: HostedApprovalRuntimeAdmission): ReadonlyMap<string, RouteBinding> {
  if (!Array.isArray(value) || value.length !== admission.routes.length) {
    throw new Error('hosted_actual_owner_capability_routes_invalid')
  }
  const expected = new Map(admission.routes.map(route => [route.routeId, Object.freeze({
    routeId: route.routeId, sessionId: route.authority.sessionId, routeRunId: route.authority.runId,
    generation: route.scope.authorityGeneration,
  })]))
  const result = new Map<string, RouteBinding>()
  for (const candidate of value) {
    const route = record(candidate); exact(route, ['routeId', 'sessionId', 'routeRunId', 'generation'])
    const projected = expected.get(String(route.routeId))
    if (!projected || !ROUTE_RUN_ID.test(projected.routeRunId) || JSON.stringify(route) !== JSON.stringify(projected) ||
      result.has(projected.routeId)) throw new Error('hosted_actual_owner_capability_routes_invalid')
    result.set(projected.routeId, projected)
  }
  return result
}

export const acceptanceCapabilityPurpose = PURPOSE
export const acceptanceCaptureFields = CAPTURE_FIELDS

async function queryCapability(config: ActualOwnerAcceptanceConfig,
  admission: HostedApprovalRuntimeAdmission): Promise<ReturnType<typeof authenticateCapabilityEnvelope>> {
  const nonce = randomBytes(32).toString('hex')
  const response = await fetch(config.runtime.capabilityEndpoint, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5_000),
    headers: {
      authorization: `Bearer ${config.ownerToken}`,
      'x-actual-owner-session': config.runtime.ownerBinding.ownerSessionId,
      'x-agent-teams-nonce': nonce,
    },
  })
  const bytes = await boundedResponse(response)
  let input: unknown
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    assertNoDuplicateJsonObjectKeys(source)
    input = JSON.parse(source)
    if (source !== JSON.stringify(input)) throw new Error('noncanonical')
  } catch {
    throw new Error('hosted_actual_owner_capability_invalid')
  }
  return authenticateCapabilityEnvelope(input, config, admission, nonce)
}

export function authenticateCapabilityEnvelope(value: unknown, config: ActualOwnerAcceptanceConfig,
  admission: HostedApprovalRuntimeAdmission, nonce: string): {
    routes: ReadonlyMap<string, RouteBinding>; captures: Record<string, unknown>
  } {
  const input = record(value)
  exact(input, ['schemaVersion', 'purpose', 'nonce', 'harnessRunId', 'ownerSessionId',
    'contractSha256', 'runtimeManifestSha256', 'driverSocket', 'productSocket', 'routes', 'captures', 'hmacSha256'])
  const signature = input.hmacSha256
  const unsigned = { ...input }; delete unsigned.hmacSha256
  const expectedMac = createHmac('sha256', config.ownerToken).update(JSON.stringify(unsigned)).digest()
  const actualMac = typeof signature === 'string' && /^[0-9a-f]{64}$/.test(signature)
    ? Buffer.from(signature, 'hex') : Buffer.alloc(0)
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac) ||
    input.schemaVersion !== 1 || input.purpose !== PURPOSE || input.nonce !== nonce ||
    input.harnessRunId !== config.runtime.runId ||
    input.ownerSessionId !== config.runtime.ownerBinding.ownerSessionId ||
    input.contractSha256 !== config.productContract.sha256 ||
    input.runtimeManifestSha256 !== config.runtimeManifestSha256 ||
      JSON.stringify(input.driverSocket) !== JSON.stringify(config.runtime.socketIdentity.driverSocket) ||
      JSON.stringify(input.productSocket) !== JSON.stringify(config.runtime.socketIdentity.productSocket) ||
      config.runtime.socketIdentity.driverSocket.endpoint === config.runtime.socketIdentity.productSocket.endpoint) {
    throw new Error('hosted_actual_owner_capability_binding_invalid')
  }
  const routes = parseRoutes(input.routes, admission)
  const captures = record(input.captures); exact(captures, CAPTURE_FIELDS)
  return Object.freeze({ routes, captures })
}
