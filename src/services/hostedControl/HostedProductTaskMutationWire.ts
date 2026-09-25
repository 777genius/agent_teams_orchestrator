import { createHmac, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  decodeHostedControlAuthority,
  decodeHostedTaskMutationCommand,
  decodeHostedTaskMutationTerminalResult,
  fingerprintHostedTaskCommand,
  HOSTED_CONTROL_OPERATION,
  type HostedControlAuthority,
  type HostedControlOwnerBinding,
  type HostedControlStableAuthority,
  type HostedTaskMutationRequest,
  type HostedTaskMutationTerminalResult,
} from './protocol.js'
import type { HostedTaskMutationOutcome } from './HostedTaskMutationService.js'

const EXCHANGE_ID = /^task-request_[0-9a-f]{32}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const MAX_SELF_WRITE_EFFECTS = 512

export type HostedProductTaskMutationPort = {
  mutateWithSelfWriteEffects(request: HostedTaskMutationRequest): Promise<HostedTaskMutationOutcome>
}

/**
 * Product's owner-bound mutation envelope carries the browser grant fence in its
 * authority and signs the operation name; the legacy control envelope does neither.
 */
export function isProductTaskMutationEnvelope(message: Record<string, unknown>): boolean {
  const authority = message.authority
  return message.operation === HOSTED_CONTROL_OPERATION &&
    typeof authority === 'object' && authority !== null && !Array.isArray(authority) &&
    Object.hasOwn(authority, 'ownerEffectFence')
}

export async function dispatchProductTaskMutation(input: {
  message: Record<string, unknown>
  secret: Uint8Array
  proofDomain: string
  authority: HostedControlStableAuthority
  activeOwner: HostedControlOwnerBinding | null
  tasks: HostedProductTaskMutationPort
}): Promise<Record<string, unknown>> {
  const { message } = input
  exactKeys(message, ['schemaVersion', 'exchangeId', 'operation', 'ownerBinding', 'authority', 'payload', 'ownerProof'], 'task request')
  if (message.schemaVersion !== 2 || message.operation !== HOSTED_CONTROL_OPERATION ||
    typeof message.exchangeId !== 'string' || !EXCHANGE_ID.test(message.exchangeId)) {
    throw new Error('Invalid hosted Product task request')
  }
  if (!input.activeOwner || !isDeepStrictEqual(message.ownerBinding, input.activeOwner)) {
    throw new Error('Invalid hosted Product task owner binding')
  }
  const wireAuthority = record(message.authority, 'task authority')
  const { ownerEffectFence, ...controlAuthority } = wireAuthority
  const fence = record(ownerEffectFence, 'task owner effect fence')
  exactKeys(fence, ['grantRevision', 'identityChecksum'], 'task owner effect fence')
  if (typeof fence.grantRevision !== 'string' || !SHA256_HEX.test(fence.grantRevision) ||
    typeof fence.identityChecksum !== 'string' || !SHA256_HEX.test(fence.identityChecksum)) {
    throw new Error('Invalid hosted Product task owner effect fence')
  }
  const authority = decodeHostedControlAuthority(controlAuthority)
  if (!sameStableAuthority(authority, input.authority)) throw new Error('Invalid hosted Product task authority')
  const payload = record(message.payload, 'task payload')
  exactKeys(payload, ['command', 'payloadFingerprint'], 'task payload')
  const command = decodeHostedTaskMutationCommand(payload.command)
  if (command.teamId !== authority.teamId || payload.payloadFingerprint !== fingerprintHostedTaskCommand(command)) {
    throw new Error('Invalid hosted Product task payload')
  }
  const unsignedRequest = {
    schemaVersion: message.schemaVersion,
    exchangeId: message.exchangeId,
    operation: message.operation,
    ownerBinding: message.ownerBinding,
    authority: message.authority,
    payload: message.payload,
  }
  verifyProof(input, 'request', unsignedRequest, message.ownerProof)

  const request: HostedTaskMutationRequest = {
    schemaVersion: 2,
    exchangeId: message.exchangeId,
    operation: HOSTED_CONTROL_OPERATION,
    ownerBinding: input.activeOwner,
    authority,
    payload: { command, payloadFingerprint: payload.payloadFingerprint },
    ownerProof: message.ownerProof as string,
  }
  const outcome = await input.tasks.mutateWithSelfWriteEffects(request)
  const result = decodeHostedTaskMutationTerminalResult(outcome.result)
  if (!resultMatchesRequest(request, result)) throw new Error('Hosted Product task result does not match its request')
  const unsignedResponse = {
    ...unsignedRequest,
    payload: productTaskMutationPayload(result, outcome.selfWriteEffects),
  }
  return { ...unsignedResponse, ownerProof: proof(input, 'response', unsignedResponse) }
}

/** Product's task-board result schema (hostedTaskBoardOrchestratorAuthority). */
export function productTaskMutationPayload(
  result: HostedTaskMutationTerminalResult,
  selfWriteEffects: HostedTaskMutationOutcome['selfWriteEffects'],
): Record<string, unknown> {
  if (result.kind === 'committed') {
    if (selfWriteEffects.length > MAX_SELF_WRITE_EFFECTS) throw new Error('Hosted Product task self-write effects exceed the limit')
    return { schemaVersion: 1, ...result, selfWriteEffects: selfWriteEffects.map(effect => ({ ...effect })) }
  }
  if (result.kind === 'unavailable') {
    return { schemaVersion: 1, kind: 'unavailable', retryAfterMs: result.retryAfterMs ?? null }
  }
  return { schemaVersion: 1, ...result }
}

function resultMatchesRequest(request: HostedTaskMutationRequest, result: HostedTaskMutationTerminalResult): boolean {
  if (result.kind !== 'committed' && result.kind !== 'idempotent_replay') return true
  const command = request.payload.command
  return result.payloadFingerprint === request.payload.payloadFingerprint &&
    result.currentSourceGeneration === command.expectedSourceGeneration &&
    result.receipt.commandId === command.commandId &&
    result.receipt.teamId === command.teamId &&
    result.receipt.sourceGeneration === command.expectedSourceGeneration
}

function proof(
  input: { secret: Uint8Array; proofDomain: string },
  direction: 'request' | 'response',
  envelope: Record<string, unknown>,
): string {
  return createHmac('sha256', input.secret)
    .update(`${input.proofDomain}\u0000${HOSTED_CONTROL_OPERATION}\u0000${direction}\u0000${JSON.stringify(envelope)}`)
    .digest('hex')
}

function verifyProof(
  input: { secret: Uint8Array; proofDomain: string },
  direction: 'request',
  envelope: Record<string, unknown>,
  actual: unknown,
): void {
  const expected = proof(input, direction, envelope)
  if (typeof actual !== 'string' || !SHA256_HEX.test(actual) ||
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new Error('Invalid hosted Product task proof')
  }
}

function sameStableAuthority(actual: HostedControlAuthority, expected: HostedControlStableAuthority): boolean {
  const { actorId: _, ...stable } = actual
  const { actorId: _ignored, ...stableExpected } = expected as HostedControlAuthority
  return isDeepStrictEqual(stable, stableExpected)
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
