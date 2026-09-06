import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import type { ExpectedSupervisedOpenCode } from '../opencode/OpenCodeSupervisedHostCustody.js'
import { HOSTED_OWNER_PROVENANCE_CONTRACT, HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_IMPLEMENTATION } from './HostedApprovalOwnerProvenance.js'
import { hashDescriptorV2, descriptorRowV2, type DescriptorSnapshotV2 } from './HostedControlBootstrapV2Descriptors.js'
import { canonicalV2, hashV2, immutableV2, recordV2, requireV2, textV2, HEX_V2, type BootstrapHeaderV2, type RawRetentionBindingV2, type Immutable } from './HostedControlBootstrapV2Wire.js'

/** Inputs retained by Product launchOwnerFromPlan/launchNativeOwner, selected
 * BEFORE the Owner frame. A mirror of those source contracts, not a new wire
 * document, environment authority, or constructor of TrustedOpenCodeCustody.
 * The built entry must supply these through its admitted composition closure. */
export type OwnerV2LaunchSelection = Immutable<{
  expectedHost: ExpectedSupervisedOpenCode
  bootstrapV2HeaderSha256: string
  rawRetention: RawRetentionBindingV2
  supervisorProcessStartToken: string
  ownerProcessStartToken: string
  recipeSha256: string
  harnessContractSha256: string
  ownerModule: { path: string; sha256: string }
  ownerArtifactManifestSha256: string
  ownerExecutable: { device: string; inode: string; size: number; sha256: string }
  supervisorExecutable: { device: string; inode: string; sha256: string }
  refs: { openCode: string; orchestrator: string; product: string }
  serializedProductBootstrap: string
  producerCapsule: string
  runtimeManifestSha256: string
  harnessContractPath: string
  held: {
    parentPid: number; callerPid: number; ownerPid: number
    parentStartTicks: string; callerStartTicks: string; ownerStartTicks: string
    pidfdDevice: string; pidfdInode: string
    parentPidNamespaceInode: string; parentNetworkNamespaceInode: string
    ownerPidNamespaceInode: string; ownerNetworkNamespaceInode: string
    spawnNonce: string; beforeMonotonicNs: string; forkMonotonicNs: string; heldMonotonicNs: string
    descriptors: readonly { sourceFd: number; childFd: number; kind: 'regular-file' | 'socket'
      accessMode: 'read-only' | 'write-only' | 'read-write'; append: boolean; mode: number; uid: number; gid: number
      device: string; inode: string; size: string; nlink: string; seals: number | null
      mtimeNs: string; ctimeNs: string; closedMonotonicNs: string }[]
  }
  executed: { ownerPid: number; ownerStartTicks: string; observedMonotonicNs: string; executableSha256: string
    executable: { device: string; inode: string; size: string; mode: number; uid: number; gid: number; nlink: string } }
}>
export type ExecutingOwnerV2 = Readonly<{
  pid: number; startTicks: string; parentPid: number; executableSha256: string; moduleSha256: string
  executableDevice: string; executableInode: string; executableSize: string
}>
export function processV2(pid: number) {
  const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/)
  requireV2(Number.isSafeInteger(pid) && pid > 0 && fields[0] !== 'Z' && fields[0] !== 'X', 'process')
  return { pid, parentPid: Number(fields[1]), startTicks: fields[19],
    pidNamespaceInode: String(statSync(`/proc/${pid}/ns/pid`, { bigint: true }).ino),
    networkNamespaceInode: String(statSync(`/proc/${pid}/ns/net`, { bigint: true }).ino) }
}
function hashPath(path: string, deadline: number) {
  const fd = openSync(path, constants.O_RDONLY | 0o2000000 /* Linux O_CLOEXEC */)
  try { const stat = fstatSync(fd, { bigint: true }); return { stat, sha256: hashDescriptorV2(fd, stat, deadline) } }
  finally { closeSync(fd) }
}
/** FD11 is compared with the EXECUTING image, not with the .ts module. Caller
 * closes it before reading any configuration or creating a runtime/helper. */
export function observeExecutingOwnerV2(anchor: DescriptorSnapshotV2, modulePath: string, deadline: number): ExecutingOwnerV2 {
  const current = processV2(process.pid), exe = statSync('/proc/self/exe', { bigint: true })
  requireV2(String(exe.dev) === anchor.device && String(exe.ino) === anchor.inode && String(exe.size) === anchor.size, 'executed_anchor')
  const executableSha256 = hashDescriptorV2(11, fstatSync(11, { bigint: true }), deadline)
  // Source entry is already selected by exec argv. A built entry's module is its
  // image; a source entry must retain a separate module digest and source path.
  const module = hashPath(modulePath, deadline)
  requireV2(processV2(process.pid).startTicks === current.startTicks, 'owner_start_changed')
  return Object.freeze({ ...current, executableSha256, moduleSha256: module.sha256,
    executableDevice: anchor.device, executableInode: anchor.inode, executableSize: anchor.size })
}
export function verifySelectedLaunchV2(input: {
  selection: OwnerV2LaunchSelection; header: BootstrapHeaderV2; snapshots: readonly DescriptorSnapshotV2[]
  executed: ExecutingOwnerV2; deadline: number
}): void {
  const { selection: p, header: h, snapshots, executed: actual, deadline } = input
  requireV2(p && p.held && p.executed, 'selected_launch_observations_missing')
  const held = p.held, s = h.supervisorBinding, map = h.descriptorMap, exec = p.executed
  textV2(p.ownerArtifactManifestSha256, HEX_V2)
  requireV2(Number.isSafeInteger(p.ownerExecutable.size) && p.ownerExecutable.size > 0, 'selected_image_size')
  const owner = processV2(process.pid), parent = processV2(held.parentPid), caller = processV2(held.callerPid)
  requireV2(held.ownerPid === process.pid && s.ownerPid === process.pid && exec.ownerPid === process.pid &&
    actual.startTicks === held.ownerStartTicks && exec.ownerStartTicks === held.ownerStartTicks &&
    owner.startTicks === held.ownerStartTicks && s.ownerStartTicks === held.ownerStartTicks &&
    owner.parentPid === held.parentPid && parent.parentPid === held.callerPid &&
    parent.startTicks === held.parentStartTicks && caller.startTicks === held.callerStartTicks &&
    s.supervisorPid === held.callerPid && s.supervisorStartTicks === held.callerStartTicks &&
    map.wrapperPid === held.parentPid && map.wrapperStartTicks === held.parentStartTicks &&
    map.spawnNonce === held.spawnNonce, 'caller_child_start')
  const parentFds = readdirSync(`/proc/${held.parentPid}/fd`)
  requireV2(parentFds.length <= 1024, 'parent_fd_bound')
  const handles = parentFds.filter(fd => {
    try {
      const path = `/proc/${held.parentPid}/fd/${fd}`
      if (readlinkSync(path) !== 'anon_inode:[pidfd]') return false
      const st = statSync(path, { bigint: true })
      const info = readFileSync(`/proc/${held.parentPid}/fdinfo/${fd}`, 'utf8')
      return String(st.dev) === held.pidfdDevice && String(st.ino) === held.pidfdInode &&
        new RegExp(`^Pid:\\s+${process.pid}$`, 'm').test(info)
    } catch { return false }
  })
  requireV2(handles.length === 1, 'parent_held_child')
  requireV2(new Set([held.ownerPid, held.parentPid, held.callerPid, h.expectedHost.process.pid]).size === 4, 'process_alias')
  requireV2(BigInt(held.beforeMonotonicNs) <= BigInt(held.forkMonotonicNs) &&
    BigInt(held.forkMonotonicNs) <= BigInt(held.heldMonotonicNs) &&
    BigInt(held.heldMonotonicNs) < BigInt(exec.observedMonotonicNs), 'launch_order')
  requireV2(held.descriptors.length === 8 && new Set(held.descriptors.map(d => d.sourceFd)).size === 8, 'parent_descriptors')
  for (const row of map.descriptors) {
    const observed = snapshots.find(d => d.role === row.role)!
    const parentRow = held.descriptors.find(d => d.childFd === row.childFd)
    requireV2(parentRow && canonicalV2(row) === canonicalV2(descriptorRowV2(observed)), 'authenticated_descriptor')
    for (const k of ['device', 'inode', 'kind', 'accessMode', 'append', 'mode', 'uid', 'gid'] as const)
      requireV2(parentRow[k] === row[k], 'parent_descriptor')
    requireV2(row.role === 'sealed-launcher-lease' ? parentRow.size === '0' && parentRow.seals === 0 :
      parentRow.size === observed.size && parentRow.nlink === observed.nlink, 'held_descriptor_state')
    requireV2(BigInt(parentRow.closedMonotonicNs) >= BigInt(held.forkMonotonicNs) &&
      BigInt(parentRow.closedMonotonicNs) <= BigInt(held.heldMonotonicNs), 'parent_closure_order')
  }
  for (const process of [owner, parent, caller, processV2(h.expectedHost.process.pid)]) {
    requireV2(process.pidNamespaceInode === held.ownerPidNamespaceInode &&
      process.networkNamespaceInode === held.ownerNetworkNamespaceInode, 'namespace')
  }
  requireV2(held.parentPidNamespaceInode === held.ownerPidNamespaceInode &&
    held.parentNetworkNamespaceInode === held.ownerNetworkNamespaceInode &&
    h.expectedHost.process.pidNamespaceInode === held.ownerPidNamespaceInode &&
    h.expectedHost.process.networkNamespaceInode === held.ownerNetworkNamespaceInode, 'namespace_binding')
  requireV2(actual.executableSha256 === p.ownerExecutable.sha256 && exec.executableSha256 === p.ownerExecutable.sha256 &&
    actual.executableDevice === p.ownerExecutable.device && actual.executableInode === p.ownerExecutable.inode &&
    actual.executableSize === String(p.ownerExecutable.size) && exec.executable.device === actual.executableDevice &&
    exec.executable.inode === actual.executableInode && exec.executable.size === actual.executableSize &&
    exec.executable.mode === 0o500 && exec.executable.nlink === '1' && exec.executable.uid === process.getuid!() &&
    exec.executable.gid === process.getgid!() && actual.moduleSha256 === p.ownerModule.sha256 &&
    s.ownerEntrySha256 === p.ownerModule.sha256 && s.ownerProcessStartToken === p.ownerProcessStartToken &&
    s.supervisorStartToken === p.supervisorProcessStartToken && s.recipeSha256 === p.recipeSha256 &&
    s.harnessContractSha256 === p.harnessContractSha256, 'selected_pins')
  const supervisor = hashPath(`/proc/${held.callerPid}/exe`, deadline)
  requireV2(supervisor.sha256 === p.supervisorExecutable.sha256 && s.supervisorExecutableSha256 === supervisor.sha256 &&
    String(supervisor.stat.dev) === p.supervisorExecutable.device && String(supervisor.stat.ino) === p.supervisorExecutable.inode, 'supervisor_image')
  requireV2(canonicalV2(p.expectedHost) === canonicalV2(h.expectedHost) &&
    canonicalV2(p.rawRetention) === canonicalV2(h.rawRetention) &&
    p.bootstrapV2HeaderSha256 === hashV2(canonicalV2(h)), 'selected_bootstrap')
  const peer = processV2(h.expectedHost.process.pid), image = hashPath(`/proc/${peer.pid}/exe`, deadline)
  requireV2(peer.startTicks === h.expectedHost.process.startTicks && image.sha256 === h.expectedHost.executable.sha256 &&
    String(image.stat.dev) === h.expectedHost.executable.device && String(image.stat.ino) === h.expectedHost.executable.inode &&
    String(image.stat.size) === h.expectedHost.executable.size, 'peer_image')
  requireV2(hashV2(p.serializedProductBootstrap) === h.bootstrapBinding.bootstrapDigest, 'product_bootstrap_digest')
  verifyProducerCapsuleV2(p, h, actual)
  requireV2(processV2(held.parentPid).startTicks === held.parentStartTicks &&
    processV2(held.callerPid).startTicks === held.callerStartTicks &&
    processV2(peer.pid).startTicks === peer.startTicks, 'launch_changed')
}
function verifyProducerCapsuleV2(p: OwnerV2LaunchSelection, h: BootstrapHeaderV2, actual: ExecutingOwnerV2): void {
  requireV2(Buffer.byteLength(p.producerCapsule) <= 128 * 1024 && hashV2(p.producerCapsule) === h.supervisorBinding.ownerProducerCapsuleSha256, 'capsule_digest')
  const v = JSON.parse(p.producerCapsule)
  requireV2(canonicalV2(v) === p.producerCapsule, 'capsule_canonical')
  const c = recordV2(v, 'activation,contract,contractSha256,expectedProducer,producerRole,streams,version')
  requireV2(c.contract === HOSTED_OWNER_PROVENANCE_CONTRACT && c.contractSha256 === HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 && c.version === 2 && c.producerRole === 'owner', 'capsule_contract')
  const a = recordV2(c.activation, 'controllerNonce,runId,stackManifestSha256'), e = h.expectedHost.activation
  requireV2(a.controllerNonce === e.controllerNonce && a.runId === e.runId && a.stackManifestSha256 === e.stackManifestSha256, 'capsule_activation')
  const x = recordV2(c.expectedProducer, 'artifactManifestSha256,executableSha256,implementationId,moduleSha256')
  requireV2(x.artifactManifestSha256 === p.ownerArtifactManifestSha256 && x.executableSha256 === actual.executableSha256 &&
    x.moduleSha256 === actual.moduleSha256 && x.implementationId === HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, 'capsule_producer')
  const streams = recordV2(c.streams, 'ownerWalTimeline'), fd = recordV2(streams.ownerWalTimeline, 'fd,device,inode')
  const row = h.descriptorMap.descriptors.find(d => d.role === 'owner-wal-native')!
  requireV2(fd.fd === 9 && fd.device === row.device && fd.inode === row.inode, 'capsule_fd')
}
export function freezeSelectionV2(value: OwnerV2LaunchSelection): OwnerV2LaunchSelection {
  return immutableV2(structuredClone(value))
}
