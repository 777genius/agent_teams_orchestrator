import { beforeDeadlineV2, nonblockV2, readAvailableV2, type OwnedDescriptorV2 } from './HostedControlBootstrapV2Descriptors.js'
import { requireV2 } from './HostedControlBootstrapV2Wire.js'
import { decodeSelectedLaunchPhase, SELECTED_LAUNCH_MAGIC, SELECTED_LAUNCH_MAXIMUM } from './HostedControlSelectedLaunchPhase.js'

/** Consume exactly one phase on FD5 without closing or handing it to a stream
 * reader. The same owned socket subsequently enters the activation transport.
 * FD4/7 and FD11 must already be detached before calling this reader. */
export async function readSelectedLaunchPhase(owner: OwnedDescriptorV2, deadline: number) {
  nonblockV2(owner.fd)
  const header = Buffer.alloc(8)
  let frame: Buffer | undefined
  const readExactly = async (bytes: Buffer) => {
    let offset = 0
    while (offset < bytes.length) {
      beforeDeadlineV2(deadline)
      const count = readAvailableV2(owner.fd, bytes.subarray(offset))
      requireV2(count !== 0, 'selection_phase_eof')
      if (count > 0) offset += count
      else await new Promise<void>(resolve => setTimeout(resolve, Math.min(2, Math.max(1, deadline - performance.now()))))
    }
  }
  try {
    await readExactly(header)
    const length = header.readUInt32BE(4)
    requireV2(header.readUInt32BE(0) === SELECTED_LAUNCH_MAGIC && length > 0 &&
      length <= SELECTED_LAUNCH_MAXIMUM, 'selection_phase_header')
    frame = Buffer.alloc(length + 8); header.copy(frame)
    await readExactly(frame.subarray(8))
    // Activation has no authority to start before authenticated lifecycle
    // readiness. Any already queued byte belongs to an invalid phase sequence.
    const extra = Buffer.alloc(1)
    try { requireV2(readAvailableV2(owner.fd, extra) < 0, 'selection_phase_trailing') }
    finally { extra.fill(0) }
    beforeDeadlineV2(deadline)
    const phase = decodeSelectedLaunchPhase(frame, deadline)
    beforeDeadlineV2(deadline)
    return phase
  } finally { header.fill(0); frame?.fill(0) }
}
