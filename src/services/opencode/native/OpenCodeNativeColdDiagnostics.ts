// Diagnostic-only finite telemetry. Never grants native admission or child-death authority.
export const coldFailureCodes = new Set(['TEST_cold_contract', 'TEST_cold_publication_incomplete',
        'TEST_cold_observation_timeout', 'TEST_cold_receipt_timeout', 'native_custody_unavailable',
        'native_custody_cancelled', 'native_custody_reconnect_refused', 'native_custody_response_failed',
        'native_custody_protocol', 'native_custody_timeout', 'native_custody_receipt_close_failed',
        'native_custody_helper_cleanup_unconfirmed', 'native_custody_asset_unavailable', 'native_custody_authority_unknown', 'native_custody_image_mismatch'])

// Source-owned finite errno vocabulary; an opaque uppercase string is not a diagnostic code.
export const coldErrnoCodes = new Set(['EIO', 'ENOSPC', 'ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'EBUSY', 'EPIPE',
  'EINVAL', 'EBADF', 'EDQUOT', 'ENOMEM', 'EMFILE', 'ENFILE', 'ELOOP', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EROFS',
  'EINTR', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTEMPTY',
  'EXDEV', 'EOVERFLOW', 'EINPROGRESS'])
export const coldProgressPhases = ['ready-write-start', 'ready-write-complete', 'role-run-returned', 'exit-requested', 'caught-error'] as const
export type ColdProgressPhase = typeof coldProgressPhases[number]
export type ColdProgress = { protocol: 1; role: 'A' | 'B' | 'sentinel'; phase: ColdProgressPhase; errorClass: string; code: string }
export const coldProgressPrefix = 'TEST_NATIVE_COLD_PROGRESS '
export function captureColdProgress(line: string, caseId: string, role: ColdProgress['role'], progress: ColdProgress[]): void {
      if (!line.startsWith(coldProgressPrefix) || progress.length >= 16) return
      try {
        const packet = JSON.parse(line.slice(coldProgressPrefix.length)) as Record<string, unknown>
        if (Object.keys(packet).sort().join(',') !== 'caseId,code,errorClass,phase,protocol,role' || packet.protocol !== 1 ||
          packet.caseId !== caseId || packet.role !== role || !coldProgressPhases.includes(packet.phase as ColdProgress['phase']) ||
          !['none', 'other', 'TypeError', 'SyntaxError', 'RangeError', 'Error'].includes(packet.errorClass as string) ||
          typeof packet.code !== 'string' || packet.code.length > 64 ||
          !(['none', 'other'].includes(packet.code) || coldFailureCodes.has(packet.code) || coldErrnoCodes.has(packet.code))) return
        progress.push({ protocol: 1, role, phase: packet.phase as ColdProgress['phase'], errorClass: packet.errorClass as string, code: packet.code })
      } catch { /* Unrecognized output is never recorded. */ }
}
export function drainColdOutput(stream: ReadableStream<Uint8Array>, progressLine?: (line: string) => void) {
  const reader = stream.getReader(); let bytes = 0, eofObserved = false, readFailed = false
  let cancelRequested = false, cancelCompleted = false, line = '', dropping = false
  const snapshot = () => ({ bytes: Math.min(bytes, 65537), overflow: bytes > 65536,
    eofObserved, readFailed, cancelRequested, cancelCompleted })
  const result = (async () => {
    try { while (true) {
      const part = await reader.read(); if (part.done) { eofObserved = !cancelRequested; break }
      bytes += part.value.byteLength
      if (progressLine) for (const byte of part.value) {
        if (byte === 10) { if (!dropping) progressLine(line); line = ''; dropping = false }
        else if (!dropping) { if (line.length >= 1024 || byte > 127) { dropping = true; line = '' } else line += String.fromCharCode(byte) }
      }
    } } catch (error) { readFailed = true; throw error }
    finally { line = ''; reader.releaseLock() }
    return snapshot()
  })()
  // Raw contents are discarded. Only exact allowlisted ASCII progress packets
  // may leave this drain; no provider/module output or partial line is persisted.
  return { result, snapshot, cancel: async () => {
    cancelRequested = true
    try { await reader.cancel(); cancelCompleted = true } catch { /* Captured reader may have settled. */ }
  } }
}
