import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

export const ACTUAL_OWNER_PURPOSE = 'agent-teams.hosted-actual-owner-e2e/v1' as const
export const ACTUAL_OWNER_ACCEPTANCE_PURPOSE =
  'agent-teams.hosted-actual-owner-e2e.orchestrator-acceptance/v1' as const
export const ACTUAL_OWNER_MARKER_FILE = '.agent-teams-actual-owner-e2e-owner.json' as const
export const HOSTED_APPROVAL_ADMISSION_FILE = 'hosted-approval-runtime-admission.v1.json' as const
export const HOSTED_APPROVAL_WAL_FILE = 'hosted-approval-owner.v1.json' as const

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
  refs: {
    openCode: string
    openCodeExecutableSha256: string
    orchestrator: string
    product: string
  }
}

export type ActualOwnerAcceptanceConfig = {
  admissionFile: string
  controlSocket: string
  evidenceFile: string
  hostedControlConfig: string
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

export function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

export function parseRuntimeManifest(value: unknown): ActualOwnerRuntimeManifest {
  const input = record(value, 'runtime_manifest')
  exact(input, [
    'schemaVersion', 'purpose', 'runId', 'sandboxRoot', 'markerPath', 'evidenceRoot',
    'driverBaseUrl', 'productBaseUrl', 'approvalPath', 'browser', 'capture', 'refs',
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
  const sandboxRoot = absolutePath(input.sandboxRoot, 'sandbox_root')
  const markerPath = absolutePath(input.markerPath, 'marker')
  const ownerWalTimelinePath = absolutePath(capture.ownerWalTimelinePath, 'owner_wal_timeline')
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
    refs: Object.freeze({
      openCode: fullRef(refs.openCode, 'opencode'),
      openCodeExecutableSha256: sha256(refs.openCodeExecutableSha256, 'opencode_executable'),
      orchestrator: fullRef(refs.orchestrator, 'orchestrator'),
      product: fullRef(refs.product, 'product'),
    }),
  })
}

export async function assertMarkerOwnedSandbox(runtime: ActualOwnerRuntimeManifest): Promise<void> {
  const [rootPath, markerPath] = await Promise.all([realpath(runtime.sandboxRoot), realpath(runtime.markerPath)])
  if (rootPath !== runtime.sandboxRoot || markerPath !== runtime.markerPath ||
    runtime.markerPath !== resolve(runtime.sandboxRoot, ACTUAL_OWNER_MARKER_FILE)) {
    throw new Error('hosted_actual_owner_marker_not_canonical')
  }
  const [rootStat, markerStat] = await Promise.all([
    lstat(runtime.sandboxRoot, { bigint: true }), lstat(runtime.markerPath, { bigint: true }),
  ])
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || Number(rootStat.mode & 0o077n) !== 0 ||
    !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1n ||
    Number(markerStat.mode & 0o777n) !== 0o600 || markerStat.size < 2n || markerStat.size > 1_024n) {
    throw new Error('hosted_actual_owner_marker_identity_invalid')
  }
  const marker = record(JSON.parse(await readFile(runtime.markerPath, 'utf8')), 'marker')
  exact(marker, ['schemaVersion', 'purpose', 'runId', 'rootBasename', 'rootDevice', 'rootInode'], 'marker')
  if (marker.schemaVersion !== 1 || marker.purpose !== ACTUAL_OWNER_PURPOSE ||
    marker.runId !== runtime.runId || marker.rootBasename !== basename(runtime.sandboxRoot) ||
    marker.rootDevice !== rootStat.dev.toString() || marker.rootInode !== rootStat.ino.toString()) {
    throw new Error('hosted_actual_owner_marker_binding_mismatch')
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path, { flags: 'r' })
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', rejectStream)
    stream.once('end', resolveStream)
  })
  return hash.digest('hex')
}

async function assertPrivateCanonicalFile(path: string, label: string): Promise<void> {
  if (await realpath(path) !== path) throw new Error(`hosted_actual_owner_${label}_not_canonical`)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 ||
    stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
    throw new Error(`hosted_actual_owner_${label}_not_private`)
  }
}

export async function assertCandidateArtifact(path: string, expected: string): Promise<void> {
  if ((await realpath(path)) !== path) throw new Error('hosted_actual_owner_candidate_not_canonical')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 ||
    (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('hosted_actual_owner_candidate_unsafe')
  }
  if (await hashFile(path) !== expected) throw new Error('hosted_actual_owner_candidate_digest_mismatch')
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
  await assertPrivateCanonicalFile(runtimeManifestPath, 'runtime_manifest')
  const runtime = parseRuntimeManifest(JSON.parse(await readFile(runtimeManifestPath, 'utf8')))
  await assertMarkerOwnedSandbox(runtime)
  const repositoryRoot = await realpath(input.repositoryRoot)
  await assertRepository(repositoryRoot, runtime.refs.orchestrator, 'orchestrator')
  const admissionFile = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_ADMISSION_FILE'), 'admission')
  const hostedControlConfig = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_HOSTED_CONTROL_CONFIG'), 'hosted_control_config')
  const openCodeExecutable = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_OPENCODE_EXECUTABLE'), 'opencode_executable')
  const openCodeSha256 = sha256(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_OPENCODE_SHA256'), 'opencode_executable')
  const productRoot = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_PRODUCT_ROOT'), 'product_root')
  const productPublicationTimeoutMs = positiveDuration(
    requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_PRODUCT_PUBLICATION_TIMEOUT_MS'),
    'product_publication_timeout',
  )
  const controlSocket = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_CONTROL_SOCKET'), 'control_socket')
  const evidenceFile = absolutePath(requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_EVIDENCE_FILE'), 'evidence_file')
  for (const path of [runtimeManifestPath, admissionFile, hostedControlConfig, controlSocket, evidenceFile]) {
    if (!isWithin(runtime.sandboxRoot, path)) throw new Error('hosted_actual_owner_path_escaped_sandbox')
  }
  if (runtime.markerPath !== requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_MARKER') ||
    runtimeManifestPath !== requiredEnvironment(environment, 'HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST') ||
    openCodeSha256 !== runtime.refs.openCodeExecutableSha256) {
    throw new Error('hosted_actual_owner_product_binding_mismatch')
  }
  if (environment.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH !== openCodeExecutable ||
    environment.OPENCODE_BIN_PATH && environment.OPENCODE_BIN_PATH !== openCodeExecutable) {
    throw new Error('hosted_actual_owner_opencode_path_binding_mismatch')
  }
  await assertCandidateArtifact(openCodeExecutable, openCodeSha256)
  if (await realpath(productRoot) !== productRoot) throw new Error('hosted_actual_owner_product_root_not_canonical')
  await assertRepository(productRoot, runtime.refs.product, 'product')
  return Object.freeze({
    admissionFile, controlSocket, evidenceFile, hostedControlConfig,
    markerPath: runtime.markerPath, openCodeExecutable, openCodeSha256, productRoot,
    productPublicationTimeoutMs,
    repositoryRoot, runtimeManifestPath, runtime, sandboxRoot: runtime.sandboxRoot,
    walFile: resolve(dirname(admissionFile), HOSTED_APPROVAL_WAL_FILE),
  })
}
