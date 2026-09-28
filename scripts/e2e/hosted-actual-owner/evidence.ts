import type {
  ActualOwnerAcceptanceConfig,
  ActualOwnerArtifactAuthority,
} from './contracts.js'
import { ACTUAL_OWNER_ACCEPTANCE_PURPOSE } from './contracts.js'
import type { SecureFileIdentity } from './secure-files.js'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseOwnerStateSource } from '../../../src/services/hostedControl/HostedApprovalOwnerWal.js'
import {
  actualOwnerProcessStartedAtUnixNs,
  assertActualOwnerProcessAnchorCurrent,
  validateActualOwnerProcessAnchor,
  type ActualOwnerProcessAnchor,
  type ActualOwnerProcessAnchorVerifier,
} from './process-anchor.js'

export type ActualOwnerAcceptanceStatus = 'starting' | 'ready' | 'stopping' | 'failed'

export type ActualOwnerWalSource = Readonly<{
  identity: SecureFileIdentity
  sha256: string
  observedAtUnixMs: number
}>

export type ActualOwnerAcceptanceEvidenceVerifier = Readonly<{
  trustedOwnerArtifact?: ActualOwnerArtifactAuthority
  process?: ActualOwnerProcessAnchorVerifier
  processStartedAtNs?: (anchor: ActualOwnerProcessAnchor) => bigint
  readWalSource?: (path: string) => Readonly<{ bytes: Buffer; identity: SecureFileIdentity }>
  walReadAfterOpen?: () => void
  walReadAfterRead?: () => void
  now?: () => number
}>

export type ActualOwnerAcceptanceEvidence = {
  schemaVersion: 1
  purpose: typeof ACTUAL_OWNER_ACCEPTANCE_PURPOSE
  status: ActualOwnerAcceptanceStatus
  runId: string
  markerPath: string
  refs: { orchestrator: string; openCode: string; product: string }
  ownerArtifact: ActualOwnerArtifactAuthority
  artifact: { executable: string; sha256: string }
  admission: { path: string; digest: string | null; generation: string | null }
  publication: {
    hostedControlConfig: SecureFileIdentity | null
    admission: SecureFileIdentity | null
  }
  owner: {
    pid: number
    processAnchor: ActualOwnerProcessAnchor
    controlSocket: string
    ownerSocket: string | null
    walPath: string
    walRevision: number | null
    walSource: ActualOwnerWalSource | null
    readyAnchor: string | null
    ingressCount: number
    deliveryCount: number
    decisionOperations: readonly ['approval_decision_deliver', 'approval_decision_reconcile']
  }
  failure: string | null
}

export function buildAcceptanceEvidence(input: {
  config: ActualOwnerAcceptanceConfig
  processAnchor: ActualOwnerProcessAnchor
  status: ActualOwnerAcceptanceStatus
  admission?: { digest: string; admissionGeneration: string } | null
  ownerSocket?: string | null
  state?: { revision: number; ingress: readonly unknown[]; deliveries: readonly unknown[] } | null
  walSource?: ActualOwnerWalSource | null
  failure?: string | null
  publication?: {
    hostedControlConfig: SecureFileIdentity
    admission: SecureFileIdentity
  } | null
}): ActualOwnerAcceptanceEvidence {
  const state = input.state ?? null
  const processAnchor = validateActualOwnerProcessAnchor(input.processAnchor)
  const walSource = input.walSource ?? null
  const ownerWithoutAnchor = {
    pid: processAnchor.pid,
    processAnchor,
    controlSocket: input.config.controlSocket,
    ownerSocket: input.ownerSocket ?? null,
    walPath: input.config.walFile,
    walRevision: state?.revision ?? null,
    walSource,
    ingressCount: state?.ingress.length ?? 0,
    deliveryCount: state?.deliveries.length ?? 0,
    decisionOperations: Object.freeze([
      'approval_decision_deliver', 'approval_decision_reconcile',
    ] as const),
  }
  const admission = Object.freeze({
    path: input.config.admissionFile,
    digest: input.admission?.digest ?? null,
    generation: input.admission?.admissionGeneration ?? null,
  })
  const publication = Object.freeze({
    hostedControlConfig: input.publication?.hostedControlConfig ?? null,
    admission: input.publication?.admission ?? null,
  })
  const readyAnchor = state && walSource && input.admission && input.publication
    ? acceptanceReadyAnchor({
        runId: input.config.runtime.runId,
        ownerArtifact: input.config.ownerArtifact,
        processAnchor,
        admission,
        publication,
        walPath: ownerWithoutAnchor.walPath,
        walRevision: state.revision,
        walSource,
      })
    : null
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_ACCEPTANCE_PURPOSE,
    status: input.status,
    runId: input.config.runtime.runId,
    markerPath: input.config.markerPath,
    refs: Object.freeze({
      orchestrator: input.config.runtime.refs.orchestrator,
      openCode: input.config.runtime.refs.openCode,
      product: input.config.runtime.refs.product,
    }),
    ownerArtifact: input.config.ownerArtifact,
    artifact: Object.freeze({
      executable: input.config.openCodeExecutable,
      sha256: `sha256:${input.config.openCodeSha256}`,
    }),
    admission,
    publication,
    owner: Object.freeze({
      ...ownerWithoutAnchor,
      readyAnchor,
    }),
    failure: input.failure ?? null,
  })
}

export function validateAcceptanceEvidence(
  value: unknown,
  verifier: ActualOwnerAcceptanceEvidenceVerifier | ActualOwnerProcessAnchorVerifier = {},
): ActualOwnerAcceptanceEvidence {
  const input = evidenceRecord(value)
  evidenceExact(input, [
    'schemaVersion', 'purpose', 'status', 'runId', 'markerPath', 'refs', 'ownerArtifact', 'artifact',
    'admission', 'publication', 'owner', 'failure',
  ])
  if (Reflect.get(input, 'schemaVersion') !== 1 ||
    Reflect.get(input, 'purpose') !== ACTUAL_OWNER_ACCEPTANCE_PURPOSE) {
    throw new Error('acceptance_evidence_invalid')
  }

  const status = evidenceStatus(Reflect.get(input, 'status'))
  const runId = matchingString(Reflect.get(input, 'runId'), /^[0-9a-f]{48}$/)
  const markerPath = absolutePath(Reflect.get(input, 'markerPath'))

  const refsInput = evidenceRecord(Reflect.get(input, 'refs'))
  evidenceExact(refsInput, ['orchestrator', 'openCode', 'product'])
  const refs = Object.freeze({
    orchestrator: matchingString(Reflect.get(refsInput, 'orchestrator'), /^[0-9a-f]{40}$/),
    openCode: matchingString(Reflect.get(refsInput, 'openCode'), /^[0-9a-f]{40}$/),
    product: matchingString(Reflect.get(refsInput, 'product'), /^[0-9a-f]{40}$/),
  })

  const ownerArtifactInput = evidenceRecord(Reflect.get(input, 'ownerArtifact'))
  evidenceExact(ownerArtifactInput, ['kind', 'executable', 'sha256', 'buildClosureSha256'])
  const ownerArtifactKind = Reflect.get(ownerArtifactInput, 'kind')
  if (ownerArtifactKind !== 'sealed-build' && ownerArtifactKind !== 'source-smoke') {
    throw new Error('acceptance_evidence_owner_artifact_invalid')
  }
  const ownerArtifact = Object.freeze({
    kind: ownerArtifactKind,
    executable: absolutePath(Reflect.get(ownerArtifactInput, 'executable')),
    sha256: matchingString(
      Reflect.get(ownerArtifactInput, 'sha256'), /^sha256:[0-9a-f]{64}$/,
    ) as `sha256:${string}`,
    buildClosureSha256: matchingString(
      Reflect.get(ownerArtifactInput, 'buildClosureSha256'), /^sha256:[0-9a-f]{64}$/,
    ) as `sha256:${string}`,
  })
  if (ownerArtifact.kind !== 'sealed-build') {
    throw new Error('acceptance_evidence_owner_artifact_not_production')
  }
  const normalizedVerifier: ActualOwnerAcceptanceEvidenceVerifier = 'platform' in verifier
    ? { process: verifier }
    : verifier
  if (!normalizedVerifier.trustedOwnerArtifact) {
    throw new Error('acceptance_evidence_owner_artifact_trust_missing')
  }
  if (JSON.stringify(ownerArtifact) !==
    JSON.stringify(normalizedVerifier.trustedOwnerArtifact)) {
    throw new Error('acceptance_evidence_owner_artifact_trust_mismatch')
  }

  const artifactInput = evidenceRecord(Reflect.get(input, 'artifact'))
  evidenceExact(artifactInput, ['executable', 'sha256'])
  const artifact = Object.freeze({
    executable: absolutePath(Reflect.get(artifactInput, 'executable')),
    sha256: matchingString(Reflect.get(artifactInput, 'sha256'), /^sha256:[0-9a-f]{64}$/),
  })

  const admissionInput = evidenceRecord(Reflect.get(input, 'admission'))
  evidenceExact(admissionInput, ['path', 'digest', 'generation'])
  const admissionDigest = nullableMatchingString(
    Reflect.get(admissionInput, 'digest'), /^[0-9a-f]{64}$/,
  )
  const admissionGeneration = nullableMatchingString(
    Reflect.get(admissionInput, 'generation'),
    /^approval-admission-generation_[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/,
  )
  if ((admissionDigest === null) !== (admissionGeneration === null)) {
    throw new Error('acceptance_evidence_invalid')
  }
  const admission = Object.freeze({
    path: absolutePath(Reflect.get(admissionInput, 'path')),
    digest: admissionDigest,
    generation: admissionGeneration,
  })

  const publicationInput = evidenceRecord(Reflect.get(input, 'publication'))
  evidenceExact(publicationInput, ['hostedControlConfig', 'admission'])
  const publication = Object.freeze({
    hostedControlConfig: secureFileIdentity(Reflect.get(publicationInput, 'hostedControlConfig')),
    admission: secureFileIdentity(Reflect.get(publicationInput, 'admission')),
  })
  if ((publication.hostedControlConfig === null) !== (publication.admission === null)) {
    throw new Error('acceptance_evidence_invalid')
  }

  const ownerInput = evidenceRecord(Reflect.get(input, 'owner'))
  evidenceExact(ownerInput, [
    'pid', 'processAnchor', 'controlSocket', 'ownerSocket', 'walPath', 'walRevision',
    'walSource', 'readyAnchor', 'ingressCount', 'deliveryCount', 'decisionOperations',
  ])
  const processAnchor = validateActualOwnerProcessAnchor(Reflect.get(ownerInput, 'processAnchor'))
  if (ownerArtifact.sha256 !== processAnchor.executableSha256) {
    throw new Error('acceptance_evidence_owner_artifact_process_mismatch')
  }
  const pid = positiveInteger(Reflect.get(ownerInput, 'pid'))
  const ownerSocketValue = Reflect.get(ownerInput, 'ownerSocket')
  const ownerSocket = ownerSocketValue === null ? null : absolutePath(ownerSocketValue)
  const walRevisionValue = Reflect.get(ownerInput, 'walRevision')
  const walRevision = walRevisionValue === null ? null : positiveInteger(walRevisionValue)
  const walSource = actualOwnerWalSource(Reflect.get(ownerInput, 'walSource'))
  const readyAnchorValue = Reflect.get(ownerInput, 'readyAnchor')
  const readyAnchor = readyAnchorValue === null
    ? null
    : matchingString(readyAnchorValue, /^sha256:[0-9a-f]{64}$/)
  const ingressCount = nonnegativeInteger(Reflect.get(ownerInput, 'ingressCount'))
  const deliveryCount = nonnegativeInteger(Reflect.get(ownerInput, 'deliveryCount'))
  const operations = Reflect.get(ownerInput, 'decisionOperations')
  if (pid !== processAnchor.pid || !Array.isArray(operations) || operations.length !== 2 ||
    operations[0] !== 'approval_decision_deliver' ||
    operations[1] !== 'approval_decision_reconcile' ||
    walRevision === null && (ingressCount !== 0 || deliveryCount !== 0)) {
    throw new Error('acceptance_evidence_invalid')
  }
  const owner = Object.freeze({
    pid,
    processAnchor,
    controlSocket: absolutePath(Reflect.get(ownerInput, 'controlSocket')),
    ownerSocket,
    walPath: absolutePath(Reflect.get(ownerInput, 'walPath')),
    walRevision,
    walSource,
    readyAnchor,
    ingressCount,
    deliveryCount,
    decisionOperations: Object.freeze([
      'approval_decision_deliver', 'approval_decision_reconcile',
    ] as const),
  })

  const failureValue = Reflect.get(input, 'failure')
  const failure = failureValue === null
    ? null
    : matchingString(failureValue, /^(?=.{1,1024}$)[^\0\r\n]+$/)
  const operational = status === 'ready' || status === 'stopping'
  const startingStateInvalid = status === 'starting' &&
    (admission.digest !== null || publication.admission !== null || owner.ownerSocket !== null ||
      owner.walRevision !== null || owner.walSource !== null || owner.readyAnchor !== null ||
      owner.ingressCount !== 0 || owner.deliveryCount !== 0)
  if ((status === 'failed') !== (failure !== null) || operational &&
    (admission.digest === null || publication.admission === null || owner.ownerSocket === null ||
      owner.walRevision === null || owner.walSource === null || owner.readyAnchor === null) ||
    startingStateInvalid) {
    throw new Error('acceptance_evidence_invalid')
  }
  if (operational) {
    const operationalWalRevision = owner.walRevision
    const operationalWalSource = owner.walSource
    if (operationalWalRevision === null || operationalWalSource === null) {
      throw new Error('acceptance_evidence_invalid')
    }
    assertActualOwnerProcessAnchorCurrent(processAnchor, normalizedVerifier.process)
    const expectedReadyAnchor = acceptanceReadyAnchor({
      runId,
      ownerArtifact,
      processAnchor,
      admission,
      publication,
      walPath: owner.walPath,
      walRevision: operationalWalRevision,
      walSource: operationalWalSource,
    })
    if (owner.readyAnchor !== expectedReadyAnchor) {
      throw new Error('acceptance_evidence_ready_anchor_invalid')
    }
    assertActualOwnerWalSourceCurrent(owner, admission, normalizedVerifier)
  }

  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_ACCEPTANCE_PURPOSE,
    status,
    runId,
    markerPath,
    refs,
    ownerArtifact,
    artifact,
    admission,
    publication,
    owner,
    failure,
  })
}

function acceptanceReadyAnchor(input: {
  runId: string
  ownerArtifact: ActualOwnerArtifactAuthority
  processAnchor: ActualOwnerProcessAnchor
  admission: { path: string; digest: string | null; generation: string | null }
  publication: { hostedControlConfig: SecureFileIdentity | null; admission: SecureFileIdentity | null }
  walPath: string
  walRevision: number
  walSource: ActualOwnerWalSource
}): string {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e.ready-anchor/v1',
    runId: input.runId,
    ownerArtifact: input.ownerArtifact,
    processAnchor: input.processAnchor,
    admission: input.admission,
    publication: input.publication,
    wal: {
      path: input.walPath,
      revision: input.walRevision,
      source: input.walSource,
    },
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

function assertActualOwnerWalSourceCurrent(
  owner: ActualOwnerAcceptanceEvidence['owner'],
  admission: ActualOwnerAcceptanceEvidence['admission'],
  verifier: ActualOwnerAcceptanceEvidenceVerifier,
): void {
  const expected = owner.walSource
  if (!expected || owner.walRevision === null || !admission.digest || !admission.generation) {
    throw new Error('acceptance_evidence_invalid')
  }
  let snapshot: Readonly<{ bytes: Buffer; identity: SecureFileIdentity }>
  try {
    snapshot = verifier.readWalSource
      ? verifier.readWalSource(owner.walPath)
      : readActualOwnerWalSource(
          owner.walPath,
          verifier.walReadAfterOpen,
          verifier.walReadAfterRead,
        )
  } catch (error) {
    if (error instanceof Error && error.message === 'acceptance_evidence_wal_source_stale') {
      throw error
    }
    throw new Error('acceptance_evidence_wal_source_unavailable')
  }
  if (JSON.stringify(snapshot.identity) !== JSON.stringify(expected.identity) ||
    createHash('sha256').update(snapshot.bytes).digest('hex') !== expected.sha256) {
    throw new Error('acceptance_evidence_wal_source_stale')
  }
  let wal: ReturnType<typeof parseOwnerStateSource>
  try {
    wal = parseOwnerStateSource(snapshot.bytes)
  } catch {
    throw new Error('acceptance_evidence_wal_source_malformed')
  }
  if (wal.revision !== owner.walRevision || wal.revision < 1 ||
    wal.admissionDigest !== admission.digest || wal.admissionGeneration !== admission.generation ||
    wal.ingress.length !== owner.ingressCount || wal.deliveries.length !== owner.deliveryCount) {
    throw new Error('acceptance_evidence_wal_source_malformed')
  }
  const now = (verifier.now ?? Date.now)()
  let processStartedAtNs: bigint
  try {
    processStartedAtNs = (verifier.processStartedAtNs ?? actualOwnerProcessStartedAtNs)(
      owner.processAnchor,
    )
  } catch {
    throw new Error('acceptance_evidence_wal_source_freshness_invalid')
  }
  if (processStartedAtNs < 1n || !Number.isSafeInteger(now) || now < expected.observedAtUnixMs ||
    BigInt(expected.identity.mtimeNs) < processStartedAtNs ||
    BigInt(expected.observedAtUnixMs) * 1_000_000n < processStartedAtNs ||
    BigInt(expected.identity.mtimeNs) > BigInt(expected.observedAtUnixMs) * 1_000_000n + 999_999n) {
    throw new Error('acceptance_evidence_wal_source_freshness_invalid')
  }
}

function actualOwnerProcessStartedAtNs(anchor: ActualOwnerProcessAnchor): bigint {
  return actualOwnerProcessStartedAtUnixNs(anchor)
}

function readActualOwnerWalSource(
  path: string,
  afterOpen?: () => void,
  afterRead?: () => void,
): { bytes: Buffer; identity: SecureFileIdentity } {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path ||
    typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('acceptance_evidence_wal_source_unavailable')
  }
  const linked = lstatSync(path, { bigint: true })
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n ||
    (linked.mode & 0o777n) !== 0o600n || linked.size < 2n || linked.size > 32n * 1024n * 1024n ||
    (process.getuid?.() !== undefined && linked.uid !== BigInt(process.getuid()))) {
    throw new Error('acceptance_evidence_wal_source_unavailable')
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    afterOpen?.()
    let linkedAfterOpen: BigIntStats
    try {
      linkedAfterOpen = lstatSync(path, { bigint: true })
    } catch (error) {
      throw new Error('acceptance_evidence_wal_source_stale', { cause: error })
    }
    if (!sameWalFile(before, linked) || !sameWalFile(before, linkedAfterOpen)) {
      throw new Error('acceptance_evidence_wal_source_stale')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    afterRead?.()
    let linkedAfterRead: BigIntStats
    try {
      linkedAfterRead = lstatSync(path, { bigint: true })
    } catch (error) {
      throw new Error('acceptance_evidence_wal_source_stale', { cause: error })
    }
    if (!sameWalFile(before, after) || !sameWalFile(after, linkedAfterRead) ||
      BigInt(bytes.byteLength) !== after.size) {
      throw new Error('acceptance_evidence_wal_source_stale')
    }
    return {
      bytes,
      identity: Object.freeze({
        device: after.dev.toString(),
        inode: after.ino.toString(),
        size: after.size.toString(),
        mtimeNs: after.mtimeNs.toString(),
        ctimeNs: after.ctimeNs.toString(),
      }),
    }
  } finally {
    closeSync(fd)
  }
}

function sameWalFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid
}

function evidenceRecord(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('acceptance_evidence_invalid')
  }
  return value
}

function evidenceExact(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error('acceptance_evidence_invalid')
  }
}

function matchingString(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('acceptance_evidence_invalid')
  }
  return value
}

function nullableMatchingString(value: unknown, pattern: RegExp): string | null {
  return value === null ? null : matchingString(value, pattern)
}

function absolutePath(value: unknown): string {
  const path = matchingString(value, /^.+$/)
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    throw new Error('acceptance_evidence_invalid')
  }
  return path
}

function evidenceStatus(value: unknown): ActualOwnerAcceptanceStatus {
  if (value === 'starting' || value === 'ready' || value === 'stopping' || value === 'failed') {
    return value
  }
  throw new Error('acceptance_evidence_invalid')
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('acceptance_evidence_invalid')
  }
  return Number(value)
}

function positiveInteger(value: unknown): number {
  const integer = nonnegativeInteger(value)
  if (integer < 1) throw new Error('acceptance_evidence_invalid')
  return integer
}

function secureFileIdentity(value: unknown): SecureFileIdentity | null {
  if (value === null) return null
  const input = evidenceRecord(value)
  evidenceExact(input, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'])
  const decimal = /^(0|[1-9][0-9]*)$/
  const identity = Object.freeze({
    device: matchingString(Reflect.get(input, 'device'), decimal),
    inode: matchingString(Reflect.get(input, 'inode'), decimal),
    size: matchingString(Reflect.get(input, 'size'), decimal),
    mtimeNs: matchingString(Reflect.get(input, 'mtimeNs'), decimal),
    ctimeNs: matchingString(Reflect.get(input, 'ctimeNs'), decimal),
  })
  if (identity.inode === '0' || identity.size === '0') {
    throw new Error('acceptance_evidence_invalid')
  }
  return identity
}

function actualOwnerWalSource(value: unknown): ActualOwnerWalSource | null {
  if (value === null) return null
  const input = evidenceRecord(value)
  evidenceExact(input, ['identity', 'sha256', 'observedAtUnixMs'])
  const identity = secureFileIdentity(Reflect.get(input, 'identity'))
  const observedAtUnixMs = positiveInteger(Reflect.get(input, 'observedAtUnixMs'))
  if (!identity) throw new Error('acceptance_evidence_invalid')
  return Object.freeze({
    identity,
    sha256: matchingString(Reflect.get(input, 'sha256'), /^[0-9a-f]{64}$/),
    observedAtUnixMs,
  })
}
