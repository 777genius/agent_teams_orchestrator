import { expect, test } from 'bun:test'

import { openCodeProvisioningProbe } from '../../services/opencode/OpenCodeProvisioningProbe.js'
import { runtimeVerify } from './runtime.js'

test('flushes verification JSON larger than the stdout pipe buffer before exiting', async () => {
  const originalProbe = openCodeProvisioningProbe.probe
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalExitCode = process.exitCode
  const stdout: string[] = []

  try {
    process.exitCode = undefined
    process.stdout.write = ((
      chunk: unknown,
      encodingOrCallback?: unknown,
      callback?: unknown,
    ) => {
      stdout.push(String(chunk))
      const writeCallback =
        typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : typeof callback === 'function'
            ? callback
            : null
      setTimeout(() => writeCallback?.(), 5)
      return false
    }) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    process.exit = ((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code ?? 0}`)
    }) as typeof process.exit
    openCodeProvisioningProbe.probe = (async () => ({
      detected: true,
      hostHealthy: true,
      projectPath: '/tmp/runtime-verify-large-json',
      models: Array.from({ length: 4_000 }, (_, index) => `provider/model-${index}`),
      diagnostics: [],
    })) as typeof openCodeProvisioningProbe.probe

    await expect(runtimeVerify({ json: true, provider: 'opencode' })).rejects.toThrow(
      'process.exit:0',
    )

    const payload = stdout.join('')
    expect(Buffer.byteLength(payload)).toBeGreaterThan(64 * 1024)
    expect(JSON.parse(payload)).toMatchObject({
      schemaVersion: 1,
      providerId: 'opencode',
      snapshot: {
        detected: true,
        hostHealthy: true,
      },
    })
  } finally {
    openCodeProvisioningProbe.probe = originalProbe
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
    process.exitCode = originalExitCode
  }
})
