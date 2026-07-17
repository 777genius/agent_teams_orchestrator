import { describe, expect, test } from 'bun:test'

import { getProviderModels, modelList } from './model.js'

describe('model list handler', () => {
  test('uses the shared Codex runtime model catalog', async () => {
    const details = await getProviderModels('codex', {
      getCodexModelCatalog: async () => ({
        schemaVersion: 1,
        providerId: 'codex',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-04-28T00:00:00.000Z',
        staleAt: '2026-04-28T00:10:00.000Z',
        defaultModelId: 'gpt-5.4',
        defaultLaunchModel: 'gpt-5.4',
        models: [
          {
            id: 'gpt-5.4',
            launchModel: 'gpt-5.4',
            displayName: 'GPT-5.4',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            supportsFastMode: true,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
          },
          {
            id: 'gpt-5.5',
            launchModel: 'gpt-5.5',
            displayName: 'GPT-5.5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            supportsFastMode: false,
            isDefault: false,
            upgrade: false,
            source: 'app-server',
          },
        ],
        diagnostics: {
          configReadState: 'skipped',
          appServerState: 'healthy',
          message: null,
          code: null,
        },
      }),
    })

    expect(details.defaultModel).toBe('gpt-5.4')
    expect(details.models.map(model => model.id)).toEqual(['gpt-5.4', 'gpt-5.5'])
  })

  test('excludes non-agent OpenCode models from the CLI catalog', async () => {
    const details = await getProviderModels('opencode', {
      getOpenCodeInventorySnapshot: async () => ({
        detected: true,
        binaryPath: '/tmp/opencode',
        version: '1.17.18',
        projectPath: '/tmp/project',
        profile: null,
        connectedProviders: [],
        availableProviders: ['xai'],
        models: ['xai/grok-code-fast-1', 'xai/grok-imagine-image-quality'],
        modelMetadata: [
          {
            id: 'xai/grok-imagine-image-quality',
            cost: null,
            context: null,
            limits: null,
            free: false,
            raw: {
              capabilities: {
                output: { text: false, image: true },
                toolcall: false,
              },
            },
          },
        ],
        agents: [],
        authStorePath: null,
        probeError: null,
        diagnostics: [],
      }),
    })

    expect(details.defaultModel).toBe('xai/grok-code-fast-1')
    expect(details.models.map(model => model.id)).toEqual(['xai/grok-code-fast-1'])
  })

  test('waits for JSON stdout to flush before exiting', async () => {
    const originalWrite = process.stdout.write
    const originalExit = process.exit
    const events: string[] = []
    try {
      process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        events.push(typeof chunk === 'string' && chunk.includes('"gemini"') ? 'write-json' : 'write')
        const writeCallback =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : typeof callback === 'function'
              ? callback
              : null
        events.push('write-callback')
        writeCallback?.()
        return true
      }) as typeof process.stdout.write
      process.exit = ((code?: string | number | null | undefined) => {
        events.push(`exit:${code ?? 0}`)
        throw new Error('process.exit')
      }) as typeof process.exit

      await expect(modelList({ json: true, provider: 'gemini' })).rejects.toThrow('process.exit')

      expect(events).toEqual(['write-json', 'write-callback', 'exit:0'])
    } finally {
      process.stdout.write = originalWrite
      process.exit = originalExit
    }
  })

  test('waits for text stdout to flush before exiting', async () => {
    const originalWrite = process.stdout.write
    const originalExit = process.exit
    const events: string[] = []
    try {
      process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        events.push(typeof chunk === 'string' && chunk.includes('Gemini:') ? 'write-text' : 'write')
        const writeCallback =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : typeof callback === 'function'
              ? callback
              : null
        setTimeout(() => {
          events.push('write-callback')
          writeCallback?.()
        }, 5)
        return false
      }) as typeof process.stdout.write
      process.exit = ((code?: string | number | null | undefined) => {
        events.push(`exit:${code ?? 0}`)
        throw new Error('process.exit')
      }) as typeof process.exit

      await expect(modelList({ text: true, provider: 'gemini' })).rejects.toThrow('process.exit')

      expect(events).toEqual(['write-text', 'write-callback', 'exit:0'])
    } finally {
      process.stdout.write = originalWrite
      process.exit = originalExit
    }
  })
})
