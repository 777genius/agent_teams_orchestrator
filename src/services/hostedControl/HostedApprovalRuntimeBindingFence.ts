const PIN_FENCE = Symbol('HostedApprovalRuntimeBindingFence')

export type HostedApprovalRuntimeBindingPin = {
  readonly [PIN_FENCE]: HostedApprovalRuntimeBindingFence
  isCurrent(): boolean
  capture<T>(operation: () => Promise<T>): Promise<T>
  release(): void
}

type Waiter = (release: () => void) => void

/**
 * Per-team serialization primitive shared by authoritative binding reads,
 * transition pins, and every controlled binding mutation.
 */
export class HostedApprovalRuntimeBindingFence {
  #held = false
  #generation = 0
  readonly #waiters: Waiter[] = []

  /** A short, consistent binding capture. */
  async capture<T>(operation: () => Promise<T>): Promise<T> {
    return await this.#run(operation)
  }

  /** The only entry point for mutations capable of changing binding evidence. */
  async write<T>(operation: () => Promise<T>): Promise<T> {
    return await this.#run(operation)
  }

  async withReadFence<T>(operation: () => Promise<T>): Promise<T> {
    return await this.capture(operation)
  }

  async withBindingCapture<T>(operation: () => Promise<T>): Promise<T> {
    return await this.capture(operation)
  }

  async withWriteFence<T>(operation: () => Promise<T>): Promise<T> {
    return await this.write(operation)
  }

  async withBindingMutation<T>(operation: () => Promise<T>): Promise<T> {
    return await this.write(operation)
  }

  async capturePinned<T>(
    pin: HostedApprovalRuntimeBindingPin,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (pin[PIN_FENCE] !== this) {
      throw new Error('Hosted approval runtime binding pin belongs to another fence')
    }
    return await pin.capture(operation)
  }

  /**
   * Obtains the single live transition pin without waiting. A concurrent pin,
   * capture, or mutation is reported as busy so callers can preserve PIN_BUSY
   * semantics rather than queue past a request deadline.
   */
  tryAcquirePin(): HostedApprovalRuntimeBindingPin | null {
    if (this.#held || this.#waiters.length > 0) return null
    this.#held = true
    const generation = ++this.#generation
    let released = false
    const isCurrent = () => !released && this.#held && this.#generation === generation
    const pin: HostedApprovalRuntimeBindingPin = {
      [PIN_FENCE]: this,
      isCurrent,
      capture: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (!isCurrent()) throw new Error('Hosted approval runtime binding pin is not current')
        const result = await operation()
        if (!isCurrent()) throw new Error('Hosted approval runtime binding pin is not current')
        return result
      },
      release: () => {
        if (released) return
        released = true
        if (this.#held && this.#generation === generation) this.#release()
      },
    }
    return pin
  }

  tryAcquireBindingPin(): HostedApprovalRuntimeBindingPin | null {
    return this.tryAcquirePin()
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.#acquire()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  #acquire(): Promise<() => void> {
    if (!this.#held && this.#waiters.length === 0) {
      this.#held = true
      ++this.#generation
      return Promise.resolve(this.#releaseToken())
    }
    return new Promise(resolve => this.#waiters.push(resolve))
  }

  #releaseToken(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#release()
    }
  }

  #release(): void {
    const next = this.#waiters.shift()
    if (!next) {
      this.#held = false
      return
    }
    this.#held = true
    ++this.#generation
    next(this.#releaseToken())
  }
}

export type HostedApprovalRuntimeBindingMutationFence = {
  withTeamBindingMutation<T>(teamId: string, operation: () => Promise<T>): Promise<T>
}

/** Injection surface for profile, host-record, owner, and capability writers. */
export type HostedApprovalRuntimeBindingWriterIntegrationSeam = {
  withBindingMutation<T>(operation: () => Promise<T>): Promise<T>
}

/**
 * Process-wide seam for binding-source writers. Each team receives one fence,
 * while unrelated teams remain independently writable. Production owners can
 * inject the same registry into transition lease handling without importing
 * any OpenCode store implementation.
 */
export class HostedApprovalRuntimeBindingFenceRegistry
implements HostedApprovalRuntimeBindingMutationFence {
  readonly #teams = new Map<string, HostedApprovalRuntimeBindingFence>()

  forTeam(teamId: string): HostedApprovalRuntimeBindingFence {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(teamId)) {
      throw new TypeError('Hosted approval binding fence teamId is invalid')
    }
    let fence = this.#teams.get(teamId)
    if (!fence) {
      fence = new HostedApprovalRuntimeBindingFence()
      this.#teams.set(teamId, fence)
    }
    return fence
  }

  async withTeamBindingMutation<T>(teamId: string, operation: () => Promise<T>): Promise<T> {
    return await this.forTeam(teamId).withBindingMutation(operation)
  }

  writerIntegrationForTeam(teamId: string): HostedApprovalRuntimeBindingWriterIntegrationSeam {
    const fence = this.forTeam(teamId)
    return {
      withBindingMutation: async <T>(operation: () => Promise<T>) =>
        await fence.withBindingMutation(operation),
    }
  }
}

export const hostedApprovalRuntimeBindingFences =
  new HostedApprovalRuntimeBindingFenceRegistry()
