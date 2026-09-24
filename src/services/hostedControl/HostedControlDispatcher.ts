import { createHash, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  createHostedDomainProof,
  createHostedRawDomainProof,
  parseStrictHostedSignedJsonFrame,
} from './ownerProof.js'
import type {
  HostedControlAuthority,
  HostedControlOwnerBinding,
  HostedControlStableAuthority,
} from './protocol.js'
import {
  HOSTED_LIFECYCLE_PROOF_DOMAIN,
  HOSTED_TEAM_MESSAGE_PROOF_DOMAIN,
} from './HostedControlServer.js'
import {
  HostedApprovalWireDispatcher,
  isHostedApprovalOperation,
  type HostedApprovalWirePort,
} from './HostedApprovalWire.js'

const LIFECYCLE_OPERATIONS = [
  'control_state',
  'admit_launch_plan',
  'prepare',
  'get_status',
  // Compatibility spellings used by the first hosted-controller prototype.
  'prepare_provisioning',
  'get_provisioning_status',
  'authorize',
  'revalidate',
  'replay_lookup',
  'execute',
  'release',
] as const
const MESSAGE_OPERATIONS = ['message_persist', 'message_deliver'] as const

export type HostedLifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number]
export type HostedTeamMessageOperation = (typeof MESSAGE_OPERATIONS)[number]

export type HostedLifecycleAuthority = {
  actorId: string
  workspaceId: string
  teamId: string
  deploymentId: string
  restoreGeneration: number
  mountGeneration: number
  bootId: string
  resourceRevision: string | null
  ownerEffectFence: HostedLifecycleOwnerEffectFence
}

export type HostedLifecycleOwnerEffectFence = {
  grantRevision: string
  identityChecksum: string
}

export type HostedLifecycleCommandPort = {
  dispatch(input: {
    operation: HostedLifecycleOperation
    payload: Record<string, unknown>
    authority: HostedLifecycleAuthority
  }): Promise<{ payload: Record<string, unknown>; resourceRevision: string | null }>
}

export type HostedTeamMessagePort = {
  dispatch(input: {
    operation: HostedTeamMessageOperation
    payload: Record<string, unknown>
    authority: HostedControlAuthority
  }): Promise<Record<string, unknown>>
}

export type HostedControlDispatcherOptions = {
  secret: Uint8Array
  authority: HostedControlStableAuthority
  getOwnerBinding: () => HostedControlOwnerBinding | null
  lifecycle: HostedLifecycleCommandPort
  messages: HostedTeamMessagePort
  /** Absent until a single durable approval runtime owner is composed. */
  approvals?: HostedApprovalWirePort
}

export class HostedControlDispatcher {
  constructor(private readonly options: HostedControlDispatcherOptions) {}

  async dispatch(message: Record<string, unknown>, rawLine?: string): Promise<Record<string, unknown> | null> {
    if (isHostedApprovalOperation(message.operation)) {
      if (rawLine === undefined) throw new Error('Hosted approval raw frame is required')
      if (!this.options.approvals) throw new Error('Hosted approval owner is unavailable')
      return new HostedApprovalWireDispatcher({
        secret: this.options.secret,
        authority: this.options.authority,
        getOwnerBinding: this.options.getOwnerBinding,
        approvals: this.options.approvals,
      }).dispatch(message, rawLine)
    }
    if (isLifecycleOperation(message.operation)) {
      return this.#dispatchLifecycle(message, rawLine ?? JSON.stringify(message))
    }
    if (isMessageOperation(message.operation)) {
      return this.#dispatchMessage(message)
    }
    return null
  }

  async #dispatchLifecycle(message: Record<string, unknown>, rawLine: string): Promise<Record<string, unknown>> {
    const signed = parseStrictHostedSignedJsonFrame(rawLine)
    if (!isDeepStrictEqual(signed.value, message)) throw new Error('Invalid hosted lifecycle raw frame')
    exactKeys(message, [
      'schemaVersion',
      'exchangeId',
      'operation',
      'provenance',
      'ownerBinding',
      'ownerEffectFence',
      'payload',
      'ownerProof',
    ], 'lifecycle request')
    if (message.schemaVersion !== 2 ||
      typeof message.exchangeId !== 'string' ||
      !/^lifecycle-request_[0-9a-f]{32}$/.test(message.exchangeId)) {
      throw new Error('Invalid hosted lifecycle request')
    }
    const operation = message.operation
    if (!isLifecycleOperation(operation)) throw new Error('Invalid hosted lifecycle operation')
    const ownerBinding = record(message.ownerBinding, 'lifecycle owner binding')
    const activeOwner = this.options.getOwnerBinding()
    if (!activeOwner || !isDeepStrictEqual(ownerBinding, activeOwner)) {
      throw new Error('Invalid hosted lifecycle owner binding')
    }
    const ownerEffectFence = decodeOwnerEffectFence(message.ownerEffectFence)
    const expectedIdentityChecksum = createHostedLifecycleOwnerIdentityChecksum(activeOwner, this.options.authority)
    if (ownerEffectFence.identityChecksum !== expectedIdentityChecksum) {
      throw new Error('Invalid hosted lifecycle owner effect identity')
    }
    const payload = decodeLifecyclePayload(operation, message.payload, this.options.authority, ownerEffectFence)
    const provenance = decodeLifecycleRequestProvenance(
      message.provenance,
      payload,
      activeOwner,
      String(message.exchangeId),
      operation,
    )
    const unsigned = {
      schemaVersion: 2,
      exchangeId: message.exchangeId,
      operation,
      provenance,
      ownerBinding: activeOwner,
      ownerEffectFence,
      payload,
    }
    verifyRawDomainProof(
      this.options.secret,
      HOSTED_LIFECYCLE_PROOF_DOMAIN,
      'request',
      signed.ownerProof,
      signed.serializedUnsignedEnvelope,
    )
    const result = await this.options.lifecycle.dispatch({
      operation,
      payload,
      authority: payload.authority,
    })
    const responsePayload = decodeLifecycleResponsePayload(operation, result.payload, payload)
    const resourceRevision = nullableRevision(result.resourceRevision)
    if (resourceRevision !== lifecycleResponseRevision(operation, responsePayload)) {
      throw new Error('Invalid hosted lifecycle response revision')
    }
    const responseAuthority = { ...payload.authority, resourceRevision }
    const responseProvenance = reverseLifecycleProvenance(provenance)
    const envelope = {
      schemaVersion: 2,
      exchangeId: message.exchangeId,
      operation,
      provenance: responseProvenance,
      ownerBinding: activeOwner,
      ownerEffectFence,
      authority: responseAuthority,
      payload: responsePayload,
    }
    return {
      ...envelope,
      ownerProof: createHostedRawDomainProof(this.options.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN,
        'response', JSON.stringify(envelope)),
    }
  }

  async #dispatchMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    exactKeys(message, [
      'schemaVersion',
      'exchangeId',
      'operation',
      'ownerBinding',
      'authority',
      'payload',
      'ownerProof',
    ], 'message request')
    if (message.schemaVersion !== 2 ||
      typeof message.exchangeId !== 'string' ||
      !/^message-request_[0-9a-f]{32}$/.test(message.exchangeId)) {
      throw new Error('Invalid hosted message request')
    }
    const operation = message.operation
    if (!isMessageOperation(operation)) throw new Error('Invalid hosted message operation')
    const ownerBinding = record(message.ownerBinding, 'message owner binding')
    const activeOwner = this.options.getOwnerBinding()
    if (!activeOwner || !isDeepStrictEqual(ownerBinding, activeOwner)) {
      throw new Error('Invalid hosted message owner binding')
    }
    const authority = decodeMessageAuthority(message.authority)
    if (!sameStableAuthority(authority, this.options.authority)) {
      throw new Error('Invalid hosted message authority')
    }
    const payload = record(message.payload, 'message payload')
    const unsigned = {
      schemaVersion: 2,
      exchangeId: message.exchangeId,
      operation,
      ownerBinding: activeOwner,
      authority,
      payload,
    }
    verifyDomainProof(this.options.secret, HOSTED_TEAM_MESSAGE_PROOF_DOMAIN, 'request', message.ownerProof, unsigned)
    const responsePayload = decodeMessageResponsePayload(operation, record(
      await this.options.messages.dispatch({ operation, payload, authority }),
      'message response payload',
    ), payload, authority)
    const envelope = { ...unsigned, payload: responsePayload }
    return {
      ...envelope,
      ownerProof: createHostedDomainProof(
        this.options.secret,
        HOSTED_TEAM_MESSAGE_PROOF_DOMAIN,
        'response',
        envelope,
      ),
    }
  }
}

export function createHostedLifecycleOwnerIdentityChecksum(
  ownerBinding: HostedControlOwnerBinding,
  authority: HostedControlStableAuthority,
): string {
  return createHash('sha256').update(JSON.stringify([
    'agent-teams.hosted-lifecycle-owner-effect-identity/v1',
    ownerBinding.ownerAuthority,
    ownerBinding.ownerGeneration,
    ownerBinding.ownerSessionId,
    ownerBinding.socketIdentity.device,
    ownerBinding.socketIdentity.inode,
    ownerBinding.socketIdentity.uid,
    ownerBinding.socketIdentity.gid,
    ownerBinding.socketIdentity.mode,
    authority.deploymentId,
    authority.bootId,
    authority.restoreGeneration,
    authority.workspaceId,
    authority.mountBinding.mountGeneration,
    authority.mountBinding.declaredRootHash,
    authority.teamId,
  ])).digest('hex')
}

function decodeLifecyclePayload(
  operation: HostedLifecycleOperation,
  value: unknown,
  expected: HostedControlStableAuthority,
  expectedOwnerEffectFence: HostedLifecycleOwnerEffectFence,
): Record<string, unknown> & { authority: HostedLifecycleAuthority } {
  const payload = record(value, 'lifecycle payload')
  const queryOperation = isLifecycleQueryOperation(operation)
  const expectedKeys = queryOperation
    ? ['request', 'context', 'authority']
    : operation === 'authorize'
      ? ['command', 'context', 'authority']
      : operation === 'revalidate' || operation === 'release'
        ? ['command', 'authorization', 'context', 'authority']
        : ['command', 'authorization', 'durableCommand', 'context', 'authority']
  exactKeys(payload, expectedKeys, 'lifecycle payload')
  record(payload[queryOperation ? 'request' : 'command'], 'lifecycle command')
  if (operation === 'admit_launch_plan') {
    const request = record(payload.request, 'lifecycle plan admission request')
    exactKeys(request, ['schemaVersion', 'workspaceId', 'teamId', 'workspaceRoot', 'expectedPlanGeneration'],
      'lifecycle plan admission request')
    if (request.schemaVersion !== 1 || request.workspaceId !== expected.workspaceId ||
      request.teamId !== expected.teamId || typeof request.workspaceRoot !== 'string' ||
      !request.workspaceRoot.startsWith('/') || request.workspaceRoot.includes('\0') ||
      typeof request.expectedPlanGeneration !== 'string' ||
      !/^plan-generation_[0-9a-f]{64}$/.test(request.expectedPlanGeneration)) {
      throw new Error('Invalid lifecycle plan admission request')
    }
  }
  if (!queryOperation && operation !== 'authorize') {
    record(payload.authorization, 'lifecycle authorization')
  }
  const context = record(payload.context, 'lifecycle context')
  exactKeys(context, [
    'actorId',
    'sessionId',
    'deploymentId',
    'bootId',
    'requestId',
    'authorizedScope',
    'deadlineAtMs',
  ], 'lifecycle context')
  for (const key of ['actorId', 'sessionId', 'deploymentId', 'bootId', 'requestId']) {
    nonEmptyString(context[key], `lifecycle context.${key}`)
  }
  if (typeof context.authorizedScope !== 'string' || context.authorizedScope.length === 0 ||
    !Number.isSafeInteger(context.deadlineAtMs) || (context.deadlineAtMs as number) < 0) {
    throw new Error('Invalid hosted lifecycle context')
  }
  const authority = decodeLifecycleAuthority(payload.authority)
  if (authority.actorId !== context.actorId ||
    authority.deploymentId !== context.deploymentId ||
    authority.bootId !== context.bootId ||
    authority.workspaceId !== expected.workspaceId ||
    authority.teamId !== expected.teamId ||
    authority.deploymentId !== expected.deploymentId ||
    authority.restoreGeneration !== expected.restoreGeneration ||
    authority.mountGeneration !== expected.mountBinding.mountGeneration ||
    !isDeepStrictEqual(authority.ownerEffectFence, expectedOwnerEffectFence) ||
    authority.bootId !== expected.bootId) {
    throw new Error('Invalid hosted lifecycle authority')
  }
  if (operation === 'replay_lookup' || operation === 'execute') {
    decodeDurableCommand(payload.durableCommand, payload.command, expectedOwnerEffectFence, expected, authority.actorId)
  }
  return { ...payload, authority }
}

function sameStableAuthority(
  actual: HostedControlAuthority,
  expected: HostedControlStableAuthority,
): boolean {
  const { actorId: _, ...stable } = actual
  const { actorId: _ignored, ...stableExpected } = expected as HostedControlAuthority
  return isDeepStrictEqual(stable, stableExpected)
}

function decodeLifecycleAuthority(value: unknown): HostedLifecycleAuthority {
  const authority = record(value, 'lifecycle authority')
  exactKeys(authority, [
    'actorId',
    'workspaceId',
    'teamId',
    'deploymentId',
    'restoreGeneration',
    'mountGeneration',
    'bootId',
    'resourceRevision',
    'ownerEffectFence',
  ], 'lifecycle authority')
  return {
    actorId: nonEmptyString(authority.actorId, 'lifecycle authority.actorId'),
    workspaceId: nonEmptyString(authority.workspaceId, 'lifecycle authority.workspaceId'),
    teamId: nonEmptyString(authority.teamId, 'lifecycle authority.teamId'),
    deploymentId: nonEmptyString(authority.deploymentId, 'lifecycle authority.deploymentId'),
    restoreGeneration: nonNegativeInteger(authority.restoreGeneration, 'lifecycle authority.restoreGeneration'),
    mountGeneration: positiveInteger(authority.mountGeneration, 'lifecycle authority.mountGeneration'),
    bootId: nonEmptyString(authority.bootId, 'lifecycle authority.bootId'),
    resourceRevision: nullableRevision(authority.resourceRevision),
    ownerEffectFence: decodeOwnerEffectFence(authority.ownerEffectFence),
  }
}

function decodeOwnerEffectFence(value: unknown): HostedLifecycleOwnerEffectFence {
  const fence = record(value, 'lifecycle owner effect fence')
  exactKeys(fence, ['grantRevision', 'identityChecksum'], 'lifecycle owner effect fence')
  return {
    grantRevision: patternString(fence.grantRevision, /^[0-9a-f]{64}$/, 'grantRevision'),
    identityChecksum: patternString(fence.identityChecksum, /^[0-9a-f]{64}$/, 'identityChecksum'),
  }
}

function decodeDurableCommand(
  value: unknown,
  commandValue: unknown,
  ownerEffectFence: HostedLifecycleOwnerEffectFence,
  expected: HostedControlStableAuthority,
  actorId: string,
): void {
  const durable = record(value, 'lifecycle durable command')
  exactKeys(durable, ['schemaVersion', 'commandFingerprint', 'idempotency', 'resource'], 'lifecycle durable command')
  if (durable.schemaVersion !== 1) throw new Error('Invalid durable command schema')
  const fingerprint = record(durable.commandFingerprint, 'lifecycle command fingerprint')
  exactKeys(fingerprint, ['algorithm', 'version', 'digest'], 'lifecycle command fingerprint')
  if (fingerprint.algorithm !== 'sha256' || fingerprint.version !== 1) throw new Error('Invalid command fingerprint')
  patternString(fingerprint.digest, /^[0-9a-f]{64}$/, 'command fingerprint digest')
  const command = record(commandValue, 'lifecycle command')
  const idempotency = record(durable.idempotency, 'lifecycle durable idempotency')
  exactKeys(idempotency, ['deploymentId', 'actorId', 'action', 'idempotencyKey'], 'lifecycle durable idempotency')
  const resource = record(durable.resource, 'lifecycle durable resource')
  exactKeys(resource, [
    'bootId', 'workspaceId', 'teamId', 'runId', 'expectedRevision', 'restoreGeneration',
    'mountGeneration', 'ownerEffectFence',
  ], 'lifecycle durable resource')
  if (idempotency.deploymentId !== expected.deploymentId || idempotency.actorId !== actorId ||
    idempotency.action !== command.action || idempotency.idempotencyKey !== command.idempotencyKey ||
    resource.bootId !== expected.bootId || resource.restoreGeneration !== expected.restoreGeneration ||
    resource.mountGeneration !== expected.mountBinding.mountGeneration ||
    resource.workspaceId !== command.workspaceId || resource.teamId !== command.teamId ||
    resource.expectedRevision !== command.expectedRevision ||
    resource.runId !== (command.action === 'launch' ? null : command.runId) ||
    !isDeepStrictEqual(decodeOwnerEffectFence(resource.ownerEffectFence), ownerEffectFence)) {
    throw new Error('Invalid durable command correlation')
  }
  const preimage = [
    'agent-teams.hosted-lifecycle-command/v1', command.schemaVersion, command.action,
    command.commandId, command.idempotencyKey, command.workspaceId, command.teamId,
    command.expectedRevision, command.action === 'launch' ? null : command.runId,
    ownerEffectFence.grantRevision, ownerEffectFence.identityChecksum,
  ]
  const expectedDigest = createHash('sha256').update(JSON.stringify(preimage)).digest('hex')
  if (fingerprint.digest !== expectedDigest) throw new Error('Invalid durable command fingerprint')
}

type LifecycleWireProvenance = {
  from: Record<string, unknown>
  to: Record<string, unknown>
  target: Record<string, unknown>
}

function decodeLifecycleRequestProvenance(
  value: unknown,
  payload: Record<string, unknown>,
  owner: HostedControlOwnerBinding,
  exchangeId: string,
  operation: HostedLifecycleOperation,
): LifecycleWireProvenance {
  const provenance = record(value, 'lifecycle provenance')
  exactKeys(provenance, ['from', 'to', 'target'], 'lifecycle provenance')
  const from = record(provenance.from, 'lifecycle provenance.from')
  exactKeys(from, ['kind', 'deploymentId', 'bootId', 'actorId', 'sessionId'], 'lifecycle provenance.from')
  const to = record(provenance.to, 'lifecycle provenance.to')
  exactKeys(to, ['kind', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId'], 'lifecycle provenance.to')
  const target = record(provenance.target, 'lifecycle provenance.target')
  exactKeys(target, ['capability', 'exchangeId', 'operation', 'workspaceId', 'teamId'], 'lifecycle provenance.target')
  const context = record(payload.context, 'lifecycle context')
  const authority = payload.authority as HostedLifecycleAuthority
  if (from.kind !== 'controller' || from.deploymentId !== context.deploymentId ||
    from.bootId !== context.bootId || from.actorId !== context.actorId || from.sessionId !== context.sessionId ||
    to.kind !== 'owner' || to.ownerAuthority !== owner.ownerAuthority ||
    to.ownerGeneration !== owner.ownerGeneration || to.ownerSessionId !== owner.ownerSessionId ||
    target.capability !== 'hosted-lifecycle-command' || target.exchangeId !== exchangeId ||
    target.operation !== operation || target.workspaceId !== authority.workspaceId || target.teamId !== authority.teamId) {
    throw new Error('Invalid hosted lifecycle provenance')
  }
  return { from, to, target }
}

function reverseLifecycleProvenance(value: LifecycleWireProvenance): LifecycleWireProvenance {
  return { from: value.to, to: value.from, target: value.target }
}

function decodeMessageAuthority(value: unknown): HostedControlAuthority {
  const authority = record(value, 'message authority')
  exactKeys(authority, [
    'actorId',
    'deploymentId',
    'bootId',
    'restoreGeneration',
    'workspaceId',
    'mountBinding',
    'teamId',
  ], 'message authority')
  const mountBinding = record(authority.mountBinding, 'message mount binding')
  exactKeys(mountBinding, ['mountGeneration', 'declaredRootHash'], 'message mount binding')
  return {
    actorId: nonEmptyString(authority.actorId, 'message authority.actorId'),
    deploymentId: nonEmptyString(authority.deploymentId, 'message authority.deploymentId'),
    bootId: nonEmptyString(authority.bootId, 'message authority.bootId'),
    restoreGeneration: nonNegativeInteger(authority.restoreGeneration, 'message authority.restoreGeneration'),
    workspaceId: nonEmptyString(authority.workspaceId, 'message authority.workspaceId'),
    mountBinding: {
      mountGeneration: nonNegativeInteger(mountBinding.mountGeneration, 'message mount generation'),
      declaredRootHash: patternString(mountBinding.declaredRootHash, /^[0-9a-f]{64}$/, 'message declared root hash'),
    },
    teamId: patternString(authority.teamId, /^team_[0-9a-f]{32}$/, 'message team id'),
  }
}

function decodeLifecycleResponsePayload(
  operation: HostedLifecycleOperation,
  value: unknown,
  request: Record<string, unknown> & { authority: HostedLifecycleAuthority },
): Record<string, unknown> {
  const payload = record(value, 'lifecycle response payload')
  const queryOperation = isLifecycleQueryOperation(operation)
  if (payload.schemaVersion !== (queryOperation ? 1 : 2) || typeof payload.kind !== 'string') {
    throw new Error('Invalid hosted lifecycle response payload')
  }
  if (payload.kind === 'unavailable') {
    exactKeys(payload, ['schemaVersion', 'kind', 'retryAfterMs'], 'lifecycle unavailable response')
    lifecycleRetryAfter(payload.retryAfterMs)
    return payload
  }
  if (queryOperation) {
    if (payload.kind === 'not_found') {
      exactKeys(payload, ['schemaVersion', 'kind'], 'lifecycle not found response')
      return payload
    }
    if (operation === 'admit_launch_plan') {
      exactKeys(payload, ['schemaVersion', 'kind', 'workspaceId', 'teamId', 'planGeneration'],
        'lifecycle plan admission response')
      if (payload.kind !== 'admitted' || payload.workspaceId !== request.authority.workspaceId ||
        payload.teamId !== request.authority.teamId ||
        payload.planGeneration !== record(request.request, 'plan admission request').expectedPlanGeneration) {
        throw new Error('Invalid lifecycle plan admission response')
      }
      return payload
    }
    const expectedKind = operation === 'control_state' ? 'control_state' :
      operation === 'prepare' || operation === 'prepare_provisioning' ? 'prepared' :
        operation === 'get_status' ? 'status' : 'provisioning_status'
    if (payload.kind !== expectedKind) throw new Error('Invalid hosted lifecycle projection response')
    const extension = operation === 'prepare' || operation === 'prepare_provisioning' ? ['lanes'] :
      operation === 'get_status' || operation === 'get_provisioning_status' ? ['recentCommands'] : []
    exactKeys(payload, [
      'schemaVersion', 'kind', 'workspaceId', 'teamId', 'deploymentId', 'bootId',
      'runId', 'resourceRevision', 'availableActions', ...extension,
    ], 'lifecycle control state response')
    nonEmptyString(payload.workspaceId, 'control state workspaceId')
    nonEmptyString(payload.teamId, 'control state teamId')
    nonEmptyString(payload.deploymentId, 'control state deploymentId')
    nonEmptyString(payload.bootId, 'control state bootId')
    if (payload.workspaceId !== request.authority.workspaceId || payload.teamId !== request.authority.teamId ||
      payload.deploymentId !== request.authority.deploymentId || payload.bootId !== request.authority.bootId) {
      throw new Error('Invalid hosted lifecycle control state scope')
    }
    if (payload.runId !== null) patternString(payload.runId, /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/, 'control state runId')
    patternString(payload.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'control state resourceRevision')
    if (!Array.isArray(payload.availableActions) || payload.availableActions.some(action =>
      !['launch', 'cancel', 'stop', 'recover'].includes(String(action))) ||
      new Set(payload.availableActions).size !== payload.availableActions.length) {
      throw new Error('Invalid hosted lifecycle available actions')
    }
    if (operation === 'prepare' || operation === 'prepare_provisioning') decodePreparedLanes(payload.lanes)
    if (operation === 'get_status' || operation === 'get_provisioning_status') {
      decodeRecentCommands(payload.recentCommands, request.authority)
    }
    return payload
  }
  if (operation === 'release') {
    exactKeys(payload, ['schemaVersion', 'kind', 'authorization'], 'lifecycle release response')
    if (!['released', 'already_released', 'operator_required'].includes(String(payload.kind))) throw new Error('Invalid hosted lifecycle release response')
    const authorization = decodeLifecycleAuthorization(payload.authorization, request.authority)
    assertLifecycleAuthorizationCorrelation(authorization, request)
    return payload
  }
  if (payload.kind === 'not_found') {
    exactKeys(payload, ['schemaVersion', 'kind'], 'lifecycle not found response')
    return payload
  }
  if (payload.kind === 'conflict') {
    exactKeys(payload, ['schemaVersion', 'kind', 'reason', 'currentRevision'], 'lifecycle conflict response')
    if (!['authorization_changed', 'boot_changed', 'command_in_progress', 'grant_revoked',
      'idempotency_conflict', 'idempotency_mismatch', 'stale_revision', 'stale_run'].includes(String(payload.reason))) {
      throw new Error('Invalid hosted lifecycle conflict reason')
    }
    nullableRevision(payload.currentRevision)
    return payload
  }
  if ((operation === 'authorize' && payload.kind === 'authorized') ||
    (operation === 'revalidate' && payload.kind === 'valid')) {
    exactKeys(payload, ['schemaVersion', 'kind', 'authorization'], 'lifecycle authorization response')
    const authorization = decodeLifecycleAuthorization(payload.authorization, request.authority)
    assertLifecycleAuthorizationCorrelation(authorization, request)
    return payload
  }
  if ((operation === 'execute' || operation === 'replay_lookup') &&
    ['not_started', 'started', 'operator_required', 'idempotency_mismatch'].includes(String(payload.kind))) {
    exactKeys(payload, ['schemaVersion', 'kind', 'durableCommand'], 'lifecycle durable response')
    if (!isDeepStrictEqual(payload.durableCommand, request.durableCommand)) throw new Error('Invalid durable command echo')
    return payload
  }
  if ((operation === 'execute' || operation === 'replay_lookup') && payload.kind === 'settled') {
    exactKeys(payload, ['schemaVersion', 'kind', 'durableCommand', 'result', 'authorization'], 'lifecycle execution response')
    if (!isDeepStrictEqual(payload.durableCommand, request.durableCommand)) throw new Error('Invalid durable command echo')
    const authorization = decodeLifecycleAuthorization(payload.authorization, request.authority)
    assertLifecycleAuthorizationCorrelation(authorization, request)
    decodeLifecyclePublicResult(payload.result, {
      action: record(request.command, 'lifecycle request command').action,
      commandId: record(request.command, 'lifecycle request command').commandId,
      workspaceId: request.authority.workspaceId,
      teamId: request.authority.teamId,
    }, record(request.command, 'lifecycle request command'), authorization)
    return payload
  }
  throw new Error('Invalid hosted lifecycle response payload')
}

function decodeLifecycleAuthorization(
  value: unknown,
  expected: HostedLifecycleAuthority,
): Record<string, unknown> {
  const authorization = record(value, 'lifecycle response authorization')
  exactKeys(authorization, [
    'grantId', 'authorizationGeneration', 'deploymentId', 'bootId', 'resourceRevision',
    'actorId', 'workspaceId', 'teamId', 'restoreGeneration', 'mountGeneration', 'ownerEffectFence',
  ], 'lifecycle response authorization')
  patternString(authorization.grantId, /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'grantId')
  patternString(authorization.authorizationGeneration, /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'authorizationGeneration')
  for (const key of ['deploymentId', 'bootId', 'actorId', 'workspaceId', 'teamId']) {
    nonEmptyString(authorization[key], `authorization.${key}`)
  }
  patternString(authorization.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'authorization.resourceRevision')
  nonNegativeInteger(authorization.restoreGeneration, 'authorization.restoreGeneration')
  positiveInteger(authorization.mountGeneration, 'authorization.mountGeneration')
  const ownerEffectFence = decodeOwnerEffectFence(authorization.ownerEffectFence)
  if (authorization.actorId !== expected.actorId || authorization.workspaceId !== expected.workspaceId ||
    authorization.teamId !== expected.teamId || authorization.deploymentId !== expected.deploymentId ||
    authorization.bootId !== expected.bootId || authorization.restoreGeneration !== expected.restoreGeneration) {
    throw new Error('Invalid hosted lifecycle response authorization scope')
  }
  if (authorization.mountGeneration !== expected.mountGeneration ||
    !isDeepStrictEqual(ownerEffectFence, expected.ownerEffectFence)) throw new Error('Invalid hosted lifecycle authorization fence')
  return authorization
}

function assertLifecycleAuthorizationCorrelation(
  authorization: Record<string, unknown>,
  request: Record<string, unknown>,
): void {
  const command = record(request.command, 'lifecycle request command')
  if (authorization.resourceRevision !== command.expectedRevision) {
    throw new Error('Invalid hosted lifecycle response authorization revision')
  }
  if ('authorization' in request &&
    !isDeepStrictEqual(authorization, record(request.authorization, 'lifecycle request authorization'))) {
    throw new Error('Invalid hosted lifecycle response authorization correlation')
  }
}

function decodeLifecyclePublicResult(
  value: unknown,
  correlation: { action: unknown; commandId: unknown; workspaceId: unknown; teamId: unknown },
  command?: Record<string, unknown>,
  authorization?: Record<string, unknown>,
  options: { allowOperatorRequired?: boolean } = {},
): void {
  const result = record(value, 'lifecycle public result')
  if (result.schemaVersion !== 1 || typeof result.kind !== 'string') throw new Error('Invalid lifecycle public result')
  if (result.kind === 'unavailable') {
    exactKeys(result, ['schemaVersion', 'kind', 'retryAfterMs'], 'lifecycle public unavailable')
    lifecycleRetryAfter(result.retryAfterMs)
    return
  }
  const common = ['schemaVersion', 'kind', 'action', 'commandId', 'workspaceId', 'teamId']
  if (result.kind === 'accepted' || result.kind === 'idempotent_replay') {
    exactKeys(result, [...common, 'runId', 'resourceRevision'], 'lifecycle receipt')
    patternString(result.runId, /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/, 'result.runId')
    patternString(result.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'result.resourceRevision')
  } else if (result.kind === 'conflict') {
    exactKeys(result, [...common, 'reason', 'currentRevision'], 'lifecycle conflict result')
    if (!['authorization_changed', 'boot_changed', 'command_in_progress', 'grant_revoked',
      'idempotency_conflict', 'idempotency_mismatch', 'stale_revision', 'stale_run'].includes(String(result.reason))) {
      throw new Error('Invalid lifecycle public conflict reason')
    }
    nullableRevision(result.currentRevision)
  } else if (result.kind === 'not_found' ||
    (options.allowOperatorRequired === true && result.kind === 'operator_required')) {
    exactKeys(result, common, 'lifecycle not found result')
  } else {
    throw new Error('Invalid lifecycle public result kind')
  }
  if (!['launch', 'cancel', 'stop', 'recover'].includes(String(result.action))) {
    throw new Error('Invalid result.action')
  }
  patternString(result.commandId, /^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'result.commandId')
  nonEmptyString(result.workspaceId, 'result.workspaceId')
  nonEmptyString(result.teamId, 'result.teamId')
  if (result.action !== correlation.action || result.commandId !== correlation.commandId ||
    result.workspaceId !== correlation.workspaceId || result.teamId !== correlation.teamId) {
    throw new Error('Invalid lifecycle public result scope')
  }
  if (command && authorization && (result.kind === 'accepted' || result.kind === 'idempotent_replay') &&
    (result.resourceRevision !== authorization.resourceRevision ||
      (command.action !== 'launch' && result.runId !== command.runId))) {
    throw new Error('Invalid lifecycle public result correlation')
  }
  if (authorization && result.kind === 'conflict' && result.currentRevision !== authorization.resourceRevision) {
    throw new Error('Invalid lifecycle public conflict correlation')
  }
}

function lifecycleResponseRevision(
  operation: HostedLifecycleOperation,
  payload: Record<string, unknown>,
): string | null {
  if (payload.kind === 'not_found' || payload.kind === 'unavailable') return null
  if (operation === 'admit_launch_plan') return null
  if (payload.kind === 'control_state' || payload.kind === 'prepared' || payload.kind === 'status' ||
    payload.kind === 'provisioning_status') return nullableRevision(payload.resourceRevision)
  if (operation === 'release') return nullableRevision(record(payload.authorization, 'lifecycle authorization').resourceRevision)
  if (['not_started', 'started', 'operator_required', 'idempotency_mismatch'].includes(String(payload.kind))) {
    return nullableRevision(record(requestDurableResource(payload), 'durable resource').expectedRevision)
  }
  if (payload.kind === 'conflict') return nullableRevision(payload.currentRevision)
  if ('authorization' in payload) {
    return nullableRevision(record(payload.authorization, 'lifecycle authorization').resourceRevision)
  }
  throw new Error('Invalid lifecycle response revision source')
}

function decodePreparedLanes(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error('Invalid hosted lifecycle prepared lanes')
  }
  const keys = new Set<string>()
  for (const laneValue of value) {
    const lane = record(laneValue, 'lifecycle prepared lane')
    exactKeys(lane, ['laneKey', 'backend', 'status'], 'lifecycle prepared lane')
    const laneKey = nonEmptyString(lane.laneKey, 'laneKey')
    if (keys.has(laneKey)) throw new Error('Invalid duplicate hosted lifecycle lane')
    keys.add(laneKey)
    if (lane.backend !== 'opencode' || !['ready', 'pending', 'unavailable'].includes(String(lane.status))) {
      throw new Error('Invalid hosted lifecycle prepared lane')
    }
  }
}

function decodeRecentCommands(value: unknown, authority: HostedLifecycleAuthority): void {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid hosted lifecycle recent commands')
  const seen = new Set<string>()
  for (const entryValue of value) {
    const entry = record(entryValue, 'lifecycle recent command')
    exactKeys(entry, ['action', 'commandId', 'result'], 'lifecycle recent command')
    if (!['launch', 'cancel', 'stop', 'recover'].includes(String(entry.action))) {
      throw new Error('Invalid hosted lifecycle recent command action')
    }
    patternString(entry.commandId,
      /^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'recent commandId')
    if (seen.has(String(entry.commandId))) throw new Error('Invalid duplicate hosted lifecycle recent command')
    seen.add(String(entry.commandId))
    const result = record(entry.result, 'lifecycle recent command result')
    decodeLifecyclePublicResult(result, {
      action: entry.action,
      commandId: entry.commandId,
      workspaceId: authority.workspaceId,
      teamId: authority.teamId,
    }, undefined, undefined, { allowOperatorRequired: true })
    if (result.action !== entry.action || result.commandId !== entry.commandId ||
      result.workspaceId !== authority.workspaceId || result.teamId !== authority.teamId) {
      throw new Error('Invalid lifecycle recent command correlation')
    }
  }
}

function requestDurableResource(payload: Record<string, unknown>): Record<string, unknown> {
  return record(record(payload.durableCommand, 'durable command').resource, 'durable resource')
}

function decodeMessageResponsePayload(
  operation: HostedTeamMessageOperation,
  payload: Record<string, unknown>,
  request: Record<string, unknown>,
  authority: HostedControlAuthority,
): Record<string, unknown> {
  if (payload.schemaVersion !== 2 || typeof payload.kind !== 'string') throw new Error('Invalid message response payload')
  if (payload.kind === 'unavailable') {
    exactKeys(payload, ['schemaVersion', 'kind', 'retryAfterMs'], 'message unavailable response')
    messageRetryAfter(payload.retryAfterMs)
    return payload
  }
  if (operation === 'message_deliver') {
    exactKeys(payload, ['schemaVersion', 'kind'], 'message delivery response')
    if (!['delivered', 'pending', 'operator_required'].includes(payload.kind)) {
      throw new Error('Invalid message delivery response')
    }
    return payload
  }
  if (payload.kind === 'persisted' || payload.kind === 'idempotent_replay') {
    exactKeys(payload, ['schemaVersion', 'kind', 'receipt'], 'message persistence response')
    const receipt = record(payload.receipt, 'message persistence receipt')
    exactKeys(receipt, ['schemaVersion', 'teamId', 'messageId', 'clientMessageId', 'persistence'], 'message persistence receipt')
    if (receipt.schemaVersion !== 1 || receipt.persistence !== 'durable') throw new Error('Invalid message persistence receipt')
    nonEmptyString(receipt.teamId, 'receipt.teamId')
    patternString(receipt.messageId, /^message_[0-9a-f]{32}$/, 'receipt.messageId')
    patternString(receipt.clientMessageId, /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'receipt.clientMessageId')
    if (receipt.teamId !== authority.teamId || receipt.clientMessageId !== request.clientMessageId) {
      throw new Error('Invalid message persistence receipt scope')
    }
    return payload
  }
  if (payload.kind === 'conflict') {
    exactKeys(payload, ['schemaVersion', 'kind', 'reason'], 'message conflict response')
    if (payload.reason !== 'idempotency_mismatch') throw new Error('Invalid message conflict response')
    return payload
  }
  if (payload.kind === 'not_found') {
    exactKeys(payload, ['schemaVersion', 'kind'], 'message not found response')
    return payload
  }
  throw new Error('Invalid message persistence response')
}

function lifecycleRetryAfter(value: unknown): void {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 60_000)) {
    throw new Error('Invalid retryAfterMs')
  }
}

function messageRetryAfter(value: unknown): void {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
    throw new Error('Invalid retryAfterMs')
  }
}

function verifyDomainProof(
  secret: Uint8Array,
  domain: string,
  direction: string,
  proof: unknown,
  envelope: object,
): void {
  const expected = createHostedDomainProof(secret, domain, direction, envelope)
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof) ||
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'))) {
    throw new Error('Invalid hosted control proof')
  }
}

function verifyRawDomainProof(
  secret: Uint8Array,
  domain: string,
  direction: string,
  proof: unknown,
  serializedUnsignedEnvelope: string,
): void {
  const expected = createHostedRawDomainProof(secret, domain, direction, serializedUnsignedEnvelope)
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof) ||
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'))) {
    throw new Error('Invalid hosted lifecycle raw proof')
  }
}

function isLifecycleOperation(value: unknown): value is HostedLifecycleOperation {
  return LIFECYCLE_OPERATIONS.includes(value as HostedLifecycleOperation)
}
function isLifecycleQueryOperation(operation: HostedLifecycleOperation): boolean {
  return operation === 'control_state' || operation === 'admit_launch_plan' || operation === 'prepare' || operation === 'get_status' ||
    operation === 'prepare_provisioning' || operation === 'get_provisioning_status'
}
function isMessageOperation(value: unknown): value is HostedTeamMessageOperation {
  return MESSAGE_OPERATIONS.includes(value as HostedTeamMessageOperation)
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${field}`)
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, expected: string[], field: string): void {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`Invalid ${field} keys`)
  }
}
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${field}`)
  return value
}
function patternString(value: unknown, pattern: RegExp, field: string): string {
  const string = nonEmptyString(value, field)
  if (!pattern.test(string)) throw new Error(`Invalid ${field}`)
  return string
}
function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${field}`)
  return value as number
}
function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field)
  if (parsed < 1) throw new Error(`Invalid ${field}`)
  return parsed
}
function nullableRevision(value: unknown): string | null {
  if (value === null) return null
  return patternString(value, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'resource revision')
}
