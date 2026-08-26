import { createHash, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  createHostedRawDomainProof,
  parseStrictHostedSignedJsonFrame,
} from './ownerProof.js'
import {
  type HostedControlAuthority,
  type HostedControlOwnerBinding,
  type HostedControlStableAuthority,
} from './protocol.js'
import { containsHostPath } from './hostPathSafety.js'

export const HOSTED_APPROVAL_PROOF_DOMAIN =
  'agent-teams.hosted-runtime-approval.owner-proof/v1'
export const HOSTED_APPROVAL_WIRE_SCHEMA_VERSION = 4 as const
export const HOSTED_APPROVAL_WIRE_CAPABILITY =
  '{"format":"agent-teams.hosted-approval-wire-capability/v1","wireSchemaVersion":4,"ownerProofDomain":"agent-teams.hosted-runtime-approval.owner-proof/v1","operations":["approval_ingress_claim","approval_ingress_ack","approval_ingress_authority_resolve","approval_decision_deliver","approval_decision_reconcile"],"openCodeProtocol":"agent-teams-hosted-approval-v2","openCodeSchemaVersion":2}' as const
export const HOSTED_APPROVAL_WIRE_CAPABILITY_DIGEST =
  '40a6c4a131b4e64c04b87337fbce667c91f274fb85b3879c6cdcac49dbbbd639' as const
/** Includes the newline delimiter consumed by HostedControlServer. */
export const HOSTED_APPROVAL_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const HOSTED_APPROVAL_MAX_CLAIM_RECORDS = 100
export const HOSTED_APPROVAL_CLAIM_FRAME_RESERVE_BYTES = 8 * 1024
export const HOSTED_APPROVAL_MAX_CLAIM_AGGREGATE_BYTES =
  HOSTED_APPROVAL_MAX_FRAME_BYTES - HOSTED_APPROVAL_CLAIM_FRAME_RESERVE_BYTES
export const HOSTED_APPROVAL_MAX_PAYLOAD_JSON_BYTES = 136 * 1024
export const HOSTED_APPROVAL_MAX_RECORD_BYTES = 272 * 1024
export const HOSTED_APPROVAL_MAX_PREVIEW_CONTENT_BYTES = 64 * 1024
export const HOSTED_APPROVAL_MAX_SUMMARY_BYTES = 2 * 1024

const OPERATIONS = [
  'approval_ingress_claim',
  'approval_ingress_ack',
  'approval_ingress_authority_resolve',
  'approval_decision_deliver',
  'approval_decision_reconcile',
] as const

export type HostedApprovalOperation = (typeof OPERATIONS)[number]
export type HostedApprovalDecision = 'allow' | 'deny' | 'timeout'

export type HostedApprovalIngressAuthority = {
  deploymentId: string
  teamId: string
  runId: string
  planGeneration: number
  laneId: string
  providerId: 'anthropic' | 'codex' | 'gemini' | 'opencode'
  credentialGeneration: number
  credentialId: string
  sessionId: string
  runtimeInstanceId: string
  deliveryOwnerId: string
}

export type HostedApprovalIngressLease = {
  generation: number
  ownerId: string
  leaseToken: string
  claimedAtIso: string
  leaseExpiresAtIso: string
}

export type HostedApprovalIngressRecord = {
  outboxVersion: 1
  outboxId: string
  commandId: string
  effectRef: string
  deliveryRef: string
  authority: HostedApprovalIngressAuthority
  payloadJson: string
  observedAtIso: string
  acceptedAtIso: string
  lease: HostedApprovalIngressLease | null
  acknowledgedAtIso: string | null
}

export type HostedApprovalClaimRequest = {
  ownerId: string
  leaseToken: string
  leaseDurationMs: number
  limit: number
}

export type HostedApprovalAckRequest = {
  outboxId: string
  generation: number
  ownerId: string
  leaseToken: string
}

export type HostedApprovalAckResult = {
  status: 'acknowledged' | 'already_acknowledged' | 'conflict' | 'unavailable'
}

export type HostedApprovalAuthorityScope = {
  principalId: string
  workspaceId: string
  teamId: string
  authorityGeneration: string
  restoreGeneration: number
}

export type HostedApprovalAuthorityResult =
  | { status: 'resolved'; scope: HostedApprovalAuthorityScope }
  | { status: 'stale_generation' | 'wrong_lane' | 'unavailable' }

export type HostedApprovalDeliveryRequest = {
  providerDeliveryId: string
  reconciliationRef: string
  principal:
    | { kind: 'operator'; actorId: string }
    | { kind: 'system_timeout' }
  deliveryRef: string
  approvalId: string
  approvalGeneration: string
  decision: HostedApprovalDecision
  partition: { teamId: string; runId: string }
  requestId: string
}

export type HostedApprovalDeliveryResult =
  | { status:
    | 'delivered'
    | 'idempotent_replay'
    | 'stale_generation'
    | 'expired'
    | 'wrong_lane'
    | 'self_approval'
    | 'unavailable'
  }
  | { status: 'operator_required'; reconciliationRef: string }

export type HostedApprovalReconciliationRequest = {
  reconciliationRef: string
  providerDeliveryId: string
  partition: { teamId: string; runId: string }
}

export type HostedApprovalReconciliationResult = {
  status: 'delivered' | 'not_delivered' | 'operator_required' | 'unavailable'
}

/** Internal conflict signal; it is never serialized as a product result. */
export type HostedApprovalDeliveryPortResult =
  | HostedApprovalDeliveryResult
  | { status: 'conflict' }

export type HostedApprovalDeliveryAuthorization = {
  /** Opaque owner-local compare-and-effect capability; never serialized. */
  token: string
  persistedAuthority: HostedApprovalIngressAuthority
}

export type HostedApprovalDeliveryAuthorizationResult =
  | { status: 'authorized'; authorization: HostedApprovalDeliveryAuthorization }
  | HostedApprovalDeliveryPortResult

export type HostedApprovalWirePort = {
  /** Claims only the ordered prefix that fits maximumAggregateBytes. */
  claimIngress(input: {
    request: HostedApprovalClaimRequest
    maximumAggregateBytes: number
  }): Promise<readonly HostedApprovalIngressRecord[]>
  acknowledgeIngress(request: HostedApprovalAckRequest): Promise<HostedApprovalAckResult>
  /** Returns the separately admitted private binding; never derive it from a launch plan. */
  getAdmittedIngressAuthority(
    authority: HostedApprovalIngressAuthority,
  ): Promise<HostedApprovalIngressAuthority | null>
  resolveIngressAuthority(authority: HostedApprovalIngressAuthority): Promise<HostedApprovalAuthorityResult>
  /**
   * Atomically resolves providerDeliveryId + deliveryRef + payloadFingerprint
   * to persisted immutable authority and returns an opaque authorization.
   */
  authorizeDecision(input: {
    request: HostedApprovalDeliveryRequest
    payloadFingerprint: string
  }): Promise<HostedApprovalDeliveryAuthorizationResult>
  /**
   * Immediately before effect, atomically revalidates the opaque authorization,
   * providerDeliveryId, deliveryRef, payloadFingerprint, and exact admitted
   * authority. Any change returns unavailable without invoking provider effect.
   * Equal settled bindings return idempotent_replay; different fingerprints
   * return conflict and are never serialized.
   * An operator actorId is authenticated and is not a MemberId. The lifecycle
   * owner must resolve it through its admitted private ActorId -> MemberId
   * mapping and compare the resolved MemberId with the persisted ingress
   * deliveryOwnerId. A missing mapping returns unavailable; direct string
   * comparison between principalId and deliveryOwnerId is forbidden.
   */
  deliverDecision(input: {
    request: HostedApprovalDeliveryRequest
    payloadFingerprint: string
    authorization: HostedApprovalDeliveryAuthorization
    admittedAuthority: HostedApprovalIngressAuthority
  }): Promise<HostedApprovalDeliveryPortResult>
  /** Classifies durable evidence only. This operation must never call the provider effect. */
  reconcileDecision(request: HostedApprovalReconciliationRequest): Promise<HostedApprovalReconciliationResult>
}

export type HostedApprovalWireDispatcherOptions = {
  secret: Uint8Array
  authority: HostedControlStableAuthority
  getOwnerBinding: () => HostedControlOwnerBinding | null
  approvals: HostedApprovalWirePort
}

export class HostedApprovalWireDispatcher {
  constructor(private readonly options: HostedApprovalWireDispatcherOptions) {}

  async dispatch(
    message: Record<string, unknown>,
    rawLine: string,
  ): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(rawLine, 'utf8') + 1 > HOSTED_APPROVAL_MAX_FRAME_BYTES) {
      throw new Error('Hosted approval request frame exceeds limit')
    }
    const signed = parseStrictHostedSignedJsonFrame(rawLine)
    if (!isDeepStrictEqual(signed.value, message)) {
      throw new Error('Invalid hosted approval raw frame')
    }
    exactKeys(message, [
      'schemaVersion', 'exchangeId', 'operation', 'ownerBinding',
      'authority', 'payload', 'ownerProof',
    ], 'approval request')
    if (message.schemaVersion !== HOSTED_APPROVAL_WIRE_SCHEMA_VERSION ||
      typeof message.exchangeId !== 'string' ||
      !/^approval-request_[0-9a-f]{32}$/.test(message.exchangeId) ||
      !isHostedApprovalOperation(message.operation)) {
      throw new Error('Invalid hosted approval request')
    }
    const activeOwner = this.options.getOwnerBinding()
    if (!activeOwner || !isDeepStrictEqual(message.ownerBinding, activeOwner)) {
      throw new Error('Invalid hosted approval owner binding')
    }
    const wireAuthority = decodeApprovalWireAuthority(message.authority)
    if (!sameWireAuthority(wireAuthority, this.options.authority)) {
      throw new Error('Invalid hosted approval authority')
    }
    verifyRawProof(
      this.options.secret,
      signed.ownerProof,
      signed.serializedUnsignedEnvelope,
      'request',
    )

    const runtimeAuthority: HostedControlAuthority = {
      ...wireAuthority,
      teamId: this.options.authority.teamId,
    }
    const payload = await this.#dispatchPayload(message.operation, message.payload, runtimeAuthority)
    const envelope = {
      schemaVersion: HOSTED_APPROVAL_WIRE_SCHEMA_VERSION,
      exchangeId: message.exchangeId,
      operation: message.operation,
      ownerBinding: activeOwner,
      authority: wireAuthority,
      payload,
    }
    const serialized = JSON.stringify(envelope)
    const ownerProof = createHostedRawDomainProof(
      this.options.secret,
      HOSTED_APPROVAL_PROOF_DOMAIN,
      'response',
      serialized,
    )
    const response = { ...envelope, ownerProof }
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') + 1 > HOSTED_APPROVAL_MAX_FRAME_BYTES) {
      throw new Error('Hosted approval response frame exceeds limit')
    }
    return response
  }

  async #dispatchPayload(
    operation: HostedApprovalOperation,
    value: unknown,
    outerAuthority: HostedControlAuthority,
  ): Promise<unknown> {
    switch (operation) {
      case 'approval_ingress_claim': {
        const request = decodeClaimRequest(value)
        const records = [...await this.options.approvals.claimIngress({
          request,
          maximumAggregateBytes: HOSTED_APPROVAL_MAX_CLAIM_AGGREGATE_BYTES,
        })]
        if (records.length > request.limit || records.length > HOSTED_APPROVAL_MAX_CLAIM_RECORDS) {
          throw new Error('Invalid hosted approval claim response count')
        }
        const decoded: HostedApprovalIngressRecord[] = []
        const outboxIds = new Set<string>()
        for (const record of records) {
          const admitted = decodeHostedApprovalIngressRecord(record, outerAuthority)
          if (!admitted.lease || admitted.lease.ownerId !== request.ownerId ||
            admitted.lease.leaseToken !== request.leaseToken || admitted.acknowledgedAtIso !== null ||
            outboxIds.has(admitted.outboxId)) {
            throw new Error('Invalid hosted approval claim response correlation')
          }
          outboxIds.add(admitted.outboxId)
          const privateBinding = await this.options.approvals.getAdmittedIngressAuthority(admitted.authority)
          if (!privateBinding || !isDeepStrictEqual(privateBinding, admitted.authority)) {
            throw new Error('Hosted approval ingress authority is not privately admitted')
          }
          decoded.push(admitted)
        }
        if (Buffer.byteLength(JSON.stringify(decoded), 'utf8') > HOSTED_APPROVAL_MAX_CLAIM_AGGREGATE_BYTES) {
          throw new Error('Invalid hosted approval claim response bytes')
        }
        return decoded
      }
      case 'approval_ingress_ack': {
        const result = await this.options.approvals.acknowledgeIngress(decodeAckRequest(value))
        return decodeStatus(result, [
          'acknowledged', 'already_acknowledged', 'conflict', 'unavailable',
        ], 'approval acknowledgement result')
      }
      case 'approval_ingress_authority_resolve': {
        const authority = decodeHostedApprovalIngressAuthority(value)
        bindIngressAuthority(authority, outerAuthority)
        const privateBinding = await this.options.approvals.getAdmittedIngressAuthority(authority)
        if (!privateBinding || !isDeepStrictEqual(privateBinding, authority)) {
          return { status: 'unavailable' }
        }
        return decodeAuthorityResult(
          await this.options.approvals.resolveIngressAuthority(authority),
          outerAuthority,
        )
      }
      case 'approval_decision_deliver': {
        const request = decodeDeliveryRequest(value)
        if (request.partition.teamId !== outerAuthority.teamId) {
          throw new Error('Invalid hosted approval delivery partition')
        }
        const payloadFingerprint = fingerprintHostedApprovalDelivery(request)
        const authorizationResult = await this.options.approvals.authorizeDecision({
          request, payloadFingerprint,
        })
        if (authorizationResult.status !== 'authorized') {
          return decodeDeliveryResult(authorizationResult, request.reconciliationRef)
        }
        const authorization = decodeDeliveryAuthorization(authorizationResult)
        const persistedAuthority = authorization.persistedAuthority
        bindIngressAuthority(persistedAuthority, outerAuthority)
        const admittedAuthority = await this.options.approvals
          .getAdmittedIngressAuthority(persistedAuthority)
        if (!admittedAuthority || !isDeepStrictEqual(admittedAuthority, persistedAuthority)) {
          return { status: 'unavailable' }
        }
        const result = await this.options.approvals.deliverDecision({
          request,
          payloadFingerprint,
          authorization,
          admittedAuthority,
        })
        return decodeDeliveryResult(result, request.reconciliationRef)
      }
      case 'approval_decision_reconcile': {
        const request = decodeReconciliationRequest(value)
        if (request.partition.teamId !== outerAuthority.teamId) {
          throw new Error('Invalid hosted approval reconciliation partition')
        }
        return decodeReconciliationResult(
          await this.options.approvals.reconcileDecision(request),
        )
      }
    }
  }
}

function decodeDeliveryAuthorization(
  value: unknown,
): HostedApprovalDeliveryAuthorization {
  const result = record(value, 'approval delivery authorization result')
  exactKeys(result, ['status', 'authorization'], 'approval delivery authorization result')
  if (result.status !== 'authorized') throw new Error('Invalid approval delivery authorization status')
  const authorization = record(result.authorization, 'approval delivery authorization')
  exactKeys(authorization, ['token', 'persistedAuthority'], 'approval delivery authorization')
  return {
    token: identifier(authorization.token, 'approval delivery authorization token'),
    persistedAuthority: decodeHostedApprovalIngressAuthority(authorization.persistedAuthority),
  }
}

function decodeDeliveryResult(value: unknown, expectedReconciliationRef: string): HostedApprovalDeliveryResult {
  if (record(value, 'approval delivery result').status === 'conflict') {
    throw new Error('Hosted approval delivery idempotency conflict')
  }
  const input = record(value, 'approval delivery result')
  if (input.status === 'operator_required') {
    exactKeys(input, ['status', 'reconciliationRef'], 'approval delivery result')
    if (input.reconciliationRef !== expectedReconciliationRef) {
      throw new Error('Invalid approval reconciliationRef correlation')
    }
    return {
      status: 'operator_required',
      reconciliationRef: reconciliationRef(input.reconciliationRef),
    }
  }
  return decodeStatus(input, [
      'delivered', 'idempotent_replay', 'stale_generation', 'expired',
      'wrong_lane', 'self_approval', 'unavailable',
    ],
    'approval delivery result',
  )
}

function decodeReconciliationResult(value: unknown): HostedApprovalReconciliationResult {
  return decodeStatus(value, [
    'delivered', 'not_delivered', 'operator_required', 'unavailable',
  ], 'approval reconciliation result')
}

export function isHostedApprovalOperation(value: unknown): value is HostedApprovalOperation {
  return OPERATIONS.includes(value as HostedApprovalOperation)
}

export function fingerprintHostedApprovalDelivery(request: HostedApprovalDeliveryRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function decodeClaimRequest(value: unknown): HostedApprovalClaimRequest {
  const input = record(value, 'approval claim request')
  exactKeys(input, ['ownerId', 'leaseToken', 'leaseDurationMs', 'limit'], 'approval claim request')
  return {
    ownerId: identifier(input.ownerId, 'approval claim ownerId'),
    leaseToken: identifier(input.leaseToken, 'approval claim leaseToken'),
    leaseDurationMs: integer(input.leaseDurationMs, 'approval claim leaseDurationMs', 1, 300_000),
    limit: integer(input.limit, 'approval claim limit', 1, HOSTED_APPROVAL_MAX_CLAIM_RECORDS),
  }
}

function decodeAckRequest(value: unknown): HostedApprovalAckRequest {
  const input = record(value, 'approval acknowledgement request')
  exactKeys(input, ['outboxId', 'generation', 'ownerId', 'leaseToken'], 'approval acknowledgement request')
  return {
    outboxId: patterned(input.outboxId, /^runtime_permission:effect:[a-f0-9]{64}$/, 'approval outboxId'),
    generation: integer(input.generation, 'approval acknowledgement generation', 1),
    ownerId: identifier(input.ownerId, 'approval acknowledgement ownerId'),
    leaseToken: identifier(input.leaseToken, 'approval acknowledgement leaseToken'),
  }
}

export function decodeHostedApprovalIngressRecord(
  value: unknown,
  outerAuthority: HostedControlAuthority,
): HostedApprovalIngressRecord {
  const input = record(value, 'approval ingress record')
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > HOSTED_APPROVAL_MAX_RECORD_BYTES) {
    throw new Error('Invalid approval ingress record bytes')
  }
  exactKeys(input, [
    'outboxVersion', 'outboxId', 'commandId', 'effectRef', 'deliveryRef',
    'authority', 'payloadJson', 'observedAtIso', 'acceptedAtIso', 'lease',
    'acknowledgedAtIso',
  ], 'approval ingress record')
  if (input.outboxVersion !== 1) throw new Error('Invalid approval ingress record version')
  const outboxId = patterned(input.outboxId, /^runtime_permission:effect:[a-f0-9]{64}$/, 'approval outboxId')
  const effectRef = patterned(input.effectRef, /^effect:[a-f0-9]{64}$/, 'approval effectRef')
  if (outboxId !== `runtime_permission:${effectRef}`) throw new Error('Invalid approval outbox binding')
  const authority = decodeHostedApprovalIngressAuthority(input.authority)
  bindIngressAuthority(authority, outerAuthority)
  const payloadJson = boundedText(input.payloadJson, 'approval payloadJson', HOSTED_APPROVAL_MAX_PAYLOAD_JSON_BYTES, true)
  validateApprovalPayloadJson(payloadJson, String(input.deliveryRef))
  const observedAtIso = iso(input.observedAtIso, 'approval observedAtIso')
  const acceptedAtIso = iso(input.acceptedAtIso, 'approval acceptedAtIso')
  const lease = input.lease === null ? null : decodeLease(input.lease)
  const acknowledgedAtIso = input.acknowledgedAtIso === null
    ? null
    : iso(input.acknowledgedAtIso, 'approval acknowledgedAtIso')
  if (Date.parse(acceptedAtIso) < Date.parse(observedAtIso) ||
    acknowledgedAtIso !== null && (!lease || Date.parse(acknowledgedAtIso) < Date.parse(acceptedAtIso))) {
    throw new Error('Invalid approval ingress timestamps')
  }
  return {
    outboxVersion: 1,
    outboxId,
    commandId: identifier(input.commandId, 'approval commandId'),
    effectRef,
    deliveryRef: deliveryRef(input.deliveryRef),
    authority,
    payloadJson,
    observedAtIso,
    acceptedAtIso,
    lease,
    acknowledgedAtIso,
  }
}

function decodeLease(value: unknown): HostedApprovalIngressLease {
  const input = record(value, 'approval ingress lease')
  exactKeys(input, ['generation', 'ownerId', 'leaseToken', 'claimedAtIso', 'leaseExpiresAtIso'], 'approval ingress lease')
  const claimedAtIso = iso(input.claimedAtIso, 'approval lease claimedAtIso')
  const leaseExpiresAtIso = iso(input.leaseExpiresAtIso, 'approval lease leaseExpiresAtIso')
  const duration = Date.parse(leaseExpiresAtIso) - Date.parse(claimedAtIso)
  if (duration < 1 || duration > 300_000) throw new Error('Invalid approval ingress lease duration')
  return {
    generation: integer(input.generation, 'approval lease generation', 1),
    ownerId: identifier(input.ownerId, 'approval lease ownerId'),
    leaseToken: identifier(input.leaseToken, 'approval lease leaseToken'),
    claimedAtIso,
    leaseExpiresAtIso,
  }
}

export function decodeHostedApprovalIngressAuthority(value: unknown): HostedApprovalIngressAuthority {
  const input = record(value, 'approval ingress authority')
  exactKeys(input, [
    'deploymentId', 'teamId', 'runId', 'planGeneration', 'laneId', 'providerId',
    'credentialGeneration', 'credentialId', 'sessionId', 'runtimeInstanceId',
    'deliveryOwnerId',
  ], 'approval ingress authority')
  if (!['anthropic', 'codex', 'gemini', 'opencode'].includes(String(input.providerId))) {
    throw new Error('Invalid approval providerId')
  }
  return {
    deploymentId: patterned(input.deploymentId, /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/, 'approval deploymentId'),
    teamId: canonicalId(input.teamId, 'team', 'approval teamId'),
    runId: canonicalId(input.runId, 'run', 'approval runId'),
    planGeneration: integer(input.planGeneration, 'approval planGeneration', 1),
    laneId: identifier(input.laneId, 'approval laneId', 128),
    providerId: input.providerId as HostedApprovalIngressAuthority['providerId'],
    credentialGeneration: integer(input.credentialGeneration, 'approval credentialGeneration', 1),
    credentialId: identifier(input.credentialId, 'approval credentialId'),
    sessionId: identifier(input.sessionId, 'approval sessionId'),
    runtimeInstanceId: identifier(input.runtimeInstanceId, 'approval runtimeInstanceId'),
    deliveryOwnerId: canonicalId(input.deliveryOwnerId, 'member', 'approval deliveryOwnerId'),
  }
}

function bindIngressAuthority(
  authority: HostedApprovalIngressAuthority,
  outerAuthority: HostedControlAuthority,
): void {
  if (authority.deploymentId !== outerAuthority.deploymentId ||
    authority.teamId !== outerAuthority.teamId) {
    throw new Error('Invalid approval ingress authority binding')
  }
}

function decodeAuthorityResult(
  value: unknown,
  outerAuthority: HostedControlAuthority,
): HostedApprovalAuthorityResult {
  const input = record(value, 'approval authority result')
  if (input.status !== 'resolved') {
    return decodeStatus(input, [
      'stale_generation', 'wrong_lane', 'unavailable',
    ], 'approval authority result')
  }
  exactKeys(input, ['status', 'scope'], 'approval authority result')
  const scope = record(input.scope, 'approval authority scope')
  exactKeys(scope, [
    'principalId', 'workspaceId', 'teamId', 'authorityGeneration', 'restoreGeneration',
  ], 'approval authority scope')
  const decoded = {
    principalId: patterned(scope.principalId, /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/, 'approval principalId'),
    workspaceId: canonicalId(scope.workspaceId, 'workspace', 'approval workspaceId'),
    teamId: canonicalId(scope.teamId, 'team', 'approval scope teamId'),
    authorityGeneration: patterned(scope.authorityGeneration, /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/, 'approval authorityGeneration'),
    restoreGeneration: integer(scope.restoreGeneration, 'approval scope restoreGeneration', 0),
  }
  if (decoded.workspaceId !== outerAuthority.workspaceId || decoded.teamId !== outerAuthority.teamId ||
    decoded.restoreGeneration !== outerAuthority.restoreGeneration) {
    throw new Error('Invalid approval resolved authority binding')
  }
  return { status: 'resolved', scope: decoded }
}

function decodeDeliveryRequest(value: unknown): HostedApprovalDeliveryRequest {
  const input = record(value, 'approval delivery request')
  exactKeys(input, [
    'providerDeliveryId', 'reconciliationRef', 'principal', 'deliveryRef', 'approvalId', 'approvalGeneration',
    'decision', 'partition', 'requestId',
  ], 'approval delivery request')
  const partition = record(input.partition, 'approval delivery partition')
  exactKeys(partition, ['teamId', 'runId'], 'approval delivery partition')
  if (!['allow', 'deny', 'timeout'].includes(String(input.decision))) {
    throw new Error('Invalid approval decision')
  }
  const principal = decodeDeliveryPrincipal(input.principal)
  if (input.decision === 'timeout' && principal.kind !== 'system_timeout' ||
    input.decision !== 'timeout' && principal.kind !== 'operator') {
    throw new Error('Invalid approval decision principal')
  }
  return {
    providerDeliveryId: identifier(input.providerDeliveryId, 'approval providerDeliveryId'),
    reconciliationRef: reconciliationRef(input.reconciliationRef),
    principal,
    deliveryRef: deliveryRef(input.deliveryRef),
    approvalId: patterned(input.approvalId, /^approval_[0-9a-f]{32}$/, 'approval approvalId'),
    approvalGeneration: patterned(input.approvalGeneration, /^generation_runtime-permission-[0-9a-f]{64}$/, 'approval approvalGeneration'),
    decision: input.decision as HostedApprovalDecision,
    partition: {
      teamId: canonicalId(partition.teamId, 'team', 'approval delivery teamId'),
      runId: canonicalId(partition.runId, 'run', 'approval delivery runId'),
    },
    requestId: identifier(input.requestId, 'approval delivery requestId'),
  }
}

function decodeReconciliationRequest(value: unknown): HostedApprovalReconciliationRequest {
  const input = record(value, 'approval reconciliation request')
  exactKeys(input, ['reconciliationRef', 'providerDeliveryId', 'partition'], 'approval reconciliation request')
  const partition = record(input.partition, 'approval reconciliation partition')
  exactKeys(partition, ['teamId', 'runId'], 'approval reconciliation partition')
  return {
    reconciliationRef: reconciliationRef(input.reconciliationRef),
    providerDeliveryId: identifier(input.providerDeliveryId, 'approval reconciliation providerDeliveryId'),
    partition: {
      teamId: canonicalId(partition.teamId, 'team', 'approval reconciliation teamId'),
      runId: canonicalId(partition.runId, 'run', 'approval reconciliation runId'),
    },
  }
}

function decodeDeliveryPrincipal(value: unknown): HostedApprovalDeliveryRequest['principal'] {
  const input = record(value, 'approval delivery principal')
  if (input.kind === 'system_timeout') {
    exactKeys(input, ['kind'], 'approval delivery principal')
    return { kind: 'system_timeout' }
  }
  exactKeys(input, ['kind', 'actorId'], 'approval delivery principal')
  if (input.kind !== 'operator') throw new Error('Invalid approval delivery principal')
  return {
    kind: 'operator',
    actorId: patterned(input.actorId, /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/, 'approval actorId'),
  }
}

function validateApprovalPayloadJson(payloadJson: string, expectedDeliveryRef: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(payloadJson) } catch { throw new Error('Invalid approval payloadJson') }
  const input = record(parsed, 'approval payload')
  exactKeys(input, [
    'schemaVersion', 'deliveryRef', 'category', 'summary', 'expiresAtMs', 'preview',
  ], 'approval payload')
  if (input.schemaVersion !== 1 || input.deliveryRef !== expectedDeliveryRef ||
    !['file_change', 'command', 'network', 'other'].includes(String(input.category)) ||
    input.expiresAtMs !== null && (!Number.isSafeInteger(input.expiresAtMs) || Number(input.expiresAtMs) < 0)) {
    throw new Error('Invalid approval payload')
  }
  boundedRedactedText(input.summary, 'approval summary', HOSTED_APPROVAL_MAX_SUMMARY_BYTES)
  if (input.preview !== null) {
    const preview = record(input.preview, 'approval preview')
    exactKeys(preview, ['previewRef', 'content', 'byteLength', 'truncated', 'isBinary'], 'approval preview')
    patterned(preview.previewRef, /^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/, 'approval previewRef')
    const content = boundedRedactedText(
      preview.content, 'approval preview content',
      HOSTED_APPROVAL_MAX_PREVIEW_CONTENT_BYTES, true, true,
    )
    const byteLength = integer(preview.byteLength, 'approval preview byteLength', 0, 64 * 1024)
    if (Buffer.byteLength(content, 'utf8') > byteLength || typeof preview.truncated !== 'boolean' ||
      typeof preview.isBinary !== 'boolean' || preview.isBinary && content !== '') {
      throw new Error('Invalid approval preview')
    }
  }
}

function decodeStatus<T extends string>(
  value: unknown,
  statuses: readonly T[],
  field: string,
): { status: T } {
  const input = record(value, field)
  exactKeys(input, ['status'], field)
  if (!statuses.includes(input.status as T)) throw new Error(`Invalid ${field} status`)
  return { status: input.status as T }
}

type HostedApprovalWireAuthority = Omit<HostedControlAuthority, 'teamId'>

function decodeApprovalWireAuthority(value: unknown): HostedApprovalWireAuthority {
  const input = record(value, 'approval wire authority')
  exactKeys(input, [
    'actorId', 'deploymentId', 'bootId', 'restoreGeneration', 'workspaceId', 'mountBinding',
  ], 'approval wire authority')
  const mount = record(input.mountBinding, 'approval wire mount binding')
  exactKeys(mount, ['mountGeneration', 'declaredRootHash'], 'approval wire mount binding')
  return {
    actorId: patterned(input.actorId, /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/, 'approval actorId'),
    deploymentId: patterned(input.deploymentId, /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/, 'approval deploymentId'),
    bootId: patterned(input.bootId, /^boot_[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/, 'approval bootId'),
    restoreGeneration: integer(input.restoreGeneration, 'approval restoreGeneration', 0),
    workspaceId: canonicalId(input.workspaceId, 'workspace', 'approval workspaceId'),
    mountBinding: {
      mountGeneration: integer(mount.mountGeneration, 'approval mountGeneration', 1),
      declaredRootHash: patterned(mount.declaredRootHash, /^[0-9a-f]{64}$/, 'approval declaredRootHash'),
    },
  }
}

function sameWireAuthority(authority: HostedApprovalWireAuthority, expected: HostedControlStableAuthority): boolean {
  return authority.deploymentId === expected.deploymentId &&
    authority.bootId === expected.bootId &&
    authority.restoreGeneration === expected.restoreGeneration &&
    authority.workspaceId === expected.workspaceId &&
    isDeepStrictEqual(authority.mountBinding, expected.mountBinding)
}

function verifyRawProof(
  secret: Uint8Array,
  proof: string,
  serialized: string,
  direction: 'request' | 'response',
): void {
  const expected = createHostedRawDomainProof(
    secret, HOSTED_APPROVAL_PROOF_DOMAIN, direction, serialized,
  )
  if (proof.length !== expected.length ||
    !timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('Invalid hosted approval owner proof')
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${field}`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new Error(`Invalid ${field} keys`)
  }
}

function integer(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${field}`)
  return Number(value)
}

function identifier(value: unknown, field: string, max = 192): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`Invalid ${field}`)
  }
  return value
}

function patterned(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${field}`)
  return value
}

function canonicalId(value: unknown, prefix: string, field: string): string {
  return patterned(value, new RegExp(`^${prefix}_[0-9a-f]{32}$`), field)
}

function deliveryRef(value: unknown): string {
  return patterned(value, /^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/, 'approval deliveryRef')
}

function reconciliationRef(value: unknown): string {
  return patterned(
    value,
    /^approval-reconciliation_[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/,
    'approval reconciliationRef',
  )
}

function iso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error(`Invalid ${field}`)
  }
  return value
}

function boundedText(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${field}`)
  }
  return value
}

function boundedRedactedText(
  value: unknown,
  field: string,
  maxBytes: number,
  allowEmpty = false,
  allowNewlines = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes || containsHostPath(value)) {
    throw new Error(`Invalid ${field}`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const allowed = code === 9 || allowNewlines && (code === 10 || code === 13)
    if (code <= 31 && !allowed || code === 127) throw new Error(`Invalid ${field}`)
  }
  return value
}
