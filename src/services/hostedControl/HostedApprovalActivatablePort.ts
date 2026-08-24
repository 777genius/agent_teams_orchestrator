import type { HostedApprovalWirePort } from './HostedApprovalWire.js'

export type HostedApprovalActivationLifecycle =
  | { status: 'inactive'; epoch: 0 }
  | { status: 'recovering'; epoch: number }
  | { status: 'active'; epoch: number }
  | { status: 'revoked'; epoch: number; sealed: true }

export type HostedApprovalActivationEffectToken = {
  readonly epoch: number
  consume(): boolean
}

export type HostedApprovalActivationGuard = {
  readonly epoch: number
  /** True only while this exact activation attempt remains recovering or active. */
  isCurrent(): boolean
  /** Available only after the delegate has been installed. */
  prepareEffectToken(): HostedApprovalActivationEffectToken | null
  /** The delegate reference is installed synchronously at this call boundary. */
  install(delegate: HostedApprovalWirePort): void
}

type Lifecycle =
  | { status: 'inactive'; epoch: 0 }
  | { status: 'recovering'; epoch: number; attempt: symbol }
  | { status: 'active'; epoch: number; attempt: symbol; delegate: HostedApprovalWirePort }
  | { status: 'revoked'; epoch: number; sealed: true }

export class HostedApprovalPortUnavailableError extends Error {
  readonly code = 'hosted_approval_owner_unavailable'

  constructor() {
    super('Hosted approval owner is unavailable')
    this.name = 'HostedApprovalPortUnavailableError'
  }
}

/**
 * Stable fail-closed target for an approval owner recovered after startup.
 * Revocation replaces the active lifecycle reference before cleanup begins;
 * already-started delegate calls retain their result so proven receipts are
 * not rewritten by this forwarding layer.
 */
export class HostedApprovalActivatablePort implements HostedApprovalWirePort {
  #lifecycle: Lifecycle = { status: 'inactive', epoch: 0 }

  get lifecycle(): HostedApprovalActivationLifecycle {
    const lifecycle = this.#lifecycle
    switch (lifecycle.status) {
      case 'inactive': return { status: 'inactive', epoch: 0 }
      case 'recovering': return { status: 'recovering', epoch: lifecycle.epoch }
      case 'active': return { status: 'active', epoch: lifecycle.epoch }
      case 'revoked': return { status: 'revoked', epoch: lifecycle.epoch, sealed: true }
    }
  }

  beginRecovery(): HostedApprovalActivationGuard {
    if (this.#lifecycle.status !== 'inactive') {
      throw new Error('Hosted approval activation cannot be started more than once')
    }
    const epoch = this.#lifecycle.epoch + 1
    const attempt = Symbol('hosted-approval-activation-attempt')
    this.#lifecycle = { status: 'recovering', epoch, attempt }

    return Object.freeze({
      epoch,
      isCurrent: () => this.#isCurrentAttempt(epoch, attempt),
      prepareEffectToken: () => this.#prepareEffectToken(epoch, attempt),
      install: (delegate: HostedApprovalWirePort) => this.#install(epoch, attempt, delegate),
    })
  }

  async revoke(
    cleanup?: (delegate: HostedApprovalWirePort | null) => void | Promise<void>,
  ): Promise<void> {
    const lifecycle = this.#lifecycle
    if (lifecycle.status === 'revoked') return

    const delegate = lifecycle.status === 'active' ? lifecycle.delegate : null
    // This single replacement clears the delegate and advances the epoch. It
    // is the revocation linearization point and must precede all cleanup.
    this.#lifecycle = { status: 'revoked', epoch: lifecycle.epoch + 1, sealed: true }
    await cleanup?.(delegate)
  }

  claimIngress(input: Parameters<HostedApprovalWirePort['claimIngress']>[0]) {
    const delegate = this.#activeDelegate()
    return delegate
      ? delegate.claimIngress(input)
      : Promise.reject(new HostedApprovalPortUnavailableError())
  }

  acknowledgeIngress(request: Parameters<HostedApprovalWirePort['acknowledgeIngress']>[0]) {
    const delegate = this.#activeDelegate()
    return delegate
      ? delegate.acknowledgeIngress(request)
      : Promise.resolve({ status: 'unavailable' as const })
  }

  getAdmittedIngressAuthority(
    authority: Parameters<HostedApprovalWirePort['getAdmittedIngressAuthority']>[0],
  ) {
    const delegate = this.#activeDelegate()
    return delegate
      ? delegate.getAdmittedIngressAuthority(authority)
      : Promise.resolve(null)
  }

  resolveIngressAuthority(
    authority: Parameters<HostedApprovalWirePort['resolveIngressAuthority']>[0],
  ) {
    const delegate = this.#activeDelegate()
    return delegate
      ? delegate.resolveIngressAuthority(authority)
      : Promise.resolve({ status: 'unavailable' as const })
  }

  authorizeDecision(input: Parameters<HostedApprovalWirePort['authorizeDecision']>[0]) {
    const delegate = this.#activeDelegate()
    return delegate
      ? delegate.authorizeDecision(input)
      : Promise.resolve({ status: 'unavailable' as const })
  }

  deliverDecision(input: Parameters<HostedApprovalWirePort['deliverDecision']>[0]) {
    const delegate = this.#activeDelegate()
    return delegate
      ? delegate.deliverDecision(input)
      : Promise.resolve({ status: 'unavailable' as const })
  }

  reconcileDecision(request: Parameters<HostedApprovalWirePort['reconcileDecision']>[0]) {
    const delegate = this.#activeDelegate()
    return delegate
      ? delegate.reconcileDecision(request)
      : Promise.resolve({ status: 'unavailable' as const })
  }

  #activeDelegate(): HostedApprovalWirePort | null {
    const lifecycle = this.#lifecycle
    return lifecycle.status === 'active' ? lifecycle.delegate : null
  }

  #isCurrentAttempt(epoch: number, attempt: symbol): boolean {
    const lifecycle = this.#lifecycle
    return (lifecycle.status === 'recovering' || lifecycle.status === 'active') &&
      lifecycle.epoch === epoch && lifecycle.attempt === attempt
  }

  #prepareEffectToken(
    epoch: number,
    attempt: symbol,
  ): HostedApprovalActivationEffectToken | null {
    const lifecycle = this.#lifecycle
    if (
      lifecycle.status !== 'active' ||
      lifecycle.epoch !== epoch ||
      lifecycle.attempt !== attempt
    ) return null

    let consumed = false
    return Object.freeze({
      epoch,
      consume: () => {
        if (consumed) return false
        consumed = true
        const current = this.#lifecycle
        return current.status === 'active' &&
          current.epoch === epoch && current.attempt === attempt
      },
    })
  }

  #install(epoch: number, attempt: symbol, delegate: HostedApprovalWirePort): void {
    if (!delegate || typeof delegate !== 'object') {
      throw new TypeError('Hosted approval delegate is required')
    }
    const lifecycle = this.#lifecycle
    if (
      lifecycle.status !== 'recovering' ||
      lifecycle.epoch !== epoch ||
      lifecycle.attempt !== attempt
    ) {
      throw new Error('Hosted approval activation attempt is no longer current')
    }
    // The complete active state, including its delegate, becomes visible in
    // one synchronous reference assignment.
    this.#lifecycle = { status: 'active', epoch, attempt, delegate }
  }
}
