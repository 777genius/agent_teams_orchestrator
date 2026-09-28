import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { readAnchoredFile } from './secure-files.js'

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
  repositoryRoot: string | null
  orchestratorRef: string
  ownerArtifact: ActualOwnerArtifactAuthority
  runtimeManifestPath: string
  runtime: ActualOwnerRuntimeManifest
  sandboxRoot: string
  walFile: string
}

export type ActualOwnerArtifactAuthority = Readonly<{
  kind: 'sealed-build' | 'source-smoke'
  executable: string
  sha256: `sha256:${string}`
  buildClosureSha256: `sha256:${string}`
}>

export type ActualOwnerOrchestratorAuthority =
  | Readonly<{
      kind: 'source'
      repositoryRoot: string
      ownerArtifact: ActualOwnerArtifactAuthority
    }>
  | Readonly<{
      kind: 'built'
      orchestratorRef: string
      ownerArtifact: ActualOwnerArtifactAuthority
    }>

export function assertProductionOwnerTrust(
  ownerArtifact: ActualOwnerArtifactAuthority,
  signedOwnerArtifactDigest: `sha256:${string}` | undefined,
): void {
  if (ownerArtifact.kind === 'sealed-build' &&
    signedOwnerArtifactDigest !== ownerArtifact.sha256) {
    throw new Error('hosted_actual_owner_owner_artifact_trust_mismatch')
  }
  if (ownerArtifact.kind === 'source-smoke' && signedOwnerArtifactDigest !== undefined) {
    throw new Error('hosted_actual_owner_owner_artifact_not_production')
  }
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

function ownerArtifactAuthority(
  value: ActualOwnerArtifactAuthority,
  expectedKind: ActualOwnerArtifactAuthority['kind'],
): ActualOwnerArtifactAuthority {
  if (value.kind !== expectedKind) {
    throw new Error('hosted_actual_owner_owner_artifact_kind_invalid')
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.sha256) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.buildClosureSha256)) {
    throw new Error('hosted_actual_owner_owner_artifact_sha256_invalid')
  }
  return Object.freeze({
    kind: expectedKind,
    executable: absolutePath(value.executable, 'owner_artifact'),
    sha256: `sha256:${sha256(value.sha256.slice('sha256:'.length), 'owner_artifact')}`,
    buildClosureSha256: `sha256:${sha256(
      value.buildClosureSha256.slice('sha256:'.length), 'owner_build_closure',
    )}`,
  })
}

export function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

const timelineAppends = new Map<string, Promise<void>>()

export async function appendPrivateTimeline(
  path: string,
  sandboxRoot: string,
  line: string,
): Promise<void> {
  if (!line.endsWith('\n') || line.slice(0, -1).includes('\n') || !isWithin(sandboxRoot, path)) {
    throw new Error('hosted_actual_owner_timeline_record_invalid')
  }
  const previous = timelineAppends.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => appendPrivateTimelineRecord(
    path, sandboxRoot, line,
  ))
  timelineAppends.set(path, current)
  try {
    await current
  } finally {
    if (timelineAppends.get(path) === current) timelineAppends.delete(path)
  }
}

async function appendPrivateTimelineRecord(
  path: string,
  sandboxRoot: string,
  line: string,
): Promise<void> {
  const parentPath = dirname(path)
  if (parentPath !== sandboxRoot && !isWithin(sandboxRoot, parentPath)) {
    throw new Error('hosted_actual_owner_timeline_path_escaped_sandbox')
  }
  const nofollow = constants.O_NOFOLLOW
  if (typeof nofollow !== 'number') throw new Error('hosted_actual_owner_nofollow_unavailable')
  const parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | nofollow)
  try {
    const [parentBefore, parentLinked, parentCanonical] = await Promise.all([
      parent.stat({ bigint: true }), lstat(parentPath, { bigint: true }), realpath(parentPath),
    ])
    const currentUid = process.getuid?.()
    if (!parentBefore.isDirectory() || !parentLinked.isDirectory() ||
      parentLinked.isSymbolicLink() || parentBefore.dev !== parentLinked.dev ||
      parentBefore.ino !== parentLinked.ino || parentCanonical !== parentPath ||
      (parentBefore.mode & 0o022n) !== 0n ||
      (currentUid !== undefined && parentBefore.uid !== BigInt(currentUid))) {
      throw new Error('hosted_actual_owner_timeline_parent_untrusted')
    }
    const anchoredPath = `/proc/self/fd/${parent.fd}/${basename(path)}`
    const handle = await open(
      anchoredPath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | nofollow,
      0o600,
    )
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n || Number(before.mode & 0o777n) !== 0o600 ||
        (currentUid !== undefined && before.uid !== BigInt(currentUid))) {
        throw new Error('hosted_actual_owner_timeline_file_untrusted')
      }
      await handle.writeFile(line)
      await handle.sync()
      const [after, linked, canonical, parentAfter, parentCurrent] = await Promise.all([
        handle.stat({ bigint: true }), lstat(anchoredPath, { bigint: true }), realpath(path),
        parent.stat({ bigint: true }), lstat(parentPath, { bigint: true }),
      ])
      if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size + BigInt(Buffer.byteLength(line)) ||
        after.nlink !== 1n || after.dev !== linked.dev || after.ino !== linked.ino ||
        linked.isSymbolicLink() || canonical !== path ||
        parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino ||
        parentCurrent.isSymbolicLink() || parentCurrent.dev !== parentBefore.dev ||
        parentCurrent.ino !== parentBefore.ino) {
        throw new Error('hosted_actual_owner_timeline_identity_drift')
      }
      await parent.sync()
    } finally {
      await handle.close()
    }
  } finally {
    await parent.close()
  }
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

export async function assertCandidateArtifact(path: string, expected: string): Promise<void> {
  let bytes: Buffer
  try {
    bytes = (await readAnchoredFile(path, dirname(path), {
      minimumBytes: 1, maximumBytes: 1024 * 1024 * 1024, executable: true, ownerOnly: false,
    })).bytes
  } catch { throw new Error('hosted_actual_owner_candidate_unsafe') }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
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
  authority: ActualOwnerOrchestratorAuthority
}): Promise<ActualOwnerAcceptanceConfig> {
  const environment = input.environment ?? process.env
  if (environment.NODE_ENV === 'production') throw new Error('hosted_actual_owner_production_use_forbidden')
  if (input.args.length !== 2 || input.args[0] !== '--runtime-manifest') {
    throw new Error('hosted_actual_owner_arguments_invalid')
  }
  const runtimeManifestPath = absolutePath(input.args[1], 'runtime_manifest')
  const runtimeBytes = await readPrivateCanonicalFile(runtimeManifestPath, 'runtime_manifest')
  const runtime = parseRuntimeManifest(JSON.parse(runtimeBytes.toString('utf8')))
  await assertMarkerOwnedSandbox(runtime)
  let repositoryRoot: string | null = null
  let orchestratorRef: string
  const ownerArtifact = ownerArtifactAuthority(
    input.authority.ownerArtifact,
    input.authority.kind === 'built' ? 'sealed-build' : 'source-smoke',
  )
  if (input.authority.kind === 'source') {
    repositoryRoot = await realpath(input.authority.repositoryRoot)
    await assertRepository(repositoryRoot, runtime.refs.orchestrator, 'orchestrator')
    orchestratorRef = runtime.refs.orchestrator
  } else {
    orchestratorRef = fullRef(input.authority.orchestratorRef, 'built_orchestrator')
    if (orchestratorRef !== runtime.refs.orchestrator) {
      throw new Error('hosted_actual_owner_built_orchestrator_ref_mismatch')
    }
  }
  if (ownerArtifact.kind === 'source-smoke') {
    await assertCandidateArtifact(ownerArtifact.executable, ownerArtifact.sha256.slice(7))
  }
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
    repositoryRoot, orchestratorRef, ownerArtifact,
    runtimeManifestPath, runtime, sandboxRoot: runtime.sandboxRoot,
    walFile: resolve(dirname(admissionFile), HOSTED_APPROVAL_WAL_FILE),
  })
}
