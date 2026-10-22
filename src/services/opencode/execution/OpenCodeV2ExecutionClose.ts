import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

/** The owner waits 10s for the wrapper exit after its close frame; the whole
 * close sequence, closed ACK included, must stay inside that window. */
export const openCodeV2ExecutionCloseMs = 9500
export const openCodeV2ExecutionCloseStartupMs = 6000
export const openCodeV2ExecutionCloseFinalizeMs = 3000
export const openCodeV2ExecutionCloseAckMs = 500

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
  try {
    if (sequence.startup) await boundOpenCodeRead(Promise.resolve(sequence.startup).catch(() => undefined),
      Math.min(openCodeV2ExecutionCloseStartupMs, remaining()))
  } catch { complete = false }
  try {
    if (sequence.finalize) await boundOpenCodeRead(sequence.finalize(), Math.min(openCodeV2ExecutionCloseFinalizeMs, remaining()))
  } catch { complete = false }
  if (!complete) return false
  try { await boundOpenCodeRead(sequence.acknowledge(), Math.min(openCodeV2ExecutionCloseAckMs, remaining())); return true } catch { return false }
}
