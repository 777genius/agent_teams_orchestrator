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

/** A startup join that rejects or times out still closes an unused scope with
 * its ACK; only a fully completed finalize earns one. Returns whether the
 * closed acknowledgment was delivered. */
export async function runOpenCodeV2ExecutionCloseSequence(sequence: ExecutionCloseSequenceInput,
  deadline: number = Date.now() + openCodeV2ExecutionCloseMs): Promise<boolean> {
  let complete = true
  const remaining = () => Math.max(1, deadline - Date.now())
  const phase = () => Math.max(1, remaining() - openCodeV2ExecutionCloseAckReserveMs)
  try {
    if (sequence.startup) await boundOpenCodeRead(Promise.resolve(sequence.startup).catch(() => undefined), phase())
  } catch { complete = false }
  try {
    if (sequence.finalize) await boundOpenCodeRead(sequence.finalize(), phase())
  } catch { complete = false }
  if (!complete) return false
  try { await boundOpenCodeRead(sequence.acknowledge(), Math.min(remaining(), openCodeV2ExecutionCloseAckReserveMs)); return true } catch { return false }
}
