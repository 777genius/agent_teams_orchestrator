import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { RunControlRequest } from './OpenCodeV2RunTypes.js'

/** Replay history covers only the signed frame's live operation window. A
 * 24-hour run must not exhaust its control channel after 4096 total polls.
 * Reserve eight of the fixed 4096 live slots exclusively for scoped stop. */
export class OpenCodeV2RunNonces {
  private readonly live = new Map<string, number>()
  claim(nonce: string, deadline: number, operation: RunControlRequest['operation'], now: number): void {
    executionAssert(Number.isSafeInteger(now) && Number.isSafeInteger(deadline) && deadline > now &&
      deadline - now <= 30_000, 'run_control_timeout')
    executionAssert(/^[a-f0-9]{64}$/.test(nonce), 'run_control_replay')
    for (const [key, expires] of this.live) if (expires <= now) this.live.delete(key)
    executionAssert(!this.live.has(nonce) && this.live.size < (operation === 'stop' ? 4096 : 4088), 'run_control_replay')
    this.live.set(nonce, deadline)
  }
}
