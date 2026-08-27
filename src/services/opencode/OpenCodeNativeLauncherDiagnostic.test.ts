import { describe, expect, test } from 'bun:test'
import { drainOpenCodeNativeLauncherStderr, openCodeNativeAuthorityExitError,
  OPEN_CODE_NATIVE_LAUNCHER_STDERR_MAX_BYTES } from './OpenCodeNativeLauncherDiagnostic.js'

describe('OpenCode native launcher diagnostics', () => {
  test('accepts only stable stage and bounded numeric evidence', () => {
    expect(openCodeNativeAuthorityExitError(
      'OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=create_process win32=87\n', 126,
    ).message).toBe('OpenCode Windows publication authority is unavailable [redacted] '
      + '(native_stage=create_process win32=87 exit=126)')
    const hostile = 'OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=C:\\secret\\worker.exe win32=87\n'
      + 'TOKEN=credential OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=create_process win32=4294967296\n'
    const error = openCodeNativeAuthorityExitError(hostile, 126)
    expect(error.message).toBe('OpenCode Windows publication authority is unavailable [redacted] '
      + '(native_stage=process_exit exit=126)')
    expect(error.message).not.toContain('secret')
    expect(error.message).not.toContain('credential')
  })

  test('continuously drains stderr but retains only the fixed prefix', async () => {
    const chunk = new Uint8Array(700).fill(65); let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ < 4) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const retained = await drainOpenCodeNativeLauncherStderr(stream)
    expect(pulls).toBe(5)
    expect(new TextEncoder().encode(retained).byteLength).toBe(OPEN_CODE_NATIVE_LAUNCHER_STDERR_MAX_BYTES)
  })
})
