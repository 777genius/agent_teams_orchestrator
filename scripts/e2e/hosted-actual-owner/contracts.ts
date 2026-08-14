import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { readAnchoredFile } from './secure-files.js'

export const ACTUAL_OWNER_PURPOSE = 'agent-teams.hosted-actual-owner-e2e/v1' as const
export const ACTUAL_OWNER_ACCEPTANCE_PURPOSE =
  'agent-teams.hosted-actual-owner-e2e.orchestrator-acceptance/v1' as const
export const ACTUAL_OWNER_MARKER_FILE = '.agent-teams-actual-owner-e2e-owner.json' as const
export const HOSTED_APPROVAL_ADMISSION_FILE = 'hosted-approval-runtime-admission.v1.json' as const
export const HOSTED_APPROVAL_WAL_FILE = 'hosted-approval-owner.v1.json' as const
export const ACTUAL_OWNER_DESCRIPTOR_TOKENS = Object.freeze({
  sandboxRoot: '${SANDBOX_ROOT}',
  productRoot: '${PRODUCT_ROOT}',
  orchestratorRoot: '${ORCHESTRATOR_ROOT}',
  openCodeExecutable: '${OPENCODE_EXECUTABLE}',
} as const)

const execFileAsync = promisify(execFile)
const SHA256 = /^[0-9a-f]{64}$/
const FULL_REF = /^[0-9a-f]{40}$/
const RUN_ID = /^[0-9a-f]{48}$/

type JsonRecord = Record<string, unknown>

export type ActualOwnerRuntimeManifest = {
  schemaVersion: 1
  purpose: typeof ACTUAL_OWNER_PURPOSE
  runId: string
  sandboxRoot: string
  markerPath: string
  capture: { ownerWalTimelinePath: string }
  descriptors: {
    sandboxRoot: RuntimePathDescriptor
    productRoot: RuntimePathDescriptor
    orchestratorRoot: RuntimePathDescriptor
    openCodeExecutable: RuntimePathDescriptor & { size: string; sha256: string }
  }
  refs: {
    openCode: string
    openCodeExecutableSha256: string
    orchestrator: string
    product: string
  }
}

export type RuntimePathDescriptor = {
  token: string
  path: string
  device: string
  inode: string
  mode: string
  uid: string
}

export type ActualOwnerAcceptanceConfig = {
  admissionFile: string
  controlSocket: string
  evidenceFile: string
  markerPath: string
  openCodeExecutable: string
  openCodeSha256: string
  productRoot: string
  productPublicationTimeoutMs: number
  repositoryRoot: string
  runtimeManifestPath: string
  runtime: ActualOwnerRuntimeManifest
  sandboxRoot: string
  walFile: string
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`hosted_actual_owner_${label}_invalid`)
  }
  return value as JsonRecord
}

function exact(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`hosted_actual_owner_${label}_invalid`)
  }
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    throw new Error(`hosted_actual_owner_${label}_path_invalid`)
  }
  return value
}

function fullRef(value: unknown, label: string): string {
  if (typeof value !== 'string' || !FULL_REF.test(value)) {
    throw new Error(`hosted_actual_owner_${label}_unfrozen_ref`)
  }
  return value
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`hosted_actual_owner_${label}_sha256_invalid`)
  }
  return value
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`hosted_actual_owner_${label}_identity_invalid`)
  }
  return value
}

function parseDescriptor(
  value: unknown,
  token: string,
  label: string,
  executable = false,
): RuntimePathDescriptor & { size?: string; sha256?: string } {
  const input = record(value, `${label}_descriptor`)
  exact(input, executable
    ? ['token', 'path', 'device', 'inode', 'mode', 'uid', 'size', 'sha256']
    : ['token', 'path', 'device', 'inode', 'mode', 'uid'], `${label}_descriptor`)
  if (input.token !== token) throw new Error(`hosted_actual_owner_${label}_descriptor_token_invalid`)
  return Object.freeze({
    token,
    path: absolutePath(input.path, `${label}_descriptor`),
    device: decimal(input.device, `${label}_descriptor_device`),
    inode: decimal(input.inode, `${label}_descriptor_inode`),
    mode: decimal(input.mode, `${label}_descriptor_mode`),
    uid: decimal(input.uid, `${label}_descriptor_uid`),
    ...(executable ? {
      size: decimal(input.size, `${label}_descriptor_size`),
      sha256: sha256(input.sha256, `${label}_descriptor`),
    } : {}),
  })
}

function expandDescriptor(value: unknown, descriptor: RuntimePathDescriptor, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') ||
    value !== descriptor.token && !value.startsWith(`${descriptor.token}/`)) {
    throw new Error(`hosted_actual_owner_${label}_descriptor_binding_invalid`)
  }
  const expanded = `${descriptor.path}${value.slice(descriptor.token.length)}`
  return absolutePath(expanded, label)
}

export function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

export function parseRuntimeManifest(value: unknown): ActualOwnerRuntimeManifest {
  const input = record(value, 'runtime_manifest')
  exact(input, [
    'schemaVersion', 'purpose', 'runId', 'sandboxRoot', 'markerPath', 'evidenceRoot',
    'driverBaseUrl', 'productBaseUrl', 'approvalPath', 'browser', 'capture', 'refs', 'descriptors',
  ], 'runtime_manifest')
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_PURPOSE ||
    typeof input.runId !== 'string' || !RUN_ID.test(input.runId)) {
    throw new Error('hosted_actual_owner_runtime_manifest_invalid')
  }
  const capture = record(input.capture, 'runtime_capture')
  exact(capture, [
    'conditionalPostLedgerPath', 'negativeResultsPath', 'openCodeTimelinePath',
    'ownerWalTimelinePath', 'productTimelinePath', 'protectedEffectLedgerPath',
  ], 'runtime_capture')
  const refs = record(input.refs, 'runtime_refs')
  exact(refs, ['openCode', 'openCodeExecutableSha256', 'orchestrator', 'product'], 'runtime_refs')
  const descriptors = record(input.descriptors, 'runtime_descriptors')
  exact(descriptors, ['sandboxRoot', 'productRoot', 'orchestratorRoot', 'openCodeExecutable'],
    'runtime_descriptors')
  const sandboxDescriptor = parseDescriptor(descriptors.sandboxRoot,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.sandboxRoot, 'sandbox_root')
  const productDescriptor = parseDescriptor(descriptors.productRoot,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.productRoot, 'product_root')
  const orchestratorDescriptor = parseDescriptor(descriptors.orchestratorRoot,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.orchestratorRoot, 'orchestrator_root')
  const openCodeDescriptor = parseDescriptor(descriptors.openCodeExecutable,
    ACTUAL_OWNER_DESCRIPTOR_TOKENS.openCodeExecutable, 'opencode_executable', true) as
      RuntimePathDescriptor & { size: string; sha256: string }
  const sandboxRoot = expandDescriptor(input.sandboxRoot, sandboxDescriptor, 'sandbox_root')
  const markerPath = expandDescriptor(input.markerPath, sandboxDescriptor, 'marker')
  const ownerWalTimelinePath = expandDescriptor(capture.ownerWalTimelinePath, sandboxDescriptor,
    'owner_wal_timeline')
  if (!isWithin(sandboxRoot, markerPath) || !isWithin(sandboxRoot, ownerWalTimelinePath)) {
    throw new Error('hosted_actual_owner_runtime_path_escaped_sandbox')
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId: input.runId,
    sandboxRoot,
    markerPath,
    capture: Object.freeze({ ownerWalTimelinePath }),
    descriptors: Object.freeze({
      sandboxRoot: sandboxDescriptor,
      productRoot: productDescriptor,
      orchestratorRoot: orchestratorDescriptor,
      openCodeExecutable: openCodeDescriptor,
    }),
    refs: Object.freeze({
      openCode: fullRef(refs.openCode, 'opencode'),
      openCodeExecutableSha256: sha256(refs.openCodeExecutableSha256, 'opencode_executable'),
      orchestrator: fullRef(refs.orchestrator, 'orchestrator'),
      product: fullRef(refs.product, 'product'),
    }),
  })
}

export async function assertRuntimeDescriptors(runtime: ActualOwnerRuntimeManifest): Promise<void> {
  const descriptors = runtime.descriptors
  const checks = [
    ['sandbox_root', descriptors.sandboxRoot, 'directory'],
    ['product_root', descriptors.productRoot, 'directory'],
    ['orchestrator_root', descriptors.orchestratorRoot, 'directory'],
    ['opencode_executable', descriptors.openCodeExecutable, 'file'],
  ] as const
  for (const [label, descriptor, kind] of checks) {
    const [stat, canonical] = await Promise.all([lstat(descriptor.path, { bigint: true }), realpath(descriptor.path)])
    if (canonical !== descriptor.path || stat.isSymbolicLink() ||
      (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) ||
      stat.dev.toString() !== descriptor.device || stat.ino.toString() !== descriptor.inode ||
      (stat.mode & 0o777n).toString() !== descriptor.mode || stat.uid.toString() !== descriptor.uid ||
      (stat.mode & 0o022n) !== 0n ||
      (process.getuid?.() !== undefined && stat.uid !== BigInt(process.getuid())) ||
      (kind === 'file' && ((stat.mode & 0o111n) === 0n || stat.nlink !== 1n ||
        stat.size.toString() !== descriptors.openCodeExecutable.size))) {
      throw new Error(`hosted_actual_owner_${label}_descriptor_identity_mismatch`)
    }
  }
  if (descriptors.sandboxRoot.path !== runtime.sandboxRoot ||
    descriptors.productRoot.path === runtime.sandboxRoot ||
    descriptors.orchestratorRoot.path === runtime.sandboxRoot ||
    descriptors.openCodeExecutable.sha256 !== runtime.refs.openCodeExecutableSha256) {
    throw new Error('hosted_actual_owner_descriptor_binding_mismatch')
  }
}

export async function assertMarkerOwnedSandbox(runtime: ActualOwnerRuntimeManifest): Promise<void> {
  if (runtime.markerPath !== resolve(runtime.sandboxRoot, ACTUAL_OWNER_MARKER_FILE)) {
    throw new Error('hosted_actual_owner_marker_not_canonical')
  }
  const secured = await readAnchoredFile(runtime.markerPath, runtime.sandboxRoot, {
    minimumBytes: 2, maximumBytes: 1_024, mode: 0o600,
  })
  const rootStat = await lstat(runtime.sandboxRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || Number(rootStat.mode & 0o077n) !== 0) {
    throw new Error('hosted_actual_owner_marker_identity_invalid')
  }
  const marker = record(JSON.parse(secured.bytes.toString('utf8')), 'marker')
  exact(marker, ['schemaVersion', 'purpose', 'runId', 'rootBasename', 'rootDevice', 'rootInode'], 'marker')
  if (marker.schemaVersion !== 1 || marker.purpose !== ACTUAL_OWNER_PURPOSE ||
    marker.runId !== runtime.runId || marker.rootBasename !== basename(runtime.sandboxRoot) ||
    marker.rootDevice !== rootStat.dev.toString() || marker.rootInode !== rootStat.ino.toString()) {
    throw new Error('hosted_actual_owner_marker_binding_mismatch')
  }
}

async function readPrivateCanonicalFile(path: string, label: string): Promise<Buffer> {
  try {
    return (await readAnchoredFile(path, dirname(path), {
      minimumBytes: 2, maximumBytes: 1024 * 1024,
    })).bytes
  } catch {
    throw new Error(`hosted_actual_owner_${label}_not_private`)
  }
}

export async function assertCandidateArtifact(
  path: string,
  expected: string,
  descriptor?: RuntimePathDescriptor & { size: string },
): Promise<void> {
  let secured: Awaited<ReturnType<typeof readAnchoredFile>>
  try {
    secured = await readAnchoredFile(path, dirname(path), {
      minimumBytes: 1, maximumBytes: 1024 * 1024 * 1024, executable: true, ownerOnly: false,
    })
  } catch { throw new Error('hosted_actual_owner_candidate_unsafe') }
  if (descriptor && (secured.identity.device !== descriptor.device ||
    secured.identity.inode !== descriptor.inode || secured.identity.size !== descriptor.size ||
    secured.identity.mode !== descriptor.mode || secured.identity.uid !== descriptor.uid)) {
    throw new Error('hosted_actual_owner_candidate_identity_mismatch')
  }
  if (createHash('sha256').update(secured.bytes).digest('hex') !== expected) {
    throw new Error('hosted_actual_owner_candidate_digest_mismatch')
  }
}

async function assertRepository(root: string, expected: string, label: 'orchestrator' | 'product'): Promise<void> {
  const options = { encoding: 'utf8' as const, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }
  const [top, head, status] = await Promise.all([
    execFileAsync('/usr/bin/git', ['-C', root, 'rev-parse', '--show-toplevel'], options),
    execFileAsync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], options),
    execFileAsync('/usr/bin/git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], options),
  ])
  if (top.stdout.trim() !== root || head.stdout.trim() !== expected) {
    throw new Error(`hosted_actual_owner_${label}_ref_mismatch`)
  }
  if (status.stdout !== '') throw new Error(`hosted_actual_owner_${label}_dirty`)
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]
  if (!value || value.includes('\0')) throw new Error(`hosted_actual_owner_${key.toLowerCase()}_missing`)
  return value
}

function positiveDuration(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 60 * 60_000) {
    throw new Error(`hosted_actual_owner_${label}_invalid`)
  }
  return parsed
}

export async function loadAcceptanceConfig(input: {
  args: readonly string[]
  environment?: NodeJS.ProcessEnv
  repositoryRoot: string
}): Promise<ActualOwnerAcceptanceConfig> {
  const environment = input.environment ?? process.env
  if (environment.NODE_ENV === 'production') throw new Error('hosted_actual_owner_production_use_forbidden')
  if (input.args.length !== 2 || input.args[0] !== '--runtime-manifest') {
    throw new Error('hosted_actual_owner_arguments_invalid')
  }
  const runtimeManifestPath = absolutePath(input.args[1], 'runtime_manifest')
  const runtimeBytes = await readPrivateCanonicalFile(runtimeManifestPath, 'runtime_manifest')
  const runtime = parseRuntimeManifest(JSON.parse(runtimeBytes.toString('utf8')))
  await assertRuntimeDescriptors(runtime)
  await assertMarkerOwnedSandbox(runtime)
  const repositoryRoot = await realpath(input.repositoryRoot)
  if (repositoryRoot !== runtime.descriptors.orchestratorRoot.path) {
    throw new Error('hosted_actual_owner_orchestrator_descriptor_mismatch')
  }
  await assertRepository(repositoryRoot, runtime.refs.orchestrator, 'orchestrator')
  const admissionFile = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_ADMISSION_FILE'), 'admission')
  const openCodeExecutable = runtime.descriptors.openCodeExecutable.path
  const openCodeSha256 = runtime.descriptors.openCodeExecutable.sha256
  const productRoot = runtime.descriptors.productRoot.path
  const productPublicationTimeoutMs = positiveDuration(
    requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_PRODUCT_PUBLICATION_TIMEOUT_MS'),
    'product_publication_timeout',
  )
  const controlSocket = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_CONTROL_SOCKET'), 'control_socket')
  const evidenceFile = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_EVIDENCE_FILE'), 'evidence_file')
  for (const path of [runtimeManifestPath, admissionFile, controlSocket, evidenceFile]) {
    if (!isWithin(runtime.sandboxRoot, path)) throw new Error('hosted_actual_owner_path_escaped_sandbox')
  }
  if (runtime.markerPath !== requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_MARKER') ||
    runtimeManifestPath !== requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST')) {
    throw new Error('hosted_actual_owner_product_binding_mismatch')
  }
  if (environment.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH !== openCodeExecutable ||
    environment.OPENCODE_BIN_PATH && environment.OPENCODE_BIN_PATH !== openCodeExecutable) {
    throw new Error('hosted_actual_owner_opencode_path_binding_mismatch')
  }
  await assertCandidateArtifact(openCodeExecutable, openCodeSha256, runtime.descriptors.openCodeExecutable)
  if (await realpath(productRoot) !== productRoot) throw new Error('hosted_actual_owner_product_root_not_canonical')
  await assertRepository(productRoot, runtime.refs.product, 'product')
  return Object.freeze({
    admissionFile, controlSocket, evidenceFile,
    markerPath: runtime.markerPath, openCodeExecutable, openCodeSha256, productRoot,
    productPublicationTimeoutMs,
    repositoryRoot, runtimeManifestPath, runtime, sandboxRoot: runtime.sandboxRoot,
    walFile: resolve(dirname(admissionFile), HOSTED_APPROVAL_WAL_FILE),
  })
}
