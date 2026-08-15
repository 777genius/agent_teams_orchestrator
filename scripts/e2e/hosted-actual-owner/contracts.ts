import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { assertAnchoredIdentity, readAnchoredFile, type SecureFileIdentity, type TrustedRoot } from './secure-files.js'
import { assertProductContractCurrent, loadProductContract, type ActualOwnerProductContract } from './product-contract.js'

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
const HARNESS_RUN_ID = /^[0-9a-f]{48}$/

type JsonRecord = Record<string, unknown>

export type ActualOwnerRuntimeManifest = {
  schemaVersion: 1
  purpose: typeof ACTUAL_OWNER_PURPOSE
  runId: string
  sandboxRoot: string
  markerPath: string
  ownerWalTimelineRawPath: string
  capabilityEndpoint: string
  ownerBinding: { ownerUid: number; ownerSessionId: string; ownerTokenSha256: string }
  socketIdentity: {
    driverSocket: { endpoint: string; device: string; inode: string }
    productSocket: { endpoint: string; device: string; inode: string }
  }
  contract: {
    path: string; sha256: string; byteCount: number; device: string; inode: string; mode: string
    sourceCommit: string; repositoryPath: string
  }
  browser: {
    ownerStorageStatePath: string; nonOwnerStorageStatePath: string; tracePath: string; resultsPath: string
  }
  capture: {
    browserResultsPath: string; conditionalPostLedgerPath: string; negativeResultsPath: string
    openCodeTimelinePath: string; ownerWalTimelinePath: string
    productTimelinePath: string; protectedEffectLedgerPath: string
  }
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
  ownerToken: string
  productContract: ActualOwnerProductContract
  productRoot: string
  productPublicationTimeoutMs: number
  repositoryRoot: string
  runtimeManifestPath: string
  runtimeManifestIdentity: SecureFileIdentity
  runtimeManifestSha256: string
  runtime: ActualOwnerRuntimeManifest
  sandboxRoot: string
  walFile: string
}

export function sandboxAnchor(runtime: ActualOwnerRuntimeManifest): TrustedRoot {
  return Object.freeze({
    path: runtime.sandboxRoot,
    device: runtime.descriptors.sandboxRoot.device,
    inode: runtime.descriptors.sandboxRoot.inode,
  })
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
    'schemaVersion', 'purpose', 'runId', 'sandboxRoot', 'markerPath', 'ownerWalTimelineRawPath', 'evidenceRoot',
    'driverBaseUrl', 'productBaseUrl', 'approvalPath', 'capabilityEndpoint', 'ownerBinding',
    'socketIdentity', 'contract', 'browser', 'capture', 'refs', 'descriptors',
  ], 'runtime_manifest')
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_PURPOSE ||
    typeof input.runId !== 'string' || !HARNESS_RUN_ID.test(input.runId)) {
    throw new Error('hosted_actual_owner_runtime_manifest_invalid')
  }
  const capture = record(input.capture, 'runtime_capture')
  exact(capture, [
    'browserResultsPath', 'conditionalPostLedgerPath', 'negativeResultsPath', 'openCodeTimelinePath',
    'ownerWalTimelinePath', 'productTimelinePath', 'protectedEffectLedgerPath',
  ], 'runtime_capture')
  const browser = record(input.browser, 'runtime_browser')
  exact(browser, ['ownerStorageStatePath', 'nonOwnerStorageStatePath', 'tracePath', 'resultsPath'],
    'runtime_browser')
  const ownerBinding = record(input.ownerBinding, 'runtime_owner_binding')
  exact(ownerBinding, ['ownerUid', 'ownerSessionId', 'ownerTokenSha256'], 'runtime_owner_binding')
  const socketIdentity = record(input.socketIdentity, 'runtime_socket_identity')
  exact(socketIdentity, ['driverSocket', 'productSocket'], 'runtime_socket_identity')
  const driverSocket = record(socketIdentity.driverSocket, 'runtime_driver_socket')
  const productSocket = record(socketIdentity.productSocket, 'runtime_product_socket')
  exact(driverSocket, ['endpoint', 'device', 'inode'], 'runtime_driver_socket')
  exact(productSocket, ['endpoint', 'device', 'inode'], 'runtime_product_socket')
  const contract = record(input.contract, 'runtime_contract')
  exact(contract, ['path', 'sha256', 'byteCount', 'device', 'inode', 'mode', 'sourceCommit',
    'repositoryPath'], 'runtime_contract')
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
  const ownerWalTimelineRawPath = expandDescriptor(input.ownerWalTimelineRawPath, sandboxDescriptor,
    'owner_wal_timeline_raw')
  const ownerWalTimelinePath = expandDescriptor(capture.ownerWalTimelinePath, sandboxDescriptor,
    'owner_wal_timeline')
  const expandSandbox = (value: unknown, label: string) =>
    expandDescriptor(value, sandboxDescriptor, label)
  const expandedBrowser = Object.freeze({
    ownerStorageStatePath: expandSandbox(browser.ownerStorageStatePath, 'owner_storage_state'),
    nonOwnerStorageStatePath: expandSandbox(browser.nonOwnerStorageStatePath, 'non_owner_storage_state'),
    tracePath: expandSandbox(browser.tracePath, 'browser_trace'),
    resultsPath: expandSandbox(browser.resultsPath, 'browser_results'),
  })
  const expandedCapture = Object.freeze({
    browserResultsPath: expandSandbox(capture.browserResultsPath, 'capture_browser_results'),
    conditionalPostLedgerPath: expandSandbox(capture.conditionalPostLedgerPath, 'conditional_post_ledger'),
    negativeResultsPath: expandSandbox(capture.negativeResultsPath, 'negative_results'),
    openCodeTimelinePath: expandSandbox(capture.openCodeTimelinePath, 'opencode_timeline'),
    ownerWalTimelinePath,
    productTimelinePath: expandSandbox(capture.productTimelinePath, 'product_timeline'),
    protectedEffectLedgerPath: expandSandbox(capture.protectedEffectLedgerPath, 'protected_effect_ledger'),
  })
  const driverBaseUrl = loopbackBaseUrl(input.driverBaseUrl, 'driver_base_url')
  const productBaseUrl = loopbackBaseUrl(input.productBaseUrl, 'product_base_url')
  if (!isWithin(sandboxRoot, markerPath) || !isWithin(sandboxRoot, ownerWalTimelinePath) ||
    !isWithin(sandboxRoot, ownerWalTimelineRawPath) ||
    typeof input.evidenceRoot !== 'string' || !isAbsolute(input.evidenceRoot) ||
    resolve(input.evidenceRoot) !== input.evidenceRoot ||
    typeof input.approvalPath !== 'string' || !/^\/[A-Za-z0-9/_-]+$/.test(input.approvalPath) ||
    expandedCapture.browserResultsPath !== expandedBrowser.resultsPath ||
    ownerWalTimelineRawPath !== ownerWalTimelinePath ||
    input.capabilityEndpoint !== new URL('v1/capability', driverBaseUrl).toString() ||
    driverSocket.endpoint !== new URL(driverBaseUrl).host ||
    productSocket.endpoint !== new URL(productBaseUrl).host ||
    driverSocket.endpoint === productSocket.endpoint ||
    decimal(driverSocket.device, 'driver_socket_device') === decimal(productSocket.device, 'product_socket_device') &&
      decimal(driverSocket.inode, 'driver_socket_inode') === decimal(productSocket.inode, 'product_socket_inode') ||
    !Number.isSafeInteger(ownerBinding.ownerUid) || (ownerBinding.ownerUid as number) < 0 ||
    ownerBinding.ownerSessionId !== `session_${input.runId}` ||
    typeof ownerBinding.ownerTokenSha256 !== 'string' || !SHA256.test(ownerBinding.ownerTokenSha256)) {
    throw new Error('hosted_actual_owner_runtime_manifest_binding_invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId: input.runId,
    sandboxRoot,
    markerPath,
    ownerWalTimelineRawPath,
    capabilityEndpoint: input.capabilityEndpoint as string,
    ownerBinding: Object.freeze({ ownerUid: ownerBinding.ownerUid as number,
      ownerSessionId: ownerBinding.ownerSessionId as string,
      ownerTokenSha256: ownerBinding.ownerTokenSha256 as string }),
    socketIdentity: Object.freeze({
      driverSocket: Object.freeze({ endpoint: driverSocket.endpoint as string,
        device: decimal(driverSocket.device, 'driver_socket_device'),
        inode: decimal(driverSocket.inode, 'driver_socket_inode') }),
      productSocket: Object.freeze({ endpoint: productSocket.endpoint as string,
        device: decimal(productSocket.device, 'product_socket_device'),
        inode: decimal(productSocket.inode, 'product_socket_inode') }),
    }),
    contract: Object.freeze({
      path: expandSandbox(contract.path, 'contract'), sha256: sha256(contract.sha256, 'contract'),
      byteCount: positiveInteger(contract.byteCount, 'contract_byte_count'),
      device: decimal(contract.device, 'contract_device'), inode: decimal(contract.inode, 'contract_inode'),
      mode: decimal(contract.mode, 'contract_mode'), sourceCommit: fullRef(contract.sourceCommit, 'contract'),
      repositoryPath: contract.repositoryPath as string,
    }),
    browser: expandedBrowser,
    capture: expandedCapture,
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

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`hosted_actual_owner_${label}_invalid`)
  }
  return value as number
}

function loopbackBaseUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`hosted_actual_owner_${label}_invalid`)
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`hosted_actual_owner_${label}_invalid`) }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/' ||
    parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`hosted_actual_owner_${label}_invalid`)
  }
  return parsed.toString()
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
  if (!new RegExp(`^actual-owner-${runtime.runId}-[A-Za-z0-9]{6}$`).test(basename(runtime.sandboxRoot))) {
    throw new Error('hosted_actual_owner_sandbox_root_name_invalid')
  }
  if (runtime.markerPath !== resolve(runtime.sandboxRoot, ACTUAL_OWNER_MARKER_FILE)) {
    throw new Error('hosted_actual_owner_marker_not_canonical')
  }
  const secured = await readAnchoredFile(runtime.markerPath, sandboxAnchor(runtime), {
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

async function readPrivateCanonicalFile(
  path: string, root: TrustedRoot, label: string,
): Promise<{ bytes: Buffer; identity: SecureFileIdentity }> {
  try {
    return await readAnchoredFile(path, root, {
      minimumBytes: 2, maximumBytes: 1024 * 1024,
    })
  } catch {
    throw new Error(`hosted_actual_owner_${label}_not_private`)
  }
}

export async function assertCandidateArtifact(
  path: string,
  expected: string,
  descriptor?: RuntimePathDescriptor & { size: string },
  trustedRoot?: TrustedRoot,
): Promise<void> {
  let secured: Awaited<ReturnType<typeof readAnchoredFile>>
  try {
    secured = await readAnchoredFile(path, trustedRoot ?? dirname(path), {
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
  const options = {
    encoding: 'utf8' as const,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }
  const git = (args: readonly string[]) => execFileAsync('/usr/bin/git', [
    '--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args,
  ], options)
  const [top, head, status] = await Promise.all([
    git(['rev-parse', '--show-toplevel']),
    git(['rev-parse', '--verify', 'HEAD^{commit}']),
    git(['status', '--porcelain=v1', '--untracked-files=all']),
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
  if (input.args.length !== 8 || input.args[0] !== '--runtime-manifest') {
    throw new Error('hosted_actual_owner_arguments_invalid')
  }
  const runtimeManifestPath = absolutePath(input.args[1], 'runtime_manifest')
  const markerPath = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_MARKER'), 'marker')
  if (basename(markerPath) !== ACTUAL_OWNER_MARKER_FILE) {
    throw new Error('hosted_actual_owner_marker_not_canonical')
  }
  const declaredSandboxRoot = dirname(markerPath)
  const declaredRootStat = await lstat(declaredSandboxRoot, { bigint: true })
  if (!declaredRootStat.isDirectory() || declaredRootStat.isSymbolicLink()) {
    throw new Error('hosted_actual_owner_sandbox_root_invalid')
  }
  const externalAnchor: TrustedRoot = Object.freeze({
    path: declaredSandboxRoot,
    device: declaredRootStat.dev.toString(),
    inode: declaredRootStat.ino.toString(),
  })
  if (!isWithin(declaredSandboxRoot, runtimeManifestPath)) {
    throw new Error('hosted_actual_owner_path_escaped_sandbox')
  }
  const runtimeFile = await readPrivateCanonicalFile(runtimeManifestPath, externalAnchor, 'runtime_manifest')
  const runtime = parseRuntimeManifest(JSON.parse(runtimeFile.bytes.toString('utf8')))
  if (runtimeFile.identity.device === runtime.contract.device &&
    runtimeFile.identity.inode === runtime.contract.inode) {
    throw new Error('hosted_actual_owner_manifest_contract_identity_aliased')
  }
  if (runtime.sandboxRoot !== declaredSandboxRoot || runtime.markerPath !== markerPath) {
    throw new Error('hosted_actual_owner_runtime_external_binding_mismatch')
  }
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
  const ownerToken = requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN')
  if (process.getuid?.() !== runtime.ownerBinding.ownerUid ||
    createHash('sha256').update(ownerToken).digest('hex') !== runtime.ownerBinding.ownerTokenSha256) {
    throw new Error('hosted_actual_owner_product_owner_binding_mismatch')
  }
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
  if (!isWithin(runtime.sandboxRoot, openCodeExecutable)) {
    throw new Error('hosted_actual_owner_opencode_path_escaped_sandbox')
  }
  await assertCandidateArtifact(openCodeExecutable, openCodeSha256,
    runtime.descriptors.openCodeExecutable, sandboxAnchor(runtime))
  if (await realpath(productRoot) !== productRoot) throw new Error('hosted_actual_owner_product_root_not_canonical')
  await assertRepository(productRoot, runtime.refs.product, 'product')
  const productContract = await loadProductContract({ args: input.args.slice(2), runtime, productRoot,
    anchor: sandboxAnchor(runtime) })
  return Object.freeze({
    admissionFile, controlSocket, evidenceFile,
    markerPath: runtime.markerPath, openCodeExecutable, openCodeSha256, ownerToken, productContract, productRoot,
    productPublicationTimeoutMs,
    repositoryRoot, runtimeManifestPath, runtimeManifestIdentity: runtimeFile.identity,
    runtimeManifestSha256: createHash('sha256').update(runtimeFile.bytes).digest('hex'),
    runtime, sandboxRoot: runtime.sandboxRoot,
    walFile: resolve(dirname(admissionFile), HOSTED_APPROVAL_WAL_FILE),
  })
}

export async function assertAcceptanceConfigCurrent(config: ActualOwnerAcceptanceConfig): Promise<void> {
  const anchor = sandboxAnchor(config.runtime)
  const manifest = await assertAnchoredIdentity(config.runtimeManifestPath, anchor,
    config.runtimeManifestIdentity, { minimumBytes: 2, maximumBytes: 1024 * 1024 })
  if (createHash('sha256').update(manifest).digest('hex') !== config.runtimeManifestSha256) {
    throw new Error('hosted_actual_owner_runtime_manifest_digest_mismatch')
  }
  const reparsed = parseRuntimeManifest(JSON.parse(manifest.toString('utf8')))
  if (JSON.stringify(reparsed) !== JSON.stringify(config.runtime)) {
    throw new Error('hosted_actual_owner_runtime_manifest_projection_mismatch')
  }
  await assertRuntimeDescriptors(config.runtime)
  await assertMarkerOwnedSandbox(config.runtime)
  await assertCandidateArtifact(config.openCodeExecutable, config.openCodeSha256,
    config.runtime.descriptors.openCodeExecutable, anchor)
  await assertProductContractCurrent({ contract: config.productContract, runtime: config.runtime, anchor })
  await Promise.all([
    assertRepository(config.repositoryRoot, config.runtime.refs.orchestrator, 'orchestrator'),
    assertRepository(config.productRoot, config.runtime.refs.product, 'product'),
  ])
}
