import { HEX_V2, immutableV2, recordV2, requireV2, textV2 } from './HostedControlBootstrapV2Wire.js'

/** Wire observations emitted by Product r1029. Parsing is not verification of
 * the independently signed recipe, public roots or live process relationship. */
export type SelectedSupervisorProcessV1 = Readonly<{
  contract: 'agent-teams.hosted-selected-supervisor-process/v1'
  pid: number; parentPid: number; startTicks: string
  pidNamespaceInode: string; mountNamespaceInode: string; networkNamespaceInode: string
  processStartToken: string; observedMonotonicNs: string
  executable: { device: string; inode: string; size: string; sha256: string }
  module: SelectedSupervisorFileV1
  loader: SelectedSupervisorFileV1
  namespaceInit: { pid: number; parentPid: number; startTicks: string
    pidNamespaceInode: string; mountNamespaceInode: string; networkNamespaceInode: string
    executable: { device: string; inode: string; size: string; sha256: string } }
}>
type SelectedSupervisorFileV1 = Readonly<{ path: string; root: string; relativePath: string
  device: string; inode: string; size: number; mode: number; nlink: 1; sha256: string }>
export type SelectedControlV1 = Readonly<{
  contract: 'agent-teams.hosted-selected-control-verification/v1'
  authorityEpoch: number; controllerNonce: string; freezeId: string; reviewId: string; authorizationId: string
  artifacts: readonly { path: string; descriptor: number; relativePath: string
    device: string; inode: string; size: number; sha256: string }[]
}>
export type SelectedRecipeV1 = Readonly<{ path: string; sha256: string; device: string; inode: string; size: number }>
export type SelectedSupervisorEvidenceV1 = Readonly<{
  selectedSupervisor: SelectedSupervisorProcessV1
  selectedControl: SelectedControlV1
  selectedRecipe: SelectedRecipeV1
}>
const decimal = (value: unknown) => {
  textV2(value, /^(?:0|[1-9][0-9]{0,19})$/)
  requireV2(BigInt(value as string) <= 0xffffffffffffffffn, 'selected_decimal')
}
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER) =>
  requireV2(Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum, 'selected_integer')
const path = (value: unknown) => textV2(value, /^\/[\x21-\x7e]{1,4095}$/)
function image(value: unknown) {
  const r = recordV2(value, 'device,inode,size,sha256')
  for (const k of ['device', 'inode', 'size']) decimal(r[k])
  textV2(r.sha256, HEX_V2)
}
function processFields(r: Record<string, unknown>) {
  positive(r.pid, 2147483647)
  requireV2(Number.isSafeInteger(r.parentPid) && Number(r.parentPid) >= 0 && Number(r.parentPid) <= 2147483647, 'selected_parent')
  for (const k of ['startTicks', 'pidNamespaceInode', 'mountNamespaceInode', 'networkNamespaceInode']) decimal(r[k])
}
function file(value: unknown) {
  const r = recordV2(value, 'path,root,relativePath,device,inode,size,mode,nlink,sha256')
  path(r.path); textV2(r.root, /^[A-Za-z][A-Za-z0-9]*$/)
  textV2(r.relativePath, /^[\x21-\x7e]{1,512}$/)
  decimal(r.device); decimal(r.inode); positive(r.size, 1024 ** 3)
  requireV2([0o400, 0o444, 0o500, 0o555].includes(r.mode as number) && r.nlink === 1, 'selected_file')
  textV2(r.sha256, HEX_V2)
}
export function parseSelectedSupervisorEvidenceV1(value: unknown): SelectedSupervisorEvidenceV1 {
  const r = recordV2(value, 'selectedSupervisor,selectedControl,selectedRecipe')
  const p = recordV2(r.selectedSupervisor, 'contract,pid,parentPid,startTicks,pidNamespaceInode,mountNamespaceInode,networkNamespaceInode,processStartToken,observedMonotonicNs,executable,module,loader,namespaceInit')
  requireV2(p.contract === 'agent-teams.hosted-selected-supervisor-process/v1', 'selected_supervisor_contract')
  processFields(p); decimal(p.observedMonotonicNs); textV2(p.processStartToken, HEX_V2)
  image(p.executable); file(p.module); file(p.loader)
  const init = recordV2(p.namespaceInit, 'pid,parentPid,startTicks,pidNamespaceInode,mountNamespaceInode,networkNamespaceInode,executable')
  processFields(init); image(init.executable)
  const c = recordV2(r.selectedControl, 'contract,authorityEpoch,controllerNonce,freezeId,reviewId,authorizationId,artifacts')
  requireV2(c.contract === 'agent-teams.hosted-selected-control-verification/v1', 'selected_control_contract')
  positive(c.authorityEpoch)
  for (const k of ['controllerNonce', 'freezeId', 'reviewId', 'authorizationId']) textV2(c[k], HEX_V2)
  requireV2(Array.isArray(c.artifacts) && c.artifacts.length === 5, 'selected_public_artifacts')
  for (const item of c.artifacts as unknown[]) {
    const a = recordV2(item, 'path,descriptor,relativePath,device,inode,size,sha256')
    path(a.path); positive(a.descriptor, 1024); positive(a.size, 4 * 1024 * 1024)
    textV2(a.relativePath, /^[\x21-\x7e]{1,512}$/); decimal(a.device); decimal(a.inode); textV2(a.sha256, HEX_V2)
  }
  const recipe = recordV2(r.selectedRecipe, 'path,sha256,device,inode,size')
  path(recipe.path); textV2(recipe.sha256, HEX_V2); decimal(recipe.device); decimal(recipe.inode); positive(recipe.size, 16 * 1024 * 1024)
  return immutableV2(r as unknown as SelectedSupervisorEvidenceV1)
}

/** Actual /proc cmdline shape of the r1029 Node entry. No NUL repair, shell
 * parsing, trailing arguments or alternate loader/module spellings are allowed. */
export function assertSelectedSupervisorArgvV1(bytes: Uint8Array,
  selected: Pick<SelectedSupervisorProcessV1, 'module' | 'loader'>): void {
  requireV2(bytes.byteLength > 0 && bytes.byteLength <= 64 * 1024 && bytes[bytes.byteLength - 1] === 0,
    'selected_supervisor_argv_frame')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const argv = text.slice(0, -1).split('\0')
  requireV2(argv.length === 5 && argv[1] === '--import' && argv[2] === selected.loader.path &&
    argv[3] === selected.module.path && argv[4] === '--selected-supervisor-v1', 'selected_supervisor_argv')
  requireV2(argv[0]!.startsWith('/toolchain/') && !argv[0]!.includes('\\') &&
    argv[0]!.slice(1).split('/').every(part => part && part !== '.' && part !== '..'), 'selected_supervisor_argv_image')
}
