import { appendFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

type TraceDetails = Record<string, string | number | boolean | null | undefined>
let count = 0
/** TEST observation only; never changes a queried identity or return value. */
export function traceOwnPid(stage: string, pid: number | undefined, details: TraceDetails = {}): void {
  const file = process.env.TEST_LIVE_PID_TRACE
  if (!file || pid !== process.pid || count >= 200) return
  count += 1
  try {
    appendFileSync(file, JSON.stringify({ stage: count === 200 ? 'trace-limit-reached' : stage,
      now: Date.now(), monotonicMs: performance.now(), observerPid: process.pid, targetPid: pid, ...details }) + '\n')
  } catch {
    // Static marker only; never throw into process-query event callbacks.
    try { process.stderr.write('TEST_LIVE_PID_TRACE_WRITE_FAILED\n') } catch { /* A broken capture pipe cannot qualify. */ }
  }
}
