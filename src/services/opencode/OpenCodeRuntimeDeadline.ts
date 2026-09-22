export const OPEN_CODE_READINESS_PHASES = [
  'mcp_preflight',
  'host_start',
  'execution_submit',
  'execution_poll',
  'post_probe_refresh',
  'provider_mutation',
  'stop_abort',
  'stop_verify',
  'stop_cleanup',
] as const

export type OpenCodeReadinessPhase = typeof OPEN_CODE_READINESS_PHASES[number]

export type OpenCodePhaseContext = {
  phase: OpenCodeReadinessPhase
  signal: AbortSignal
  remainingMs(): number
  throwIfExpired(): void
  /** Records an observable quarantine for late side effects. Quarantine is
   * diagnostic state, not permission to release the mutation fence: only the
   * actual operation settlement can retire its receipt. */
  markLateEffectsSafelyIsolated(): void
}

type OpenCodeRuntimeDeadlineDeps = {
  monotonicNow?: () => number
  setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  quiescenceGraceMs?: number
  quiescenceGate?: OpenCodeRuntimeQuiescenceGate
}

const DEFAULT_QUIESCENCE_GRACE_MS = 250

export type OpenCodeLateEffectReceipt = {
  phase: OpenCodeReadinessPhase
  graceMs: number
  safelyIsolated: boolean
  settled: boolean
  settlement: Promise<void>
}

export class OpenCodeRuntimeLateEffectFencedError extends Error {
  constructor(readonly receipts: readonly OpenCodeLateEffectReceipt[]) {
    super('OpenCode operation has late effects that have not settled')
    this.name = 'OpenCodeRuntimeLateEffectFencedError'
  }
}

/** Process-wide by default: a command that has escaped its deadline cannot
 * overlap a later OpenCode command until its late effect actually settles. */
export class OpenCodeRuntimeQuiescenceGate {
  private readonly receipts = new Set<OpenCodeLateEffectReceipt>()
  /**
   * Provider state is one mutable resource from this process's point of view.
   * The queue is deliberately separate from late-effect receipts: admission
   * must happen before an operation is even constructed, while receipts keep a
   * timed-out owner from releasing a resource it may still be changing.
   */
  private providerMutationTail: Promise<void> = Promise.resolve()

  add(receipt: OpenCodeLateEffectReceipt): void {
    this.receipts.add(receipt)
  }

  delete(receipt: OpenCodeLateEffectReceipt): void {
    this.receipts.delete(receipt)
  }

  assertCanStartConflictingWork(): void {
    const blocking = [...this.receipts].filter(receipt => !receipt.settled)
    if (blocking.length > 0) throw new OpenCodeRuntimeLateEffectFencedError(blocking)
  }

  async acquireProviderMutation(signal: AbortSignal): Promise<() => void> {
    const predecessor = this.providerMutationTail
    let resolveTurn!: () => void
    const turn = new Promise<void>(resolve => { resolveTurn = resolve })
    this.providerMutationTail = predecessor.then(() => turn)
    let released = false
    const release = () => {
      if (released) return
      released = true
      resolveTurn()
    }
    try {
      // Do not start a provider promise while waiting for admission.  If this
      // command is cancelled in the queue, it still retires its queue turn
      // after its predecessor, preserving FIFO exclusion for the next owner.
      await raceOpenCodeAbortSignal(predecessor, signal)
      return release
    } catch (error) {
      void predecessor.then(release)
      throw error
    }
  }
}

const defaultOpenCodeRuntimeQuiescenceGate = new OpenCodeRuntimeQuiescenceGate()

export class OpenCodeRuntimeDeadlineError extends Error {
  readonly kind = 'timeout' as const

  constructor(
    readonly phase: OpenCodeReadinessPhase,
    readonly commandBudgetMs: number,
    readonly elapsedMs: number,
  ) {
    super(`OpenCode readiness phase ${phase} timed out after ${elapsedMs}ms`)
    this.name = 'OpenCodeRuntimeDeadlineError'
  }

  get remainingMs(): number {
    return Math.max(0, this.commandBudgetMs - this.elapsedMs)
  }

  toDetails(): Record<string, unknown> {
    return {
      phase: this.phase,
      commandBudgetMs: this.commandBudgetMs,
      elapsedMs: this.elapsedMs,
      remainingMs: this.remainingMs,
    }
  }
}

export function isOpenCodeRuntimeDeadlineError(
  error: unknown,
): error is OpenCodeRuntimeDeadlineError {
  return error instanceof OpenCodeRuntimeDeadlineError
}

export function throwOpenCodeAbortReason(signal: AbortSignal): never {
  const reason = signal.reason
  if (reason instanceof Error) {
    throw reason
  }
  throw new Error(typeof reason === 'string' ? reason : 'OpenCode operation aborted')
}

export async function raceOpenCodeAbortSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) throwOpenCodeAbortReason(signal)

  let removeAbortListener = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const rejectWithReason = () => {
      try {
        throwOpenCodeAbortReason(signal)
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', rejectWithReason, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', rejectWithReason)
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    removeAbortListener()
  }
}

export async function waitForOpenCodeAbortableDelay(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
    return
  }
  if (signal.aborted) throwOpenCodeAbortReason(signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await raceOpenCodeAbortSignal(
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) }),
      signal,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class OpenCodeRuntimeDeadline {
  private readonly monotonicNow: () => number
  private readonly setTimer: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly quiescenceGraceMs: number
  private readonly quiescenceGate: OpenCodeRuntimeQuiescenceGate
  private readonly startedAtMs: number
  private readonly deadlineAtMs: number
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  /** Late operations are fenced after a bounded grace. The receipt is the
   * production hand-off: conflicting work must not proceed until it settles.
   * Quarantine can be observed but cannot unlock a mutable provider lane. */
  private readonly lateEffectReceipts = new Set<OpenCodeLateEffectReceipt>()
  private currentPhase: OpenCodeReadinessPhase = 'host_start'
  private disposed = false

  constructor(
    readonly commandBudgetMs: number,
    deps: OpenCodeRuntimeDeadlineDeps = {},
  ) {
    if (!Number.isFinite(commandBudgetMs) || commandBudgetMs <= 0) {
      throw new Error('OpenCode runtime deadline requires a positive finite command budget')
    }

    this.monotonicNow = deps.monotonicNow ?? (() => performance.now())
    this.setTimer = deps.setTimer ?? setTimeout
    this.clearTimer = deps.clearTimer ?? clearTimeout
    this.quiescenceGraceMs = deps.quiescenceGraceMs ?? DEFAULT_QUIESCENCE_GRACE_MS
    this.quiescenceGate = deps.quiescenceGate ?? defaultOpenCodeRuntimeQuiescenceGate
    if (!Number.isFinite(this.quiescenceGraceMs) || this.quiescenceGraceMs < 0) {
      throw new Error('OpenCode runtime deadline requires a non-negative finite quiescence grace')
    }
    this.startedAtMs = this.monotonicNow()
    this.deadlineAtMs = this.startedAtMs + commandBudgetMs
    this.timer = this.setTimer(
      () => this.abortForDeadline(),
      commandBudgetMs,
    ) as ReturnType<typeof setTimeout>
    // Bun on Windows can leave an idle loop asleep when the only deadline is
    // unreferenced. Command ownership disposes this referenced timer.
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get elapsedMs(): number {
    return Math.max(0, Math.ceil(this.monotonicNow() - this.startedAtMs))
  }

  remainingMs(): number {
    return Math.max(0, Math.ceil(this.deadlineAtMs - this.monotonicNow()))
  }

  get unsettledOperationCount(): number {
    return this.lateEffectReceipts.size
  }

  get lateEffects(): readonly OpenCodeLateEffectReceipt[] {
    return [...this.lateEffectReceipts]
  }

  assertCanStartConflictingWork(): void {
    this.quiescenceGate.assertCanStartConflictingWork()
  }

  throwIfExpired(phase: OpenCodeReadinessPhase = this.currentPhase): void {
    this.currentPhase = phase
    if (this.controller.signal.aborted) {
      throwOpenCodeAbortReason(this.controller.signal)
    }
    if (this.remainingMs() <= 0) {
      this.abortForDeadline()
      throwOpenCodeAbortReason(this.controller.signal)
    }
  }

  async runPhase<T>(
    phase: OpenCodeReadinessPhase,
    operation: (context: OpenCodePhaseContext) => Promise<T>,
  ): Promise<T> {
    // Provider/reconciliation work is admitted before invoking its closure.
    // This is important because constructing several provider clients begins
    // observable I/O, not merely local preparation.
    let releaseMutation = phase === 'provider_mutation'
      ? await this.quiescenceGate.acquireProviderMutation(this.controller.signal)
      : undefined
    let removeAbortListener = () => {}
    let operationPromise: Promise<T> | undefined
    let safelyIsolated = false
    let lateEffectReceipt: OpenCodeLateEffectReceipt | undefined
    const isolateLateEffects = () => {
      safelyIsolated = true
      if (lateEffectReceipt) {
        lateEffectReceipt.safelyIsolated = true
      }
    }
    try {
      this.assertCanStartConflictingWork()
      this.currentPhase = phase
      this.throwIfExpired(phase)
      const context: OpenCodePhaseContext = {
        phase,
        signal: this.controller.signal,
        remainingMs: () => this.remainingMs(),
        throwIfExpired: () => this.throwIfExpired(phase),
        markLateEffectsSafelyIsolated: isolateLateEffects,
      }
      const aborted = new Promise<never>((_, reject) => {
        const rejectWithReason = () => {
          try { throwOpenCodeAbortReason(this.controller.signal) } catch (error) { reject(error) }
        }
        if (this.controller.signal.aborted) { rejectWithReason(); return }
        this.controller.signal.addEventListener('abort', rejectWithReason, { once: true })
        removeAbortListener = () => this.controller.signal.removeEventListener('abort', rejectWithReason)
      })
      // Deferring only to a microtask means admission is complete before the
      // provider closure can perform its first read-modify-write or I/O.
      operationPromise = Promise.resolve().then(() => {
        this.throwIfExpired(phase)
        return operation(context)
      })
      return await Promise.race([operationPromise, aborted])
    } catch (error) {
      if (operationPromise) {
        const settledDuringGrace = await this.waitForSettlementOrGrace(operationPromise)
        if (!settledDuringGrace) {
          const releaseLateMutation = releaseMutation
          lateEffectReceipt = this.recordLateEffect(operationPromise, phase, safelyIsolated, releaseLateMutation)
          // The late receipt now owns the provider turn. Do not release it in
          // this invocation's finally block; real settlement is the only
          // event that may make another mutation runnable.
          releaseMutation = undefined
        }
      }
      throw error
    } finally {
      removeAbortListener()
      releaseMutation?.()
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearTimer(this.timer)
  }

  abort(reason: unknown = new Error('OpenCode operation aborted')): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private waitForSettlementOrGrace(operation: Promise<unknown>): Promise<boolean> {
    return new Promise(resolve => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (settled: boolean) => {
        if (finished) return
        finished = true
        if (timer !== undefined) this.clearTimer(timer)
        resolve(settled)
      }
      timer = this.setTimer(() => finish(false), this.quiescenceGraceMs)
      void operation.then(
        () => finish(true),
        () => finish(true),
      )
    })
  }

  private recordLateEffect(
    operation: Promise<unknown>,
    phase: OpenCodeReadinessPhase,
    safelyIsolated: boolean,
    onSettlement?: () => void,
  ): OpenCodeLateEffectReceipt {
    let receipt!: OpenCodeLateEffectReceipt
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      receipt.settled = true
      this.lateEffectReceipts.delete(receipt)
      this.quiescenceGate.delete(receipt)
      onSettlement?.()
    })
    receipt = {
      phase,
      graceMs: this.quiescenceGraceMs,
      safelyIsolated,
      settled: false,
      settlement,
    }
    this.lateEffectReceipts.add(receipt)
    this.quiescenceGate.add(receipt)
    return receipt
  }

  private abortForDeadline(): void {
    if (this.controller.signal.aborted) {
      return
    }
    this.controller.abort(
      new OpenCodeRuntimeDeadlineError(
        this.currentPhase,
        this.commandBudgetMs,
        Math.max(this.commandBudgetMs, this.elapsedMs),
      ),
    )
  }
}
