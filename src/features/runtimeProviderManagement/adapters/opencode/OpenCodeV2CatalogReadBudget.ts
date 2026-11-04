import { OpenCodeRuntimeDeadline } from '../../../../services/opencode/OpenCodeRuntimeDeadline.js'

export const OPEN_CODE_V2_CATALOG_READ_BUDGET_MS = 240_000
export type OpenCodeV2CatalogReadPhase = 'selection' | 'profile' | 'receipt' | 'acquisition' | 'sdk' | 'models' | 'retirement'

export class OpenCodeV2CatalogReadTimeout extends Error {
  constructor(phase: OpenCodeV2CatalogReadPhase, budget: OpenCodeRuntimeDeadline, cause: unknown) {
    super(`OpenCode V2 catalog timed out during ${phase} after ${budget.elapsedMs}ms (budget ${budget.commandBudgetMs}ms). No model execution was submitted.`, { cause })
    this.name = 'OpenCodeV2CatalogReadTimeout'
  }
}

/** One read budget from native selection through retirement. Never races an owned
 * operation: its existing abort/retirement path must finish or retain custody. */
export class OpenCodeV2CatalogReadBudget {
  readonly deadline: OpenCodeRuntimeDeadline
  private phase: OpenCodeV2CatalogReadPhase = 'selection'
  private failedPhase: OpenCodeV2CatalogReadPhase | undefined
  private expiredPhase: OpenCodeV2CatalogReadPhase | undefined
  constructor(timeoutMs = OPEN_CODE_V2_CATALOG_READ_BUDGET_MS) {
    this.deadline = new OpenCodeRuntimeDeadline(timeoutMs)
    this.deadline.signal.addEventListener('abort', () => { this.expiredPhase = this.phase }, { once: true })
  }
  get signal(): AbortSignal { return this.deadline.signal }
  /** Keep the failed stage when normal retirement runs; cleanup failure takes precedence. */
  get diagnosticPhase(): OpenCodeV2CatalogReadPhase { return this.failedPhase ?? this.phase }
  noteFailure(phase: OpenCodeV2CatalogReadPhase = this.phase): void { this.failedPhase = phase }
  remainingMs(): number { return this.deadline.remainingMs() }
  enter(phase: OpenCodeV2CatalogReadPhase): void { this.check(); this.phase = phase }
  check(): void { this.deadline.throwIfExpired() }
  /** Retirement runs even when the read budget is already exhausted. */
  retiring(): void { if (this.remainingMs() > 0) this.phase = 'retirement' }
  async run<T>(operation: (budget: OpenCodeV2CatalogReadBudget) => Promise<T>): Promise<T> {
    try {
      const value = await operation(this)
      this.check()
      return value
    } catch (error) {
      if (this.signal.aborted) throw new OpenCodeV2CatalogReadTimeout(this.expiredPhase ?? this.phase, this.deadline, error)
      throw error
    } finally { this.deadline.dispose() }
  }
}
