/** One admission deadline, converted once; never refreshed by a PID or phase. */
export class OpenCodeStartupCleanupBudget {
  private readonly deadline: number

  constructor(deadlineUnixMs: unknown, private readonly now = () => performance.now()) {
    const remaining = typeof deadlineUnixMs === 'number' ? deadlineUnixMs - Date.now() : NaN
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 120_000) {
      throw new Error('Startup cleanup requires a future deadlineUnixMs within 120 seconds')
    }
    this.deadline = now() + remaining
  }

  remaining(): number { return Math.max(0, this.deadline - this.now()) }

  cap(ms: number): number {
    const remaining = this.remaining()
    if (remaining <= 0) throw new Error('Startup cleanup deadline exhausted')
    return Math.min(ms, remaining)
  }

  assertAvailable(reserveMs = 0): void {
    if (this.remaining() <= reserveMs) throw new Error('Startup cleanup deadline exhausted')
  }
}
