import { afterEach, describe, expect, test } from 'bun:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import { PassThrough } from 'node:stream'

import { DEFAULT_CODEX_MODEL } from '../../utils/model/codex.js'
import {
  clearCodexRuntimeModelCatalogCacheForTesting,
  getCodexRuntimeModelCatalog,
} from './codexModelCatalog.js'

type FakeSpawnCall = {
  binaryPath: string
  args: string[]
  options: SpawnOptions
}

type FakeModelPage = {
  data?: Array<Record<string, unknown>>
  nextCursor?: string | null
}

function createFakeCodexAppServerSpawn(options: {
  pages?: FakeModelPage[]
  modelListError?: { code: number; message: string }
} = {}): {
  calls: FakeSpawnCall[]
  spawnCli: (binaryPath: string, args: string[], spawnOptions: SpawnOptions) => ChildProcess
} {
  const calls: FakeSpawnCall[] = []
  const pages = options.pages ?? [
    {
      data: [
        {
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
          additionalSpeedTiers: ['fast'],
          inputModalities: ['text', 'image'],
          isDefault: true,
        },
      ],
      nextCursor: 'page-2',
    },
    {
      data: [
        {
          id: 'gpt-5.5',
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
          inputModalities: ['text', 'image'],
        },
      ],
      nextCursor: null,
    },
  ]

  const spawnCli = (
    binaryPath: string,
    args: string[],
    spawnOptions: SpawnOptions,
  ): ChildProcess => {
    calls.push({ binaryPath, args, options: spawnOptions })
    const child = new EventEmitter() as ChildProcess
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: () => {
        ;(child as { exitCode: number | null }).exitCode = 0
        child.emit('exit', 0, null)
        return true
      },
    })

    let pageIndex = 0
    const input = readline.createInterface({ input: stdin })
    input.on('line', line => {
      const message = JSON.parse(line) as {
        id?: number
        method?: string
      }
      if (typeof message.id !== 'number') {
        return
      }
      if (message.method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
        return
      }
      if (message.method === 'model/list') {
        if (options.modelListError) {
          stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: options.modelListError,
            })}\n`,
          )
          return
        }
        const page = pages[pageIndex] ?? { data: [], nextCursor: null }
        pageIndex += 1
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: page })}\n`)
      }
    })

    return child
  }

  return { calls, spawnCli }
}

afterEach(() => {
  clearCodexRuntimeModelCatalogCacheForTesting()
})

describe('Codex app-server model catalog loader', () => {
  test('reads paginated model/list results from the configured Codex binary', async () => {
    const fake = createFakeCodexAppServerSpawn()
    const catalog = await getCodexRuntimeModelCatalog({
      env: {
        CODEX_CLI_PATH: '/opt/codex/bin/codex.cmd',
        CODEX_HOME: '/tmp/codex home',
      } as NodeJS.ProcessEnv,
      which: command => (command === 'codex' ? '/usr/local/bin/codex' : null),
      spawnCli: fake.spawnCli,
      now: () => new Date('2026-04-28T00:00:00.000Z'),
    })

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].binaryPath).toBe('/opt/codex/bin/codex.cmd')
    expect(fake.calls[0].args).toEqual(['app-server'])
    expect(catalog.source).toBe('app-server')
    expect(catalog.status).toBe('ready')
    expect(catalog.models.map(model => model.launchModel)).toEqual(['gpt-5.4', 'gpt-5.5'])
    expect(catalog.defaultLaunchModel).toBe('gpt-5.4')
    expect(catalog.models.find(model => model.id === 'gpt-5.5')?.displayName).toBe('GPT-5.5')
  })

  test('falls back to the static catalog when the binary is missing', async () => {
    const catalog = await getCodexRuntimeModelCatalog({
      env: {} as NodeJS.ProcessEnv,
      which: () => null,
      now: () => new Date('2026-04-28T00:00:00.000Z'),
    })

    expect(catalog.source).toBe('static-fallback')
    expect(catalog.status).toBe('unavailable')
    expect(catalog.diagnostics.appServerState).toBe('runtime-missing')
    expect(catalog.models.map(model => model.id)).toContain('gpt-5.5')
    expect(catalog.defaultLaunchModel).toBe(DEFAULT_CODEX_MODEL)
  })

  test('falls back when model/list is not supported by the installed app-server', async () => {
    const fake = createFakeCodexAppServerSpawn({
      modelListError: {
        code: -32601,
        message: 'Method not found',
      },
    })
    const catalog = await getCodexRuntimeModelCatalog({
      env: {} as NodeJS.ProcessEnv,
      which: command => (command === 'codex' ? '/usr/local/bin/codex' : null),
      spawnCli: fake.spawnCli,
      now: () => new Date('2026-04-28T00:00:00.000Z'),
    })

    expect(catalog.source).toBe('static-fallback')
    expect(catalog.diagnostics.appServerState).toBe('incompatible')
    expect(catalog.diagnostics.code).toBe('-32601')
    expect(catalog.models.map(model => model.id)).toContain('gpt-5.5')
  })
})
