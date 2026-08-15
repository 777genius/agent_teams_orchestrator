import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  HOSTED_APPROVAL_TRANSITION_ACQUIRED_TTL_MS,
  HOSTED_APPROVAL_TRANSITION_MAX_TOMBSTONES_PER_TEAM,
  HOSTED_APPROVAL_TRANSITION_PINNED_TTL_MS,
  HOSTED_APPROVAL_TRANSITION_TOMBSTONE_RETENTION_MS,
  HostedApprovalTransitionProtocolError,
  digestHostedApprovalTransitionValue,
  encodeHostedApprovalTransitionFrame,
  hostedApprovalTransitionError,
  isHostedApprovalTransitionDeadlineElapsed,
  type HostedApprovalTransitionAssertReason,
  type HostedApprovalTransitionBinding,
  type HostedApprovalTransitionDeadline,
  type HostedApprovalTransitionErrorCode,
  type HostedApprovalTransitionOperation,
  type HostedApprovalTransitionProductProjection,
  type HostedApprovalTransitionRequest,
  type HostedApprovalTransitionResponse,
  type HostedApprovalTransitionSuccessPayloads,
  validateHostedApprovalTransitionBinding,
  validateHostedApprovalTransitionProductProjection,
} from './HostedApprovalTransitionWire.js'

export type HostedApprovalTransitionTerminalState =
  | 'released_tombstone' | 'expired_tombstone' | 'fenced_tombstone' | 'restart_tombstone'
export type HostedApprovalTransitionLeaseState = 'acquired' | 'pinned' | HostedApprovalTransitionTerminalState

export type HostedApprovalTransitionRetainedResponse = {
  operation: HostedApprovalTransitionOperation
  requestDigest: string
  payloadIdentity: string
  response: Buffer
  retryableSameOperation: boolean
}
export type HostedApprovalTransitionLeaseRecord = {
  transitionId: string
  leaseId: string
  teamId: string
  generation: number
  projectionDigest: string
  bindingDigest: string
  productProjection: HostedApprovalTransitionProductProjection
  binding: HostedApprovalTransitionBinding
  clientProcessIdentity: HostedApprovalTransitionProductProjection['clientProcessIdentity']
  owner: HostedApprovalTransitionProductProjection['expectedOwner']
  state: HostedApprovalTransitionLeaseState
  expiresAtMs: number
  pinnedExpiresAtMs: number | null
  terminalReason: HostedApprovalTransitionAssertReason | null
  terminalAtMs: number | null
  releasedAtMs: number | null
  lastSequence: number
  responses: Record<number, HostedApprovalTransitionRetainedResponse>
}
export type HostedApprovalTransitionTeamLedger = {
  teamId: string
  generationHighWater: number
  currentBindingDigest: string | null
  records: Record<string, HostedApprovalTransitionLeaseRecord>
  rejectedTransitions?: Record<string, { lastSequence: number; responses: Record<number, HostedApprovalTransitionRetainedResponse> }>
}

/**
 * The implementation of this port owns durable locking, atomic replacement,
 * file and parent-directory fsync. The callback is the sole serialization
 * point shared with binding mutation.
 */
export interface HostedApprovalTransitionLedger {
  serialized<T>(input: {
    transitionId: string
    teamIdHint: string | null
    mutate: (team: HostedApprovalTransitionTeamLedger | null) => Promise<{
      team: HostedApprovalTransitionTeamLedger | null
      result: T
    }>
  }): Promise<T>
}

export type HostedApprovalTransitionPin = { release(): Promise<void> }
export interface HostedApprovalTransitionBindingResolver {
  /** Fresh authoritative read, including reciprocal peer/socket/process/descriptor checks. */
  read(projection: HostedApprovalTransitionProductProjection): Promise<HostedApprovalTransitionBinding>
  /** Uses the exact exclusive primitive shared by every binding-source mutation. */
  acquireTeamPin(teamId: string): Promise<HostedApprovalTransitionPin | null>
  /** Freshly checks binding sources, pin, owner, socket and both processes. */
  assertCurrent(input: {
    record: HostedApprovalTransitionLeaseRecord
    binding: HostedApprovalTransitionBinding
  }): Promise<HostedApprovalTransitionAssertReason | null>
}

export type HostedApprovalTransitionServiceRequest = {
  request: HostedApprovalTransitionRequest
  requestDigest: string
  deadline: HostedApprovalTransitionDeadline
}

export class HostedApprovalRuntimeBindingLeaseService {
  readonly #pins = new Map<string, HostedApprovalTransitionPin>()
  constructor(private readonly options: {
    secret: Uint8Array
    ledger: HostedApprovalTransitionLedger
    bindingResolver: HostedApprovalTransitionBindingResolver
    now?: () => number
    monotonicNow?: () => number
    randomBytes?: (size: number) => Uint8Array
  }) {
    if (options.secret.byteLength !== 32) throw new TypeError('Hosted approval transition secret must be exactly 32 bytes')
  }

  async dispatch(input: HostedApprovalTransitionServiceRequest): Promise<Buffer> {
    const { request } = input
    const teamIdHint = request.operation === 'acquire'
      ? (request.payload as HostedApprovalTransitionRequest<'acquire'>['payload']).productProjection.stableAuthority.teamId
      : null
    return this.options.ledger.serialized({
      transitionId: request.transitionId,
      teamIdHint,
      mutate: async team => this.#mutate(team, input),
    })
  }

  /** Run under recovery before transition-wire readiness; it performs no binding or provider read. */
  async recoverTeam(teamId: string): Promise<void> {
    await this.options.ledger.serialized({
      transitionId: `recovery:${teamId}`,
      teamIdHint: teamId,
      mutate: async team => {
        if (!team) return { team, result: undefined }
        const now = this.#now()
        for (const record of Object.values(team.records)) {
          if (record.state === 'acquired' || record.state === 'pinned') {
            await this.#terminal(record, 'restart_tombstone', 'owner_restarted', now)
          }
        }
        team.generationHighWater += 1
        team.currentBindingDigest = null
        return { team, result: undefined }
      },
    })
  }

  async #mutate(team: HostedApprovalTransitionTeamLedger | null, input: HostedApprovalTransitionServiceRequest) {
    const { request, requestDigest } = input
    const existing = team?.records[request.transitionId]
    const rejected = team?.rejectedTransitions?.[request.transitionId]
    const retained = existing?.responses[request.sequence] ?? rejected?.responses[request.sequence]
    if (retained) {
      if (retained.requestDigest !== requestDigest) return this.#error(team, input, 'TRANSITION_CONFLICT', false)
      return { team, result: Buffer.from(retained.response) }
    }
    if (this.#deadlineElapsed(input.deadline)) return this.#error(team, input, 'DEADLINE_EXCEEDED', true)
    if (existing && request.sequence !== existing.lastSequence + 1) return this.#error(team, input, 'SEQUENCE_OUT_OF_ORDER', false)
    if (!existing && rejected && request.sequence !== rejected.lastSequence + 1) return this.#error(team, input, 'SEQUENCE_OUT_OF_ORDER', false)
    if (!existing && (request.operation !== 'acquire' || request.sequence !== 1)) {
      return this.#error(team, input, request.operation === 'acquire' ? 'SEQUENCE_OUT_OF_ORDER' : 'LEASE_NOT_FOUND', false)
    }
    if (existing) await this.#expireIfNeeded(existing)
    if (existing && request.sequence === existing.lastSequence + 1) {
      const previous = existing.responses[existing.lastSequence]
      if (previous?.retryableSameOperation &&
        (previous.operation !== request.operation || previous.payloadIdentity !== digestHostedApprovalTransitionValue(request.payload))) {
        return this.#error(team, input, 'OPERATION_OUT_OF_ORDER', true)
      }
    }
    try {
      if (request.operation === 'acquire') return await this.#acquire(team, input)
      if (!team || !existing) return this.#error(team, input, 'LEASE_NOT_FOUND', false)
      if (request.operation === 'consume') return await this.#consume(team, existing, input)
      if (request.operation === 'assert') return await this.#assert(team, existing, input)
      return await this.#release(team, existing, input)
    } catch (error) {
      const code = error instanceof HostedApprovalTransitionProtocolError ? error.code : 'UNAVAILABLE'
      return this.#error(team, input, code, true)
    }
  }

  async #acquire(team: HostedApprovalTransitionTeamLedger | null, input: HostedApprovalTransitionServiceRequest) {
    const request = input.request as HostedApprovalTransitionRequest<'acquire'>
    if (team?.records[request.transitionId]) return this.#error(team, input, 'OPERATION_OUT_OF_ORDER', false)
    const projection = validateHostedApprovalTransitionProductProjection(request.payload.productProjection)
    if (digestHostedApprovalTransitionValue(projection) !== request.payload.projectionDigest) return this.#error(team, input, 'PROJECTION_MISMATCH', false)
    const current = team ?? { teamId: projection.stableAuthority.teamId, generationHighWater: 0, currentBindingDigest: null, records: {}, rejectedTransitions: {} }
    if (current.teamId !== projection.stableAuthority.teamId) return this.#error(team, input, 'PROJECTION_MISMATCH', false)
    this.#evictOldTombstones(current)
    const terminalCount = Object.values(current.records).filter(record => isTerminal(record.state)).length
    if (terminalCount >= HOSTED_APPROVAL_TRANSITION_MAX_TOMBSTONES_PER_TEAM) return this.#error(current, input, 'TOMBSTONE_CAPACITY', true)
    let binding: HostedApprovalTransitionBinding
    try { binding = validateHostedApprovalTransitionBinding(await this.options.bindingResolver.read(projection), projection) }
    catch { return this.#error(current, input, 'BINDING_INVALID', false) }
    const bindingDigest = digestHostedApprovalTransitionValue(binding)
    if (current.currentBindingDigest !== bindingDigest) {
      current.generationHighWater += 1
      if (!Number.isSafeInteger(current.generationHighWater) || current.generationHighWater < 1) return this.#error(team, input, 'INTERNAL', true)
      current.currentBindingDigest = bindingDigest
    } else if (current.generationHighWater < 1) current.generationHighWater = 1
    const now = this.#now()
    const leaseId = `approval-transition-lease_${Buffer.from((this.options.randomBytes ?? randomBytes)(16)).toString('hex')}`
    const record: HostedApprovalTransitionLeaseRecord = {
      transitionId: request.transitionId, leaseId, teamId: current.teamId,
      generation: current.generationHighWater, projectionDigest: request.payload.projectionDigest,
      bindingDigest, productProjection: structuredClone(projection), binding: structuredClone(binding),
      clientProcessIdentity: structuredClone(projection.clientProcessIdentity), owner: structuredClone(projection.expectedOwner),
      state: 'acquired', expiresAtMs: now + HOSTED_APPROVAL_TRANSITION_ACQUIRED_TTL_MS,
      pinnedExpiresAtMs: null, terminalReason: null, terminalAtMs: null, releasedAtMs: null,
      lastSequence: request.sequence, responses: {},
    }
    current.records[request.transitionId] = record
    const payload: HostedApprovalTransitionSuccessPayloads['acquire'] = {
      status: 'acquired', leaseId, generation: record.generation, expiresAtMs: record.expiresAtMs,
      projectionDigest: record.projectionDigest, bindingDigest, binding: structuredClone(binding),
    }
    return this.#success(current, record, input, payload)
  }

  async #consume(team: HostedApprovalTransitionTeamLedger, record: HostedApprovalTransitionLeaseRecord, input: HostedApprovalTransitionServiceRequest) {
    const request = input.request as HostedApprovalTransitionRequest<'consume'>
    if (record.state === 'expired_tombstone') return this.#error(team, input, 'LEASE_EXPIRED', false)
    if (record.state === 'pinned') return this.#error(team, input, 'LEASE_ALREADY_CONSUMED', false)
    if (isTerminal(record.state)) return this.#error(team, input, 'LEASE_RELEASED', false)
    const mismatch = this.#payloadMismatch(record, request.payload, true); if (mismatch) return this.#error(team, input, mismatch, false)
    const pin = await this.options.bindingResolver.acquireTeamPin(record.teamId)
    if (!pin) return this.#error(team, input, 'PIN_BUSY', true)
    let retained = false
    try {
      const binding = validateHostedApprovalTransitionBinding(await this.options.bindingResolver.read(record.productProjection), record.productProjection)
      const digest = digestHostedApprovalTransitionValue(binding)
      if (digest !== record.bindingDigest || !isDeepStrictEqual(binding, record.binding)) {
        await this.#terminal(record, 'fenced_tombstone', 'binding_changed'); return this.#error(team, input, 'BINDING_DRIFT', false)
      }
      const reason = await this.options.bindingResolver.assertCurrent({ record, binding })
      if (reason) {
        await this.#terminal(record, reason === 'owner_restarted' ? 'restart_tombstone' : 'fenced_tombstone', reason)
        return this.#error(team, input, reason === 'owner_restarted' ? 'OWNER_RESTARTED' : driftError(reason), false)
      }
      if (this.#deadlineElapsed(input.deadline)) return this.#error(team, input, 'DEADLINE_EXCEEDED', true)
      const now = this.#now(); record.state = 'pinned'; record.pinnedExpiresAtMs = now + HOSTED_APPROVAL_TRANSITION_PINNED_TTL_MS
      this.#pins.set(record.leaseId, pin); retained = true
      return this.#success(team, record, input, { status: 'consumed', leaseId: record.leaseId, generation: record.generation, pinnedExpiresAtMs: record.pinnedExpiresAtMs, bindingDigest: record.bindingDigest, binding: structuredClone(binding) })
    } finally { if (!retained) await pin.release() }
  }

  async #assert(team: HostedApprovalTransitionTeamLedger, record: HostedApprovalTransitionLeaseRecord, input: HostedApprovalTransitionServiceRequest) {
    const request = input.request as HostedApprovalTransitionRequest<'assert'>
    const mismatch = this.#payloadMismatch(record, request.payload, false); if (mismatch) return this.#error(team, input, mismatch, false)
    if (record.state === 'acquired') return this.#error(team, input, 'LEASE_NOT_CONSUMED', false)
    let reason = terminalReason(record)
    if (record.state === 'pinned') {
      reason = await this.options.bindingResolver.assertCurrent({ record, binding: structuredClone(record.binding) })
      if (!this.#pins.has(record.leaseId) && !reason) reason = 'fenced'
      if (reason) await this.#terminal(record, reason === 'owner_restarted' ? 'restart_tombstone' : reason === 'expired' ? 'expired_tombstone' : 'fenced_tombstone', reason)
    }
    if (this.#deadlineElapsed(input.deadline)) return this.#error(team, input, 'DEADLINE_EXCEEDED', true)
    return this.#success(team, record, input, { status: 'asserted', leaseId: record.leaseId, generation: record.generation, current: reason === null, reason })
  }

  async #release(team: HostedApprovalTransitionTeamLedger, record: HostedApprovalTransitionLeaseRecord, input: HostedApprovalTransitionServiceRequest) {
    const request = input.request as HostedApprovalTransitionRequest<'release'>
    const mismatch = this.#payloadMismatch(record, request.payload, false); if (mismatch) return this.#error(team, input, mismatch, false)
    if (record.state === 'expired_tombstone') return this.#error(team, input, 'LEASE_EXPIRED', false)
    if (record.state === 'restart_tombstone') return this.#error(team, input, 'OWNER_RESTARTED', false)
    if (record.state === 'fenced_tombstone') return this.#error(team, input, 'LEASE_RELEASED', false)
    if (record.state !== 'released_tombstone') {
      const releasedAtMs = this.#now()
      await this.#terminal(record, 'released_tombstone', 'released', releasedAtMs)
    }
    if (this.#deadlineElapsed(input.deadline)) return this.#error(team, input, 'DEADLINE_EXCEEDED', true)
    return this.#success(team, record, input, { status: 'released', leaseId: record.leaseId, generation: record.generation, releasedAtMs: record.releasedAtMs! })
  }

  #payloadMismatch(record: HostedApprovalTransitionLeaseRecord, payload: { leaseId: string; generation: number; bindingDigest: string; projectionDigest?: string }, projection: boolean): HostedApprovalTransitionErrorCode | null {
    if (payload.leaseId !== record.leaseId) return 'LEASE_NOT_FOUND'
    if (payload.generation !== record.generation) return 'GENERATION_MISMATCH'
    if (payload.bindingDigest !== record.bindingDigest || (projection && payload.projectionDigest !== record.projectionDigest)) return 'BINDING_DRIFT'
    return null
  }

  #success<O extends HostedApprovalTransitionOperation>(team: HostedApprovalTransitionTeamLedger, record: HostedApprovalTransitionLeaseRecord, input: HostedApprovalTransitionServiceRequest, payload: HostedApprovalTransitionSuccessPayloads[O]) {
    const request = input.request as HostedApprovalTransitionRequest<O>
    const unsigned = { schemaVersion: 1, transitionId: request.transitionId, operation: request.operation, sequence: request.sequence, requestDigest: input.requestDigest, payload } as Omit<HostedApprovalTransitionResponse<O>, 'ownerProof'>
    const response = encodeHostedApprovalTransitionFrame(unsigned, this.options.secret, 'response')
    this.#retain(record, input, response, false)
    return { team, result: response }
  }

  #error(team: HostedApprovalTransitionTeamLedger | null, input: HostedApprovalTransitionServiceRequest, code: HostedApprovalTransitionErrorCode, _retain: boolean) {
    const request = input.request
    const unsigned = { schemaVersion: 1, transitionId: request.transitionId, operation: request.operation, sequence: request.sequence, requestDigest: input.requestDigest, error: hostedApprovalTransitionError(code) } as Omit<HostedApprovalTransitionResponse, 'ownerProof'>
    const response = encodeHostedApprovalTransitionFrame(unsigned, this.options.secret, 'response')
    const record = team?.records[request.transitionId]
    if (record && request.sequence === record.lastSequence + 1 && code !== 'TRANSITION_CONFLICT' && code !== 'SEQUENCE_OUT_OF_ORDER') {
      this.#retain(record, input, response, hostedApprovalTransitionError(code).retryScope === 'same_operation')
    } else if (team && !record && request.operation === 'acquire' && code !== 'TRANSITION_CONFLICT' && code !== 'SEQUENCE_OUT_OF_ORDER') {
      const rejectedTransitions = team.rejectedTransitions ??= {}
      const rejected = rejectedTransitions[request.transitionId] ??= { lastSequence: 0, responses: {} }
      if (request.sequence === rejected.lastSequence + 1) {
        rejected.lastSequence = request.sequence
        rejected.responses[request.sequence] = {
          operation: request.operation, requestDigest: input.requestDigest,
          payloadIdentity: digestHostedApprovalTransitionValue(request.payload), response: Buffer.from(response),
          retryableSameOperation: hostedApprovalTransitionError(code).retryScope === 'same_operation',
        }
      }
    }
    return { team, result: response }
  }

  #retain(record: HostedApprovalTransitionLeaseRecord, input: HostedApprovalTransitionServiceRequest, response: Buffer, retryableSameOperation: boolean): void {
    record.lastSequence = input.request.sequence
    record.responses[input.request.sequence] = {
      operation: input.request.operation, requestDigest: input.requestDigest,
      payloadIdentity: digestHostedApprovalTransitionValue(input.request.payload), response: Buffer.from(response), retryableSameOperation,
    }
  }
  async #expireIfNeeded(record: HostedApprovalTransitionLeaseRecord): Promise<void> {
    if (record.state === 'acquired' && this.#now() >= record.expiresAtMs) await this.#terminal(record, 'expired_tombstone', 'expired')
    if (record.state === 'pinned' && this.#now() >= record.pinnedExpiresAtMs!) await this.#terminal(record, 'expired_tombstone', 'expired')
  }
  async #terminal(record: HostedApprovalTransitionLeaseRecord, state: HostedApprovalTransitionTerminalState, reason: HostedApprovalTransitionAssertReason | 'released', at = this.#now()): Promise<void> {
    record.state = state; record.terminalReason = reason === 'released' ? 'released' : reason; record.terminalAtMs = at
    if (state === 'released_tombstone' && record.releasedAtMs === null) record.releasedAtMs = at
    const pin = this.#pins.get(record.leaseId); this.#pins.delete(record.leaseId); await pin?.release()
  }
  #evictOldTombstones(team: HostedApprovalTransitionTeamLedger): void {
    const cutoff = this.#now() - HOSTED_APPROVAL_TRANSITION_TOMBSTONE_RETENTION_MS
    const evictable = Object.values(team.records).filter(record => isTerminal(record.state) && record.terminalAtMs! < cutoff).sort((a, b) => a.terminalAtMs! - b.terminalAtMs!)
    for (const record of evictable) delete team.records[record.transitionId]
  }
  #deadlineElapsed(deadline: HostedApprovalTransitionDeadline): boolean { return isHostedApprovalTransitionDeadlineElapsed(deadline, this.#now(), (this.options.monotonicNow ?? this.#now.bind(this))()) }
  #now(): number { return (this.options.now ?? Date.now)() }
}

function isTerminal(state: HostedApprovalTransitionLeaseState): state is HostedApprovalTransitionTerminalState { return state.endsWith('_tombstone') }
function terminalReason(record: HostedApprovalTransitionLeaseRecord): HostedApprovalTransitionAssertReason | null {
  if (record.state === 'pinned') return null
  if (record.state === 'expired_tombstone') return 'expired'
  if (record.state === 'released_tombstone') return 'released'
  if (record.state === 'restart_tombstone') return 'owner_restarted'
  if (record.state === 'fenced_tombstone') return record.terminalReason ?? 'fenced'
  return 'fenced'
}
function driftError(reason: HostedApprovalTransitionAssertReason): HostedApprovalTransitionErrorCode {
  if (reason === 'socket_changed') return 'SOCKET_IDENTITY_MISMATCH'
  if (reason === 'process_changed') return 'PROCESS_IDENTITY_MISMATCH'
  if (reason === 'client_changed') return 'CLIENT_IDENTITY_MISMATCH'
  if (reason === 'owner_restarted') return 'OWNER_RESTARTED'
  return 'BINDING_DRIFT'
}

/** A deterministic test adapter; production must inject a durable fsyncing ledger. */
export class InMemoryHostedApprovalTransitionLedger implements HostedApprovalTransitionLedger {
  readonly teams = new Map<string, HostedApprovalTransitionTeamLedger>()
  readonly transitions = new Map<string, string>()
  #queue: Promise<unknown> = Promise.resolve()
  serialized<T>(input: {
    transitionId: string
    teamIdHint: string | null
    mutate: (team: HostedApprovalTransitionTeamLedger | null) => Promise<{ team: HostedApprovalTransitionTeamLedger | null; result: T }>
  }): Promise<T> {
    const run = async () => {
      const teamId = input.teamIdHint ?? this.transitions.get(input.transitionId) ?? null
      const current = teamId ? this.teams.get(teamId) ?? null : null
      const output = await input.mutate(current)
      if (output.team) {
        this.teams.set(output.team.teamId, output.team)
        this.transitions.set(input.transitionId, output.team.teamId)
      }
      return output.result
    }
    const result = this.#queue.then(run, run); this.#queue = result.then(() => undefined, () => undefined); return result
  }
}
