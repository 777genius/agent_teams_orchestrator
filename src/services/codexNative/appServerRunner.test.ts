import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'bun:test'

import { runCodexNativeAppServer } from './appServerRunner.js'
import type { CodexNativeExecObservation } from './execRunner.js'

function createFakeCodexAppServer() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill() {
      this.killed = true
      this.exitCode = 0
      this.emit('exit', 0, null)
      return true
    },
  })
  return { child, stdin, stdout, stderr }
}

function writeJson(stream: PassThrough, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`)
}

async function collect(
  iterator: AsyncGenerator<CodexNativeExecObservation, unknown, unknown>,
): Promise<{ observations: CodexNativeExecObservation[]; summary: unknown }> {
  const observations: CodexNativeExecObservation[] = []
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return { observations, summary: next.value }
    }
    observations.push(next.value)
  }
}

describe('runCodexNativeAppServer', () => {
  test('runs app-server with a Codex home overlay that omits user config.toml', async () => {
    const fake = createFakeCodexAppServer()
    const sourceHome = await mkdtemp(path.join(tmpdir(), 'codex-home-source-'))
    const previousCodexHome = process.env.CODEX_HOME
    let spawnedCodexHome: string | undefined

    await writeFile(path.join(sourceHome, 'config.toml'), 'service_tier = "priority"\n')
    await writeFile(path.join(sourceHome, 'auth.json'), '{"tokens":true}\n')

    fake.stdin.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as {
          id?: number | string
          method?: string
        }

        if (message.method === 'initialize') {
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            id: message.id,
            result: {},
          })
          continue
        }

        if (message.method === 'thread/start') {
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            id: message.id,
            result: { thread: { id: 'thread-1' } },
          })
          continue
        }

        if (message.method === 'turn/start') {
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            id: message.id,
            result: { turn: { id: 'turn-1', status: 'inProgress' } },
          })
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed' },
            },
          })
        }
      }
    })

    try {
      process.env.CODEX_HOME = sourceHome
      await collect(
        runCodexNativeAppServer(
          {
            prompt: 'Reply PONG',
            cwd: '/tmp/demo',
            model: 'gpt-5.4',
            requestApproval: async () => ({ allow: true }),
          },
          {
            which: () => '/usr/local/bin/codex',
            resolveVersion: () => 'codex-cli 0.125.0',
            spawnProcess: (_executablePath, _args, options) => {
              spawnedCodexHome = options.env.CODEX_HOME
              expect(spawnedCodexHome).toBeTruthy()
              expect(spawnedCodexHome).not.toBe(sourceHome)
              expect(existsSync(path.join(spawnedCodexHome!, 'config.toml'))).toBe(false)
              expect(existsSync(path.join(spawnedCodexHome!, 'auth.json'))).toBe(true)
              return fake.child as never
            },
          },
        ),
      )

      expect(spawnedCodexHome).toBeTruthy()
      expect(existsSync(spawnedCodexHome!)).toBe(false)
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      await rm(sourceHome, { recursive: true, force: true })
    }
  })

  test('round-trips a real app-server approval request into the injected approval handler', async () => {
    const fake = createFakeCodexAppServer()
    const approvalResponses: Array<Record<string, unknown>> = []
    const approvalRequests: string[] = []

    fake.stdin.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as {
          id?: number | string
          method?: string
          result?: Record<string, unknown>
        }

        if (message.result?.decision) {
          approvalResponses.push(message.result)
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'msg-1',
              delta: 'OK',
            },
          })
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed' },
            },
          })
          return
        }

        if (message.method === 'initialize') {
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            id: message.id,
            result: {},
          })
          return
        }

        if (message.method === 'thread/start') {
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              thread: {
                id: 'thread-1',
                sessionId: 'thread-1',
              },
            },
          })
          return
        }

        if (message.method === 'turn/start') {
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              turn: {
                id: 'turn-1',
                status: 'inProgress',
              },
            },
          })
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            id: 'approval-rpc-1',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-1',
              command: 'echo ok',
              cwd: '/tmp/demo',
              reason: 'needs shell',
              availableDecisions: ['accept', 'decline'],
            },
          })
        }
      }
    })

    const { observations, summary } = await collect(
      runCodexNativeAppServer(
        {
          prompt: 'Run echo ok',
          cwd: '/tmp/demo',
          model: 'gpt-5.3-codex',
          requestApproval: async approval => {
            approvalRequests.push(approval.providerRequestId)
            return { allow: true }
          },
        },
        {
          which: () => '/usr/local/bin/codex',
          resolveVersion: () => 'codex-cli 0.125.0',
          spawnProcess: () => fake.child as never,
        },
      ),
    )

    expect(approvalRequests).toEqual([
      'codex:item/commandExecution/requestApproval:item-1',
    ])
    expect(approvalResponses).toEqual([{ decision: 'accept' }])
    expect(
      observations.some(
        observation =>
          observation.type === 'normalized_event' &&
          observation.event.type === 'assistant_text' &&
          observation.event.text === 'OK',
      ),
    ).toBe(true)
    expect(summary).toMatchObject({
      threadId: 'thread-1',
      completionPolicy: 'ephemeral',
      finalHistoryCompleteness: 'explicit-hydration-required',
    })
  })
})
