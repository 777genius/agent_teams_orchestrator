import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { normalize } from 'node:path'

import { parseStrictHostedSignedJsonFrame } from './ownerProof.js'

export const HOSTED_APPROVAL_TRANSITION_SCHEMA_VERSION = 1 as const
export const HOSTED_APPROVAL_TRANSITION_PROOF_DOMAIN =
  'agent-teams.hosted-approval-transition.owner-proof/v1' as const
export const HOSTED_APPROVAL_TRANSITION_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const HOSTED_APPROVAL_TRANSITION_FRAME_READ_MS = 5_000
export const HOSTED_APPROVAL_TRANSITION_ACQUIRED_TTL_MS = 10_000
export const HOSTED_APPROVAL_TRANSITION_PINNED_TTL_MS = 30_000
export const HOSTED_APPROVAL_TRANSITION_TOMBSTONE_RETENTION_MS = 86_400_000
export const HOSTED_APPROVAL_TRANSITION_MAX_TOMBSTONES_PER_TEAM = 4_096

export const HOSTED_APPROVAL_TRANSITION_CONTRACT_JSON_SHA256 =
  'c4304b8e5e7899f5a9064c3b0b711c20e15e83b42d607292277f7c84b9d39e' as const

export const HOSTED_APPROVAL_TRANSITION_OPERATIONS =
  ['acquire', 'consume', 'assert', 'release'] as const
export type HostedApprovalTransitionOperation =
  (typeof HOSTED_APPROVAL_TRANSITION_OPERATIONS)[number]

export type HostedApprovalTransitionProcessIdentity = {
  pid: number
  startIdentity: string
}
export type HostedApprovalTransitionSocketIdentity = {
  device: string
  inode: string
  uid: number
  gid: number
  mode: 384
}
export type HostedApprovalTransitionOuterAuthority = {
  deploymentId: string
  bootId: string
  workspaceId: string
  teamId: string
  restoreGeneration: number
  mountBinding: { mountGeneration: number; declaredRootHash: string }
}
export type HostedApprovalTransitionOwner = {
  teamId: string
  ownerAuthority: string
  ownerGeneration: number
  ownerSessionId: string
  socketPath: string
  socketIdentity: HostedApprovalTransitionSocketIdentity
  processIdentity: HostedApprovalTransitionProcessIdentity
}
export type HostedApprovalTransitionLifecycle =
  | { state: 'provisioning'; ownerGeneration: number }
  | { state: 'restart_required'; ownerGeneration: number; approvalGeneration: number }
  | { state: 'active'; ownerGeneration: number; approvalGeneration: number; approvalDigest: string }
export type HostedApprovalTransitionProductProjection = {
  teamName: string
  lifecycle: HostedApprovalTransitionLifecycle
  expectedInstalledArtifactDigest: string
  stableAuthority: HostedApprovalTransitionOuterAuthority
  expectedOwner: HostedApprovalTransitionOwner
  clientProcessIdentity: HostedApprovalTransitionProcessIdentity
}
export type HostedApprovalTransitionRoute = {
  routeId: string
  authority: {
    deploymentId: string; teamId: string; runId: string; planGeneration: number
    laneId: string; providerId: 'opencode'; credentialGeneration: number
    credentialId: string; sessionId: string; runtimeInstanceId: string; deliveryOwnerId: string
  }
  scope: {
    principalId: string; workspaceId: string; teamId: string
    authorityGeneration: string; restoreGeneration: number
  }
  memberName: string
  openCodeBinding: {
    toolApprovalMode: 'manual'; planGeneration: number; credentialGeneration: number
    credentialId: string; runtimeInstanceId: string; deliveryOwnerId: string
    openCodeArtifactDigest: string; sessionRecordFingerprint: string; liveEffectFingerprint: string
  }
}
export type HostedApprovalTransitionBinding = {
  outerAuthority: HostedApprovalTransitionOuterAuthority
  routes: HostedApprovalTransitionRoute[]
  memberIdsByName: Record<string, string>
  actorMembers: Record<string, string>
  owner: HostedApprovalTransitionOwner
  capability: {
    schemaVersion: 2; protocol: 'agent-teams-hosted-approval-v2'
    authentication: 'opencode-basic'; runtimeInstanceId: string; configGeneration: string
  }
}

export type HostedApprovalTransitionRequestPayloads = {
  acquire: { productProjection: HostedApprovalTransitionProductProjection; projectionDigest: string }
  consume: { leaseId: string; generation: number; projectionDigest: string; bindingDigest: string }
  assert: { leaseId: string; generation: number; bindingDigest: string }
  release: { leaseId: string; generation: number; bindingDigest: string }
}
export type HostedApprovalTransitionSuccessPayloads = {
  acquire: {
    status: 'acquired'; leaseId: string; generation: number; expiresAtMs: number
    projectionDigest: string; bindingDigest: string; binding: HostedApprovalTransitionBinding
  }
  consume: {
    status: 'consumed'; leaseId: string; generation: number; pinnedExpiresAtMs: number
    bindingDigest: string; binding: HostedApprovalTransitionBinding
  }
  assert: {
    status: 'asserted'; leaseId: string; generation: number; current: boolean
    reason: HostedApprovalTransitionAssertReason | null
  }
  release: { status: 'released'; leaseId: string; generation: number; releasedAtMs: number }
}
export type HostedApprovalTransitionAssertReason =
  | 'expired' | 'released' | 'fenced' | 'owner_restarted' | 'binding_changed'
  | 'socket_changed' | 'process_changed' | 'client_changed'

export type HostedApprovalTransitionRequest<O extends HostedApprovalTransitionOperation = HostedApprovalTransitionOperation> = {
  schemaVersion: 1; transitionId: string; operation: O; sequence: number; deadlineAtMs: number
  payload: HostedApprovalTransitionRequestPayloads[O]; ownerProof: string
}
export type HostedApprovalTransitionSuccessResponse<O extends HostedApprovalTransitionOperation = HostedApprovalTransitionOperation> = {
  schemaVersion: 1; transitionId: string; operation: O; sequence: number; requestDigest: string
  payload: HostedApprovalTransitionSuccessPayloads[O]; ownerProof: string
}

export const HOSTED_APPROVAL_TRANSITION_ERRORS = {
  DEADLINE_EXCEEDED: ['request deadline has elapsed', true, 'same_operation', 0],
  INVALID_SCHEMA: ['request schema is invalid', false, 'never', null],
  LIMIT_EXCEEDED: ['request limit is exceeded', false, 'never', null],
  SEQUENCE_OUT_OF_ORDER: ['sequence is not the next transition sequence', false, 'never', null],
  OPERATION_OUT_OF_ORDER: ['operation is not legal in the lease state', false, 'never', null],
  TRANSITION_CONFLICT: ['transition replay bytes do not match', false, 'never', null],
  PROJECTION_MISMATCH: ['product projection does not match owner authority', false, 'never', null],
  BINDING_INVALID: ['authoritative binding is invalid', false, 'never', null],
  SOCKET_IDENTITY_MISMATCH: ['owner socket identity does not match', true, 'new_transition', null],
  PROCESS_IDENTITY_MISMATCH: ['owner process identity does not match', true, 'new_transition', null],
  CLIENT_IDENTITY_MISMATCH: ['product process identity does not match', true, 'new_transition', null],
  OWNER_NOT_CURRENT: ['orchestrator owner authority is not current', true, 'new_transition', null],
  PIN_BUSY: ['another transition holds the team pin', true, 'same_operation', 25],
  LEASE_NOT_FOUND: ['lease is not retained', false, 'never', null],
  LEASE_EXPIRED: ['lease has expired', true, 'new_transition', null],
  LEASE_ALREADY_CONSUMED: ['lease was already consumed by another sequence', false, 'never', null],
  LEASE_NOT_CONSUMED: ['lease has not been consumed', false, 'never', null],
  LEASE_RELEASED: ['lease is already terminal', false, 'never', null],
  GENERATION_MISMATCH: ['lease generation does not match', false, 'never', null],
  BINDING_DRIFT: ['authoritative binding changed', true, 'new_transition', null],
  OWNER_RESTARTED: ['orchestrator owner restarted', true, 'new_transition', null],
  TOMBSTONE_CAPACITY: ['transition tombstone capacity is exhausted', true, 'same_operation', 1000],
  UNAVAILABLE: ['transition authority is unavailable', true, 'same_operation', 50],
  INTERNAL: ['transition operation did not settle', true, 'same_operation', 50],
} as const
export type HostedApprovalTransitionErrorCode = keyof typeof HOSTED_APPROVAL_TRANSITION_ERRORS
export type HostedApprovalTransitionError = {
  code: HostedApprovalTransitionErrorCode; message: string; retryable: boolean
  retryScope: 'same_operation' | 'new_transition' | 'never'; retryAfterMs: number | null
}
export type HostedApprovalTransitionErrorResponse<O extends HostedApprovalTransitionOperation = HostedApprovalTransitionOperation> = {
  schemaVersion: 1; transitionId: string; operation: O; sequence: number; requestDigest: string
  error: HostedApprovalTransitionError; ownerProof: string
}
export type HostedApprovalTransitionResponse<O extends HostedApprovalTransitionOperation = HostedApprovalTransitionOperation> =
  | HostedApprovalTransitionSuccessResponse<O> | HostedApprovalTransitionErrorResponse<O>

const REQUEST_KEYS = ['schemaVersion', 'transitionId', 'operation', 'sequence', 'deadlineAtMs', 'payload', 'ownerProof']
const RESPONSE_KEYS = ['schemaVersion', 'transitionId', 'operation', 'sequence', 'requestDigest', 'payload', 'ownerProof']
const ERROR_RESPONSE_KEYS = ['schemaVersion', 'transitionId', 'operation', 'sequence', 'requestDigest', 'error', 'ownerProof']
const PAYLOAD_KEYS = {
  acquire: ['productProjection', 'projectionDigest'],
  consume: ['leaseId', 'generation', 'projectionDigest', 'bindingDigest'],
  assert: ['leaseId', 'generation', 'bindingDigest'],
  release: ['leaseId', 'generation', 'bindingDigest'],
} as const
const SUCCESS_KEYS = {
  acquire: ['status', 'leaseId', 'generation', 'expiresAtMs', 'projectionDigest', 'bindingDigest', 'binding'],
  consume: ['status', 'leaseId', 'generation', 'pinnedExpiresAtMs', 'bindingDigest', 'binding'],
  assert: ['status', 'leaseId', 'generation', 'current', 'reason'],
  release: ['status', 'leaseId', 'generation', 'releasedAtMs'],
} as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DEPLOYMENT = /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/
const TEAM_ID = /^team_[0-9a-f]{32}$/
const RUN_ID = /^run_[0-9a-f]{32}$/
const MEMBER_ID = /^member_[0-9a-f]{32}$/
const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/
const AUTHORITY_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const RUNTIME_INSTANCE = /^runtime_instance_[0-9a-f]{32}$/
const CONFIG_GENERATION = /^config_generation_[0-9a-f]{32}$/
const TRANSITION_ID = /^approval-transition_[0-9a-f]{32}$/
const LEASE_ID = /^approval-transition-lease_[0-9a-f]{32}$/
const HEX = /^[0-9a-f]{64}$/
const PREFIXED_HEX = /^sha256:[0-9a-f]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]{0,31})$/
const START_ID = /^start_[0-9a-f]{64}$/

function fail(message = 'Hosted approval transition schema is invalid'): never { throw new TypeError(message) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function keys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const result = record(value)
  const actual = Object.keys(result)
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail()
  return result
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value) || hasUnpairedSurrogate(value)) fail()
  return value
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum || Object.is(value, -0)) fail()
  return value as number
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}
function assertAllStrings(value: unknown): void {
  if (typeof value === 'string') { if (hasUnpairedSurrogate(value)) fail(); return }
  if (Array.isArray(value)) { value.forEach(assertAllStrings); return }
  if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { assertAllStrings(key); assertAllStrings(item) })
}
function processIdentity(value: unknown): HostedApprovalTransitionProcessIdentity {
  const v = keys(value, ['pid', 'startIdentity'])
  integer(v.pid, 1); string(v.startIdentity, START_ID)
  return v as HostedApprovalTransitionProcessIdentity
}
function socketIdentity(value: unknown): HostedApprovalTransitionSocketIdentity {
  const v = keys(value, ['device', 'inode', 'uid', 'gid', 'mode'])
  string(v.device, DECIMAL); string(v.inode, DECIMAL); integer(v.uid); integer(v.gid)
  if (v.mode !== 384) fail()
  return v as HostedApprovalTransitionSocketIdentity
}
function outerAuthority(value: unknown): HostedApprovalTransitionOuterAuthority {
  const v = keys(value, ['deploymentId', 'bootId', 'workspaceId', 'teamId', 'restoreGeneration', 'mountBinding'])
  string(v.deploymentId, DEPLOYMENT); string(v.bootId, ID); string(v.workspaceId, ID); string(v.teamId, TEAM_ID); integer(v.restoreGeneration)
  const mount = keys(v.mountBinding, ['mountGeneration', 'declaredRootHash'])
  integer(mount.mountGeneration, 1); string(mount.declaredRootHash, HEX)
  return v as HostedApprovalTransitionOuterAuthority
}
function owner(value: unknown): HostedApprovalTransitionOwner {
  const v = keys(value, ['teamId', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'socketPath', 'socketIdentity', 'processIdentity'])
  string(v.teamId, TEAM_ID); string(v.ownerAuthority, OWNER_AUTHORITY); integer(v.ownerGeneration, 1); string(v.ownerSessionId, OWNER_SESSION)
  const path = string(v.socketPath, /^\//)
  if (path.includes('\0') || normalize(path) !== path || Buffer.byteLength(path, 'utf8') > 103) fail()
  socketIdentity(v.socketIdentity); processIdentity(v.processIdentity)
  return v as HostedApprovalTransitionOwner
}
function lifecycle(value: unknown): HostedApprovalTransitionLifecycle {
  const v = record(value)
  if (v.state === 'provisioning') keys(v, ['state', 'ownerGeneration'])
  else if (v.state === 'restart_required') keys(v, ['state', 'ownerGeneration', 'approvalGeneration'])
  else if (v.state === 'active') { keys(v, ['state', 'ownerGeneration', 'approvalGeneration', 'approvalDigest']); string(v.approvalDigest, PREFIXED_HEX) }
  else fail()
  integer(v.ownerGeneration, 1)
  if (v.state !== 'provisioning') integer(v.approvalGeneration, 1)
  return v as HostedApprovalTransitionLifecycle
}
export function validateHostedApprovalTransitionProductProjection(value: unknown): HostedApprovalTransitionProductProjection {
  const v = keys(value, ['teamName', 'lifecycle', 'expectedInstalledArtifactDigest', 'stableAuthority', 'expectedOwner', 'clientProcessIdentity'])
  string(v.teamName, TEAM_NAME); const life = lifecycle(v.lifecycle); string(v.expectedInstalledArtifactDigest, PREFIXED_HEX)
  const stable = outerAuthority(v.stableAuthority); const expected = owner(v.expectedOwner); processIdentity(v.clientProcessIdentity)
  if (life.ownerGeneration !== expected.ownerGeneration || stable.teamId !== expected.teamId) fail('Hosted approval transition projection does not match owner')
  return v as HostedApprovalTransitionProductProjection
}

function route(value: unknown): HostedApprovalTransitionRoute {
  const v = keys(value, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding'])
  string(v.routeId, ID); string(v.memberName, ID)
  const a = keys(v.authority, ['deploymentId', 'teamId', 'runId', 'planGeneration', 'laneId', 'providerId', 'credentialGeneration', 'credentialId', 'sessionId', 'runtimeInstanceId', 'deliveryOwnerId'])
  string(a.deploymentId, DEPLOYMENT); string(a.teamId, TEAM_ID); string(a.runId, RUN_ID); integer(a.planGeneration, 1); string(a.laneId, PLAN_ID)
  if (a.providerId !== 'opencode') fail(); integer(a.credentialGeneration, 1); string(a.credentialId, ID); string(a.sessionId, ID); string(a.runtimeInstanceId, RUNTIME_INSTANCE); string(a.deliveryOwnerId, MEMBER_ID)
  const s = keys(v.scope, ['principalId', 'workspaceId', 'teamId', 'authorityGeneration', 'restoreGeneration'])
  string(s.principalId, ACTOR_ID); string(s.workspaceId, ID); string(s.teamId, TEAM_ID); string(s.authorityGeneration, AUTHORITY_GENERATION); integer(s.restoreGeneration)
  const o = keys(v.openCodeBinding, ['toolApprovalMode', 'planGeneration', 'credentialGeneration', 'credentialId', 'runtimeInstanceId', 'deliveryOwnerId', 'openCodeArtifactDigest', 'sessionRecordFingerprint', 'liveEffectFingerprint'])
  if (o.toolApprovalMode !== 'manual') fail(); integer(o.planGeneration, 1); integer(o.credentialGeneration, 1); string(o.credentialId, ID); string(o.runtimeInstanceId, RUNTIME_INSTANCE); string(o.deliveryOwnerId, MEMBER_ID); string(o.openCodeArtifactDigest, PREFIXED_HEX); string(o.sessionRecordFingerprint, HEX); string(o.liveEffectFingerprint, HEX)
  if (o.planGeneration !== a.planGeneration || o.credentialGeneration !== a.credentialGeneration || o.credentialId !== a.credentialId || o.runtimeInstanceId !== a.runtimeInstanceId || o.deliveryOwnerId !== a.deliveryOwnerId) fail()
  return v as HostedApprovalTransitionRoute
}
function dictionary(value: unknown, keyPattern: RegExp): Record<string, string> {
  const v = record(value); const names = Object.keys(v)
  if (names.length < 1 || names.length > 256 || names.some((name, index) => !keyPattern.test(name) || hasUnpairedSurrogate(name) || (index > 0 && names[index - 1]! >= name))) fail()
  const values = names.map(name => string(v[name], MEMBER_ID)); if (new Set(values).size !== values.length) fail()
  return v as Record<string, string>
}
export function validateHostedApprovalTransitionBinding(value: unknown, projection?: HostedApprovalTransitionProductProjection): HostedApprovalTransitionBinding {
  const v = keys(value, ['outerAuthority', 'routes', 'memberIdsByName', 'actorMembers', 'owner', 'capability'])
  const outer = outerAuthority(v.outerAuthority); const owned = owner(v.owner)
  if (!Array.isArray(v.routes) || v.routes.length < 1 || v.routes.length > 256) fail()
  const routes = v.routes.map(route); const names = dictionary(v.memberIdsByName, ID); const actors = dictionary(v.actorMembers, ACTOR_ID)
  const nameValues = Object.values(names); const actorValues = Object.values(actors)
  if (nameValues.length !== actorValues.length || nameValues.some(item => !actorValues.includes(item))) fail()
  const capability = keys(v.capability, ['schemaVersion', 'protocol', 'authentication', 'runtimeInstanceId', 'configGeneration'])
  if (capability.schemaVersion !== 2 || capability.protocol !== 'agent-teams-hosted-approval-v2' || capability.authentication !== 'opencode-basic') fail()
  string(capability.runtimeInstanceId, RUNTIME_INSTANCE); string(capability.configGeneration, CONFIG_GENERATION)
  const routeIds = new Set<string>(); const sessions = new Set<string>()
  routes.forEach((item, index) => {
    if ((index > 0 && routes[index - 1]!.routeId >= item.routeId) || routeIds.has(item.routeId) || sessions.has(item.authority.sessionId)) fail()
    routeIds.add(item.routeId); sessions.add(item.authority.sessionId)
    if (item.authority.deploymentId !== outer.deploymentId || item.authority.teamId !== outer.teamId || item.scope.workspaceId !== outer.workspaceId || item.scope.teamId !== outer.teamId || item.scope.restoreGeneration !== outer.restoreGeneration || actors[item.scope.principalId] !== item.authority.deliveryOwnerId || names[item.memberName] !== item.authority.deliveryOwnerId || item.openCodeBinding.runtimeInstanceId !== capability.runtimeInstanceId) fail()
    if (projection && item.openCodeBinding.openCodeArtifactDigest !== projection.expectedInstalledArtifactDigest) fail()
  })
  if (owned.teamId !== outer.teamId) fail()
  if (projection && (canonicalHostedApprovalTransitionJson(outer) !== canonicalHostedApprovalTransitionJson(projection.stableAuthority) || canonicalHostedApprovalTransitionJson(owned) !== canonicalHostedApprovalTransitionJson(projection.expectedOwner) || owned.ownerGeneration !== projection.lifecycle.ownerGeneration)) fail()
  return v as HostedApprovalTransitionBinding
}

export function canonicalHostedApprovalTransitionJson(value: unknown): string {
  assertAllStrings(value)
  return JSON.stringify(value)
}
export function digestHostedApprovalTransitionValue(value: unknown): string {
  return createHash('sha256').update(canonicalHostedApprovalTransitionJson(value)).digest('hex')
}
export function digestHostedApprovalTransitionUnsigned(serializedUnsignedEnvelope: string): string {
  return createHash('sha256').update(serializedUnsignedEnvelope).digest('hex')
}
export function createHostedApprovalTransitionProof(secret: Uint8Array, direction: 'request' | 'response', serializedUnsignedEnvelope: string): string {
  if (secret.byteLength !== 32) throw new TypeError('Hosted approval transition secret must be exactly 32 bytes')
  return createHmac('sha256', secret).update(HOSTED_APPROVAL_TRANSITION_PROOF_DOMAIN).update('\0').update(direction).update('\0').update(serializedUnsignedEnvelope).digest('hex')
}
function verifyProof(secret: Uint8Array, direction: 'request' | 'response', unsigned: string, actual: string): void {
  const expected = Buffer.from(createHostedApprovalTransitionProof(secret, direction, unsigned), 'hex')
  const received = Buffer.from(actual, 'hex')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail('Hosted approval transition proof is invalid')
}
function validateRequestPayload(operation: HostedApprovalTransitionOperation, value: unknown): void {
  const v = keys(value, PAYLOAD_KEYS[operation])
  if (operation === 'acquire') {
    const projection = validateHostedApprovalTransitionProductProjection(v.productProjection)
    if (string(v.projectionDigest, HEX) !== digestHostedApprovalTransitionValue(projection)) fail('Hosted approval transition projection digest is invalid')
  } else {
    string(v.leaseId, LEASE_ID); integer(v.generation, 1); string(v.bindingDigest, HEX)
    if (operation === 'consume') string(v.projectionDigest, HEX)
  }
}
export function validateHostedApprovalTransitionRequest(value: unknown): HostedApprovalTransitionRequest {
  const v = keys(value, REQUEST_KEYS)
  if (v.schemaVersion !== 1 || !HOSTED_APPROVAL_TRANSITION_OPERATIONS.includes(v.operation as never)) fail()
  string(v.transitionId, TRANSITION_ID); integer(v.sequence, 1, 2_147_483_647); integer(v.deadlineAtMs); string(v.ownerProof, HEX)
  validateRequestPayload(v.operation as HostedApprovalTransitionOperation, v.payload)
  if (v.operation === 'acquire' && v.sequence !== 1) fail()
  return v as HostedApprovalTransitionRequest
}
function validateError(value: unknown): HostedApprovalTransitionError {
  const v = keys(value, ['code', 'message', 'retryable', 'retryScope', 'retryAfterMs'])
  if (typeof v.code !== 'string' || !(v.code in HOSTED_APPROVAL_TRANSITION_ERRORS)) fail()
  const tuple = HOSTED_APPROVAL_TRANSITION_ERRORS[v.code as HostedApprovalTransitionErrorCode]
  if (v.message !== tuple[0] || v.retryable !== tuple[1] || v.retryScope !== tuple[2] || v.retryAfterMs !== tuple[3]) fail()
  return v as HostedApprovalTransitionError
}
function validateSuccessPayload(operation: HostedApprovalTransitionOperation, value: unknown): void {
  const v = keys(value, SUCCESS_KEYS[operation])
  const statuses = { acquire: 'acquired', consume: 'consumed', assert: 'asserted', release: 'released' } as const
  if (v.status !== statuses[operation]) fail(); string(v.leaseId, LEASE_ID); integer(v.generation, 1)
  if (operation === 'acquire') { integer(v.expiresAtMs); string(v.projectionDigest, HEX); const binding = validateHostedApprovalTransitionBinding(v.binding); if (string(v.bindingDigest, HEX) !== digestHostedApprovalTransitionValue(binding)) fail() }
  if (operation === 'consume') { integer(v.pinnedExpiresAtMs); const binding = validateHostedApprovalTransitionBinding(v.binding); if (string(v.bindingDigest, HEX) !== digestHostedApprovalTransitionValue(binding)) fail() }
  if (operation === 'assert') {
    if (typeof v.current !== 'boolean') fail()
    const reasons: HostedApprovalTransitionAssertReason[] = ['expired', 'released', 'fenced', 'owner_restarted', 'binding_changed', 'socket_changed', 'process_changed', 'client_changed']
    if ((v.current && v.reason !== null) || (!v.current && (typeof v.reason !== 'string' || !reasons.includes(v.reason as HostedApprovalTransitionAssertReason)))) fail()
  }
  if (operation === 'release') integer(v.releasedAtMs)
}
export function validateHostedApprovalTransitionResponse(value: unknown): HostedApprovalTransitionResponse {
  const v = record(value); const isError = Object.hasOwn(v, 'error')
  keys(v, isError ? ERROR_RESPONSE_KEYS : RESPONSE_KEYS)
  if (v.schemaVersion !== 1 || !HOSTED_APPROVAL_TRANSITION_OPERATIONS.includes(v.operation as never)) fail()
  string(v.transitionId, TRANSITION_ID); integer(v.sequence, 1, 2_147_483_647); string(v.requestDigest, HEX); string(v.ownerProof, HEX)
  if (isError) validateError(v.error); else validateSuccessPayload(v.operation as HostedApprovalTransitionOperation, v.payload)
  return v as HostedApprovalTransitionResponse
}

export type ParsedHostedApprovalTransitionFrame<T> = {
  value: T; serializedUnsignedEnvelope: string; requestDigest: string; frame: Buffer
}
export function parseHostedApprovalTransitionRequestFrame(frame: Uint8Array, secret: Uint8Array): ParsedHostedApprovalTransitionFrame<HostedApprovalTransitionRequest> {
  return parseFrame(frame, secret, 'request', validateHostedApprovalTransitionRequest)
}
export function parseHostedApprovalTransitionResponseFrame(frame: Uint8Array, secret: Uint8Array): ParsedHostedApprovalTransitionFrame<HostedApprovalTransitionResponse> {
  return parseFrame(frame, secret, 'response', validateHostedApprovalTransitionResponse)
}
function parseFrame<T>(frame: Uint8Array, secret: Uint8Array, direction: 'request' | 'response', validate: (value: unknown) => T): ParsedHostedApprovalTransitionFrame<T> {
  if (frame.byteLength < 2 || frame.byteLength > HOSTED_APPROVAL_TRANSITION_MAX_FRAME_BYTES || frame[frame.byteLength - 1] !== 0x0a || frame.slice(0, -1).includes(0x0a) || frame.slice(0, -1).includes(0x0d)) fail('Hosted approval transition frame is invalid')
  const bytes = Buffer.from(frame)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('Hosted approval transition frame has a BOM')
  let line: string
  try { line = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)) } catch { return fail('Hosted approval transition frame is not UTF-8') }
  const parsed = parseStrictHostedSignedJsonFrame(line)
  const value = validate(parsed.value)
  if (canonicalHostedApprovalTransitionJson(value) !== line) fail('Hosted approval transition frame is not canonical')
  verifyProof(secret, direction, parsed.serializedUnsignedEnvelope, parsed.ownerProof)
  return { value, serializedUnsignedEnvelope: parsed.serializedUnsignedEnvelope, requestDigest: digestHostedApprovalTransitionUnsigned(parsed.serializedUnsignedEnvelope), frame: bytes }
}

export function encodeHostedApprovalTransitionFrame<T extends HostedApprovalTransitionRequest | HostedApprovalTransitionResponse>(unsigned: Omit<T, 'ownerProof'>, secret: Uint8Array, direction: 'request' | 'response'): Buffer {
  const serialized = canonicalHostedApprovalTransitionJson(unsigned)
  const ownerProof = createHostedApprovalTransitionProof(secret, direction, serialized)
  const frame = Buffer.from(`${serialized.slice(0, -1)},"ownerProof":"${ownerProof}"}\n`)
  if (frame.byteLength > HOSTED_APPROVAL_TRANSITION_MAX_FRAME_BYTES) throw new RangeError('Hosted approval transition frame exceeds 8 MiB')
  if (direction === 'request') validateHostedApprovalTransitionRequest(JSON.parse(frame.subarray(0, -1).toString()))
  else validateHostedApprovalTransitionResponse(JSON.parse(frame.subarray(0, -1).toString()))
  return frame
}
export function hostedApprovalTransitionError(code: HostedApprovalTransitionErrorCode): HostedApprovalTransitionError {
  const [message, retryable, retryScope, retryAfterMs] = HOSTED_APPROVAL_TRANSITION_ERRORS[code]
  return { code, message, retryable, retryScope, retryAfterMs }
}

const FUTURE_DEADLINE_MS: Record<HostedApprovalTransitionOperation, number> = { acquire: 5_000, consume: 5_000, assert: 2_000, release: 5_000 }
export type HostedApprovalTransitionDeadline = { receiptAtMs: number; deadlineAtMs: number; monotonicDeadlineMs: number }
export function admitHostedApprovalTransitionDeadline(operation: HostedApprovalTransitionOperation, deadlineAtMs: number, receiptAtMs: number, monotonicNowMs: number): HostedApprovalTransitionDeadline {
  integer(deadlineAtMs); integer(receiptAtMs); if (!Number.isFinite(monotonicNowMs)) fail()
  const remaining = deadlineAtMs - receiptAtMs
  if (remaining <= 0 || remaining > FUTURE_DEADLINE_MS[operation]) throw new HostedApprovalTransitionProtocolError('DEADLINE_EXCEEDED')
  return { receiptAtMs, deadlineAtMs, monotonicDeadlineMs: monotonicNowMs + remaining }
}
export function isHostedApprovalTransitionDeadlineElapsed(deadline: HostedApprovalTransitionDeadline, wallNowMs: number, monotonicNowMs: number): boolean {
  return wallNowMs >= deadline.deadlineAtMs || monotonicNowMs >= deadline.monotonicDeadlineMs
}
export class HostedApprovalTransitionProtocolError extends Error {
  readonly code: HostedApprovalTransitionErrorCode
  constructor(code: HostedApprovalTransitionErrorCode) { super(HOSTED_APPROVAL_TRANSITION_ERRORS[code][0]); this.name = 'HostedApprovalTransitionProtocolError'; this.code = code }
}
