/** Inventory work keeps its original budget; only explicit command-lock queueing is excluded. */
export class OpenCodeInventoryActiveTimeout {
  private timer: ReturnType<typeof setTimeout> | undefined
  private remainingMs: number
  private startedAt = performance.now()
  private waiting = false
  private disposed = false

  constructor(timeoutMs: number, private readonly expire: () => void) {
    this.remainingMs = timeoutMs
    this.arm()
  }

  readonly setQueueWaiting = (waiting: boolean): void => {
    if (this.disposed || this.waiting === waiting) return
    this.waiting = waiting
    if (waiting) {
      clearTimeout(this.timer)
      this.remainingMs -= Math.max(0, performance.now() - this.startedAt)
      if (this.remainingMs <= 0) this.finish()
    } else this.arm()
  }

  private arm(): void {
    this.startedAt = performance.now()
    this.timer = setTimeout(() => this.finish(), Math.max(0, this.remainingMs))
  }

  private finish(): void {
    if (this.disposed) return
    this.dispose()
    this.expire()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
  }
}
