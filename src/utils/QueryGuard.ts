/**
 * Synchronous state machine for the query lifecycle, compatible with
 * React's `useSyncExternalStore`.
 *
 * Three states:
 *   idle        → no query, safe to dequeue and process
 *   dispatching → an item was dequeued, async chain hasn't reached onQuery yet
 *   running     → onQuery called tryStart(), query is executing
 *
 * Transitions:
 *   idle → dispatching  (reserve / reserveContinuation)
 *   dispatching → running  (tryStart / startReservedContinuation)
 *   idle → running  (tryStart, for direct user submissions)
 *   running → idle  (end / forceEnd)
 *   dispatching → idle  (cancelReservation / cancelReservedContinuation)
 *
 * `isActive` returns true for both dispatching and running, preventing
 * re-entry from the queue processor during the async gap.
 *
 * Continuation tickets are owner-scoped. Ordinary `cancelReservation()`
 * never drops a continuation ticket; a late C1 finally cannot release C2.
 *
 * Usage with React:
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { randomUUID } from 'node:crypto'
import { createSignal } from './signal.js'

export type ContinuationTicket = {
  runtimeInstanceId: string
  expectedGeneration: number
  reservationNonce: string
  intentId: string
  admissionPayloadHash?: string
  expiresAtMs?: number
}

export type ContinuationReserveResult =
  | { ok: true; ticket: ContinuationTicket }
  | {
      ok: false
      code: 'busy' | 'instance_mismatch' | 'conflict'
    }

export type ContinuationStartResult =
  | { ok: true; generation: number }
  | { ok: false; code: 'stale' | 'busy' }

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _generation = 0
  private _continuation: ContinuationTicket | null = null
  private readonly _runtimeInstanceId: string
  private readonly _changed = createSignal()

  constructor(runtimeInstanceId = randomUUID()) {
    this._runtimeInstanceId = runtimeInstanceId
  }

  get runtimeInstanceId(): string {
    return this._runtimeInstanceId
  }

  /**
   * Reserve the guard for ordinary queue processing. Transitions idle → dispatching.
   * Returns false if not idle (another query, dispatch, or continuation in progress).
   */
  reserve(): boolean {
    if (this._status !== 'idle' || this._continuation) return false
    this._status = 'dispatching'
    this._notify()
    return true
  }

  /**
   * Protocol-2 early continuation: synchronous reserve before the first await.
   * The ticket is bound to one intent/nonce and this runtime instance.
   */
  reserveContinuation(input: {
    runtimeInstanceId: string
    expectedGeneration: number
    intentId: string
    reservationNonce?: string
    admissionPayloadHash?: string
    expiresAtMs?: number
  }): ContinuationReserveResult {
    if (this._status !== 'idle' || this._continuation) {
      return { ok: false, code: 'busy' }
    }
    if (
      input.runtimeInstanceId !== this._runtimeInstanceId ||
      input.expectedGeneration !== this._generation
    ) {
      return { ok: false, code: 'instance_mismatch' }
    }
    const intentId = input.intentId.trim()
    if (!intentId) {
      return { ok: false, code: 'conflict' }
    }
    const ticket: ContinuationTicket = {
      runtimeInstanceId: this._runtimeInstanceId,
      expectedGeneration: this._generation,
      reservationNonce: input.reservationNonce?.trim() || randomUUID(),
      intentId,
      ...(input.admissionPayloadHash?.trim()
        ? { admissionPayloadHash: input.admissionPayloadHash.trim() }
        : {}),
      ...(input.expiresAtMs != null ? { expiresAtMs: input.expiresAtMs } : {}),
    }
    this._continuation = ticket
    this._status = 'dispatching'
    this._notify()
    return { ok: true, ticket }
  }

  /**
   * Cancel an ordinary queue reservation when processQueueIfReady had nothing
   * to process. Does not touch a continuation ticket: a late C1 finally must
   * not drop a newer C2 reservation.
   */
  cancelReservation(): void {
    if (this._continuation) return
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this._notify()
  }

  cancelReservedContinuation(
    ticket: ContinuationTicket,
  ): 'cancelled' | 'stale' {
    if (!this.matchesContinuation(ticket)) {
      return 'stale'
    }
    this._continuation = null
    if (this._status === 'dispatching') {
      this._status = 'idle'
    }
    this._notify()
    return 'cancelled'
  }

  /**
   * User/foreground submit wins: drop a pending continuation ticket then
   * leave the guard idle so ordinary reserve/tryStart can proceed.
   */
  invalidateContinuationForUserSubmit(): boolean {
    if (!this._continuation) return false
    this._continuation = null
    if (this._status === 'dispatching') {
      this._status = 'idle'
    }
    this._notify()
    return true
  }

  /**
   * Start a query. Returns the generation number on success,
   * or null if a query is already running (concurrent guard).
   * Accepts transitions from both idle (direct user submit)
   * and dispatching (queue processor path).
   *
   * A held continuation ticket is dropped: user/direct start wins.
   */
  tryStart(): number | null {
    if (this._status === 'running') return null
    this._continuation = null
    this._status = 'running'
    ++this._generation
    this._notify()
    return this._generation
  }

  startReservedContinuation(
    ticket: ContinuationTicket,
  ): ContinuationStartResult {
    if (this._status === 'running') {
      return { ok: false, code: 'busy' }
    }
    if (
      !this.matchesContinuation(ticket) ||
      this._status !== 'dispatching' ||
      ticket.runtimeInstanceId !== this._runtimeInstanceId
    ) {
      return { ok: false, code: 'stale' }
    }
    this._continuation = null
    this._status = 'running'
    ++this._generation
    this._notify()
    return { ok: true, generation: this._generation }
  }

  /**
   * End a query. Returns true if this generation is still current
   * (meaning the caller should perform cleanup). Returns false if a
   * newer query has started (stale finally block from a cancelled query).
   */
  end(generation: number): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._status = 'idle'
    this._notify()
    return true
  }

  /**
   * Force-end the current query regardless of generation.
   * Used by onCancel where any running query should be terminated.
   * Increments generation so stale finally blocks from the cancelled
   * query's promise rejection will see a mismatch and skip cleanup.
   * Also invalidates a continuation ticket, including an idle leftover.
   */
  forceEnd(): void {
    const hadContinuation = this._continuation != null
    this._continuation = null
    if (this._status === 'idle' && !hadContinuation) return
    this._status = 'idle'
    ++this._generation
    this._notify()
  }

  /**
   * Is the guard active (dispatching or running)?
   * Always synchronous — not subject to React state batching delays.
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  get status(): 'idle' | 'dispatching' | 'running' {
    return this._status
  }

  get generation(): number {
    return this._generation
  }

  get continuationTicket(): ContinuationTicket | null {
    return this._continuation
  }

  // --
  // useSyncExternalStore interface

  /** Subscribe to state changes. Stable reference — safe as useEffect dep. */
  subscribe = this._changed.subscribe

  /** Snapshot for useSyncExternalStore. Returns `isActive`. */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  expireReservedContinuation(nowMs = Date.now()): boolean {
    const ticket = this._continuation
    if (!ticket?.expiresAtMs || ticket.expiresAtMs > nowMs) {
      return false
    }
    this._continuation = null
    if (this._status === 'dispatching') {
      this._status = 'idle'
    }
    this._notify()
    return true
  }

  private matchesContinuation(ticket: ContinuationTicket): boolean {
    return (
      this._continuation != null &&
      this._continuation.reservationNonce === ticket.reservationNonce &&
      this._continuation.intentId === ticket.intentId &&
      (this._continuation.admissionPayloadHash ?? '') ===
        (ticket.admissionPayloadHash ?? '')
    )
  }

  private _notify(): void {
    this._changed.emit()
  }
}
