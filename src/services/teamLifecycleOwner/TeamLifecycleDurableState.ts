import { isDeepStrictEqual } from 'node:util'
import {
  computeCanonicalPolicyDigest,
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwnedProcessRef,
  parseOwningProcessIdentityRef,
  parseSpawnNonce,
  spawnNonceDigest,
  type ProcessOwnershipScope,
  type ProcessOwnershipState,
  type SpawnNonce,
} from '@agent-teams/owner-anchor-library'
import type { HostedLifecycleProviderSnapshot } from '../hostedControl/HostedLifecycleSnapshot.js'
import {
  computeNativeProductPlanRefDigest,
  type NativeAcquisitionDrainProof,
  type NativeAcquisitionNoEffectProof,
  type NativeAcquisitionPreparedExpectation,
  type NativeProcessAcquisition,
  type NativeProcessReadinessProof,
  type OwnedNativeProcessIdentity,
} from './NativeProcessAcquisition.js'
import type { TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'

export const TEAM_LIFECYCLE_STATE_SCHEMA_VERSION = 5 as const
export const TEAM_LIFECYCLE_STATE_MAX_BYTES = 32 * 1024 * 1024
export const TEAM_LIFECYCLE_ATTEMPT_CAPACITY = 4096
export const TEAM_LIFECYCLE_TOMBSTONE_CAPACITY = 8192
export const TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES = 64 * 1024
export const TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY = 32
export const TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY = 16

const MAX_SAFE_INTEGER_JSON_BYTES = 16
const MAX_OPAQUE_REF_JSON_BYTES = 258
const SHA256_DIGEST_JSON_BYTES = 73

export type AttemptPhase =
  | 'armed'
  | 'acquired'
  | 'ready'
  | 'uncertain'
  | 'anchor-terminal-pending'
  | 'drained'
  | 'noeffect'

export type AttemptFence = Readonly<{
  key: string
  runId: string
  ownerIncarnation: string
  controllerInstanceId: string
  ownerPlanGeneration: string
  operationEpoch: number
  attemptOrdinal: number
}>

export type AStopSuccess = Extract<
  Awaited<ReturnType<NativeProcessAcquisition['stopOwnedNativeProcess']>>,
  { status: 'drained' | 'already_drained' }
>
export type NativeCleanupOperation = 'stopOwnedNativeProcess' | 'reconcileFailedAttempt'
export type NativeCleanupCompletion = Readonly<{
  fence: AttemptFence
  identity: OwnedNativeProcessIdentity
  operation: NativeCleanupOperation
  result: AStopSuccess
}>
export type NativeCleanupFailure = Readonly<{
  operation: NativeCleanupOperation
  reason: string
}>
export type DurableNativeUncertainEvidence = Readonly<{
  attempt: Readonly<{
    version: 1
    kind: 'known-anchor-ref' | 'uncertain-start-without-ref'
    expected: NativeAcquisitionPreparedExpectation
    processRef?: string
    startResult: unknown
  }>
  phase: string
  adapterResult: unknown
}>

export type DurableAttempt = {
  key: string
  kind: 'native'
  phase: AttemptPhase
  fence: AttemptFence
  expected: NativeAcquisitionPreparedExpectation
  identity?: OwnedNativeProcessIdentity
  readinessProof?: NativeProcessReadinessProof
  uncertainEvidence?: readonly DurableNativeUncertainEvidence[]
  anchorTerminalEvidence?: NativeAcquisitionDrainProof
  cleanupSettlement?: Readonly<{ status: 'pending' }> | Readonly<{
    status: 'completed'
    completion: NativeCleanupCompletion
  }>
  cleanupFailures?: readonly NativeCleanupFailure[]
  terminalEvidence?: NativeAcquisitionNoEffectProof
  processOwnership?: ProcessOwnershipState
}

export type DurableAttemptTombstone = {
  key: string
  fence: AttemptFence
  expected: NativeAcquisitionPreparedExpectation
  scope: ProcessOwnershipScope
  processRef?: string
  terminalPhase: 'drained' | 'noeffect'
  terminalEvidence: NativeAcquisitionDrainProof | NativeAcquisitionNoEffectProof
  cleanupCompletion?: NativeCleanupCompletion
}

export type DurableStateV5 = {
  schemaVersion: typeof TEAM_LIFECYCLE_STATE_SCHEMA_VERSION
  revision: number
  planFingerprint: string
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode']
  phase: HostedLifecycleProviderSnapshot['phase']
  runId: string | null
  recoverable: boolean
  ownerIncarnation: string | null
  recoveryBindings: Record<string, string>
  operationEpoch: number
  attempts: Record<string, DurableAttempt>
  tombstones: DurableAttemptTombstone[]
  disposition: unknown | null
  legacyUnresolved: null | Readonly<{
    schemaVersion: 2 | 3 | 4
    runId: string
    phase: Exclude<HostedLifecycleProviderSnapshot['phase'], 'idle'>
    recoveryBindings: Record<string, string>
  }>
}

export function createAttemptKey(input: Readonly<{
  ownerPlanGeneration: string
  runId: string
  originalLaneId: string
  globalOrdinal: number
  attemptOrdinal: number
}>): string {
  text(input.ownerPlanGeneration, 'attempt owner generation', 512)
  text(input.runId, 'attempt run', 256)
  text(input.originalLaneId, 'attempt lane', 256)
  integer(input.globalOrdinal, 'attempt global ordinal')
  integer(input.attemptOrdinal, 'attempt ordinal')
  return [
    input.ownerPlanGeneration,
    input.runId,
    input.originalLaneId,
    String(input.globalOrdinal),
    String(input.attemptOrdinal),
  ].map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|')
}

export function createInitialDurableState(
  planFingerprint: string,
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode'],
  retained?: Partial<Pick<
    DurableStateV5,
    'revision' | 'operationEpoch' | 'attempts' | 'tombstones' | 'disposition' | 'legacyUnresolved'
  >>,
): DurableStateV5 {
  return {
    schemaVersion: 5,
    revision: retained?.revision ?? 0,
    planFingerprint,
    toolApprovalMode,
    phase: 'idle',
    runId: null,
    recoverable: false,
    ownerIncarnation: null,
    recoveryBindings: {},
    operationEpoch: retained?.operationEpoch ?? 0,
    attempts: retained?.attempts ?? {},
    tombstones: retained?.tombstones ?? [],
    disposition: retained?.disposition ?? null,
    legacyUnresolved: retained?.legacyUnresolved ?? null,
  }
}

export function decodeDurableState(value: unknown): DurableStateV5 {
  const source = object(value, 'state')
  if (source.schemaVersion === 2 || source.schemaVersion === 3 || source.schemaVersion === 4) {
    const migrated = migrateLegacy(source)
    assertDurableStateCapacity(migrated)
    return migrated
  }
  if (source.schemaVersion !== 5) throw new Error('Unsupported team lifecycle state schema')
  keys(source, [
    'schemaVersion', 'revision', 'planFingerprint', 'toolApprovalMode', 'phase', 'runId',
    'recoverable', 'ownerIncarnation', 'recoveryBindings', 'operationEpoch', 'attempts',
    'tombstones', 'disposition', 'legacyUnresolved',
  ])
  validateBase(source)
  integer(source.operationEpoch, 'operation epoch')
  const attemptSource = object(source.attempts, 'attempts')
  if (Object.keys(attemptSource).length > TEAM_LIFECYCLE_ATTEMPT_CAPACITY) {
    throw new Error('Team lifecycle attempt capacity exceeded')
  }
  const attempts: Record<string, DurableAttempt> = {}
  for (const [key, candidate] of Object.entries(attemptSource)) {
    attempts[key] = decodeAttempt(key, candidate)
  }
  if (!Array.isArray(source.tombstones) || source.tombstones.length > TEAM_LIFECYCLE_TOMBSTONE_CAPACITY) {
    throw new Error('Invalid team lifecycle tombstones')
  }
  const state: DurableStateV5 = {
    schemaVersion: 5,
    revision: source.revision as number,
    planFingerprint: source.planFingerprint as string,
    toolApprovalMode: source.toolApprovalMode as TeamLifecycleLaunchPlan['toolApprovalMode'],
    phase: source.phase as DurableStateV5['phase'],
    runId: source.runId as string | null,
    recoverable: source.recoverable as boolean,
    ownerIncarnation: source.ownerIncarnation as string | null,
    recoveryBindings: recoveryBindings(source.recoveryBindings),
    operationEpoch: source.operationEpoch as number,
    attempts,
    tombstones: source.tombstones.map(decodeTombstone),
    disposition: decodeDisposition(source.disposition),
    legacyUnresolved: source.legacyUnresolved === null
      ? null
      : decodeLegacyUnresolved(source.legacyUnresolved),
  }
  validateLedger(state)
  return cloneJson(state)
}

/** The shared publication gate consumed by the physical transaction lane. */
export function validateDurableStateForWrite(state: DurableStateV5): DurableStateV5 {
  const encoded = stringifyDurableState(state)
  const decoded = parseDurableStateJson(encoded)
  assertDurableStateCapacity(decoded, Buffer.byteLength(encoded, 'utf8') + 1)
  return decoded
}

export function assertDurableStateCapacity(
  state: DurableStateV5,
  encodedBytes = safeDurableJsonByteLength(state) + 1,
): void {
  const unresolvedAttempts = Object.values(state.attempts).filter(attempt => !terminal(attempt))
  const unresolved = unresolvedAttempts.length
  if (state.tombstones.length + unresolved > TEAM_LIFECYCLE_TOMBSTONE_CAPACITY) {
    throw new Error('Team lifecycle terminal slot reserve unavailable')
  }
  const revisionHeadroom = MAX_SAFE_INTEGER_JSON_BYTES - safeDurableJsonByteLength(state.revision)
  if (revisionHeadroom < 0) throw new Error('Invalid team lifecycle revision envelope')
  const reservation = unresolvedAttempts.reduce(
    (total, attempt) => total + durableAttemptReservationBytes(attempt),
    0,
  )
  if (encodedBytes + revisionHeadroom + reservation > TEAM_LIFECYCLE_STATE_MAX_BYTES) {
    throw new Error('Team lifecycle terminal byte reserve unavailable')
  }
}

export function assertIdleCustody(state: DurableStateV5): void {
  if (
    state.legacyUnresolved ||
    state.disposition !== null ||
    Object.values(state.attempts).some(attempt => !terminal(attempt))
  ) {
    throw new Error('Team lifecycle idle publication has unresolved custody')
  }
}

export function stringifyDurableState(state: DurableStateV5): string {
  return JSON.stringify(encodeSafeJson(state))
}
export function safeDurableJsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(encodeSafeJson(value)), 'utf8')
}
export function parseDurableStateJson(bytes: string): DurableStateV5 {
  rejectDuplicateJsonMembers(bytes)
  const state = decodeDurableState(decodeSafeJson(JSON.parse(bytes)))
  assertDurableStateCapacity(state, Buffer.byteLength(bytes, 'utf8'))
  return state
}

type ByteBoundFields = Readonly<Record<string, number>>

function objectBytes(fields: ByteBoundFields): number {
  const entries = Object.entries(fields)
  return 2 + entries.reduce(
    (total, [name, valueBytes]) => total + safeDurableJsonByteLength(name) + 1 + valueBytes,
    0,
  ) + Math.max(0, entries.length - 1)
}

function arrayBytes(count: number, valueBytes: number): number {
  return 2 + count * valueBytes + Math.max(0, count - 1)
}

function textBytes(inputBytes: number): number {
  return 2 + 6 * inputBytes
}

function bareIdentityMaxBytes(expected: NativeAcquisitionPreparedExpectation): number {
  return safeDurableJsonByteLength(expected) - 2 +
    safeDurableJsonByteLength('kind') + 1 + safeDurableJsonByteLength('hosted-anchor') +
    safeDurableJsonByteLength('processRef') + 1 + MAX_OPAQUE_REF_JSON_BYTES + 2 + 2
}

function drainProofMaxBytes(): number {
  return objectBytes({
    kind: safeDurableJsonByteLength('exact-anchor-terminal'),
    identity: TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    adapterResult: safeDurableJsonByteLength({ status: 'already_drained' }),
    observedAt: textBytes(256),
  })
}

function noEffectProofMaxBytes(expected: NativeAcquisitionPreparedExpectation): number {
  return objectBytes({
    kind: safeDurableJsonByteLength('pre-start-failure'),
    expected: safeDurableJsonByteLength(expected),
    startWasNeverCalled: 4,
    claimSettled: 4,
    observedAt: textBytes(256),
    reason: textBytes(4096),
  })
}

function cleanupCompletionMaxBytes(fence: AttemptFence): number {
  return objectBytes({
    fence: safeDurableJsonByteLength(fence),
    identity: TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    operation: Math.max(
      safeDurableJsonByteLength('stopOwnedNativeProcess'),
      safeDurableJsonByteLength('reconcileFailedAttempt'),
    ),
    result: safeDurableJsonByteLength({ status: 'already_drained' }),
  })
}

function processOwnershipMaxBytes(expected: NativeAcquisitionPreparedExpectation): number {
  const scopeBytes = safeDurableJsonByteLength(expectedAttemptScope(expected))
  const workspaceBytes = safeDurableJsonByteLength(expectedWorkspace(expected))
  const binaryBytes = safeDurableJsonByteLength(
    expected.binding.launchSpec.argvAuthority.binaryPolicy,
  )
  const intent = objectBytes({
    intentVersion: 1,
    scope: scopeBytes,
    processRef: MAX_OPAQUE_REF_JSON_BYTES,
    spawnNonce: MAX_OPAQUE_REF_JSON_BYTES,
    workspaceBinding: workspaceBytes,
    binaryBinding: binaryBytes,
    argvDigest: SHA256_DIGEST_JSON_BYTES,
    argvCount: safeDurableJsonByteLength(
      expected.binding.launchSpec.argvAuthority.argv.length,
    ),
    environmentPolicyDigest: SHA256_DIGEST_JSON_BYTES,
    relayScopeDigest: SHA256_DIGEST_JSON_BYTES,
  })
  const attestation = objectBytes({
    attestationVersion: 1,
    authorityId: textBytes(1024),
    bootId: safeDurableJsonByteLength(expected.ownerBootId),
    processRef: MAX_OPAQUE_REF_JSON_BYTES,
    scope: scopeBytes,
    workspaceBinding: workspaceBytes,
    spawnNonceDigest: SHA256_DIGEST_JSON_BYTES,
    channelRef: MAX_OPAQUE_REF_JSON_BYTES,
    owningProcessIdentityRef: MAX_OPAQUE_REF_JSON_BYTES,
    anchorIdentityRef: MAX_OPAQUE_REF_JSON_BYTES,
  })
  const ownership = objectBytes({
    recordVersion: 1,
    processRef: MAX_OPAQUE_REF_JSON_BYTES,
    scope: scopeBytes,
    workspaceBinding: workspaceBytes,
    spawnNonceDigest: SHA256_DIGEST_JSON_BYTES,
    controllerInstanceId: safeDurableJsonByteLength(expected.ownerControllerInstanceId),
    ownerAttestation: attestation,
    mainProcessIdentityRef: MAX_OPAQUE_REF_JSON_BYTES,
    lastStatusSequence: MAX_SAFE_INTEGER_JSON_BYTES,
  })
  return objectBytes({
    stateVersion: 1,
    revision: MAX_SAFE_INTEGER_JSON_BYTES,
    phase: safeDurableJsonByteLength('unclassified_residual'),
    intent,
    ownership,
    terminalReason: textBytes(4096),
  })
}

/** Maximum retained terminal row plus tombstone representation for this immutable attempt. */
export function durableAttemptSettlementEnvelopeBytes(attempt: Pick<
  DurableAttempt,
  'key' | 'fence' | 'expected'
>): number {
  const expected = safeDurableJsonByteLength(attempt.expected)
  const fence = safeDurableJsonByteLength(attempt.fence)
  const key = safeDurableJsonByteLength(attempt.key)
  const scope = safeDurableJsonByteLength(expectedAttemptScope(attempt.expected))
  const drainProof = drainProofMaxBytes()
  const noEffectProof = noEffectProofMaxBytes(attempt.expected)
  const completion = cleanupCompletionMaxBytes(attempt.fence)
  const cleanupFailure = objectBytes({
    operation: Math.max(
      safeDurableJsonByteLength('stopOwnedNativeProcess'),
      safeDurableJsonByteLength('reconcileFailedAttempt'),
    ),
    reason: textBytes(4096),
  })
  const base = {
    key,
    kind: safeDurableJsonByteLength('native'),
    phase: safeDurableJsonByteLength('anchor-terminal-pending'),
    fence,
    expected,
  }
  const common = {
    uncertainEvidence: arrayBytes(
      TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY,
      TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    ),
    cleanupFailures: arrayBytes(TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY, cleanupFailure),
    processOwnership: processOwnershipMaxBytes(attempt.expected),
  }
  const drainedRow = objectBytes({
    ...base,
    identity: TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    readinessProof: TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    ...common,
    anchorTerminalEvidence: drainProof,
    cleanupSettlement: Math.max(
      safeDurableJsonByteLength({ status: 'pending' }),
      objectBytes({ status: safeDurableJsonByteLength('completed'), completion }),
    ),
  })
  const noEffectRow = objectBytes({
    ...base,
    ...common,
    terminalEvidence: noEffectProof,
  })
  const drainedTombstone = objectBytes({
    key,
    fence,
    expected,
    scope,
    processRef: MAX_OPAQUE_REF_JSON_BYTES,
    terminalPhase: safeDurableJsonByteLength('drained'),
    terminalEvidence: drainProof,
    cleanupCompletion: completion,
  })
  const noEffectTombstone = objectBytes({
    key,
    fence,
    expected,
    scope,
    terminalPhase: safeDurableJsonByteLength('noeffect'),
    terminalEvidence: noEffectProof,
  })
  return Math.max(drainedRow + drainedTombstone, noEffectRow + noEffectTombstone)
}

export function durableAttemptReservationBytes(attempt: DurableAttempt): number {
  const remaining = durableAttemptSettlementEnvelopeBytes(attempt) -
    safeDurableJsonByteLength(attempt) + 1
  if (remaining < 0) throw new Error('Team lifecycle attempt exceeds settlement envelope')
  return remaining
}

export function assertDurableAttemptAdmissionBounds(
  expected: NativeAcquisitionPreparedExpectation,
): void {
  if (bareIdentityMaxBytes(expected) > TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES) {
    throw new Error('Native expectation cannot support bounded acquired identity')
  }
}

export function assertDrainProofCapacity(proof: unknown): void {
  if (safeDurableJsonByteLength(proof) > drainProofMaxBytes()) {
    throw new Error('Team lifecycle native terminal evidence exceeds derived capacity')
  }
}

export function assertNoEffectProofCapacity(
  proof: unknown,
  expected: NativeAcquisitionPreparedExpectation,
): void {
  if (safeDurableJsonByteLength(proof) > noEffectProofMaxBytes(expected)) {
    throw new Error('Team lifecycle native no-effect evidence exceeds derived capacity')
  }
}

export function assertCleanupCompletionCapacity(
  completion: unknown,
  fence: AttemptFence,
): void {
  if (safeDurableJsonByteLength(completion) > cleanupCompletionMaxBytes(fence)) {
    throw new Error('Team lifecycle native cleanup completion exceeds derived capacity')
  }
}

export function expectedAttemptScope(
  expected: NativeAcquisitionPreparedExpectation,
): ProcessOwnershipScope {
  return cloneJson({
    planRef: expected.binding.launchSpec.planRef,
    executionUnitId: expected.binding.executionUnit.executionUnitId,
  })
}

export function identitiesMatchEffect(
  left: OwnedNativeProcessIdentity,
  right: OwnedNativeProcessIdentity,
): boolean {
  return left.processRef === right.processRef &&
    isDeepStrictEqual(baseIdentity(left), baseIdentity(right))
}

/**
 * Product exposes the same opaque process lookup key through two separately branded ports.
 * Re-parse at that boundary before comparing so persisted Product ownership and A's supervisor
 * identity are joined without erasing either public brand.
 */
export function ownedProcessRefsEqual(left: unknown, right: unknown): boolean {
  return parseOwnedProcessRef(left) === parseOwnedProcessRef(right)
}

export function drainEvidenceSemanticallyEqual(
  left: NativeAcquisitionDrainProof,
  right: NativeAcquisitionDrainProof,
): boolean {
  return identitiesMatchEffect(left.identity, right.identity) &&
    terminalStatus(left.adapterResult.status) &&
    terminalStatus(right.adapterResult.status)
}

function migrateLegacy(source: Record<string, unknown>): DurableStateV5 {
  const version = source.schemaVersion as 2 | 3 | 4
  keys(source, [
    'schemaVersion', 'revision', 'planFingerprint', 'toolApprovalMode', 'phase', 'runId',
    'recoverable', ...(version === 2 ? [] : ['ownerIncarnation']),
    ...(version === 4 ? ['recoveryBindings'] : []),
  ])
  validateBase({
    ...source,
    ownerIncarnation: version === 2 ? null : source.ownerIncarnation,
    recoveryBindings: version === 4 ? source.recoveryBindings : {},
  })
  const bindings = version === 4 ? recoveryBindings(source.recoveryBindings) : {}
  const active = source.phase !== 'idle'
  return {
    schemaVersion: 5,
    revision: source.revision as number,
    planFingerprint: source.planFingerprint as string,
    toolApprovalMode: source.toolApprovalMode as TeamLifecycleLaunchPlan['toolApprovalMode'],
    phase: source.phase as DurableStateV5['phase'],
    runId: source.runId as string | null,
    recoverable: source.recoverable as boolean,
    ownerIncarnation: version === 2 ? null : source.ownerIncarnation as string | null,
    recoveryBindings: bindings,
    operationEpoch: 0,
    attempts: {},
    tombstones: [],
    disposition: active ? { kind: 'legacy-unresolved', sourceSchemaVersion: version } : null,
    legacyUnresolved: active ? {
      schemaVersion: version,
      runId: source.runId as string,
      phase: source.phase as Exclude<DurableStateV5['phase'], 'idle'>,
      recoveryBindings: bindings,
    } : null,
  }
}

function decodeAttempt(key: string, value: unknown): DurableAttempt {
  text(key, 'attempt key', 4096)
  const source = object(value, 'attempt')
  optionalKeys(source, ['key', 'kind', 'phase', 'fence', 'expected'], [
    'identity', 'readinessProof', 'uncertainEvidence', 'anchorTerminalEvidence',
    'cleanupSettlement', 'cleanupFailures', 'terminalEvidence', 'processOwnership',
  ])
  if (
    source.key !== key ||
    source.kind !== 'native' ||
    typeof source.phase !== 'string' ||
    ![
      'armed', 'acquired', 'ready', 'uncertain', 'anchor-terminal-pending',
      'drained', 'noeffect',
    ].includes(source.phase)
  ) throw new Error('Invalid team lifecycle attempt')
  const fence = decodeFence(source.fence)
  const expected = decodeExpectation(source.expected)
  if (
    fence.key !== key ||
    fence.runId !== expected.runId ||
    fence.ownerPlanGeneration !== expected.ownerPlanGeneration ||
    fence.controllerInstanceId !== expected.ownerControllerInstanceId ||
    key !== createAttemptKey({
      ownerPlanGeneration: expected.ownerPlanGeneration,
      runId: expected.runId,
      originalLaneId: expected.laneId,
      globalOrdinal: expected.memberOrdinal,
      attemptOrdinal: fence.attemptOrdinal,
    })
  ) throw new Error('Attempt expectation does not match canonical fence')
  const attempt: DurableAttempt = {
    key,
    kind: 'native',
    phase: source.phase as AttemptPhase,
    fence,
    expected,
  }
  if (source.identity !== undefined) attempt.identity = decodeIdentity(source.identity, expected)
  if (source.readinessProof !== undefined) {
    attempt.readinessProof = decodeReadiness(source.readinessProof, expected)
  }
  if (source.uncertainEvidence !== undefined) {
    if (
      !Array.isArray(source.uncertainEvidence) ||
      source.uncertainEvidence.length > TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY
    ) throw new Error('Invalid native uncertainty evidence')
    attempt.uncertainEvidence = source.uncertainEvidence.map(item =>
      decodeUncertainty(item, expected))
  }
  if (source.anchorTerminalEvidence !== undefined) {
    attempt.anchorTerminalEvidence = decodeDrainProof(source.anchorTerminalEvidence, expected)
  }
  if (source.cleanupSettlement !== undefined) {
    attempt.cleanupSettlement = decodeCleanupSettlement(
      source.cleanupSettlement,
      expected,
      fence,
    )
  }
  if (source.cleanupFailures !== undefined) {
    if (
      !Array.isArray(source.cleanupFailures) ||
      source.cleanupFailures.length > TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY
    ) throw new Error('Invalid native cleanup failures')
    attempt.cleanupFailures = source.cleanupFailures.map(decodeCleanupFailure)
  }
  if (source.terminalEvidence !== undefined) {
    attempt.terminalEvidence = decodeNoEffect(source.terminalEvidence, expected)
  }
  if (source.processOwnership !== undefined) {
    attempt.processOwnership = decodeOwnership(source.processOwnership, expected, attempt.identity)
  }
  validatePhase(attempt)
  if (!terminal(attempt)) assertDurableAttemptAdmissionBounds(expected)
  return cloneJson(attempt)
}

function decodeFence(value: unknown): AttemptFence {
  const source = object(value, 'attempt fence')
  keys(source, [
    'key', 'runId', 'ownerIncarnation', 'controllerInstanceId',
    'ownerPlanGeneration', 'operationEpoch', 'attemptOrdinal',
  ])
  text(source.key, 'attempt key', 4096)
  text(source.runId, 'attempt run', 256)
  text(source.ownerIncarnation, 'attempt owner incarnation', 256)
  text(source.controllerInstanceId, 'attempt controller', 512)
  text(source.ownerPlanGeneration, 'attempt owner generation', 512)
  integer(source.operationEpoch, 'attempt operation epoch')
  integer(source.attemptOrdinal, 'attempt ordinal')
  return cloneJson(source) as AttemptFence
}

function decodeExpectation(value: unknown): NativeAcquisitionPreparedExpectation {
  const source = object(value, 'native expectation')
  keys(source, [
    'version', 'role', 'publicTeamId', 'legacyKey', 'runId', 'attemptSetId',
    'attemptToken', 'memberOrdinal', 'laneId', 'displayName', 'agentId', 'provider',
    'model', ...(source.effort === undefined ? [] : ['effort']), 'ownerBootId',
    'ownerControllerInstanceId', 'ownerPlanGeneration', 'productPlanGeneration',
    'productPlanRef', 'materialDigest', 'recipeDigest', 'profileDigest', 'binding',
  ])
  if (
    source.version !== 1 ||
    typeof source.role !== 'string' ||
    !['native-lead', 'native-worker'].includes(source.role) ||
    typeof source.provider !== 'string' ||
    !['anthropic', 'codex', 'gemini'].includes(source.provider)
  ) throw new Error('Invalid native expectation discriminator')
  for (const name of [
    'publicTeamId', 'legacyKey', 'runId', 'attemptSetId', 'attemptToken', 'laneId',
    'displayName', 'agentId', 'model', 'ownerBootId', 'ownerControllerInstanceId',
    'ownerPlanGeneration', 'productPlanRef', 'materialDigest', 'recipeDigest',
    'profileDigest',
  ] as const) text(source[name], `native expectation ${name}`, 4096)
  if (source.effort !== undefined) text(source.effort, 'native effort', 256)
  integer(source.memberOrdinal, 'native member ordinal')
  integer(source.productPlanGeneration, 'native Product generation')
  const binding = object(source.binding, 'native binding')
  keys(binding, [
    'ownerPlanGeneration', 'ownerUnitBindingId', 'orderedMembers',
    'executionUnit', 'launchSpec',
  ])
  if (binding.ownerPlanGeneration !== source.ownerPlanGeneration) {
    throw new Error('Native binding owner generation mismatch')
  }
  text(binding.ownerUnitBindingId, 'native unit binding id', 1024)
  if (!Array.isArray(binding.orderedMembers) || binding.orderedMembers.length !== 1) {
    throw new Error('Native binding must contain one ordered member')
  }
  const member = object(binding.orderedMembers[0], 'native ordered member')
  keys(member, ['ordinal', 'memberId'])
  integer(member.ordinal, 'native ordered member ordinal')
  text(member.memberId, 'native ordered member id', 1024)
  if (member.ordinal !== source.memberOrdinal || member.memberId !== source.agentId) {
    throw new Error('Native ordered member mapping mismatch')
  }
  decodeExecutionUnit(binding.executionUnit, source)
  decodeLaunchSpec(binding.launchSpec, source, binding.executionUnit)
  const launchSpec = object(binding.launchSpec, 'native launch spec')
  if (source.productPlanRef !== computeNativeProductPlanRefDigest(launchSpec.planRef)) {
    throw new Error('Native Product plan reference digest mismatch')
  }
  bounded(value, 'native expectation')
  return cloneJson(value) as NativeAcquisitionPreparedExpectation
}

function decodeExecutionUnit(value: unknown, expected: Record<string, unknown>): void {
  const unit = object(value, 'native execution unit')
  keys(unit, [
    'executionUnitId', 'backendBinding', 'laneId', 'memberIds', 'binaryPolicy',
    'environmentPolicy', 'credentialExposureSet', 'credentialIsolation',
    'resourcePolicy',
  ])
  text(unit.executionUnitId, 'execution unit id', 1024)
  text(unit.laneId, 'execution lane id', 256)
  if (
    unit.laneId !== expected.laneId ||
    !Array.isArray(unit.memberIds) ||
    unit.memberIds.length !== 1 ||
    unit.memberIds[0] !== expected.agentId
  ) throw new Error('Native execution unit member mapping mismatch')
  const backend = object(unit.backendBinding, 'runtime backend binding')
  keys(backend, ['backend', 'bindingId', 'bindingRevision'])
  if (backend.backend !== 'provisioning_cli') throw new Error('Invalid native backend')
  text(backend.bindingId, 'runtime backend binding id', 1024)
  integer(backend.bindingRevision, 'runtime backend revision')
  binary(unit.binaryPolicy)
  environment(unit.environmentPolicy)
  credentialExposure(unit.credentialExposureSet)
  if (unit.credentialIsolation !== 'dedicated_execution_unit') {
    throw new Error('Invalid native credential isolation')
  }
  resource(unit.resourcePolicy)
}

function decodeLaunchSpec(
  value: unknown,
  expected: Record<string, unknown>,
  executionUnit: unknown,
): void {
  const spec = object(value, 'native launch spec')
  keys(spec, [
    'planRef', 'executionUnitId', 'backend', 'argvAuthority', 'workdirAuthority',
    'environmentAuthority', 'resourcePolicy',
  ])
  const unit = object(executionUnit, 'native execution unit')
  if (spec.executionUnitId !== unit.executionUnitId || spec.backend !== 'provisioning_cli') {
    throw new Error('Native launch unit mismatch')
  }
  const plan = object(spec.planRef, 'native Product plan ref')
  keys(plan, ['teamId', 'runId', 'generation', 'planHash'])
  text(plan.teamId, 'Product team id', 1024)
  text(plan.runId, 'Product run id', 256)
  integer(plan.generation, 'Product plan generation')
  digest(plan.planHash, 'Product plan hash')
  if (
    plan.teamId !== expected.publicTeamId ||
    plan.runId !== expected.runId ||
    plan.generation !== expected.productPlanGeneration
  ) throw new Error('Native Product plan mapping mismatch')
  const argv = object(spec.argvAuthority, 'native argv authority')
  keys(argv, ['executableRef', 'binaryPolicy', 'argv', 'argvHash'])
  text(argv.executableRef, 'executable authority', 2048)
  binary(argv.binaryPolicy)
  digest(argv.argvHash, 'argv hash')
  if (
    !Array.isArray(argv.argv) ||
    argv.argv.length === 0 ||
    argv.argv.length > 256 ||
    argv.argv.some(item =>
      typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > 16 * 1024)
  ) throw new Error('Invalid native argv authority')
  const workdir = object(spec.workdirAuthority, 'native workdir authority')
  keys(workdir, ['workdirRef', 'grant'])
  text(workdir.workdirRef, 'workdir authority', 2048)
  workspaceGrant(workdir.grant)
  const env = object(spec.environmentAuthority, 'native environment authority')
  keys(env, ['environmentRef', 'policy'])
  text(env.environmentRef, 'environment authority', 2048)
  environment(env.policy)
  resource(spec.resourcePolicy)
  if (
    !isDeepStrictEqual(unit.binaryPolicy, argv.binaryPolicy) ||
    !isDeepStrictEqual(unit.environmentPolicy, env.policy) ||
    !isDeepStrictEqual(unit.resourcePolicy, spec.resourcePolicy)
  ) throw new Error('Native launch policy substitution')
}

function decodeIdentity(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
): OwnedNativeProcessIdentity {
  const source = object(value, 'native identity')
  keys(source, [
    ...Object.keys(expected), 'kind', 'processRef',
    ...(source.runtimeSessionId === undefined ? [] : ['runtimeSessionId']),
    ...(source.readiness === undefined ? [] : ['readiness']),
    ...(source.diagnostics === undefined ? [] : ['diagnostics']),
  ])
  if (
    source.kind !== 'hosted-anchor' ||
    !isDeepStrictEqual(baseIdentityRecord(source), expected)
  ) throw new Error('Native identity expectation substitution')
  parseOwnedProcessRef(source.processRef)
  if (source.runtimeSessionId !== undefined) {
    text(source.runtimeSessionId, 'native runtime session', 2048)
  }
  const readiness = source.readiness === undefined
    ? undefined
    : decodeReadiness(source.readiness, expected)
  if (readiness && source.runtimeSessionId === undefined) {
    throw new Error('Native ready identity has no runtime session')
  }
  if (
    readiness?.kind === 'hosted-native-ready-ack' &&
    source.runtimeSessionId !== readiness.acknowledgement.sessionId
  ) throw new Error('Native lead session substitution')
  if (
    readiness?.kind === 'hosted-worker-runtime' &&
    source.runtimeSessionId !== readiness.runtimeSessionId
  ) throw new Error('Native worker session substitution')
  if (source.diagnostics !== undefined) {
    const diagnostics = object(source.diagnostics, 'native diagnostics')
    keys(diagnostics, [
      'pid',
      ...(diagnostics.startedAtMs === undefined ? [] : ['startedAtMs']),
      ...(diagnostics.osIdentity === undefined ? [] : ['osIdentity']),
    ])
    positiveInteger(diagnostics.pid, 'native diagnostic pid')
    if (diagnostics.startedAtMs !== undefined) {
      positiveNumber(diagnostics.startedAtMs, 'native process start time')
    }
    if (diagnostics.osIdentity !== undefined) {
      text(diagnostics.osIdentity, 'native OS identity', 4096)
    }
    const proofPid = readiness?.kind === 'hosted-native-ready-ack'
      ? readiness.acknowledgement.pid
      : readiness?.diagnosticPid
    if (proofPid !== undefined && proofPid !== diagnostics.pid) {
      throw new Error('Native diagnostic pid substitution')
    }
  }
  bounded(value, 'native identity')
  return cloneJson(value) as OwnedNativeProcessIdentity
}

function decodeReadiness(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
): NativeProcessReadinessProof {
  const proof = object(value, 'native readiness proof')
  if (proof.kind === 'hosted-native-ready-ack') {
    keys(proof, ['kind', 'acknowledgement'])
    if (expected.role !== 'native-lead') throw new Error('Native readiness role mismatch')
    leadAck(proof.acknowledgement, expected)
  } else if (proof.kind === 'hosted-worker-runtime') {
    keys(proof, [
      'kind', 'runtimeReady', 'inboxPollerReady', 'bootstrapAccepted',
      'mailboxMessageId', 'runtimeSessionId', 'diagnosticPid',
    ])
    if (expected.role !== 'native-worker') throw new Error('Native readiness role mismatch')
    text(proof.mailboxMessageId, 'native mailbox message id', 4096)
    text(proof.runtimeSessionId, 'native worker session', 2048)
    positiveInteger(proof.diagnosticPid, 'native worker diagnostic pid')
    const runtime = runtimeEvent(proof.runtimeReady, 'runtime_ready', expected)
    const inbox = runtimeEvent(proof.inboxPollerReady, 'inbox_poller_ready', expected)
    const bootstrap = runtimeEvent(proof.bootstrapAccepted, 'bootstrap_submitted', expected)
    if (
      runtime.pid !== proof.diagnosticPid ||
      inbox.pid !== runtime.pid ||
      bootstrap.pid !== runtime.pid ||
      runtime.runId !== proof.runtimeSessionId ||
      inbox.runId !== proof.runtimeSessionId ||
      bootstrap.runId !== proof.runtimeSessionId ||
      runtime.bootstrapRunId !== inbox.bootstrapRunId ||
      runtime.bootstrapRunId !== bootstrap.bootstrapRunId ||
      (
        bootstrap.bootstrapMirrorId !== proof.mailboxMessageId &&
        bootstrap.bootstrapMessageId !== proof.mailboxMessageId &&
        typeof bootstrap.bootstrapProofToken !== 'string'
      )
    ) throw new Error('Native worker readiness events do not join')
  } else throw new Error('Invalid native readiness proof')
  bounded(value, 'native readiness proof')
  return cloneJson(value) as NativeProcessReadinessProof
}

function leadAck(value: unknown, expected: NativeAcquisitionPreparedExpectation): void {
  const ack = object(value, 'native ready acknowledgement')
  keys(ack, [
    'version', 'state', 'role', 'publicTeamId', 'legacyKey', 'runId',
    'primaryAgentId', 'primaryDisplayName', 'primaryAlias', 'sessionId', 'pid',
    'processStartedAtMs', 'processOsIdentity', 'launchIdentityToken',
    'envelopeDigest', 'materialDigest', 'profileDigest', 'settingsDigest',
    'mcpDigest', 'permissionMode', 'canonicalDataRoot', 'canonicalTeamRoot',
    'canonicalTasksRoot', 'canonicalCwd', 'mailboxCustody', 'acknowledgedAt',
  ])
  if (
    ack.version !== 1 ||
    ack.state !== 'ready' ||
    ack.role !== 'native-lead' ||
    ack.publicTeamId !== expected.publicTeamId ||
    ack.legacyKey !== expected.legacyKey ||
    ack.runId !== expected.runId ||
    ack.primaryAgentId !== expected.agentId ||
    ack.primaryDisplayName !== expected.displayName ||
    ack.primaryAlias !== 'team-lead' ||
    ack.launchIdentityToken !== expected.attemptToken ||
    ack.materialDigest !== expected.materialDigest ||
    ack.profileDigest !== expected.profileDigest ||
    ack.permissionMode !== 'bypassPermissions' ||
    ack.mailboxCustody !== 'hosted-lead-pump'
  ) throw new Error('Native lead acknowledgement substitution')
  for (const name of [
    'sessionId', 'processOsIdentity', 'envelopeDigest', 'settingsDigest',
    'mcpDigest', 'canonicalDataRoot', 'canonicalTeamRoot',
    'canonicalTasksRoot', 'canonicalCwd', 'acknowledgedAt',
  ] as const) text(ack[name], `native acknowledgement ${name}`, 8192)
  positiveInteger(ack.pid, 'native acknowledgement pid')
  positiveNumber(ack.processStartedAtMs, 'native acknowledgement start time')
  date(ack.acknowledgedAt, 'native acknowledgement time')
}

function runtimeEvent(
  value: unknown,
  type: string,
  expected: NativeAcquisitionPreparedExpectation,
): Record<string, unknown> {
  const event = object(value, 'native runtime event')
  optionalKeys(event, ['version', 'type', 'timestamp', 'pid'], [
    'teamName', 'agentName', 'agentId', 'runId', 'bootstrapRunId', 'cwd',
    'source', 'bootstrapProofToken', 'contextHash', 'briefingHash',
    'bootstrapMessageId', 'bootstrapMirrorId', 'retryable', 'attempt', 'detail',
  ])
  if (
    event.version !== 1 ||
    event.type !== type ||
    event.teamName !== expected.legacyKey ||
    event.agentName !== expected.displayName ||
    event.agentId !== expected.agentId
  ) throw new Error('Native runtime event substitution')
  date(event.timestamp, 'native runtime event time')
  positiveInteger(event.pid, 'native runtime event pid')
  text(event.runId, 'native runtime session', 2048)
  text(event.bootstrapRunId, 'native bootstrap run', 2048)
  for (const name of [
    'cwd', 'source', 'bootstrapProofToken', 'contextHash', 'briefingHash',
    'bootstrapMessageId', 'bootstrapMirrorId', 'detail',
  ] as const) {
    if (event[name] !== undefined) text(event[name], `native runtime event ${name}`, 16 * 1024)
  }
  if (event.retryable !== undefined && typeof event.retryable !== 'boolean') {
    throw new Error('Invalid native runtime retry flag')
  }
  if (event.attempt !== undefined) integer(event.attempt, 'native runtime attempt')
  return event
}

function decodeDrainProof(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
): NativeAcquisitionDrainProof {
  const proof = object(value, 'native drain proof')
  keys(proof, ['kind', 'identity', 'adapterResult', 'observedAt'])
  if (proof.kind !== 'exact-anchor-terminal') throw new Error('Invalid native drain proof')
  decodeIdentity(proof.identity, expected)
  const result = object(proof.adapterResult, 'native terminal result')
  keys(result, ['status'])
  if (!terminalStatus(result.status)) throw new Error('Invalid native terminal result')
  text(proof.observedAt, 'native terminal observation', 256)
  assertDrainProofCapacity(value)
  return cloneJson(value) as NativeAcquisitionDrainProof
}

function decodeNoEffect(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
): NativeAcquisitionNoEffectProof {
  const proof = object(value, 'native no-effect proof')
  keys(proof, [
    'kind', 'expected', 'startWasNeverCalled', 'claimSettled', 'observedAt', 'reason',
  ])
  if (
    proof.kind !== 'pre-start-failure' ||
    proof.startWasNeverCalled !== true ||
    proof.claimSettled !== true ||
    !isDeepStrictEqual(decodeExpectation(proof.expected), expected)
  ) throw new Error('Invalid native no-effect proof')
  text(proof.observedAt, 'native no-effect observation', 256)
  text(proof.reason, 'native no-effect reason', 4096)
  assertNoEffectProofCapacity(value, expected)
  return cloneJson(value) as NativeAcquisitionNoEffectProof
}

function decodeCleanupSettlement(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
  fence: AttemptFence,
): DurableAttempt['cleanupSettlement'] {
  const settlement = object(value, 'native cleanup settlement')
  if (settlement.status === 'pending') {
    keys(settlement, ['status'])
  } else if (settlement.status === 'completed') {
    keys(settlement, ['status', 'completion'])
    decodeCleanupCompletion(settlement.completion, expected, fence)
  } else throw new Error('Invalid native cleanup settlement')
  return cloneJson(value) as DurableAttempt['cleanupSettlement']
}

function decodeCleanupCompletion(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
  fence: AttemptFence,
): NativeCleanupCompletion {
  const completion = object(value, 'native cleanup completion')
  keys(completion, ['fence', 'identity', 'operation', 'result'])
  if (
    !isDeepStrictEqual(decodeFence(completion.fence), fence) ||
    typeof completion.operation !== 'string' ||
    !['stopOwnedNativeProcess', 'reconcileFailedAttempt'].includes(
      completion.operation,
    )
  ) throw new Error('Invalid native cleanup completion binding')
  decodeIdentity(completion.identity, expected)
  const result = object(completion.result, 'native cleanup result')
  keys(result, ['status'])
  if (!terminalStatus(result.status)) throw new Error('Invalid native cleanup result')
  assertCleanupCompletionCapacity(value, fence)
  return cloneJson(value) as NativeCleanupCompletion
}

function decodeCleanupFailure(value: unknown): NativeCleanupFailure {
  const failure = object(value, 'native cleanup failure')
  keys(failure, ['operation', 'reason'])
  if (
    typeof failure.operation !== 'string' ||
    !['stopOwnedNativeProcess', 'reconcileFailedAttempt'].includes(failure.operation)
  ) {
    throw new Error('Invalid native cleanup operation')
  }
  text(failure.reason, 'native cleanup failure reason', 4096)
  return cloneJson(value) as NativeCleanupFailure
}

function decodeUncertainty(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
): DurableNativeUncertainEvidence {
  const evidence = object(value, 'native uncertainty evidence')
  keys(evidence, ['attempt', 'phase', 'adapterResult'])
  text(evidence.phase, 'native uncertainty phase', 512)
  const attempt = object(evidence.attempt, 'native failed attempt')
  keys(attempt, [
    'version', 'kind', 'expected',
    ...(attempt.processRef === undefined ? [] : ['processRef']),
    'startResult',
  ])
  if (
    attempt.version !== 1 ||
    typeof attempt.kind !== 'string' ||
    !['known-anchor-ref', 'uncertain-start-without-ref'].includes(attempt.kind) ||
    !isDeepStrictEqual(decodeExpectation(attempt.expected), expected)
  ) throw new Error('Invalid native failed attempt')
  if (attempt.processRef !== undefined) {
    parseOwnedProcessRef(attempt.processRef)
  }
  adapterResult(attempt.startResult, 'native start result')
  adapterResult(evidence.adapterResult, 'native adapter result')
  bounded(value, 'native uncertainty evidence')
  return cloneJson(value) as DurableNativeUncertainEvidence
}

function decodeOwnership(
  value: unknown,
  expected: NativeAcquisitionPreparedExpectation,
  identity?: OwnedNativeProcessIdentity,
): ProcessOwnershipState {
  const state = object(value, 'process ownership')
  if (
    state.stateVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0 ||
    typeof state.phase !== 'string' ||
    ![
      'spawn_intent', 'owned', 'stopping', 'drained', 'unclassified_residual',
    ].includes(state.phase)
  ) throw new Error('Invalid process ownership state')
  const base = ['stateVersion', 'revision', 'phase', 'intent']
  if (state.phase === 'spawn_intent') keys(state, base)
  else if (state.phase === 'owned' || state.phase === 'stopping') {
    keys(state, [...base, 'ownership'])
  } else if (state.phase === 'drained') {
    keys(state, [...base, 'ownership', 'terminalReason'])
  } else {
    keys(state, [
      ...base,
      ...(state.ownership === undefined ? [] : ['ownership']),
      'terminalReason',
    ])
  }
  const intent = object(state.intent, 'spawn intent')
  keys(intent, [
    'intentVersion', 'scope', 'processRef', 'spawnNonce', 'workspaceBinding',
    'binaryBinding', 'argvDigest', 'argvCount', 'environmentPolicyDigest',
    'relayScopeDigest',
  ])
  if (intent.intentVersion !== 1) throw new Error('Invalid spawn intent version')
  scope(intent.scope)
  parseOwnedProcessRef(intent.processRef)
  parseSpawnNonce(intent.spawnNonce)
  workspaceBinding(intent.workspaceBinding)
  binary(intent.binaryBinding)
  digest(intent.argvDigest, 'spawn argv digest')
  integer(intent.argvCount, 'spawn argv count')
  digest(intent.environmentPolicyDigest, 'spawn environment digest')
  digest(intent.relayScopeDigest, 'spawn relay digest')
  const spec = expected.binding.launchSpec
  if (
    !isDeepStrictEqual(intent.scope, expectedAttemptScope(expected)) ||
    !isDeepStrictEqual(intent.workspaceBinding, expectedWorkspace(expected)) ||
    !isDeepStrictEqual(intent.binaryBinding, spec.argvAuthority.binaryPolicy) ||
    intent.argvDigest !== spec.argvAuthority.argvHash ||
    intent.argvCount !== spec.argvAuthority.argv.length ||
    intent.environmentPolicyDigest !==
      computeCanonicalPolicyDigest(expected.binding.executionUnit.environmentPolicy) ||
    intent.relayScopeDigest !== computeCanonicalPolicyDigest({
      laneId: expected.binding.executionUnit.laneId,
      memberIds: expected.binding.executionUnit.memberIds,
    }) ||
    (identity && !ownedProcessRefsEqual(intent.processRef, identity.processRef))
  ) throw new Error('Process intent does not join admitted attempt')
  if (state.ownership !== undefined) {
    ownershipRecord(state.ownership, intent, expected)
  }
  if (state.terminalReason !== undefined) {
    text(state.terminalReason, 'process terminal reason', 4096)
  }
  return cloneJson(value) as ProcessOwnershipState
}

function ownershipRecord(
  value: unknown,
  intent: Record<string, unknown>,
  expected: NativeAcquisitionPreparedExpectation,
): void {
  const ownership = object(value, 'ownership record')
  keys(ownership, [
    'recordVersion', 'processRef', 'scope', 'workspaceBinding', 'spawnNonceDigest',
    'controllerInstanceId', 'ownerAttestation', 'mainProcessIdentityRef',
    'lastStatusSequence',
  ])
  if (
    ownership.recordVersion !== 1 ||
    ownership.processRef !== intent.processRef ||
    !isDeepStrictEqual(ownership.scope, intent.scope) ||
    !isDeepStrictEqual(ownership.workspaceBinding, intent.workspaceBinding) ||
    ownership.controllerInstanceId !== expected.ownerControllerInstanceId
  ) throw new Error('Process ownership record substitution')
  digest(ownership.spawnNonceDigest, 'ownership spawn nonce digest')
  if (ownership.spawnNonceDigest !== spawnNonceDigest(intent.spawnNonce as SpawnNonce)) {
    throw new Error('Ownership nonce digest mismatch')
  }
  parseMainProcessIdentityRef(ownership.mainProcessIdentityRef)
  positiveInteger(ownership.lastStatusSequence, 'ownership status sequence')
  const attestation = object(ownership.ownerAttestation, 'owner attestation')
  keys(attestation, [
    'attestationVersion', 'authorityId', 'bootId', 'processRef', 'scope',
    'workspaceBinding', 'spawnNonceDigest', 'channelRef',
    'owningProcessIdentityRef', 'anchorIdentityRef',
  ])
  if (
    attestation.attestationVersion !== 1 ||
    attestation.bootId !== expected.ownerBootId ||
    attestation.processRef !== ownership.processRef ||
    !isDeepStrictEqual(attestation.scope, ownership.scope) ||
    !isDeepStrictEqual(attestation.workspaceBinding, ownership.workspaceBinding) ||
    attestation.spawnNonceDigest !== ownership.spawnNonceDigest
  ) throw new Error('Process owner attestation substitution')
  text(attestation.authorityId, 'owner attestation authorityId', 1024)
  parseAnchorChannelRef(attestation.channelRef)
  parseOwningProcessIdentityRef(attestation.owningProcessIdentityRef)
  parseAnchorIdentityRef(attestation.anchorIdentityRef)
}

function decodeTombstone(value: unknown): DurableAttemptTombstone {
  const source = object(value, 'attempt tombstone')
  optionalKeys(source, [
    'key', 'fence', 'expected', 'scope', 'terminalPhase', 'terminalEvidence',
  ], ['processRef', 'cleanupCompletion'])
  text(source.key, 'tombstone key', 4096)
  const fence = decodeFence(source.fence)
  const expected = decodeExpectation(source.expected)
  if (
    source.key !== fence.key ||
    fence.runId !== expected.runId ||
    fence.ownerPlanGeneration !== expected.ownerPlanGeneration ||
    fence.controllerInstanceId !== expected.ownerControllerInstanceId ||
    fence.key !== createAttemptKey({
      ownerPlanGeneration: expected.ownerPlanGeneration,
      runId: expected.runId,
      originalLaneId: expected.laneId,
      globalOrdinal: expected.memberOrdinal,
      attemptOrdinal: fence.attemptOrdinal,
    }) ||
    !isDeepStrictEqual(scope(source.scope), expectedAttemptScope(expected))
  ) throw new Error('Invalid native tombstone mapping')
  if (source.terminalPhase === 'drained') {
    const proof = decodeDrainProof(source.terminalEvidence, expected)
    const completion = decodeCleanupCompletion(source.cleanupCompletion, expected, fence)
    if (
      source.processRef !== proof.identity.processRef ||
      !identitiesMatchEffect(proof.identity, completion.identity)
    ) throw new Error('Native drained tombstone identity mismatch')
  } else if (source.terminalPhase === 'noeffect') {
    if (source.processRef !== undefined || source.cleanupCompletion !== undefined) {
      throw new Error('Invalid native no-effect tombstone')
    }
    decodeNoEffect(source.terminalEvidence, expected)
  } else throw new Error('Invalid native tombstone phase')
  return cloneJson(value) as DurableAttemptTombstone
}

function validatePhase(attempt: DurableAttempt): void {
  const identity = attempt.identity !== undefined
  const ready = attempt.readinessProof !== undefined
  const anchor = attempt.anchorTerminalEvidence !== undefined
  const completion = attempt.cleanupSettlement?.status === 'completed'
    ? attempt.cleanupSettlement.completion
    : undefined
  if (
    (attempt.terminalEvidence !== undefined && attempt.phase !== 'noeffect') ||
    (completion !== undefined && attempt.phase !== 'drained') ||
    (attempt.cleanupSettlement?.status === 'pending' &&
      attempt.phase !== 'anchor-terminal-pending') ||
    (anchor && !['anchor-terminal-pending', 'drained'].includes(attempt.phase))
  ) throw new Error('Native optional phase evidence mismatch')
  if (
    ready &&
    (!identity || !isDeepStrictEqual(attempt.identity?.readiness, attempt.readinessProof))
  ) throw new Error('Native readiness is not bound to identity')
  if (attempt.phase === 'armed' && (identity || ready || anchor || attempt.terminalEvidence)) {
    throw new Error('Armed attempt has effect evidence')
  }
  if (attempt.phase === 'acquired' && (!identity || ready || anchor || attempt.terminalEvidence)) {
    throw new Error('Invalid acquired attempt evidence')
  }
  if (attempt.phase === 'acquired' && !productMayBeStopping(attempt.processOwnership)) {
    throw new Error('Native acquired attempt lacks compatible exact Product ownership')
  }
  if (attempt.phase === 'ready' && (!identity || !ready || anchor || attempt.terminalEvidence)) {
    throw new Error('Invalid ready attempt evidence')
  }
  if (attempt.phase === 'ready' && !productMayBeStopping(attempt.processOwnership)) {
    throw new Error('Native ready attempt lacks compatible exact Product ownership')
  }
  if (attempt.phase === 'uncertain' && (!attempt.uncertainEvidence?.length || anchor || attempt.terminalEvidence)) {
    throw new Error('Invalid uncertain attempt evidence')
  }
  if (
    attempt.phase === 'anchor-terminal-pending' &&
    (!anchor || attempt.cleanupSettlement?.status !== 'pending' || attempt.terminalEvidence)
  ) throw new Error('Invalid pending native terminal evidence')
  if (attempt.phase === 'drained' && (!anchor || !completion || attempt.terminalEvidence)) {
    throw new Error('Invalid drained native terminal evidence')
  }
  if (
    attempt.phase === 'noeffect' &&
    (!attempt.terminalEvidence || identity || ready || anchor || attempt.cleanupSettlement)
  ) throw new Error('Invalid native no-effect evidence')
  if (anchor) {
    if (
      attempt.processOwnership?.phase !== 'drained' ||
      !ownedProcessRefsEqual(
        attempt.processOwnership.intent.processRef,
        attempt.anchorTerminalEvidence?.identity.processRef,
      )
    ) throw new Error('Native terminal evidence lacks exact Product drained join')
    if (
      identity &&
      !identitiesMatchEffect(attempt.identity!, attempt.anchorTerminalEvidence!.identity)
    ) throw new Error('Native terminal identity substitution')
  }
  if (
    completion &&
    !identitiesMatchEffect(
      attempt.anchorTerminalEvidence!.identity,
      completion.identity,
    )
  ) throw new Error('Native cleanup completion identity substitution')
  const knownRef = attempt.identity?.processRef ?? attempt.processOwnership?.intent.processRef
  for (const evidence of attempt.uncertainEvidence ?? []) {
    const uncertaintyRef = evidence.attempt.processRef
    if (uncertaintyRef !== undefined &&
      (knownRef === undefined || !ownedProcessRefsEqual(uncertaintyRef, knownRef))) {
      throw new Error('Native uncertainty process reference substitution')
    }
  }
}

/**
 * Product publishes its stop state before accepted A invokes B's recorder.  Consequently an
 * acquired/ready B row can legitimately be observed with any post-owned Product phase while the
 * stop call is between Product CAS and recordUncertain/recordDrained.  Spawn intent is excluded:
 * A cannot publish acquired until Product has first committed ownership.
 */
function productMayBeStopping(ownership: ProcessOwnershipState | undefined): boolean {
  return ownership !== undefined && 'ownership' in ownership && ownership.ownership !== undefined && [
    'owned',
    'stopping',
    'drained',
    'unclassified_residual',
  ].includes(ownership.phase)
}

function validateLedger(state: DurableStateV5): void {
  const scopes: Array<{ key: string; value: unknown }> = []
  const refs: Array<{ key: string; value: string }> = []
  const sessions: Array<{ key: string; value: string }> = []
  for (const attempt of Object.values(state.attempts)) {
    scopes.push({ key: attempt.key, value: expectedAttemptScope(attempt.expected) })
    const ref = attempt.identity?.processRef ?? attempt.processOwnership?.intent.processRef
    if (ref) refs.push({ key: attempt.key, value: String(ref) })
    for (const evidence of attempt.uncertainEvidence ?? []) {
      if (evidence.attempt.processRef) {
        refs.push({ key: attempt.key, value: String(evidence.attempt.processRef) })
      }
    }
    if (attempt.identity?.runtimeSessionId) {
      sessions.push({ key: attempt.key, value: attempt.identity.runtimeSessionId })
    }
  }
  const tombstoneKeys = new Set<string>()
  for (const tombstone of state.tombstones) {
    if (tombstoneKeys.has(tombstone.key)) throw new Error('Duplicate native tombstone key')
    tombstoneKeys.add(tombstone.key)
    const attempt = state.attempts[tombstone.key]
    if (attempt) {
      if (
        attempt.phase !== tombstone.terminalPhase ||
        !isDeepStrictEqual(attempt.fence, tombstone.fence) ||
        !isDeepStrictEqual(attempt.expected, tombstone.expected)
      ) throw new Error('Attempt/tombstone terminal mismatch')
      if (
        attempt.phase === 'drained' &&
        (
          !drainEvidenceSemanticallyEqual(
            attempt.anchorTerminalEvidence!,
            tombstone.terminalEvidence as NativeAcquisitionDrainProof,
          ) ||
          !isDeepStrictEqual(
            attempt.cleanupSettlement?.status === 'completed'
              ? attempt.cleanupSettlement.completion
              : undefined,
            tombstone.cleanupCompletion,
          )
        )
      ) throw new Error('Attempt/tombstone drain evidence mismatch')
      if (
        attempt.phase === 'noeffect' &&
        !isDeepStrictEqual(attempt.terminalEvidence, tombstone.terminalEvidence)
      ) throw new Error('Attempt/tombstone no-effect evidence mismatch')
    }
    scopes.push({ key: tombstone.key, value: tombstone.scope })
    if (tombstone.processRef) refs.push({ key: tombstone.key, value: tombstone.processRef })
    if (
      tombstone.terminalPhase === 'drained' &&
      (tombstone.terminalEvidence as NativeAcquisitionDrainProof).identity.runtimeSessionId
    ) {
      sessions.push({
        key: tombstone.key,
        value: (tombstone.terminalEvidence as NativeAcquisitionDrainProof)
          .identity.runtimeSessionId!,
      })
    }
  }
  for (const attempt of Object.values(state.attempts)) {
    if (terminal(attempt) && !tombstoneKeys.has(attempt.key)) {
      throw new Error('Terminal native attempt has no matching tombstone')
    }
  }
  noDuplicates(scopes, isDeepStrictEqual, 'scope')
  noDuplicates(refs, (left, right) => left === right, 'process reference')
  noDuplicates(sessions, (left, right) => left === right, 'runtime session')
  if (state.phase === 'idle') assertIdleCustody(state)
  assertDurableStateCapacity(state)
}

function noDuplicates<T>(
  values: readonly { key: string; value: T }[],
  equal: (left: T, right: T) => boolean,
  label: string,
): void {
  for (let index = 0; index < values.length; index += 1) {
    for (let other = index + 1; other < values.length; other += 1) {
      if (
        values[index]!.key !== values[other]!.key &&
        equal(values[index]!.value, values[other]!.value)
      ) throw new Error(`Duplicate native ${label}`)
    }
  }
}

function decodeDisposition(value: unknown): unknown | null {
  if (value === null) return null
  const source = object(value, 'disposition')
  if (source.kind === 'legacy-unresolved') {
    keys(source, ['kind', 'sourceSchemaVersion'])
    if (![2, 3, 4].includes(source.sourceSchemaVersion as number)) {
      throw new Error('Invalid legacy disposition')
    }
  } else if (source.kind === 'native-controller-replacement-required') {
    keys(source, ['kind', 'runId', 'reason'])
    if (
      !(source.runId === null || typeof source.runId === 'string') ||
      source.reason !== 'boot-local-native-channels-are-not-adoptable'
    ) throw new Error('Invalid native replacement disposition')
  } else {
    keys(source, [
      'runId', 'operationEpoch', 'status', 'reason',
      ...(source.evidence === undefined ? [] : ['evidence']),
    ])
    text(source.runId, 'disposition run', 256)
    integer(source.operationEpoch, 'disposition epoch')
    if (
      typeof source.status !== 'string' ||
      !['pending', 'delivered', 'retired'].includes(source.status)
    ) {
      throw new Error('Invalid lifecycle disposition status')
    }
    text(source.reason, 'disposition reason', 4096)
    if (source.evidence !== undefined) bounded(source.evidence, 'disposition evidence')
  }
  return cloneJson(value)
}

function decodeLegacyUnresolved(
  value: unknown,
): NonNullable<DurableStateV5['legacyUnresolved']> {
  const source = object(value, 'legacy unresolved state')
  keys(source, ['schemaVersion', 'runId', 'phase', 'recoveryBindings'])
  if (
    ![2, 3, 4].includes(source.schemaVersion as number) ||
    typeof source.phase !== 'string' ||
    !['launching', 'running', 'stopping', 'failed'].includes(source.phase)
  ) throw new Error('Invalid legacy unresolved state')
  text(source.runId, 'legacy unresolved run', 256)
  return {
    schemaVersion: source.schemaVersion as 2 | 3 | 4,
    runId: source.runId as string,
    phase: source.phase as Exclude<DurableStateV5['phase'], 'idle'>,
    recoveryBindings: recoveryBindings(source.recoveryBindings),
  }
}

function scope(value: unknown): ProcessOwnershipScope {
  const result = object(value, 'process ownership scope')
  keys(result, ['planRef', 'executionUnitId'])
  const plan = object(result.planRef, 'process ownership plan')
  keys(plan, ['teamId', 'runId', 'generation', 'planHash'])
  text(result.executionUnitId, 'scope execution unit', 1024)
  text(plan.teamId, 'scope team', 1024)
  text(plan.runId, 'scope run', 256)
  integer(plan.generation, 'scope generation')
  digest(plan.planHash, 'scope plan hash')
  return cloneJson(value) as ProcessOwnershipScope
}

function workspaceBinding(value: unknown): void {
  const binding = object(value, 'workspace binding')
  keys(binding, [
    'workspaceId', 'registrationRevision', 'bindingGeneration', 'mountGeneration',
  ])
  text(binding.workspaceId, 'workspace id', 1024)
  for (const name of [
    'registrationRevision', 'bindingGeneration', 'mountGeneration',
  ] as const) integer(binding[name], `workspace ${name}`)
}

function workspaceGrant(value: unknown): void {
  const grant = object(value, 'workspace grant')
  keys(grant, [
    'grantId', 'workspaceId', 'registrationRevision', 'bindingGeneration',
    'mountGeneration', 'permission',
  ])
  text(grant.grantId, 'workspace grant id', 1024)
  text(grant.workspaceId, 'workspace grant workspace', 1024)
  for (const name of [
    'registrationRevision', 'bindingGeneration', 'mountGeneration',
  ] as const) integer(grant[name], `workspace grant ${name}`)
  if (grant.permission !== 'execute_process') {
    throw new Error('Invalid workspace execution permission')
  }
}

function binary(value: unknown): void {
  const policy = object(value, 'binary policy')
  keys(policy, ['policy', 'binaryId', 'binaryRevision', 'binaryHash'])
  if (policy.policy !== 'registered_exact_binary') {
    throw new Error('Invalid registered binary policy')
  }
  text(policy.binaryId, 'binary id', 1024)
  integer(policy.binaryRevision, 'binary revision')
  digest(policy.binaryHash, 'binary hash')
}

function environment(value: unknown): void {
  const policy = object(value, 'environment policy')
  keys(policy, ['policy', 'variables'])
  if (
    policy.policy !== 'explicit_allowlist' ||
    !Array.isArray(policy.variables) ||
    policy.variables.length > 512
  ) throw new Error('Invalid environment policy')
  const names = new Set<string>()
  let previousName: string | undefined
  for (const value of policy.variables) {
    const variable = object(value, 'environment variable policy')
    keys(variable, [
      'name', 'provenance',
      ...(variable.secretRef === undefined ? [] : ['secretRef']),
    ])
    if (
      typeof variable.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(variable.name)
    ) throw new Error('Invalid environment variable name')
    if (
      names.has(variable.name) ||
      (previousName !== undefined && previousName >= variable.name) ||
      typeof variable.provenance !== 'string' ||
      ![
        'provider_static', 'runtime_metadata', 'workspace_metadata', 'secret_ref',
      ].includes(variable.provenance)
    ) throw new Error('Invalid environment variable policy')
    names.add(variable.name)
    previousName = variable.name
    if ((variable.provenance === 'secret_ref') !== (variable.secretRef !== undefined)) {
      throw new Error('Invalid environment secret provenance')
    }
    if (variable.secretRef !== undefined) secretRef(variable.secretRef)
  }
}

function credentialExposure(value: unknown): void {
  const exposure = object(value, 'credential exposure')
  keys(exposure, ['secretRefs'])
  if (!Array.isArray(exposure.secretRefs) || exposure.secretRefs.length > 512) {
    throw new Error('Invalid credential exposure')
  }
  const ids = new Set<string>()
  for (const value of exposure.secretRefs) {
    const id = secretRef(value)
    if (ids.has(id)) throw new Error('Duplicate credential exposure')
    ids.add(id)
  }
}

function secretRef(value: unknown): string {
  const ref = object(value, 'secret reference')
  keys(ref, ['secretRefId', 'secretClass'])
  text(ref.secretRefId, 'secret reference id', 1024)
  text(ref.secretClass, 'secret class', 1024)
  return ref.secretRefId
}

function resource(value: unknown): void {
  const policy = object(value, 'resource policy')
  keys(policy, [
    'maxRuntimeMs', 'gracefulStopMs', 'maxOutputBytes', 'maxProcessCount',
  ])
  for (const name of [
    'maxRuntimeMs', 'gracefulStopMs', 'maxOutputBytes', 'maxProcessCount',
  ] as const) positiveInteger(policy[name], `resource ${name}`)
}

function expectedWorkspace(
  expected: NativeAcquisitionPreparedExpectation,
): ProcessOwnershipState['intent']['workspaceBinding'] {
  const grant = expected.binding.launchSpec.workdirAuthority.grant
  return {
    workspaceId: grant.workspaceId,
    registrationRevision: grant.registrationRevision,
    bindingGeneration: grant.bindingGeneration,
    mountGeneration: grant.mountGeneration,
  }
}

function adapterResult(value: unknown, label: string): void {
  const result = object(value, label)
  text(result.status, `${label} status`, 128)
  bounded(value, label)
}

function validateBase(source: Record<string, unknown>): void {
  integer(source.revision, 'revision')
  if (
    typeof source.planFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(source.planFingerprint) ||
    typeof source.toolApprovalMode !== 'string' ||
    !['manual', 'auto'].includes(source.toolApprovalMode) ||
    typeof source.phase !== 'string' ||
    !['idle', 'launching', 'running', 'stopping', 'failed'].includes(source.phase) ||
    !(source.runId === null || (
      typeof source.runId === 'string' &&
      source.runId.length > 0 &&
      source.runId.length <= 256
    )) ||
    typeof source.recoverable !== 'boolean' ||
    !(source.ownerIncarnation === null || (
      typeof source.ownerIncarnation === 'string' &&
      source.ownerIncarnation.length > 0 &&
      source.ownerIncarnation.length <= 256
    ))
  ) throw new Error('Invalid team lifecycle state')
  if ((source.phase === 'idle') !== (source.runId === null)) {
    throw new Error('Invalid team lifecycle state/run binding')
  }
  recoveryBindings(source.recoveryBindings)
}

function recoveryBindings(value: unknown): Record<string, string> {
  const source = object(value, 'recovery bindings')
  if (
    Object.keys(source).length > 64 ||
    Object.entries(source).some(([key, binding]) =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) ||
      typeof binding !== 'string' ||
      !/^session-set_[0-9a-f]{64}$/.test(binding))
  ) throw new Error('Invalid recovery bindings')
  return { ...source } as Record<string, string>
}

function terminal(attempt: DurableAttempt): boolean {
  return attempt.phase === 'drained' || attempt.phase === 'noeffect'
}
function terminalStatus(value: unknown): value is AStopSuccess['status'] {
  return value === 'drained' || value === 'already_drained'
}
function baseIdentity(
  identity: OwnedNativeProcessIdentity,
): NativeAcquisitionPreparedExpectation {
  return baseIdentityRecord(identity) as NativeAcquisitionPreparedExpectation
}
function baseIdentityRecord(
  identity: object,
): Record<string, unknown> {
  const source = identity as Record<string, unknown>
  const {
    kind: _kind,
    processRef: _processRef,
    runtimeSessionId: _session,
    readiness: _readiness,
    diagnostics: _diagnostics,
    ...expected
  } = source
  return expected
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid team lifecycle ${label}`)
  }
  return value as Record<string, unknown>
}
function keys(source: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(source)
  if (
    actual.length !== expected.length ||
    actual.some(key => !expected.includes(key))
  ) throw new Error('Invalid team lifecycle state fields')
}
function optionalKeys(
  source: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  if (
    required.some(key => !(key in source)) ||
    Object.keys(source).some(key => !required.includes(key) && !optional.includes(key))
  ) throw new Error('Invalid team lifecycle state fields')
}
function text(value: unknown, label: string, max: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > max ||
    value.includes('\0')
  ) throw new Error(`Invalid team lifecycle ${label}`)
}
function digest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid team lifecycle ${label}`)
  }
}
function integer(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid team lifecycle ${label}`)
  }
}
function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid team lifecycle ${label}`)
  }
}
function positiveNumber(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid team lifecycle ${label}`)
  }
}
function date(value: unknown, label: string): void {
  text(value, label, 256)
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid team lifecycle ${label}`)
}
function bounded(value: unknown, label: string): void {
  if (safeDurableJsonByteLength(value) > TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES) {
    throw new Error(`Team lifecycle ${label} exceeds bound`)
  }
}

export function cloneJson<T>(value: T): T {
  return value === undefined
    ? value
    : decodeSafeJson(JSON.parse(JSON.stringify(encodeSafeJson(value)))) as T
}

const BIGINT_TAG = '$teamLifecycleBigInt'
const FORBIDDEN_KEYS = new Set([BIGINT_TAG, '__proto__', 'prototype'])

function encodeSafeJson(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString(10) }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite durable state number')
    return value
  }
  if (value === undefined) return undefined
  if (typeof value !== 'object') throw new TypeError('Unsupported durable state value')
  if (seen.has(value)) throw new TypeError('Cyclic durable state value')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map(item => {
        if (item === undefined) throw new TypeError('Undefined durable state array entry')
        return encodeSafeJson(item, seen)
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Non-plain durable state object')
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError('Reserved durable state field')
      if (item !== undefined) result[key] = encodeSafeJson(item, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function decodeSafeJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) return value
  if (Array.isArray(value)) return value.map(decodeSafeJson)
  const source = object(value, 'encoded value')
  const names = Object.keys(source)
  if (names.includes(BIGINT_TAG)) {
    if (
      names.length !== 1 ||
      typeof source[BIGINT_TAG] !== 'string' ||
      !/^-?(0|[1-9][0-9]*)$/.test(source[BIGINT_TAG])
    ) throw new Error('Invalid durable bigint encoding')
    return BigInt(source[BIGINT_TAG])
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error('Reserved durable state field')
    result[key] = decodeSafeJson(item)
  }
  return result
}

/** Detect duplicate object names before JSON.parse can collapse them. */
function rejectDuplicateJsonMembers(source: string): void {
  let index = 0
  const whitespace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1
  }
  const quoted = (): string => {
    if (source[index] !== '"') throw new Error('Invalid durable JSON string')
    const start = index++
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2
        continue
      }
      if (source[index++] === '"') {
        return JSON.parse(source.slice(start, index)) as string
      }
    }
    throw new Error('Invalid durable JSON string')
  }
  const value = (): void => {
    whitespace()
    if (source[index] === '{') {
      index += 1
      whitespace()
      const names = new Set<string>()
      if (source[index] === '}') {
        index += 1
        return
      }
      while (true) {
        whitespace()
        const name = quoted()
        if (names.has(name)) throw new Error(`Duplicate durable JSON member: ${name}`)
        names.add(name)
        whitespace()
        if (source[index++] !== ':') throw new Error('Invalid durable JSON object')
        value()
        whitespace()
        if (source[index] === '}') {
          index += 1
          return
        }
        if (source[index++] !== ',') throw new Error('Invalid durable JSON object')
      }
    }
    if (source[index] === '[') {
      index += 1
      whitespace()
      if (source[index] === ']') {
        index += 1
        return
      }
      while (true) {
        value()
        whitespace()
        if (source[index] === ']') {
          index += 1
          return
        }
        if (source[index++] !== ',') throw new Error('Invalid durable JSON array')
      }
    }
    if (source[index] === '"') {
      quoted()
      return
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        source.slice(index),
      )
    if (!match) throw new Error('Invalid durable JSON value')
    index += match[0].length
  }
  value()
  whitespace()
  if (index !== source.length) throw new Error('Invalid trailing durable JSON bytes')
}
