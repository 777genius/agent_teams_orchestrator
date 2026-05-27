import { describe, expect, test } from 'bun:test'

import {
  openCodeProviderManagementAdapter,
  type ProviderManagementResult,
  type ProviderManagementView,
} from '../../features/runtimeProviderManagement/index.js'
import {
  runtimeProvidersConnect,
  runtimeProvidersConnectApiKey,
  runtimeProvidersView,
} from './runtime.js'

async function expectRuntimeCommandExit(
  run: () => Promise<void>,
  expectedCode: number,
): Promise<void> {
  if (process.platform === 'win32') {
    await run()
    expect(process.exitCode).toBe(expectedCode)
    return
  }

  await expect(run()).rejects.toThrow(`process.exit:${expectedCode}`)
}

function minimalProviderView(): ProviderManagementView {
  return {
    runtimeId: 'opencode',
    title: 'OpenCode',
    runtime: {
      state: 'ready',
      cliPath: '/usr/local/bin/opencode',
      version: '1.0.0',
      managedProfile: 'active',
      localAuth: 'synced',
    },
    providers: [],
    configuredModels: [],
    defaultModel: null,
    fallbackModel: null,
    diagnostics: [],
  }
}

describe('runtime provider stdout contract', () => {
  test('keeps provider JSON stdout clean when runtime code writes noisy stdout', async () => {
    const originalLoadView = openCodeProviderManagementAdapter.loadView
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const originalExit = process.exit
    const originalExitCode = process.exitCode
    const stdout: string[] = []
    const stderr: string[] = []

    try {
      process.exitCode = undefined
      process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        stdout.push(String(chunk))
        const writeCallback =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : typeof callback === 'function'
              ? callback
              : null
        writeCallback?.()
        return true
      }) as typeof process.stdout.write
      process.stderr.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        stderr.push(String(chunk))
        const writeCallback =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : typeof callback === 'function'
              ? callback
              : null
        writeCallback?.()
        return true
      }) as typeof process.stderr.write
      process.exit = ((code?: string | number | null | undefined) => {
        process.stdout.write('noisy stdout during exit\n')
        throw new Error(`process.exit:${code ?? 0}`)
      }) as typeof process.exit

      openCodeProviderManagementAdapter.loadView = async () => {
        process.stdout.write('noisy stdout before result\n')
        const result = new Proxy({
          ok: true,
          value: minimalProviderView(),
        }, {
          has(target, property) {
            if (property === 'error') {
              process.stdout.write('noisy stdout while response is being selected\n')
            }
            return property in target
          },
        }) as ProviderManagementResult<ProviderManagementView>
        return result
      }

      await expectRuntimeCommandExit(
        () => runtimeProvidersView({ runtime: 'opencode', json: true }),
        0,
      )

      expect(stdout).toHaveLength(1)
      const payload = JSON.parse(stdout.join('')) as {
        runtimeId?: string
        view?: { runtimeId?: string }
      }
      expect(payload.runtimeId).toBe('opencode')
      expect(payload.view?.runtimeId).toBe('opencode')
      expect(stdout.join('')).not.toContain('noisy stdout')
      expect(stderr.join('')).toContain('noisy stdout before result')
      expect(stderr.join('')).toContain('noisy stdout while response is being selected')
      if (process.platform !== 'win32') {
        expect(stderr.join('')).toContain('noisy stdout during exit')
      }
    } finally {
      openCodeProviderManagementAdapter.loadView = originalLoadView
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.exit = originalExit
      process.exitCode = originalExitCode
    }
  })

  test('returns JSON when provider management throws before producing a result', async () => {
    const originalLoadView = openCodeProviderManagementAdapter.loadView
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const originalExit = process.exit
    const originalExitCode = process.exitCode
    const stdout: string[] = []
    const stderr: string[] = []

    try {
      process.exitCode = undefined
      process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        stdout.push(String(chunk))
        const writeCallback =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : typeof callback === 'function'
              ? callback
              : null
        writeCallback?.()
        return true
      }) as typeof process.stdout.write
      process.stderr.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        stderr.push(String(chunk))
        const writeCallback =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : typeof callback === 'function'
              ? callback
              : null
        writeCallback?.()
        return true
      }) as typeof process.stderr.write
      process.exit = ((code?: string | number | null | undefined) => {
        process.stdout.write('noisy stdout during exit\n')
        throw new Error(`process.exit:${code ?? 0}`)
      }) as typeof process.exit

      openCodeProviderManagementAdapter.loadView = async () => {
        process.stdout.write('noisy stdout before throw\n')
        throw new Error(
          'inventory probe exploded api_key: sk-secret-value-123456 Authorization: Bearer live-token-123456789',
        )
      }

      await expectRuntimeCommandExit(
        () => runtimeProvidersView({ runtime: 'opencode', json: true }),
        1,
      )

      expect(stdout).toHaveLength(1)
      const payload = JSON.parse(stdout.join('')) as {
        error?: { code?: string; message?: string; recoverable?: boolean }
      }
      expect(payload.error?.code).toBe('runtime-unhealthy')
      expect(payload.error?.recoverable).toBe(true)
      expect(payload.error?.message).toContain('inventory probe exploded')
      expect(payload.error?.message).toContain('api_key: ...redacted')
      expect(payload.error?.message).toContain('Authorization: Bearer ...redacted')
      expect(payload.error?.message).not.toContain('sk-secret-value-123456')
      expect(payload.error?.message).not.toContain('live-token-123456789')
      expect(stdout.join('')).not.toContain('noisy stdout')
      expect(stderr.join('')).toContain('noisy stdout before throw')
      if (process.platform !== 'win32') {
        expect(stderr.join('')).toContain('noisy stdout during exit')
      }
    } finally {
      openCodeProviderManagementAdapter.loadView = originalLoadView
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.exit = originalExit
      process.exitCode = originalExitCode
    }
  })

  for (const scenario of [
    {
      name: 'connect without stdin json',
      run: () => runtimeProvidersConnect({
        runtime: 'opencode',
        provider: 'openrouter',
        json: true,
      }),
      message: 'Provider setup payload must be supplied through --stdin-json',
    },
    {
      name: 'connect api key without stdin key',
      run: () => runtimeProvidersConnectApiKey({
        runtime: 'opencode',
        provider: 'openrouter',
        json: true,
      }),
      message: 'API key must be supplied through --stdin-key',
    },
  ]) {
    test(`keeps validation JSON stdout clean for ${scenario.name}`, async () => {
      const originalStdoutWrite = process.stdout.write
      const originalStderrWrite = process.stderr.write
      const originalExit = process.exit
      const originalExitCode = process.exitCode
      const stdout: string[] = []
      const stderr: string[] = []

      try {
        process.exitCode = undefined
        process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
          stdout.push(String(chunk))
          const writeCallback =
            typeof encodingOrCallback === 'function'
              ? encodingOrCallback
              : typeof callback === 'function'
                ? callback
                : null
          writeCallback?.()
          return true
        }) as typeof process.stdout.write
        process.stderr.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
          stderr.push(String(chunk))
          const writeCallback =
            typeof encodingOrCallback === 'function'
              ? encodingOrCallback
              : typeof callback === 'function'
                ? callback
                : null
          writeCallback?.()
          return true
        }) as typeof process.stderr.write
        process.exit = ((code?: string | number | null | undefined) => {
          process.stdout.write(`noisy stdout during validation exit:${code ?? 0}\n`)
          return undefined as never
        }) as typeof process.exit

        await scenario.run()
        if (process.platform === 'win32') {
          expect(process.exitCode).toBe(1)
        }

        expect(stdout).toHaveLength(1)
        const payload = JSON.parse(stdout.join('')) as {
          error?: { code?: string; message?: string; recoverable?: boolean }
        }
        expect(payload.error?.code).toBe('auth-required')
        expect(payload.error?.recoverable).toBe(true)
        expect(payload.error?.message).toBe(scenario.message)
        expect(stdout.join('')).not.toContain('noisy stdout')
        if (process.platform !== 'win32') {
          expect(stderr.join('')).toContain('noisy stdout during validation exit:1')
        }
      } finally {
        process.stdout.write = originalStdoutWrite
        process.stderr.write = originalStderrWrite
        process.exit = originalExit
        process.exitCode = originalExitCode
      }
    })
  }
})
