import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs'
import type { HostedControlBootstrapAdmissionV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { beforeDeadlineV2, OwnedDescriptorV2, sameDescriptorV2, snapshotV2,
  type DescriptorSnapshotV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Descriptors.js'
import { hashV2, requireV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'

import { inspectNativeRawPrefix } from './native-raw-envelope.js'

const MAX_CAPTURE = 64 * 1024 * 1024

/** Storage custody for the inherited FD8, separate from the P1 record codec.
 * No configurable descriptor, pathname writer, authority callback or fake
 * prefix. The codec must validate the retained prefix's records/sequence before
 * using this writer; its binding alone is not that semantic validation. */
export function retainNativeRawDescriptorV2(
  admitted: HostedControlBootstrapAdmissionV2['rawRetention'], deadline: number,
  controllerNonce?: string,
) {
  requireV2(admitted.fd === 8 && admitted.resource.fd === 8, 'raw_descriptor')
  const binding = Object.freeze({ ...admitted.binding })
  let snapshot = snapshotV2('raw-opencode-retention')
  requireV2(sameDescriptorV2(admitted.descriptor, snapshot) &&
    snapshot.kind === 'regular-file' && snapshot.accessMode === 'write-only' && snapshot.append &&
    snapshot.mode === 0o600 && snapshot.nlink === '1' &&
    snapshot.size === String(binding.initialByteLength) &&
    binding.initialByteLength >= 0 && binding.initialByteLength <= MAX_CAPTURE, 'raw_prefix_descriptor')
  // FD8 is write-only. Reopen only its live proc descriptor for a temporary
  // read view, compare the kernel inode, then close that reader before transfer.
  const reader = openSync('/proc/self/fd/8', constants.O_RDONLY | 0o2000000)
  const prefix = Buffer.alloc(binding.initialByteLength)
  try {
    const stat = fstatSync(reader, { bigint: true })
    requireV2(stat.dev.toString() === snapshot.device && stat.ino.toString() === snapshot.inode &&
      stat.size.toString() === snapshot.size, 'raw_prefix_reader')
    let offset = 0
    while (offset < prefix.length) {
      beforeDeadlineV2(deadline)
      const count = readSync(reader, prefix, offset, Math.min(65536, prefix.length - offset), offset)
      requireV2(count > 0, 'raw_prefix_eof')
      offset += count
    }
    beforeDeadlineV2(deadline)
    requireV2(hashV2(prefix) === binding.initialSha256 &&
      sameDescriptorV2(snapshot, snapshotV2('raw-opencode-retention')), 'raw_prefix_changed')
  } finally { closeSync(reader) }
  // Native composition supplies the independently admitted controller binding.
  // Validate semantic HTTP framing and sequence before transferring FD8 ownership.
  if (controllerNonce !== undefined) inspectNativeRawPrefix(prefix, binding, controllerNonce)
  beforeDeadlineV2(deadline)
  requireV2(sameDescriptorV2(snapshot, snapshotV2('raw-opencode-retention')), 'raw_prefix_changed')
  const owned = new OwnedDescriptorV2(admitted.resource.take())
  let closed = false
  let failed = false
  let closing: Promise<void> | undefined
  const current = () => {
    if (closed || failed) return false
    try {
      requireV2(owned.fd === 8 && sameDescriptorV2(snapshot, snapshotV2('raw-opencode-retention')), 'raw_writer_changed')
      return true
    } catch { failed = true; return false }
  }
  const requireCurrent = () => requireV2(current(), 'raw_writer_unavailable')
  return Object.freeze({
    binding,
    initialByteLength: prefix.length,
    // Copies prevent a consumer from changing the retained prefix observation.
    readPrefix: () => Buffer.from(prefix),
    isCurrent: current,
    async write(bytes: Uint8Array, offset: number, length: number): Promise<number> {
      requireCurrent()
      try {
        requireV2(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 &&
          length > 0 && offset + length <= bytes.byteLength &&
          BigInt(snapshot.size) + BigInt(length) <= BigInt(MAX_CAPTURE), 'raw_capture_limit')
        const count = writeSync(owned.fd, bytes, offset, length)
        requireV2(count > 0 && count <= length, 'raw_write_progress')
        const after: DescriptorSnapshotV2 = snapshotV2('raw-opencode-retention')
        requireV2(sameDescriptorV2(snapshot, after, true) &&
          BigInt(after.size) === BigInt(snapshot.size) + BigInt(count), 'raw_write_changed')
        snapshot = after
        return count
      } catch (error) { failed = true; throw error }
    },
    async sync(): Promise<void> {
      requireCurrent()
      try { fsyncSync(owned.fd); requireCurrent() } catch (error) { failed = true; throw error }
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      // Even a poisoned writer releases its own descriptor, but never a reused
      // numeric slot. Bootstrap's ownership was detached on successful retain.
      const fd = owned.take()
      try {
        const actual = fstatSync(fd, { bigint: true })
        requireV2(actual.dev.toString() === snapshot.device && actual.ino.toString() === snapshot.inode, 'raw_close_changed')
        closeSync(fd)
        closing = Promise.resolve()
      } catch (error) { closing = Promise.reject(error) }
      return closing
    },
  })
}
