import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'bun:test'

import { createCodexAppServerNotificationMapper, runCodexNativeAppServer } from './appServerRunner.js'
import { CodexNativeTranscriptProjector } from './transcriptProjector.js'
import type { CodexNativeExecObservation } from './execRunner.js'

describe('Codex app-server assistant snapshots', () => {
  for (const failure of ['exit', 'abort', 'idle timeout', 'absolute timeout'] as const) {
    test(`retains partial assistant text and usage while preserving ${failure} failure`, async () => {
      const fake = createFakeCodexAppServer()
      const controller = new AbortController()
      fake.stdin.on('data', chunk => {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue
          const message = JSON.parse(line)
          if (!message.id) continue
          writeJson(fake.stdout, {
            id: message.id,
            result: message.method === 'thread/start'
              ? { thread: { id: 'thread' } }
              : message.method === 'turn/start' ? { turn: { id: 'turn' } } : {},
          })
          if (message.method !== 'turn/start') continue
          for (const delta of ['P', 'ON']) {
            writeJson(fake.stdout, {
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread', turnId: 'turn', itemId: 'partial', delta },
            })
          }
          writeJson(fake.stdout, {
            method: 'thread/tokenUsage/updated',
            params: { threadId: 'thread', turnId: 'turn',
              tokenUsage: { last: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 1 } } },
          })
          if (failure === 'exit') setTimeout(() => fake.child.emit('exit', 1, null), 10)
          if (failure === 'abort') setTimeout(() => controller.abort(new Error('test abort')), 10)
        }
      })
      const observations: CodexNativeExecObservation[] = []
      const run = async () => {
        for await (const observation of runCodexNativeAppServer({
          prompt: 'synthetic test', cwd: '/tmp/test-only', abortSignal: controller.signal,
          requestApproval: async () => ({ allow: false }),
          idleTimeoutMs: failure === 'idle timeout' ? 15 : null,
          absoluteTimeoutMs: failure === 'absolute timeout' ? 15 : null,
        }, {
          which: () => '/test-only/codex', resolveVersion: () => 'test',
          spawnProcess: (_command, _args, options) => {
            options.signal?.addEventListener('abort', () => fake.child.emit('error', options.signal?.reason), { once: true })
            return fake.child as never
          },
        })) observations.push(observation)
      }
      await expect(run()).rejects.toThrow(failure === 'exit' ? 'exited unexpectedly' : failure)
      const events = observations.flatMap(observation => observation.type === 'normalized_event' ? [observation.event] : [])
      expect(events.filter(event => event.type === 'assistant_text')).toEqual([
        { type: 'assistant_text', itemId: 'partial', text: 'PON' },
      ])
      expect(events.some(event => event.type === 'usage_updated')).toBe(true)
      expect(events.some(event => event.type === 'turn_completed')).toBe(false)
    })
  }

  test('aggregates P + ONG at turn completion instead of returning only the final chunk', () => {
    const map = createCodexAppServerNotificationMapper()
    const projector = new CodexNativeTranscriptProjector()
    const identity = { threadId: 'thread', turnId: 'turn', itemId: 'message' }
    expect(map('item/agentMessage/delta', { ...identity, delta: 'P' })).toEqual([])
    expect(map('item/agentMessage/delta', { ...identity, delta: 'ONG' })).toEqual([])
    const events = map('turn/completed', { threadId: 'thread', turn: { id: 'turn' } })
    for (const event of events) projector.apply(event)
    expect(events[0]).toEqual({ type: 'assistant_text', itemId: 'message', text: 'PONG' })
    expect(projector.getLastAssistantMessage()?.message.content).toEqual([{ type: 'text', text: 'PONG' }])
  })

  test('replaces chunks with a final snapshot, preserving whitespace and distinct tool-turn messages', () => {
    const map = createCodexAppServerNotificationMapper()
    const identity = { threadId: 'thread', turnId: 'turn' }
    map('item/agentMessage/delta', { ...identity, itemId: 'commentary', delta: 'Working' })
    map('item/agentMessage/delta', { ...identity, itemId: 'commentary', delta: ' ' })
    const first = map('item/completed', {
      ...identity, item: { type: 'agentMessage', id: 'commentary', text: 'Working now' },
    })
    expect(first).toEqual([{ type: 'assistant_text', itemId: 'commentary', text: 'Working now' }])
    const tool = map('item/started', {
      ...identity, item: { type: 'commandExecution', id: 'tool', command: 'echo test', status: 'inProgress' },
    })
    expect(tool[0]?.type).toBe('tool_call_started')
    map('item/agentMessage/delta', { ...identity, itemId: 'answer', delta: 'P' })
    map('item/agentMessage/delta', { ...identity, itemId: 'answer', delta: 'ONG\n' })
    const answer = map('item/completed', {
      ...identity, item: { type: 'agentMessage', id: 'answer', text: 'PONG\n' },
    })
    expect(answer).toEqual([{ type: 'assistant_text', itemId: 'answer', text: 'PONG\n' }])
    expect(map('turn/completed', { threadId: 'thread', turn: { id: 'turn' } })
      .filter(event => event.type === 'assistant_text')).toEqual([])
  })

  test('keeps reused item ids separate across turns and does not trim streamed spaces', () => {
    const map = createCodexAppServerNotificationMapper()
    for (const [turnId, text] of [['first', 'one'], ['second', 'two']]) {
      map('item/agentMessage/delta', { threadId: 'thread', turnId, itemId: 'same', delta: text })
      map('item/agentMessage/delta', { threadId: 'thread', turnId, itemId: 'same', delta: ' ' })
      const events = map('turn/completed', { threadId: 'thread', turn: { id: turnId } })
      expect(events[0]).toEqual({ type: 'assistant_text', itemId: 'same', text: `${text} ` })
    }
  })

  test('emits final-only snapshots once and defers usage until buffered text is projected', () => {
    const map = createCodexAppServerNotificationMapper()
    const identity = { threadId: 'thread', turnId: 'turn' }
    const completed = { ...identity, item: { type: 'agentMessage', id: 'first', text: 'first' } }
    expect(map('item/completed', completed)).toEqual([
      { type: 'assistant_text', itemId: 'first', text: 'first' },
    ])
    expect(map('item/completed', completed)).toEqual([])
    map('item/agentMessage/delta', { ...identity, itemId: 'answer', delta: 'PONG' })
    expect(map('thread/tokenUsage/updated', {
      ...identity, tokenUsage: { last: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 } },
    })).toEqual([])
    const events = map('turn/completed', { threadId: 'thread', turn: { id: 'turn' } })
    expect(events.map(event => event.type)).toEqual(['assistant_text', 'usage_updated', 'turn_completed'])
    const projector = new CodexNativeTranscriptProjector()
    for (const event of events) projector.apply(event)
    expect(projector.getTotalUsage().output_tokens).toBe(2)
  })
})

function createFakeCodexAppServer() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 0,
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
    await mkdir(path.join(sourceHome, 'sessions'), { recursive: true })
    await writeFile(path.join(sourceHome, 'sessions', 'busy.jsonl'), '{}\n')
    await writeFile(path.join(sourceHome, 'history.jsonl'), '{}\n')

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
              expect(existsSync(path.join(spawnedCodexHome!, 'sessions'))).toBe(false)
              expect(existsSync(path.join(spawnedCodexHome!, 'history.jsonl'))).toBe(false)
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
              delta: 'P',
            },
          })
          writeJson(fake.stdout, {
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'msg-1',
              delta: 'ONG',
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
          observation.event.text === 'PONG',
      ),
    ).toBe(true)
    expect(summary).toMatchObject({
      threadId: 'thread-1',
      completionPolicy: 'ephemeral',
      finalHistoryCompleteness: 'explicit-hydration-required',
    })
  })

  test('surfaces a failed turn error instead of completing without an assistant message', async () => {
    const fake = createFakeCodexAppServer()

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
              turn: {
                id: 'turn-1',
                status: 'failed',
                error: {
                  message: "You've hit your usage limit.",
                  codexErrorInfo: null,
                  additionalDetails: null,
                },
              },
            },
          })
        }
      }
    })

    await expect(
      collect(
        runCodexNativeAppServer(
          {
            prompt: 'Reply PONG',
            cwd: '/tmp/demo',
            model: 'gpt-5.6-sol',
            requestApproval: async () => ({ allow: true }),
          },
          {
            which: () => '/usr/local/bin/codex',
            resolveVersion: () => 'codex-cli 0.144.1',
            spawnProcess: () => fake.child as never,
          },
        ),
      ),
    ).rejects.toThrow(
      "Codex app-server turn failed: You've hit your usage limit.",
    )
  })
})
