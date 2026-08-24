export const OPEN_CODE_NATIVE_LAUNCHER_STDERR_MAX_BYTES = 1024

const LAUNCH_STAGES = new Set([
  'worker_path', 'ancestor_open', 'ancestor_information', 'ancestor_reparse',
  'worker_open', 'worker_information', 'worker_reparse', 'volume_information',
  'volume_filesystem', 'expected_object', 'test_gate', 'job_create', 'job_configure',
  'standard_handle', 'duplicate_handle', 'attribute_storage', 'job_attribute',
  'handle_attribute', 'create_process', 'named_worker_open', 'named_worker_information',
  'named_worker_identity', 'resume_thread', 'wait_process', 'query_exit_code',
])

export class OpenCodeNativeAuthorityTransportError extends Error {}

/** Drains the complete pipe while retaining only a small prefix for safe parsing. */
export async function drainOpenCodeNativeLauncherStderr(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader(); const retained: Uint8Array[] = []; let retainedBytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (retainedBytes < OPEN_CODE_NATIVE_LAUNCHER_STDERR_MAX_BYTES) {
        const take = Math.min(next.value.byteLength,
          OPEN_CODE_NATIVE_LAUNCHER_STDERR_MAX_BYTES - retainedBytes)
        if (take > 0) retained.push(next.value.slice(0, take))
        retainedBytes += take
      }
    }
  } catch {
    // Exit evidence remains useful even if the diagnostic pipe itself failed.
  } finally {
    try { reader.releaseLock() } catch {}
  }
  const bytes = new Uint8Array(retainedBytes); let offset = 0
  for (const chunk of retained) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export function openCodeNativeAuthorityExitError(stderr: string, exitCode: number): Error {
  let stage: string | undefined; let win32: string | undefined
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=([a-z0-9_]{1,32})(?: win32=(\d{1,10}))?$/.exec(line)
    if (!match || !LAUNCH_STAGES.has(match[1]!)) continue
    const parsed = match[2] === undefined ? undefined : Number(match[2])
    if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff)) continue
    stage = match[1]; win32 = match[2]
    break
  }
  const safeExit = Number.isSafeInteger(exitCode) && exitCode >= -0x8000_0000 && exitCode <= 0xffff_ffff
    ? String(exitCode) : 'unknown'
  const evidence = stage
    ? `native_stage=${stage}${win32 === undefined ? '' : ` win32=${win32}`} exit=${safeExit}`
    : `native_stage=process_exit exit=${safeExit}`
  return new OpenCodeNativeAuthorityTransportError(
    `OpenCode Windows publication authority is unavailable [redacted] (${evidence})`,
  )
}
