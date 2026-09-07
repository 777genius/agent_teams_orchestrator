import { validatePreparedProfileBinding } from '../opencode/OpenCodePreparedProfileContract.js'
import { parseSelectedSupervisorEvidenceV1 } from './HostedControlSelectedSupervisorV1.js'
import { immutableV2, recordV2, requireV2 } from './HostedControlBootstrapV2Wire.js'
import type { DescriptorSnapshotV2 } from './HostedControlBootstrapV2Descriptors.js'
import type { OwnerV2LaunchSelection } from './HostedControlBootstrapV2Launch.js'

export const SELECTED_LAUNCH_PHASE = 'agent-teams.hosted-owner-selected-launch/v1'
export const SELECTED_LAUNCH_MAGIC = 0x48534c31 // HSL1; distinct from activation JSON
export const SELECTED_LAUNCH_MAXIMUM = 256 * 1024
/** Product canonicalJson wire algorithm. Unlike bootstrap-v2 integer fields,
 * signed native JSON permits all safe integers. Keep this scoped to HSL1. */
export function canonicalSelectedLaunchJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    requireV2(Number.isSafeInteger(value), 'selection_phase_number'); return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSelectedLaunchJson).join(',')}]`
  requireV2(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'selection_phase_json')
  return `{${Object.entries(value).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSelectedLaunchJson(item)}`).join(',')}}`
}
const bootstrapDeadlines = new WeakMap<object, number>()
/** Retained local timing, never a field authenticated by the selected caller. */
export function selectedLaunchBootstrapDeadline(phase: SelectedLaunchPhase): number {
  const deadline = bootstrapDeadlines.get(phase)
  requireV2(deadline !== undefined, 'selection_phase_deadline_missing')
  return deadline
}
export type SelectedLaunchPhase = Readonly<{
  contract: typeof SELECTED_LAUNCH_PHASE
  nativeAdmission: unknown
  launch: OwnerV2LaunchSelection
  sealed: Readonly<{
    observedMonotonicNs: string
    constructionClosedMonotonicNs: string
    construction: Readonly<{
      sourceFd: number; childFd: number; kind: string; accessMode: string; append: boolean
      mode: number; uid: number; gid: number; seals: number | null
      device: string; inode: string; size: string; nlink: string; mtimeNs: string; ctimeNs: string; closedMonotonicNs: string
    }>
  }>
}>

/** Decoding supplies data only. Independent artifact admission must precede use
 * of launch pins; neither this envelope nor the FD4 MAC supplies public roots. */
export function decodeSelectedLaunchPhase(bytes: Buffer, bootstrapDeadline?: number): SelectedLaunchPhase {
  requireV2(bytes.length >= 8 && bytes.readUInt32BE(0) === SELECTED_LAUNCH_MAGIC, 'selection_phase_magic')
  const length = bytes.readUInt32BE(4)
  requireV2(length > 0 && length <= SELECTED_LAUNCH_MAXIMUM && bytes.length === length + 8, 'selection_phase_length')
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(8))
    const parsed = JSON.parse(text)
    const value = recordV2(parsed, 'contract,launch,sealed,nativeAdmission')
    requireV2(value.contract === SELECTED_LAUNCH_PHASE && canonicalSelectedLaunchJson(value) === text, 'selection_phase_contract')
    const evidenceKeys = ['selectedSupervisor', 'selectedControl', 'selectedRecipe'] as const
    const launch = value.launch as Record<string, unknown>
    const extended = !!launch && evidenceKeys.some(key => Object.hasOwn(launch, key))
    recordV2(launch, 'expectedHost,bootstrapV2HeaderSha256,rawRetention,supervisorProcessStartToken,ownerProcessStartToken,recipeSha256,harnessContractSha256,ownerModule,ownerArtifactManifestSha256,ownerExecutable,supervisorExecutable,refs,serializedProductBootstrap,producerCapsule,runtimeManifestSha256,harnessContractPath,held,executed' +
      (extended ? ',selectedSupervisor,selectedControl,selectedRecipe' : '') +
      (Object.hasOwn(launch, 'preparedProfileBinding') ? ',preparedProfileBinding' : ''))
    if (Object.hasOwn(launch, 'preparedProfileBinding')) validatePreparedProfileBinding(launch.preparedProfileBinding)
    if (extended) parseSelectedSupervisorEvidenceV1(Object.fromEntries(evidenceKeys.map(key => [key, launch[key]])))
    const sealed = recordV2(value.sealed, 'observedMonotonicNs,constructionClosedMonotonicNs,construction')
    recordV2(sealed.construction, 'sourceFd,childFd,kind,accessMode,append,mode,uid,gid,seals,device,inode,size,nlink,mtimeNs,ctimeNs,closedMonotonicNs')
    const phase = immutableV2(value as unknown as SelectedLaunchPhase)
    if (bootstrapDeadline !== undefined) {
      requireV2(Number.isFinite(bootstrapDeadline), 'selection_phase_deadline')
      bootstrapDeadlines.set(phase, bootstrapDeadline)
    }
    return phase
  } catch { throw new Error('hosted_owner_v2_selection_phase_rejected') }
}

/** The sealed event is a distinct retained native observation, not inferred
 * from a header, final memfd seals, or the mere existence of an exec event. */
export function verifySelectedLaunchSealing(phase: SelectedLaunchPhase, lease: DescriptorSnapshotV2): void {
  const { sealed, launch } = phase, construction = sealed.construction
  const held = launch.held.descriptors.find(row => row.childFd === 3)
  requireV2(held && construction.kind === 'regular-file' && construction.accessMode === 'read-write' &&
    !construction.append && construction.mode === 0o600 && construction.seals === 15 && construction.nlink === '0' &&
    construction.device === held.device && construction.inode === held.inode, 'selection_sealed_construction')
  for (const key of ['device', 'inode', 'size', 'uid', 'gid', 'mode', 'seals', 'nlink'] as const)
    requireV2(construction[key] === lease[key], 'selection_sealed_lease')
  const times = [launch.held.heldMonotonicNs, sealed.constructionClosedMonotonicNs,
    sealed.observedMonotonicNs, launch.executed.observedMonotonicNs]
  for (const time of times) requireV2(typeof time === 'string' && /^[1-9][0-9]{0,19}$/.test(time), 'selection_sealed_clock')
  requireV2(BigInt(times[0]) <= BigInt(times[1]) && BigInt(times[1]) <= BigInt(times[2]) &&
    BigInt(times[2]) < BigInt(times[3]), 'selection_sealed_order')
}
