import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'

import {
  openCodeProviderManagementAdapter,
  type LoadProviderDirectoryInput,
  type LoadProviderModelsInput,
  type ProviderDirectoryView,
  type ProviderManagementResult,
  type ProviderManagementView,
  type RuntimeProviderModelsView,
} from '../../features/runtimeProviderManagement/index.js'
import {
  runtimeProvidersConnect,
  runtimeProvidersConnectApiKey,
  runtimeProvidersConfigureModelLimits,
  runtimeProvidersDirectory,
  runtimeProvidersModels,
  runtimeProvidersView,
} from './runtime.js'

async function expectRuntimeCommandExit(
  run: () => Promise<void>,
  expectedCode: number,
): Promise<void> {
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

function minimalProviderDirectory(): ProviderDirectoryView {
  return {
    runtimeId: 'opencode',
    totalCount: 0,
    returnedCount: 0,
    query: null,
    filter: 'all',
    limit: 100,
    cursor: null,
    nextCursor: null,
    entries: [],
    diagnostics: [],
    fetchedAt: '2026-07-13T00:00:00.000Z',
  }
}

function minimalProviderModels(): RuntimeProviderModelsView {
  return {
    runtimeId: 'opencode',
    providerId: 'openrouter',
    totalCount: 4,
    returnedCount: 2,
    limit: 2,
    cursor: '1',
    nextCursor: '3',
    models: [],
    defaultModelId: null,
    diagnostics: [],
    catalogState: 'fresh',
  }
}

describe('runtime provider stdout contract', () => {
  test('passes model pagination cursor and returns page metadata', async () => {
    const originalLoadModels = openCodeProviderManagementAdapter.loadModels
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const originalExit = process.exit
    const originalExitCode = process.exitCode
    const stdout: string[] = []
    let receivedInput: LoadProviderModelsInput | null = null

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
      process.stderr.write = (() => true) as typeof process.stderr.write
      process.exit = (() => undefined as never) as typeof process.exit
      openCodeProviderManagementAdapter.loadModels = async input => {
        receivedInput = input
        return { ok: true, value: minimalProviderModels() }
      }

      await runtimeProvidersModels({
        runtime: 'opencode',
        provider: 'openrouter',
        projectPath: '/tmp/provider-model-page-test',
        query: 'alpha',
        limit: 2,
        cursor: '1',
        json: true,
      })

      expect(receivedInput).toMatchObject({
        runtimeId: 'opencode',
        providerId: 'openrouter',
        projectPath: '/tmp/provider-model-page-test',
        query: 'alpha',
        limit: 2,
        cursor: '1',
      })
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        runtimeId: 'opencode',
        models: {
          totalCount: 4,
          returnedCount: 2,
          limit: 2,
          cursor: '1',
          nextCursor: '3',
        },
      })
    } finally {
      openCodeProviderManagementAdapter.loadModels = originalLoadModels
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.exit = originalExit
      process.exitCode = originalExitCode
    }
  })

  test('passes summary directory mode to provider management', async () => {
    const originalLoadDirectory = openCodeProviderManagementAdapter.loadDirectory
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const originalExit = process.exit
    const originalExitCode = process.exitCode
    const stdout: string[] = []
    let receivedInput: LoadProviderDirectoryInput | null = null

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
      process.stderr.write = (() => true) as typeof process.stderr.write
      process.exit = (() => undefined as never) as typeof process.exit
      openCodeProviderManagementAdapter.loadDirectory = async input => {
        receivedInput = input
        return { ok: true, value: minimalProviderDirectory() }
      }

      await runtimeProvidersDirectory({
        runtime: 'opencode',
        projectPath: '/tmp/provider-summary-test',
        limit: 100,
        summary: true,
        json: true,
      })

      expect(receivedInput).toMatchObject({
        runtimeId: 'opencode',
        projectPath: '/tmp/provider-summary-test',
        limit: 100,
        summary: true,
      })
      expect(stdout).toHaveLength(1)
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        runtimeId: 'opencode',
        directory: { runtimeId: 'opencode' },
      })
    } finally {
      openCodeProviderManagementAdapter.loadDirectory = originalLoadDirectory
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.exit = originalExit
      process.exitCode = originalExitCode
    }
  })

  test('streams generic OAuth authorization and accepts a matching code over stdin JSON lines', async () => {
    const originalConnectProvider = openCodeProviderManagementAdapter.connectProvider
    const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const originalExit = process.exit
    const originalExitCode = process.exitCode
    const stdout: string[] = []
    const stderr: string[] = []

    try {
      process.exitCode = undefined
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        value: Readable.from([
          `${JSON.stringify({
            method: 'oauth',
            authMethodIndex: 0,
            authOptionId: 'oauth:0',
            oauthOperationId: 'oauth-code-operation-123',
            metadata: {},
          })}\n`,
          `${JSON.stringify({
            type: 'oauth-code',
            operationId: 'oauth-code-operation-123',
            code: 'provider-returned-code',
          })}\n`,
        ]),
      })
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
        writeCallback?.()
        return true
      }) as typeof process.stdout.write
      process.stderr.write = ((
        chunk: unknown,
        encodingOrCallback?: unknown,
        callback?: unknown,
      ) => {
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
      process.exit = (() => undefined as never) as typeof process.exit
      openCodeProviderManagementAdapter.connectProvider = async (_input, observer) => {
        const response = await observer?.authorizationReady({
          operationId: 'oauth-code-operation-123',
          providerId: 'future-oauth-provider',
          displayName: 'Future OAuth Provider',
          authOptionId: 'oauth:0',
          methodIndex: 0,
          authorizationUrl: 'https://login.example.test/authorize?state=opaque',
          instructions: 'Paste the returned code.',
          completionMethod: 'code',
        })
        expect(response).toEqual({ code: 'provider-returned-code' })
        return {
          ok: true,
          value: {
            providerId: 'future-oauth-provider',
            displayName: 'Future OAuth Provider',
            state: 'connected',
            ownership: ['managed'],
            recommended: false,
            modelCount: 1,
            defaultModelId: null,
            authMethods: ['oauth'],
            actions: [],
            detail: null,
          },
        }
      }

      await runtimeProvidersConnect({
        runtime: 'opencode',
        provider: 'future-oauth-provider',
        stdinJsonLines: true,
        json: true,
      })

      expect(stdout[0]).toStartWith('@@agent-teams-runtime-provider-oauth@@')
      expect(stdout.join('')).toContain('"completionMethod":"code"')
      expect(stdout.join('')).toContain('"providerId": "future-oauth-provider"')
      expect(stdout.join('')).not.toContain('provider-returned-code')
      expect(stderr).toEqual([])
    } finally {
      openCodeProviderManagementAdapter.connectProvider = originalConnectProvider
      if (originalStdinDescriptor) {
        Object.defineProperty(process, 'stdin', originalStdinDescriptor)
      }
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.exit = originalExit
      process.exitCode = originalExitCode
    }
  })

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
        writeCallback?.()
        return true
      }) as typeof process.stdout.write
      process.stderr.write = ((
        chunk: unknown,
        encodingOrCallback?: unknown,
        callback?: unknown,
      ) => {
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
        const result = new Proxy(
          {
            ok: true,
            value: minimalProviderView(),
          },
          {
            has(target, property) {
              if (property === 'error') {
                process.stdout.write('noisy stdout while response is being selected\n')
              }
              return property in target
            },
          },
        ) as ProviderManagementResult<ProviderManagementView>
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
      expect(stderr.join('')).toContain('noisy stdout during exit')
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
        writeCallback?.()
        return true
      }) as typeof process.stdout.write
      process.stderr.write = ((
        chunk: unknown,
        encodingOrCallback?: unknown,
        callback?: unknown,
      ) => {
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
      expect(stderr.join('')).toContain('noisy stdout during exit')
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
      run: () =>
        runtimeProvidersConnect({
          runtime: 'opencode',
          provider: 'openrouter',
          json: true,
        }),
      message: 'Provider setup payload must be supplied through --stdin-json',
    },
    {
      name: 'connect api key without stdin key',
      run: () =>
        runtimeProvidersConnectApiKey({
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
          writeCallback?.()
          return true
        }) as typeof process.stdout.write
        process.stderr.write = ((
          chunk: unknown,
          encodingOrCallback?: unknown,
          callback?: unknown,
        ) => {
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

        expect(stdout).toHaveLength(1)
        const payload = JSON.parse(stdout.join('')) as {
          error?: { code?: string; message?: string; recoverable?: boolean }
        }
        expect(payload.error?.code).toBe('auth-required')
        expect(payload.error?.recoverable).toBe(true)
        expect(payload.error?.message).toBe(scenario.message)
        expect(stdout.join('')).not.toContain('noisy stdout')
        expect(stderr.join('')).toContain('noisy stdout during validation exit:1')
      } finally {
        process.stdout.write = originalStdoutWrite
        process.stderr.write = originalStderrWrite
        process.exit = originalExit
        process.exitCode = originalExitCode
      }
    })
  }

  test('returns structured JSON and exit 1 when model-limit verification fails', async () => {
    const originalConfigureModelLimits = openCodeProviderManagementAdapter.configureModelLimits
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    const originalExit = process.exit
    const originalExitCode = process.exitCode
    const stdout: string[] = []

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
      process.stderr.write = (() => true) as typeof process.stderr.write
      process.exit = ((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code ?? 0}`)
      }) as typeof process.exit
      openCodeProviderManagementAdapter.configureModelLimits = async () => ({
        ok: false,
        error: {
          code: 'model-test-failed',
          message: 'Model probe failed, so no limits were saved: endpoint unavailable',
          recoverable: true,
        },
      })

      await expectRuntimeCommandExit(
        () =>
          runtimeProvidersConfigureModelLimits({
            runtime: 'opencode',
            provider: 'local',
            model: 'local/qwen',
            contextTokens: 32_000,
            outputTokens: 4_000,
            json: true,
          }),
        1,
      )

      expect(stdout).toHaveLength(1)
      const payload = JSON.parse(stdout.join('')) as {
        runtimeId?: string
        result?: unknown
        error?: { code?: string; message?: string; recoverable?: boolean }
      }
      expect(payload.runtimeId).toBe('opencode')
      expect(payload.result).toBeUndefined()
      expect(payload.error).toEqual({
        code: 'model-test-failed',
        message: 'Model probe failed, so no limits were saved: endpoint unavailable',
        recoverable: true,
      })
    } finally {
      openCodeProviderManagementAdapter.configureModelLimits = originalConfigureModelLimits
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
      process.exit = originalExit
      process.exitCode = originalExitCode
    }
  })
})
