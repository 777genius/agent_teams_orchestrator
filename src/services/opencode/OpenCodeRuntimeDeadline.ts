export const OPEN_CODE_READINESS_PHASES = [
  'mcp_preflight',
  'host_start',
  'execution_submit',
  'execution_poll',
  'post_probe_refresh',
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
}

type OpenCodeRuntimeDeadlineDeps = {
  monotonicNow?: () => number
  setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

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
  await raceOpenCodeAbortSignal(
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    signal,
  )
}

export class OpenCodeRuntimeDeadline {
  private readonly monotonicNow: () => number
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly startedAtMs: number
  private readonly deadlineAtMs: number
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
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
    this.clearTimer = deps.clearTimer ?? clearTimeout
    this.startedAtMs = this.monotonicNow()
    this.deadlineAtMs = this.startedAtMs + commandBudgetMs
    const setTimer = deps.setTimer ?? setTimeout
    this.timer = setTimer(
      () => this.abortForDeadline(),
      commandBudgetMs,
    ) as ReturnType<typeof setTimeout>
    this.timer.unref?.()
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
    this.currentPhase = phase
    this.throwIfExpired(phase)

    const context: OpenCodePhaseContext = {
      phase,
      signal: this.controller.signal,
      remainingMs: () => this.remainingMs(),
      throwIfExpired: () => this.throwIfExpired(phase),
    }
    let removeAbortListener = () => {}
    const aborted = new Promise<never>((_, reject) => {
      const rejectWithReason = () => {
        try {
          throwOpenCodeAbortReason(this.controller.signal)
        } catch (error) {
          reject(error)
        }
      }
      if (this.controller.signal.aborted) {
        rejectWithReason()
        return
      }
      this.controller.signal.addEventListener('abort', rejectWithReason, { once: true })
      removeAbortListener = () => {
        this.controller.signal.removeEventListener('abort', rejectWithReason)
      }
    })

    try {
      return await Promise.race([operation(context), aborted])
    } finally {
      removeAbortListener()
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearTimer(this.timer)
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
