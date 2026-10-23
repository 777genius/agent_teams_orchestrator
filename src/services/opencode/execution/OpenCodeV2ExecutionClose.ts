import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

/** The owner waits 10s for the wrapper exit after its close frame, then force
 * kills. The whole close sequence shares one window inside that limit and
 * always reserves its tail for the ACK send. */
export const openCodeV2ExecutionCloseMs = 8500
export const openCodeV2ExecutionCloseAckReserveMs = 2000

export type ExecutionCloseSequenceInput = Readonly<{
  startup?: Promise<unknown> | undefined
  finalize?: (() => Promise<unknown>) | undefined
  acknowledge: () => Promise<void>
}>

/** The closed ACK certifies an authenticated identity and a disarmed wrapper
 * facade (see the child-control send), so neither a startup join nor a finalize
 * drain may delay or withhold it: the server/relay close is process self-cleanup
 * the OS reclaims at exit, exactly like the native realpath drain. Both run
 * best-effort within the shared bound; only an uncertain acknowledge (identity or
 * an uncertain disarm) withholds the ACK. Returns whether it was delivered. */
export async function runOpenCodeV2ExecutionCloseSequence(sequence: ExecutionCloseSequenceInput,
  deadline: number = Date.now() + openCodeV2ExecutionCloseMs): Promise<boolean> {
  const remaining = () => Math.max(1, deadline - Date.now())
  const phase = () => Math.max(1, remaining() - openCodeV2ExecutionCloseAckReserveMs)
  try {
    if (sequence.startup) await boundOpenCodeRead(Promise.resolve(sequence.startup).catch(() => undefined), phase())
  } catch { /* Best-effort join; an unused scope still ships its ACK. */ }
  try {
    if (sequence.finalize) await boundOpenCodeRead(sequence.finalize(), phase())
  } catch { /* Best-effort drain; the OS reclaims the server at exit. */ }
  try { await boundOpenCodeRead(sequence.acknowledge(), Math.min(remaining(), openCodeV2ExecutionCloseAckReserveMs)); return true } catch { return false }
}
