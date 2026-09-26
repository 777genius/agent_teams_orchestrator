import { createHmac, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  decodeHostedControlAuthority,
  type HostedControlAuthority,
  type HostedControlOwnerBinding,
  type HostedControlStableAuthority,
} from './protocol.js'

export const PRODUCT_OWNER_BOUND_OPERATIONS = ['task_mutate', 'message_send'] as const
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
  message_send: /^message-request_[0-9a-f]{32}$/,
}
const SHA256_HEX = /^[0-9a-f]{64}$/

/** A reason made only of fixed codes and field names; safe to log without request data. */
export class ProductOwnerBoundRejection extends Error {
  constructor(readonly reason: string) {
    super(`Hosted Product owner-bound request rejected: ${reason}`)
    this.name = 'ProductOwnerBoundRejection'
  }
}

export type ProductOwnerEffectFenceDecision =
  | 'current'
  | 'identity-file-unavailable'
  | 'identity-checksum-mismatch'
  | 'identity-team-mismatch'

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
  verifyOwnerEffectFence: (fence: ProductOwnerEffectFence) => Promise<ProductOwnerEffectFenceDecision>
}): Promise<ProductOwnerBoundRequest> {
  const { message } = input
  exactKeys(message, ['schemaVersion', 'exchangeId', 'operation', 'ownerBinding', 'authority', 'payload', 'ownerProof'], 'request-keys')
  const operation = message.operation
  if (message.schemaVersion !== 2 || !isProductOwnerBoundOperation(operation) ||
    typeof message.exchangeId !== 'string' || !EXCHANGE_ID[operation].test(message.exchangeId)) {
    throw new ProductOwnerBoundRejection('request-header')
  }
  if (!input.activeOwner) throw new ProductOwnerBoundRejection('owner-binding:inactive')
  const bindingDrift = differingFields(message.ownerBinding, input.activeOwner)
  if (bindingDrift.length > 0) throw new ProductOwnerBoundRejection(`owner-binding:${bindingDrift.join(',')}`)
  const { ownerEffectFence: rawFence, ...controlAuthority } = record(message.authority, 'authority')
  const fence = record(rawFence, 'fence')
  exactKeys(fence, ['grantRevision', 'identityChecksum'], 'fence-keys')
  if (typeof fence.grantRevision !== 'string' || !SHA256_HEX.test(fence.grantRevision) ||
    typeof fence.identityChecksum !== 'string' || !SHA256_HEX.test(fence.identityChecksum)) {
    throw new ProductOwnerBoundRejection('fence-shape')
  }
  let authority: HostedControlAuthority
  try {
    authority = decodeHostedControlAuthority(controlAuthority)
  } catch {
    throw new ProductOwnerBoundRejection(`authority-shape:${Object.keys(controlAuthority).sort().join(',')}`)
  }
  const { actorId: _actor, ...stableAuthority } = authority
  const authorityDrift = differingFields(stableAuthority, input.authority)
  if (authorityDrift.length > 0) throw new ProductOwnerBoundRejection(`authority:${authorityDrift.join(',')}`)
  const payload = record(message.payload, 'payload')
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
    throw new ProductOwnerBoundRejection('proof')
  }
  const ownerEffectFence = { grantRevision: fence.grantRevision, identityChecksum: fence.identityChecksum }
  const fenceDecision = await input.verifyOwnerEffectFence(ownerEffectFence)
  if (fenceDecision !== 'current') throw new ProductOwnerBoundRejection(`team identity fence:${fenceDecision}`)
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

/** Names of top-level (and one nested level of) fields that differ; never their values. */
function differingFields(actual: unknown, expected: unknown): string[] {
  const left = (actual && typeof actual === 'object' ? actual : {}) as Record<string, unknown>
  const right = (expected && typeof expected === 'object' ? expected : {}) as Record<string, unknown>
  const drift: string[] = []
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (isDeepStrictEqual(left[key], right[key])) continue
    const nested = left[key] && right[key] && typeof left[key] === 'object' && typeof right[key] === 'object'
      ? differingFields(left[key], right[key]).map(field => `${key}.${field}`)
      : []
    drift.push(...(nested.length > 0 ? nested : [key]))
  }
  return drift
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProductOwnerBoundRejection(`${field}-shape`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: string[], field: string): void {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new ProductOwnerBoundRejection(field)
  }
}
