import { timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createHostedDomainProof } from './ownerProof.js'
import type {
  HostedControlAuthority,
  HostedControlOwnerBinding,
  HostedControlStableAuthority,
} from './protocol.js'
import {
  HOSTED_LIFECYCLE_PROOF_DOMAIN,
  HOSTED_TEAM_MESSAGE_PROOF_DOMAIN,
} from './HostedControlServer.js'

const LIFECYCLE_OPERATIONS = [
  'control_state',
  'authorize',
  'revalidate',
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
  bootId: string
  resourceRevision: string | null
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
}

export class HostedControlDispatcher {
  constructor(private readonly options: HostedControlDispatcherOptions) {}

  async dispatch(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (isLifecycleOperation(message.operation)) {
      return this.#dispatchLifecycle(message)
    }
    if (isMessageOperation(message.operation)) {
      return this.#dispatchMessage(message)
    }
    return null
  }

  async #dispatchLifecycle(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    exactKeys(message, [
      'schemaVersion',
      'exchangeId',
      'operation',
      'ownerBinding',
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
    const payload = decodeLifecyclePayload(operation, message.payload, this.options.authority)
    const unsigned = {
      schemaVersion: 2,
      exchangeId: message.exchangeId,
      operation,
      ownerBinding: activeOwner,
      payload,
    }
    verifyDomainProof(this.options.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'request', message.ownerProof, unsigned)
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
    const envelope = {
      schemaVersion: 2,
      exchangeId: message.exchangeId,
      operation,
      ownerBinding: activeOwner,
      authority: responseAuthority,
      payload: responsePayload,
    }
    return {
      ...envelope,
      ownerProof: createHostedDomainProof(
        this.options.secret,
        HOSTED_LIFECYCLE_PROOF_DOMAIN,
        'response',
        envelope,
      ),
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

function decodeLifecyclePayload(
  operation: HostedLifecycleOperation,
  value: unknown,
  expected: HostedControlStableAuthority,
): Record<string, unknown> & { authority: HostedLifecycleAuthority } {
  const payload = record(value, 'lifecycle payload')
  const expectedKeys = operation === 'control_state'
    ? ['request', 'context', 'authority']
    : operation === 'authorize'
      ? ['command', 'context', 'authority']
      : ['command', 'authorization', 'context', 'authority']
  exactKeys(payload, expectedKeys, 'lifecycle payload')
  record(payload[operation === 'control_state' ? 'request' : 'command'], 'lifecycle command')
  if (operation !== 'control_state' && operation !== 'authorize') {
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
    authority.bootId !== expected.bootId) {
    throw new Error('Invalid hosted lifecycle authority')
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
    'bootId',
    'resourceRevision',
  ], 'lifecycle authority')
  return {
    actorId: nonEmptyString(authority.actorId, 'lifecycle authority.actorId'),
    workspaceId: nonEmptyString(authority.workspaceId, 'lifecycle authority.workspaceId'),
    teamId: nonEmptyString(authority.teamId, 'lifecycle authority.teamId'),
    deploymentId: nonEmptyString(authority.deploymentId, 'lifecycle authority.deploymentId'),
    restoreGeneration: nonNegativeInteger(authority.restoreGeneration, 'lifecycle authority.restoreGeneration'),
    bootId: nonEmptyString(authority.bootId, 'lifecycle authority.bootId'),
    resourceRevision: nullableRevision(authority.resourceRevision),
  }
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
  if (payload.schemaVersion !== (operation === 'control_state' ? 1 : 2) || typeof payload.kind !== 'string') {
    throw new Error('Invalid hosted lifecycle response payload')
  }
  if (payload.kind === 'unavailable') {
    exactKeys(payload, ['schemaVersion', 'kind', 'retryAfterMs'], 'lifecycle unavailable response')
    lifecycleRetryAfter(payload.retryAfterMs)
    return payload
  }
  if (operation === 'control_state') {
    if (payload.kind === 'not_found') {
      exactKeys(payload, ['schemaVersion', 'kind'], 'lifecycle not found response')
      return payload
    }
    if (payload.kind !== 'control_state') throw new Error('Invalid hosted lifecycle control state response')
    exactKeys(payload, [
      'schemaVersion', 'kind', 'workspaceId', 'teamId', 'deploymentId', 'bootId',
      'runId', 'resourceRevision', 'availableActions',
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
    return payload
  }
  if (operation === 'release') {
    exactKeys(payload, ['schemaVersion', 'kind'], 'lifecycle release response')
    if (payload.kind !== 'released') throw new Error('Invalid hosted lifecycle release response')
    return payload
  }
  if (payload.kind === 'not_found') {
    exactKeys(payload, ['schemaVersion', 'kind'], 'lifecycle not found response')
    return payload
  }
  if (payload.kind === 'conflict') {
    exactKeys(payload, ['schemaVersion', 'kind', 'reason', 'currentRevision'], 'lifecycle conflict response')
    if (!['authorization_changed', 'boot_changed', 'command_in_progress', 'grant_revoked',
      'idempotency_conflict', 'stale_revision', 'stale_run'].includes(String(payload.reason))) {
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
  if (operation === 'execute' && payload.kind === 'result') {
    exactKeys(payload, ['schemaVersion', 'kind', 'result', 'authorization'], 'lifecycle execution response')
    const authorization = decodeLifecycleAuthorization(payload.authorization, request.authority)
    assertLifecycleAuthorizationCorrelation(authorization, request)
    decodeLifecyclePublicResult(payload.result, request, authorization)
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
    'actorId', 'workspaceId', 'teamId', 'restoreGeneration',
  ], 'lifecycle response authorization')
  patternString(authorization.grantId, /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'grantId')
  patternString(authorization.authorizationGeneration, /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'authorizationGeneration')
  for (const key of ['deploymentId', 'bootId', 'actorId', 'workspaceId', 'teamId']) {
    nonEmptyString(authorization[key], `authorization.${key}`)
  }
  patternString(authorization.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'authorization.resourceRevision')
  nonNegativeInteger(authorization.restoreGeneration, 'authorization.restoreGeneration')
  if (authorization.actorId !== expected.actorId || authorization.workspaceId !== expected.workspaceId ||
    authorization.teamId !== expected.teamId || authorization.deploymentId !== expected.deploymentId ||
    authorization.bootId !== expected.bootId || authorization.restoreGeneration !== expected.restoreGeneration) {
    throw new Error('Invalid hosted lifecycle response authorization scope')
  }
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
  request: Record<string, unknown> & { authority: HostedLifecycleAuthority },
  authorization: Record<string, unknown>,
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
      'idempotency_conflict', 'stale_revision', 'stale_run'].includes(String(result.reason))) {
      throw new Error('Invalid lifecycle public conflict reason')
    }
    nullableRevision(result.currentRevision)
  } else if (result.kind === 'not_found') {
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
  const command = record(request.command, 'lifecycle request command')
  if (result.action !== command.action || result.commandId !== command.commandId ||
    result.workspaceId !== request.authority.workspaceId || result.teamId !== request.authority.teamId) {
    throw new Error('Invalid lifecycle public result scope')
  }
  if ((result.kind === 'accepted' || result.kind === 'idempotent_replay') &&
    (result.resourceRevision !== authorization.resourceRevision ||
      (command.action !== 'launch' && result.runId !== command.runId))) {
    throw new Error('Invalid lifecycle public result correlation')
  }
  if (result.kind === 'conflict' && result.currentRevision !== authorization.resourceRevision) {
    throw new Error('Invalid lifecycle public conflict correlation')
  }
}

function lifecycleResponseRevision(
  operation: HostedLifecycleOperation,
  payload: Record<string, unknown>,
): string | null {
  if (operation === 'release' || payload.kind === 'not_found' || payload.kind === 'unavailable') return null
  if (payload.kind === 'control_state') return nullableRevision(payload.resourceRevision)
  if (payload.kind === 'conflict') return nullableRevision(payload.currentRevision)
  if ('authorization' in payload) {
    return nullableRevision(record(payload.authorization, 'lifecycle authorization').resourceRevision)
  }
  throw new Error('Invalid lifecycle response revision source')
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

function isLifecycleOperation(value: unknown): value is HostedLifecycleOperation {
  return LIFECYCLE_OPERATIONS.includes(value as HostedLifecycleOperation)
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
function nullableRevision(value: unknown): string | null {
  if (value === null) return null
  return patternString(value, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'resource revision')
}
