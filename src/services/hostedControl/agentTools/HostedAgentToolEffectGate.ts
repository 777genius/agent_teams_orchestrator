/**
 * One Owner-process serialization point for tool effects and lifecycle transitions.
 * A caller must pass this same instance to revoke, member reassignment, and stop.
 * An effect cannot cross a transition; pending effects are fenced synchronously.
 */
export class HostedAgentToolEffectGate {
  #tail: Promise<void> = Promise.resolve()
  #generation = 0
  #closed = false
  #abort = new AbortController()

  async withCurrentMemberEffect<T>(
    isCurrent: () => boolean | Promise<boolean>,
    effect: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ kind: 'applied'; value: T } | { kind: 'unavailable' }> {
    if (this.#closed) return { kind: 'unavailable' }
    const generation = this.#generation
    return this.#enqueue(async () => {
      if (this.#closed || generation !== this.#generation || this.#abort.signal.aborted ||
        !(await isCurrent()) || generation !== this.#generation) return { kind: 'unavailable' }
      const value = await effect(this.#abort.signal)
      return { kind: 'applied', value }
    })
  }

  /** Fences pending effects now; waits for any started effect before changing ownership. */
  transition<T>(changeOwner: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Hosted agent tool effect gate is closed'))
    this.#generation += 1
    this.#abort.abort(new Error('Hosted agent tool authority is changing'))
    this.#abort = new AbortController()
    return this.#enqueue(async () => {
      if (this.#closed) throw new Error('Hosted agent tool effect gate is closed')
      try {
        return await changeOwner()
      } catch (error) {
        this.#closed = true
        this.#generation += 1
        this.#abort.abort(new Error('Hosted agent tool ownership transition failed'))
        throw error
      }
    })
  }

  /** Permanently rejects new effects and drains the one currently running. */
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#generation += 1
      this.#abort.abort(new Error('Hosted agent tool owner is closing'))
    }
    return this.#enqueue(async () => {})
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await prior
    try { return await operation() } finally { release() }
  }
}
