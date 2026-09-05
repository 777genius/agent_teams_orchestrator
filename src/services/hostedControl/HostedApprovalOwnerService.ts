import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  HostedApprovalAuthorityResult,
  HostedApprovalDeliveryAuthorizationResult,
  HostedApprovalDeliveryPortResult,
  HostedApprovalDeliveryRequest,
  HostedApprovalIngressAuthority,
  HostedApprovalReconciliationResult,
  HostedApprovalWirePort,
} from './HostedApprovalWire.js'
import { HostedApprovalOwnerStore, withoutRevision } from './HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerPublicationError, type HostedApprovalDeliveryState, type HostedApprovalOwnerState } from './HostedApprovalOwnerWal.js'
import { createOwnerOperationNonce } from './HostedApprovalOwnerProvenance.js'
import type { HostedApprovalRuntimeAdmission, HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import { ingressRecordForObservedPermission, OpenCodeHostedApprovalRuntimeAdapter } from './OpenCodeHostedApprovalRuntimeAdapter.js'

export class HostedApprovalOwnerService implements HostedApprovalWirePort {
  readonly #tokens = new Map<string, { request: HostedApprovalDeliveryRequest; fingerprint: string }>()
  constructor(private readonly options: {
    store: HostedApprovalOwnerStore
    admission: HostedApprovalRuntimeAdmission
    runtime: OpenCodeHostedApprovalRuntimeAdapter
    isCurrentOuterAuthority(): Promise<boolean>
    now?: () => number
    createToken?: () => string
  }) {}

  async recoverStateOnly(): Promise<void> {
    // No provider calls. This runs before readiness and revokes rotated routes/mappings.
    await this.options.store.reconcileAdmission(this.options.admission)
  }

  /** Fail-closed proof that recovery published this exact admission snapshot. */
  async isAdmissionRecoveredCurrent(): Promise<boolean> {
    try {
      if (!(await this.#authorityCurrent())) return false
      const state = await this.options.store.read()
      return !!state &&
        state.admissionGeneration === this.options.admission.admissionGeneration &&
        state.admissionDigest === this.options.admission.digest &&
        isDeepStrictEqual(state.routes, this.options.admission.routes) &&
        isDeepStrictEqual(state.actorMembers, this.options.admission.actorMembers)
    } catch {
      return false
    }
  }

  async pollIngress(): Promise<number> {
    if (!(await this.#authorityCurrent())) throw new Error('Hosted approval owner unavailable')
    let admitted = 0
    for (const route of this.options.admission.routes) {
      const observed = await this.options.runtime.observe(route)
      for (const permission of observed) {
        const result = await this.options.store.admitIngress(
          this.options.admission,
          ingressRecordForObservedPermission(permission),
        )
        if (result === 'admitted') admitted += 1
      }
    }
    return admitted
  }

  async claimIngress(input: Parameters<HostedApprovalWirePort['claimIngress']>[0]) {
    await this.pollIngress()
    if (!(await this.#authorityCurrent())) throw new Error('Hosted approval owner unavailable')
    return this.options.store.claim(input.request, input.maximumAggregateBytes)
  }
  async acknowledgeIngress(request: Parameters<HostedApprovalWirePort['acknowledgeIngress']>[0]) {
    return await this.#authorityCurrent()
      ? this.options.store.acknowledge(request)
      : { status: 'unavailable' as const }
  }

  async getAdmittedIngressAuthority(authority: HostedApprovalIngressAuthority) {
    if (!(await this.#authorityCurrent())) return null
    const admittedRoute = this.options.admission.routes.find(route => isDeepStrictEqual(route.authority, authority))
    if (!admittedRoute) return null
    try {
      const state = await this.options.store.read()
      return state?.admissionGeneration === this.options.admission.admissionGeneration &&
        state.admissionDigest === this.options.admission.digest &&
        state.routes.some(route => isDeepStrictEqual(route, admittedRoute)) ? authority : null
    } catch { return null }
  }

  async resolveIngressAuthority(authority: HostedApprovalIngressAuthority): Promise<HostedApprovalAuthorityResult> {
    if (!(await this.#authorityCurrent())) return { status: 'unavailable' }
    const admittedRoute = this.options.admission.routes.find(route => isDeepStrictEqual(route.authority, authority))
    if (!admittedRoute) {
      return { status: 'stale_generation' }
    }
    let state: HostedApprovalOwnerState | null
    try { state = await this.options.store.read() } catch { return { status: 'unavailable' } }
    if (state?.admissionGeneration !== this.options.admission.admissionGeneration ||
      state.admissionDigest !== this.options.admission.digest ||
      !state.routes.some(route => isDeepStrictEqual(route, admittedRoute))) return { status: 'stale_generation' }
    return { status: 'resolved', scope: admittedRoute.scope }
  }

  async authorizeDecision(input: { request: HostedApprovalDeliveryRequest; payloadFingerprint: string }): Promise<HostedApprovalDeliveryAuthorizationResult> {
    if (!(await this.#authorityCurrent())) return { status: 'unavailable' }
    let state: HostedApprovalOwnerState | null
    try { state = await this.options.store.read() } catch { return { status: 'unavailable' } }
    if (!state) return { status: 'unavailable' }
    const prior = findDelivery(state, input.request)
    if (prior) return replay(prior, input.request, input.payloadFingerprint)
    const bound = bindRequest(state, input.request); if (!bound) return { status: 'stale_generation' }
    const token = `approval-authorization_${(this.options.createToken ?? (() => randomUUID().replaceAll('-', '')))()}`
    this.#tokens.set(token, { request: input.request, fingerprint: input.payloadFingerprint })
    return { status: 'authorized', authorization: { token, persistedAuthority: bound.route.authority } }
  }

  async deliverDecision(input: Parameters<HostedApprovalWirePort['deliverDecision']>[0]): Promise<HostedApprovalDeliveryPortResult> {
    const token = this.#tokens.get(input.authorization.token); this.#tokens.delete(input.authorization.token)
    if (!token || token.fingerprint !== input.payloadFingerprint || !isDeepStrictEqual(token.request, input.request) ||
      !isDeepStrictEqual(input.authorization.persistedAuthority, input.admittedAuthority) || !(await this.#authorityCurrent())) {
      return { status: 'unavailable' }
    }
    let reconciliationOnly = false
    const operationNonce = createOwnerOperationNonce()
    try { return await this.options.store.wal.locked(async state => {
      if (!state || state.admissionGeneration !== this.options.admission.admissionGeneration ||
        state.admissionDigest !== this.options.admission.digest) return { status: 'stale_generation' }
      const prior = findDelivery(state, input.request)
      if (prior) return replay(prior, input.request, input.payloadFingerprint)
      const bound = bindRequest(state, input.request)
      if (!bound || !isDeepStrictEqual(bound.route.authority, input.admittedAuthority)) return { status: 'stale_generation' }
      if (!(await this.#routeCurrent(bound.route))) return { status: 'stale_generation' }
      if (bound.route.authority.teamId !== input.request.partition.teamId || bound.route.authority.runId !== input.request.partition.runId) {
        return this.#reject(state, bound.route, bound.record.outboxId, input, 'wrong_lane', operationNonce)
      }
      const payload = JSON.parse(bound.record.payloadJson) as { expiresAtMs: number | null }
      if (payload.expiresAtMs !== null && payload.expiresAtMs <= (this.options.now ?? Date.now)()) {
        return this.#reject(state, bound.route, bound.record.outboxId, input, 'expired', operationNonce)
      }
      if (input.request.principal.kind === 'operator') {
        const memberId = state.actorMembers[input.request.principal.actorId]
        if (!memberId) return this.#reject(state, bound.route, bound.record.outboxId, input, 'unavailable', operationNonce)
        if (memberId === bound.route.authority.deliveryOwnerId) return this.#reject(state, bound.route, bound.record.outboxId, input, 'self_approval', operationNonce)
      }
      const started: HostedApprovalDeliveryState = {
        providerDeliveryId: input.request.providerDeliveryId,
        reconciliationRef: input.request.reconciliationRef,
        deliveryRef: input.request.deliveryRef,
        payloadFingerprint: input.payloadFingerprint, outboxId: bound.record.outboxId,
        effectRef: bound.record.effectRef, phase: 'started', result: null,
      }
      // Set before awaiting publication: a completed replacement whose capture
      // acknowledgement fails must never fall through as proven unavailable.
      reconciliationOnly = true
      let startedState = (await this.options.store.wal.publishMutation(state, { ...withoutRevision(state), deliveries: [...state.deliveries, started] }, {
        operationNonce, mutation: { kind: 'delivery-started', outcome: 'started' }, delivery: started,
      })).state
      if (!(await this.#routeCurrent(bound.route))) {
        return this.#settle(startedState, started, 'rejected', 'stale_generation', operationNonce)
      }
      const result = await this.options.runtime.deliver({
        route: bound.route,
        requestId: bound.record.commandId,
        expectedEffectRef: bound.record.effectRef,
        expectedDeliveryRef: bound.record.deliveryRef,
        decision: input.request.decision,
        // The adapter invokes this again at its final provider boundary. Bind
        // authority to the exact locked fence incarnation, not just admission.
        revalidate: () => this.#effectCurrent(bound.route),
        prepareEffectToken: () => this.#prepareEffectToken(bound.route, startedState),
      })
      // Reload after the provider boundary and prove the exact started record
      // survived before any terminal publish. The WAL fence remains the shared
      // owner/handover serialization point.
      let fresh: HostedApprovalOwnerState | null
      try { fresh = await this.options.store.read() } catch { return operatorRequired(input.request.reconciliationRef) }
      const liveStarted = fresh?.deliveries
        .find(item => item.outboxId === started.outboxId && item.deliveryRef === started.deliveryRef)
      if (!fresh || !liveStarted || !isDeepStrictEqual(liveStarted, started)) {
        return operatorRequired(input.request.reconciliationRef)
      }
      startedState = fresh
      if (result === 'ambiguous') return operatorRequired(input.request.reconciliationRef)
      if (result === 'not_started') return this.#settle(startedState, started, 'rejected', 'stale_generation', operationNonce)
      if (result === 'unavailable') return this.#settle(startedState, started, 'rejected', 'unavailable', operationNonce)
      return this.#settle(startedState, started, 'completed', 'delivered', operationNonce)
    }) } catch (error) {
      if (error instanceof HostedApprovalOwnerPublicationError) {
        return error.stage === 'definitely-not-replaced'
          ? { status: 'unavailable' }
          : operatorRequired(input.request.reconciliationRef)
      }
      return reconciliationOnly
        ? operatorRequired(input.request.reconciliationRef)
        : { status: 'unavailable' }
    }
  }

  async reconcileDecision(
    request: Parameters<HostedApprovalWirePort['reconcileDecision']>[0],
  ): Promise<HostedApprovalReconciliationResult> {
    if (request.partition.teamId !== this.options.admission.outerAuthority.teamId ||
      !(await this.#authorityCurrent())) return { status: 'unavailable' }
    try {
      return await this.options.store.reconcileDecision(request, this.options.admission)
    } catch {
      return { status: 'unavailable' }
    }
  }

  async #authorityCurrent(): Promise<boolean> {
    try {
      return await this.options.isCurrentOuterAuthority() && await this.options.admission.isCurrent()
    } catch { return false }
  }
  async #routeCurrent(route: HostedApprovalRuntimeRoute): Promise<boolean> {
    try {
      if (!(await this.#authorityCurrent())) return false
      const state = await this.options.store.read()
      return !!state && state.admissionGeneration === this.options.admission.admissionGeneration &&
        state.admissionDigest === this.options.admission.digest &&
        this.options.admission.routes.some(current => isDeepStrictEqual(current, route)) &&
        state.routes.some(current => isDeepStrictEqual(current, route))
    } catch { return false }
  }
  async #effectCurrent(route: HostedApprovalRuntimeRoute): Promise<boolean> {
    return await this.options.store.wal.ownsCurrentFence() && await this.#routeCurrent(route)
  }
  async #prepareEffectToken(route: HostedApprovalRuntimeRoute, expectedState: HostedApprovalOwnerState) {
    if (!(await this.#routeCurrent(route))) return null
    const admissionToken = await this.options.admission.prepareEffectToken()
    if (!admissionToken) return null
    const walToken = await this.options.store.wal.prepareEffectToken(expectedState)
    if (!walToken) { admissionToken.consume(); return null }
    let consumed = false
    return {
      consume: () => {
        if (consumed) return false
        consumed = true
        // WAL/fence is the last check at the invocation edge.
        const admissionCurrent = admissionToken.consume()
        const walCurrent = walToken.consume()
        return admissionCurrent && walCurrent
      },
    }
  }
  async #reject(state: HostedApprovalOwnerState, route: HostedApprovalRuntimeRoute, outboxId: string, input: Parameters<HostedApprovalWirePort['deliverDecision']>[0], result: Exclude<HostedApprovalDeliveryState['result'], 'delivered' | null>, operationNonce: string) {
    if (!(await this.#routeCurrent(route))) return { status: 'stale_generation' as const }
    const record = [...state.ingress, ...state.retiredIngress].find(item => item.outboxId === outboxId)
    if (!record) return { status: 'unavailable' as const }
    const delivery: HostedApprovalDeliveryState = { providerDeliveryId: input.request.providerDeliveryId, reconciliationRef: input.request.reconciliationRef, deliveryRef: input.request.deliveryRef, payloadFingerprint: input.payloadFingerprint, outboxId, effectRef: record.effectRef, phase: 'rejected', result }
    await this.options.store.wal.publishMutation(state, { ...withoutRevision(state), deliveries: [...state.deliveries, delivery] }, {
      operationNonce, mutation: { kind: 'delivery-settled', phase: 'rejected', outcome: result }, delivery,
    })
    return { status: result } as const
  }
  async #settle(state: HostedApprovalOwnerState, delivery: HostedApprovalDeliveryState, phase: 'completed' | 'rejected', result: NonNullable<HostedApprovalDeliveryState['result']>, operationNonce: string) {
    // A provider receipt or proven terminal pre-effect failure is stronger than
    // a later admission rotation. Persist that evidence under the WAL CAS; do
    // not turn a proved outcome back into ambiguity.
    const settled = { ...delivery, phase, result } as HostedApprovalDeliveryState
    await this.options.store.wal.publishMutation(state, { ...withoutRevision(state), deliveries: state.deliveries.map(item => item.providerDeliveryId === delivery.providerDeliveryId ? settled : item) }, {
      operationNonce,
      mutation: phase === 'completed'
        ? { kind: 'delivery-settled', phase: 'completed', outcome: 'delivered' }
        : { kind: 'delivery-settled', phase: 'rejected', outcome: result as Exclude<typeof result, 'delivered'> },
      delivery: settled,
    })
    return { status: result === 'delivered' ? 'delivered' as const : result }
  }
}

function bindRequest(state: HostedApprovalOwnerState, request: HostedApprovalDeliveryRequest) {
  const record = state.ingress.find(item => item.deliveryRef === request.deliveryRef && item.commandId === request.requestId && item.authority.teamId === request.partition.teamId && item.authority.runId === request.partition.runId)
  if (!record || request.approvalGeneration !== `generation_runtime-permission-${record.effectRef.slice(7)}`) return null
  const approvalId = `approval_${createHash('sha256').update(JSON.stringify({ schemaVersion: 1, teamId: request.partition.teamId, runId: request.partition.runId, requestId: request.requestId })).digest('hex').slice(0, 32)}`
  if (request.approvalId !== approvalId) return null
  const route = state.routes.find(item => isDeepStrictEqual(item.authority, record.authority)); return route ? { record, route } : null
}
function replay(prior: HostedApprovalDeliveryState, request: HostedApprovalDeliveryRequest, fingerprint: string): HostedApprovalDeliveryPortResult {
  if (prior.providerDeliveryId !== request.providerDeliveryId || prior.deliveryRef !== request.deliveryRef ||
    prior.reconciliationRef !== request.reconciliationRef || prior.payloadFingerprint !== fingerprint) return { status: 'conflict' }
  if (prior.phase === 'started') return operatorRequired(prior.reconciliationRef)
  if (prior.phase === 'completed') return { status: 'idempotent_replay' }
  return { status: prior.result ?? 'unavailable' }
}
function operatorRequired(reconciliationRef: string): HostedApprovalDeliveryPortResult {
  return { status: 'operator_required', reconciliationRef }
}
function findDelivery(state: HostedApprovalOwnerState, request: HostedApprovalDeliveryRequest): HostedApprovalDeliveryState | undefined {
  const exactIngress = [...state.ingress, ...state.retiredIngress].find(record =>
    record.deliveryRef === request.deliveryRef && record.commandId === request.requestId &&
    record.authority.teamId === request.partition.teamId && record.authority.runId === request.partition.runId)
  return state.deliveries.find(item =>
    item.providerDeliveryId === request.providerDeliveryId ||
    item.reconciliationRef === request.reconciliationRef || item.deliveryRef === request.deliveryRef ||
    exactIngress?.outboxId === item.outboxId,
  )
}
