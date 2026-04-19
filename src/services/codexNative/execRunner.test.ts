import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  buildCodexNativeExecArgs,
  runCodexNativeExec,
} from './execRunner.js'

class FakeCodexProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

afterEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

beforeEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

describe('buildCodexNativeExecArgs', () => {
  test('builds the default phase-0 raw exec command with ephemeral json output', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      'Reply only with OK',
    ])
  })

  test('includes model, reasoning, sandbox, and writable directories when provided', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Inspect the repo and summarize it.',
        cwd: '/tmp/demo',
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
        sandboxMode: 'workspace-write',
        additionalWritableDirectories: ['/tmp/demo-2', '/tmp/demo-3'],
        ephemeral: false,
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="high"',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      '/tmp/demo-2',
      '--add-dir',
      '/tmp/demo-3',
      'Inspect the repo and summarize it.',
    ])
  })
})

describe('runCodexNativeExec', () => {
  test('yields binary identity first and streams normalized stdout and stderr events', async () => {
    const process = new FakeCodexProcess()
    const spawnProcess = mock(() => process)

    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        apiKey: 'sk-codex',
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: (binaryPath, args, options) =>
          spawnProcess(binaryPath, args, options) as never,
      },
    )

    const first = await iterator.next()
    expect(first).toMatchObject({
      done: false,
      value: {
        type: 'binary_identity',
        identity: {
          executablePath: '/usr/local/bin/codex',
          executableSource: 'system-path',
          version: 'codex-cli 0.117.0',
        },
      },
    })

    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-C',
        '/tmp/demo',
        '--ephemeral',
        'Reply only with OK',
      ],
      expect.objectContaining({
        cwd: '/tmp/demo',
        env: expect.objectContaining({
          CODEX_API_KEY: 'sk-codex',
        }),
      }),
    )

    const remaining = (async () => {
      const observed = []
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          return {
            observed,
            summary: next.value,
          }
        }
        observed.push(next.value)
      }
    })()

    process.stdout.write(
      '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n',
    )
    process.stderr.write('native stderr warning\n')
    process.stdout.write(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n',
    )
    process.stdout.write(
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":4,"output_tokens":2}}\n',
    )
    process.stdout.end()
    process.stderr.end()
    process.emit('close', 0, null)

    const { observed, summary } = await remaining
    expect(summary).toEqual({
      identity: {
        executablePath: '/usr/local/bin/codex',
        executableSource: 'system-path',
        version: 'codex-cli 0.117.0',
      },
      threadId: 'thread-1',
      credentialSource: 'explicit-api-key',
      completionPolicy: 'ephemeral',
      finalHistoryCompleteness: 'live-only',
      finalUsageAuthority: 'live-turn-completed',
    })

    expect(observed).toEqual([
      {
        type: 'normalized_event',
        event: {
          type: 'thread_started',
          threadId: 'thread-1',
        },
      },
      {
        type: 'normalized_event',
        event: {
          type: 'turn_started',
        },
      },
      {
        type: 'normalized_event',
        event: {
          type: 'warning',
          source: 'stderr',
          text: 'native stderr warning',
        },
      },
      {
        type: 'normalized_event',
        event: {
          type: 'assistant_text',
          itemId: 'item_0',
          text: 'OK',
        },
      },
      {
        type: 'normalized_event',
        event: {
          type: 'usage_updated',
          inputTokens: 12,
          cachedInputTokens: 4,
          outputTokens: 2,
        },
      },
      {
        type: 'normalized_event',
        event: {
          type: 'turn_completed',
        },
      },
    ])
  })

  test('throws a targeted error when codex exits non-zero', async () => {
    const process = new FakeCodexProcess()

    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => process as never,
      },
    )

    await iterator.next()
    const remaining = (async () => {
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          return
        }
      }
    })()

    process.stderr.write('fatal native failure\n')
    process.stdout.end()
    process.stderr.end()
    process.emit('close', 1, null)

    await expect(remaining).rejects.toThrow(
      'Codex native exec exited with code 1: fatal native failure',
    )
  })

  test('records ambient native credential routing when CODEX_API_KEY already exists in process env', async () => {
    const originalApiKey = process.env.CODEX_API_KEY
    process.env.CODEX_API_KEY = 'ambient-native-key'

    try {
      const process = new FakeCodexProcess()
      const iterator = runCodexNativeExec(
        {
          prompt: 'Reply only with OK',
          cwd: '/tmp/demo',
          ephemeral: false,
        },
        {
          which: () => '/usr/local/bin/codex',
          resolveVersion: () => 'codex-cli 0.117.0',
          spawnProcess: () => process as never,
        },
      )

      await iterator.next()
      const remaining = (async () => {
        while (true) {
          const next = await iterator.next()
          if (next.done) {
            return next.value
          }
        }
      })()

      process.stdout.write(
        '{"type":"thread.started","thread_id":"thread-2"}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n',
      )
      process.stdout.end()
      process.stderr.end()
      process.emit('close', 0, null)

      await expect(remaining).resolves.toEqual({
        identity: {
          executablePath: '/usr/local/bin/codex',
          executableSource: 'system-path',
          version: 'codex-cli 0.117.0',
        },
        threadId: 'thread-2',
        credentialSource: 'ambient-process-env',
        completionPolicy: 'persistent',
        finalHistoryCompleteness: 'explicit-hydration-required',
        finalUsageAuthority: 'live-turn-completed',
      })
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalApiKey
      }
    }
  })
})
