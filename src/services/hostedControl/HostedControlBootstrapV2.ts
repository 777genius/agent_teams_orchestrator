import { PRIVATE_PROFILE_AUTH, PRIVATE_PROFILE_DOCUMENT_MAXIMUM, type PreparedProfileProjection } from '../opencode/OpenCodePreparedProfileContract.js'
import type { HostedControlDescriptorGuard } from './HostedControlBootstrap.js'
import type { HostedControlRuntimeConfig } from './HostedControlRuntimeConfig.js'
import { HostedControlInheritedActivationV2 } from './HostedControlInheritedActivationV2.js'
import { readSelectedLaunchPhase } from './HostedControlSelectedLaunchReader.js'
import { SELECTED_LAUNCH_PHASE, verifySelectedLaunchSealing, type SelectedLaunchPhase } from './HostedControlSelectedLaunchPhase.js'
import { beforeDeadlineV2, descriptorRowV2, nonblockV2, OwnedDescriptorV2, readAvailableV2, readLeaseBytesV2,
  readOneUseV2, sameDescriptorV2, snapshotAllV2, snapshotV2, type DescriptorSnapshotV2 } from './HostedControlBootstrapV2Descriptors.js'
import { freezeSelectionV2, observeExecutingOwnerV2, processV2, verifySelectedLaunchV2,
  type ExecutingOwnerV2, type OwnerV2LaunchSelection } from './HostedControlBootstrapV2Launch.js'
import { AUTH_V2, canonicalV2, decodeFramesV2, immutableV2, OWNER_V2_ROLES, requireV2, verifyLeaseV2,
  type BootstrapHeaderV2, type Immutable, type OwnerV2Role, type ServerCredentialsV2 } from './HostedControlBootstrapV2Wire.js'

const admittedBootstraps = new WeakSet<object>()
export function assertHostedControlBootstrapAdmissionV2(value: HostedControlBootstrapAdmissionV2): void {
  requireV2(admittedBootstraps.has(value) && value.guard.assertCurrentSync(), 'bootstrap_authority')
}

export type HostedControlBootstrapAdmissionV2 = Readonly<{
  protocol: 'v2'
  config: Omit<HostedControlRuntimeConfig, 'secretFile'>
  header: BootstrapHeaderV2
  bootstrapBinding: BootstrapHeaderV2['bootstrapBinding']
  approvalActivationV2: BootstrapHeaderV2['approvalActivationV2']
  bootstrapV2HeaderSha256: string
  expectedHost: BootstrapHeaderV2['expectedHost']
  preparedProfile?: PreparedProfileProjection
  serverAuth: ServerCredentialsV2
  rawRetention: Readonly<{ fd: 8; resource: OwnedDescriptorV2; descriptor: DescriptorSnapshotV2; binding: BootstrapHeaderV2['rawRetention'] }>
  ownerNative: Readonly<{ fd: 9; resource: OwnedDescriptorV2; descriptor: DescriptorSnapshotV2; producerCapsule: string }>
  executedOwner: ExecutingOwnerV2
  secret: Buffer
  guard: HostedControlDescriptorGuard & { assertCurrentSync(): boolean }
  activation: HostedControlInheritedActivationV2
  close(): Promise<void>
}>

/** Explicit, single protocol entry. No configurable FD numbers or legacy retry.
 * Selection comes from the admitted launch, never from an auth environment or
 * from fields parsed out of this self-MACed frame. */
export async function readHostedControlBootstrapV2(options: {
  modulePath: string
  privateAuthFormat?: typeof AUTH_V2 | typeof PRIVATE_PROFILE_AUTH
  selectionPhase?: typeof SELECTED_LAUNCH_PHASE
  selectLaunch(phase?: SelectedLaunchPhase): OwnerV2LaunchSelection | Promise<OwnerV2LaunchSelection>
}): Promise<HostedControlBootstrapAdmissionV2> {
  const deadline = performance.now() + 5000
  const owners = new Map<OwnerV2Role, OwnedDescriptorV2>((Object.entries(OWNER_V2_ROLES) as [OwnerV2Role, number][])
    .map(([role, fd]) => [role, new OwnedDescriptorV2(fd)]))
  const owner = (role: OwnerV2Role) => owners.get(role)!
  let secret: Buffer | undefined
  let guard: (HostedControlDescriptorGuard & { assertCurrentSync(): boolean }) | undefined
  let activation: HostedControlInheritedActivationV2 | undefined
  let preparedProfile: PreparedProfileProjection | undefined
  let credentials: ServerCredentialsV2 | undefined
  let success = false
  try {
    const snapshots = snapshotAllV2()
    const find = (role: OwnerV2Role) => snapshots.find(d => d.role === role)!
    let executed: ExecutingOwnerV2
    try { executed = observeExecutingOwnerV2(find('executable-anchor'), options.modulePath, deadline) }
    finally { owner('executable-anchor').close() }
    beforeDeadlineV2(deadline)
    const abort = new AbortController()
    // Both streams start together before awaiting either EOF. Any rejection cancels its
    // sibling; allSettled retains and zeroes a successful sibling on failure.
    const read = (role: 'bootstrap' | 'private-server-auth', max: number) =>
      readOneUseV2(owner(role), max, deadline, abort.signal).catch(error => { abort.abort(); throw error })
    const pending = [read('bootstrap', 65604), read('private-server-auth', options.privateAuthFormat === PRIVATE_PROFILE_AUTH ? PRIVATE_PROFILE_DOCUMENT_MAXIMUM + 4 : 8196)] as const
    const results = await Promise.allSettled(pending)
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') {
      for (const result of results) if (result.status === 'fulfilled') result.value.fill(0)
      throw new Error('hosted_owner_v2_frame_read')
    }
    let h: BootstrapHeaderV2, bootstrapV2HeaderSha256: string
    {
      const decoded = decodeFramesV2(results[0].value, results[1].value, options.privateAuthFormat ?? AUTH_V2)
      credentials = decoded.credentials; secret = decoded.secret; preparedProfile = decoded.preparedProfile
      h = decoded.header; bootstrapV2HeaderSha256 = decoded.bootstrapV2HeaderSha256
    }
    for (const row of h.descriptorMap.descriptors) {
      requireV2(canonicalV2(row) === canonicalV2(descriptorRowV2(find(row.role))), 'descriptor_map')
    }
    const lease = readLeaseBytesV2(find('sealed-launcher-lease'))
    try { verifyLeaseV2(lease, h) } finally { lease.fill(0) }
    for (const k of ['device', 'inode', 'uid', 'gid', 'mode'] as const)
      requireV2(h.leaseEvidence[k] === find('sealed-launcher-lease')[k], 'lease_evidence')
    requireV2(find('raw-opencode-retention').size === String(h.rawRetention.initialByteLength), 'raw_prefix_size')
    // Selected source may read its pinned manifest/contract after the one-use
    // descriptors and anchor have closed. It cannot create runtime effects.
    requireV2(options.selectionPhase === undefined || options.selectionPhase === SELECTED_LAUNCH_PHASE, 'selection_phase_version')
    const phase = options.selectionPhase === SELECTED_LAUNCH_PHASE
      ? await readSelectedLaunchPhase(owner('activation-v2'), deadline) : undefined
    const selection = freezeSelectionV2(await withinDeadline(options.selectLaunch(phase), deadline))
    if (phase) {
      requireV2(canonicalV2(selection) === canonicalV2(phase.launch), 'selection_phase_admitted_binding')
      verifySelectedLaunchSealing(phase, find('sealed-launcher-lease'))
    }
    beforeDeadlineV2(deadline)
    requireV2(selection.ownerModule.path === options.modulePath, 'selected_module_path')
    verifySelectedLaunchV2({ selection, header: h, snapshots, executed, deadline })
    for (const role of ['sealed-launcher-lease', 'activation-v2', 'liveness', 'raw-opencode-retention', 'owner-wal-native'] as const)
      requireV2(sameDescriptorV2(find(role), snapshotV2(role)), 'descriptor_changed')
    beforeDeadlineV2(deadline)
    guard = retainGuard(owner('sealed-launcher-lease'), owner('liveness'), find('sealed-launcher-lease'), find('liveness'), h)
    activation = HostedControlInheritedActivationV2.retain(owner('activation-v2'), find('activation-v2'))
    requireV2(await guard.assertCurrent(), 'guard_lost')
    const { bootstrapBinding: b } = h
    const config = immutableV2({ socketPath: h.socketPath, claudeRoot: h.claudeRoot,
      deploymentId: b.deploymentId, bootId: b.bootId, restoreGeneration: h.restoreGeneration,
      workspaceId: b.workspaceId, teamId: h.teamId, legacyKey: h.legacyKey, mountGeneration: b.mountGeneration,
      declaredRootHash: h.declaredRootHash, ownerAuthority: h.ownerAuthority, ownerGeneration: h.ownerGeneration,
      ownerSessionId: h.ownerSessionId })
    let closed = false
    const result: HostedControlBootstrapAdmissionV2 = Object.freeze({
      protocol: 'v2', config, header: h, bootstrapBinding: b, approvalActivationV2: h.approvalActivationV2,
      bootstrapV2HeaderSha256, expectedHost: h.expectedHost,
      get preparedProfile() { requireV2(!closed, 'profile_released'); return preparedProfile },
      get serverAuth() { requireV2(!closed && credentials, 'credentials_released'); return credentials },
      rawRetention: Object.freeze({ fd: 8, resource: owner('raw-opencode-retention'), descriptor: find('raw-opencode-retention'), binding: h.rawRetention }),
      ownerNative: Object.freeze({ fd: 9, resource: owner('owner-wal-native'), descriptor: find('owner-wal-native'), producerCapsule: selection.producerCapsule }),
      executedOwner: executed, secret, guard, activation,
      async close() {
        if (closed) return
        closed = true; admittedBootstraps.delete(result); credentials = undefined; preparedProfile = undefined; secret!.fill(0)
        try { try { activation!.close() } finally { await guard!.close() } }
        finally { for (const resource of owners.values()) resource.close() }
      },
    })
    admittedBootstraps.add(result)
    success = true
    return result
  } catch (error) {
    // In particular, JSON syntax errors must not reproduce private auth bytes.
    if (error instanceof Error && /^hosted_owner_v2_[a-z_]+$/.test(error.message)) throw error
    throw new Error('hosted_owner_v2_admission_rejected')
  } finally {
    // Detached owners of FD4/7/11 are no-ops here, even if those slots were reused.
    owner('bootstrap').close(); owner('private-server-auth').close(); owner('executable-anchor').close()
    if (!success) {
      credentials = undefined; preparedProfile = undefined; secret?.fill(0)
      try { try { activation?.close() } finally { await guard?.close() } }
      finally { for (const resource of owners.values()) resource.close() }
    }
  }
}
async function withinDeadline<T>(pending: T | Promise<T>, deadline: number): Promise<T> {
  beforeDeadlineV2(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve(pending), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('hosted_owner_v2_deadline')), Math.max(1, deadline - performance.now()))
  })]) } finally { clearTimeout(timer) }
}
function retainGuard(lease: OwnedDescriptorV2, live: OwnedDescriptorV2, leaseSnapshot: DescriptorSnapshotV2,
  liveSnapshot: DescriptorSnapshotV2, header: BootstrapHeaderV2): HostedControlDescriptorGuard & { assertCurrentSync(): boolean } {
  let current = true, closed = false
  let lose!: () => void; const lost = new Promise<void>(resolve => { lose = resolve })
  const markLost = () => { if (current) { current = false; lose() } }
  nonblockV2(live.fd)
  const probe = Buffer.alloc(1)
  const check = () => {
    if (!current || closed) return false
    try {
      const owner = processV2(process.pid), parent = processV2(header.descriptorMap.wrapperPid)
      requireV2(owner.startTicks === header.supervisorBinding.ownerStartTicks && owner.parentPid === parent.pid &&
        parent.startTicks === header.descriptorMap.wrapperStartTicks, 'guard_process')
      requireV2(sameDescriptorV2(leaseSnapshot, snapshotV2('sealed-launcher-lease')) &&
        sameDescriptorV2(liveSnapshot, snapshotV2('liveness')), 'guard_descriptor')
      requireV2(readAvailableV2(live.fd, probe) < 0, 'liveness_lost')
      return true
    } catch { markLost(); return false } finally { probe.fill(0) }
  }
  const timer = setInterval(check, 10); timer.unref?.()
  return Object.freeze({ lost,
    assertCurrentSync: check,
    async assertCurrent() { return check() },
    async close() { if (closed) return; closed = true; markLost(); clearInterval(timer); live.close(); lease.close() },
  })
}
export type { BootstrapHeaderV2, Immutable, OwnerV2LaunchSelection }
