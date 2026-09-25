import { createHmac, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  decodeHostedControlAuthority,
  type HostedControlAuthority,
  type HostedControlOwnerBinding,
  type HostedControlStableAuthority,
} from './protocol.js'

export const PRODUCT_OWNER_BOUND_OPERATIONS = ['task_mutate', 'message_persist', 'message_deliver'] as const
export type ProductOwnerBoundOperation = (typeof PRODUCT_OWNER_BOUND_OPERATIONS)[number]

/**
 * `identityChecksum` is the SHA-256 of the team's published `team.identity.json`; the Owner
 * re-reads that file for every request. `grantRevision` is the requester's Product workspace
 * grant: the Owner has no grant store, and Product revalidates it around the signed exchange.
 */
export type ProductOwnerEffectFence = { grantRevision: string; identityChecksum: string }

export type ProductOwnerBoundRequest = {
  operation: ProductOwnerBoundOperation
  authority: HostedControlAuthority
  ownerEffectFence: ProductOwnerEffectFence
  payload: Record<string, unknown>
  /** Exactly the fields Product signed, in Product's order, including the fenced authority. */
  unsigned: Record<string, unknown>
}

const EXCHANGE_ID: Record<ProductOwnerBoundOperation, RegExp> = {
  task_mutate: /^task-request_[0-9a-f]{32}$/,
  message_persist: /^message-request_[0-9a-f]{32}$/,
  message_deliver: /^message-request_[0-9a-f]{32}$/,
}
const SHA256_HEX = /^[0-9a-f]{64}$/

function isProductOwnerBoundOperation(value: unknown): value is ProductOwnerBoundOperation {
  return PRODUCT_OWNER_BOUND_OPERATIONS.includes(value as ProductOwnerBoundOperation)
}

/** Product's envelope carries the browser grant fence in its authority; the legacy ones do not. */
export function isProductOwnerBoundEnvelope(message: Record<string, unknown>): boolean {
  const authority = message.authority
  return isProductOwnerBoundOperation(message.operation) &&
    typeof authority === 'object' && authority !== null && !Array.isArray(authority) &&
    Object.hasOwn(authority, 'ownerEffectFence')
}

/** Mirrors Product hostedTeamMessageOrchestratorAuthority: the operation is part of the MAC input. */
export function productOwnerBoundProofInput(
  domain: string,
  operation: ProductOwnerBoundOperation,
  direction: 'request' | 'response',
  envelope: Record<string, unknown>,
): string {
  return `${domain}\u0000${operation}\u0000${direction}\u0000${JSON.stringify(envelope)}`
}

export function productOwnerBoundProof(
  secret: Uint8Array,
  domain: string,
  operation: ProductOwnerBoundOperation,
  direction: 'request' | 'response',
  envelope: Record<string, unknown>,
): string {
  return createHmac('sha256', secret).update(productOwnerBoundProofInput(domain, operation, direction, envelope)).digest('hex')
}

export async function openProductOwnerBoundRequest(input: {
  message: Record<string, unknown>
  secret: Uint8Array
  proofDomain: string
  authority: HostedControlStableAuthority
  activeOwner: HostedControlOwnerBinding | null
  verifyOwnerEffectFence: (fence: ProductOwnerEffectFence) => Promise<boolean>
}): Promise<ProductOwnerBoundRequest> {
  const { message } = input
  exactKeys(message, ['schemaVersion', 'exchangeId', 'operation', 'ownerBinding', 'authority', 'payload', 'ownerProof'], 'owner-bound request')
  const operation = message.operation
  if (message.schemaVersion !== 2 || !isProductOwnerBoundOperation(operation) ||
    typeof message.exchangeId !== 'string' || !EXCHANGE_ID[operation].test(message.exchangeId)) {
    throw new Error('Invalid hosted Product owner-bound request')
  }
  if (!input.activeOwner || !isDeepStrictEqual(message.ownerBinding, input.activeOwner)) {
    throw new Error('Invalid hosted Product owner binding')
  }
  const { ownerEffectFence: rawFence, ...controlAuthority } = record(message.authority, 'owner-bound authority')
  const fence = record(rawFence, 'owner effect fence')
  exactKeys(fence, ['grantRevision', 'identityChecksum'], 'owner effect fence')
  if (typeof fence.grantRevision !== 'string' || !SHA256_HEX.test(fence.grantRevision) ||
    typeof fence.identityChecksum !== 'string' || !SHA256_HEX.test(fence.identityChecksum)) {
    throw new Error('Invalid hosted Product owner effect fence')
  }
  const authority = decodeHostedControlAuthority(controlAuthority)
  if (!sameStableAuthority(authority, input.authority)) throw new Error('Invalid hosted Product authority')
  const payload = record(message.payload, 'owner-bound payload')
  const unsigned = {
    schemaVersion: message.schemaVersion,
    exchangeId: message.exchangeId,
    operation,
    ownerBinding: message.ownerBinding,
    authority: message.authority,
    payload,
  }
  const expected = productOwnerBoundProof(input.secret, input.proofDomain, operation, 'request', unsigned)
  if (typeof message.ownerProof !== 'string' || !SHA256_HEX.test(message.ownerProof) ||
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(message.ownerProof, 'hex'))) {
    throw new Error('Invalid hosted Product owner-bound proof')
  }
  const ownerEffectFence = { grantRevision: fence.grantRevision, identityChecksum: fence.identityChecksum }
  if (!(await input.verifyOwnerEffectFence(ownerEffectFence))) {
    throw new Error('Hosted Product owner effect fence does not match the published team identity')
  }
  return { operation, authority, ownerEffectFence, payload, unsigned }
}

export function sealProductOwnerBoundResponse(input: {
  request: ProductOwnerBoundRequest
  payload: Record<string, unknown>
  secret: Uint8Array
  proofDomain: string
}): Record<string, unknown> {
  const unsigned = { ...input.request.unsigned, payload: input.payload }
  return {
    ...unsigned,
    ownerProof: productOwnerBoundProof(input.secret, input.proofDomain, input.request.operation, 'response', unsigned),
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
