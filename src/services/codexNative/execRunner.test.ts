import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  buildCodexNativeExecArgs,
  runCodexNativeExec,
} from './execRunner.js'

class FakeCodexProcess extends EventEmitter {
  pid?: number
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  killSignal: NodeJS.Signals | number | undefined

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    this.killSignal = signal
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
      '-',
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
      '-',
    ])
  })

  test('passes Codex xhigh reasoning through model_reasoning_effort config', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        model: 'gpt-5.4',
        reasoningEffort: 'xhigh',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      '-m',
      'gpt-5.4',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-',
    ])
  })

  test('passes forced login method and MCP config overrides through -c flags', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        forcedLoginMethod: 'chatgpt',
        configOverrides: [
          'mcp_servers.agent-teams.command="/usr/local/bin/node"',
          'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
        ],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      '-c',
      'forced_login_method="chatgpt"',
      '-c',
      'mcp_servers.agent-teams.command="/usr/local/bin/node"',
      '-c',
      'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
      '-',
    ])
  })
})

describe('runCodexNativeExec', () => {
  test('yields binary identity first and streams normalized stdout and stderr events', async () => {
    const process = new FakeCodexProcess()
    const spawnProcess = mock(() => process)
    const stdinChunks: string[] = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      stdinChunks.push(String(chunk))
    })

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
        '-',
      ],
      expect.objectContaining({
        cwd: '/tmp/demo',
        detached: globalThis.process.platform !== 'win32',
        stdin: 'pipe',
        env: expect.objectContaining({
          CODEX_API_KEY: 'sk-codex',
        }),
      }),
    )
    expect(stdinChunks.join('')).toBe('Reply only with OK')

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

  test('captures a native process close while the consumer is paused after identity', async () => {
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

    const first = await iterator.next()
    expect(first.done).toBe(false)

    process.emit('close', 1, null)

    await expect(iterator.next()).rejects.toThrow(
      'Codex native exec exited with code 1',
    )
  })

  test('terminates the detached POSIX process group when the consumer closes the stream', async () => {
    if (process.platform === 'win32') {
      return
    }

    const processKill = spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill)
    const nativeProcess = new FakeCodexProcess()
    nativeProcess.pid = 4343

    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => nativeProcess as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

    await iterator.return(undefined as never)

    expect(processKill).toHaveBeenCalledWith(-4343, 'SIGTERM')
    expect(nativeProcess.killed).toBe(false)
  })

  test('terminates a hung native exec after the configured idle timeout', async () => {
    const process = new FakeCodexProcess()
    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        idleTimeoutMs: 1,
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => process as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

    setTimeout(() => {
      process.stdout.end()
      process.stderr.end()
      process.emit('close', null, 'SIGTERM')
    }, 5)

    try {
      while (!(await iterator.next()).done) {
        // Drain observations until timeout closes the fake process.
      }
      throw new Error('Expected timeout')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        'Codex native exec timed out after 1ms of inactivity.',
      )
    }
    expect(process.killed).toBe(true)
    expect(process.killSignal).toBe('SIGTERM')
  })

  test('terminates the detached POSIX process group on idle timeout', async () => {
    if (process.platform === 'win32') {
      return
    }

    const processKill = spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill)
    const nativeProcess = new FakeCodexProcess()
    nativeProcess.pid = 4242

    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        idleTimeoutMs: 1,
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => nativeProcess as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

    setTimeout(() => {
      nativeProcess.stdout.end()
      nativeProcess.stderr.end()
      nativeProcess.emit('close', null, 'SIGTERM')
    }, 5)

    await expect(
      (async () => {
        while (!(await iterator.next()).done) {
          // Drain observations until timeout closes the fake process.
        }
      })(),
    ).rejects.toThrow('Codex native exec timed out after 1ms of inactivity.')

    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(nativeProcess.killed).toBe(false)
  })

  test('resets the configured idle timeout after stdout activity', async () => {
    const process = new FakeCodexProcess()
    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        idleTimeoutMs: 40,
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => process as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

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

    setTimeout(() => {
      process.stdout.write(
        '{"type":"thread.started","thread_id":"thread-activity"}\n',
      )
    }, 25)
    setTimeout(() => {
      process.stdout.write(
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n',
      )
      process.stdout.write(
        '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n',
      )
      process.stdout.end()
      process.stderr.end()
      process.emit('close', 0, null)
    }, 55)

    await expect(remaining).resolves.toMatchObject({
      observed: [
        {
          type: 'normalized_event',
          event: {
            type: 'thread_started',
            threadId: 'thread-activity',
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
          },
        },
        {
          type: 'normalized_event',
          event: {
            type: 'turn_completed',
          },
        },
      ],
      summary: {
        threadId: 'thread-activity',
      },
    })
    expect(process.killed).toBe(false)
  })

  test('does not reset the configured idle timeout after stderr activity', async () => {
    const process = new FakeCodexProcess()
    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        idleTimeoutMs: 40,
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => process as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

    const remaining = (async () => {
      while (!(await iterator.next()).done) {
        // Drain observations until timeout closes the fake process.
      }
    })()

    setTimeout(() => {
      process.stderr.write('still warning\n')
    }, 25)
    setTimeout(() => {
      process.stdout.write(
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n',
      )
      process.stdout.end()
      process.stderr.end()
      process.emit('close', null, 'SIGTERM')
    }, 70)

    await expect(remaining).rejects.toThrow(
      'Codex native exec timed out after 40ms of inactivity.',
    )
    expect(process.killed).toBe(true)
    expect(process.killSignal).toBe('SIGTERM')
  })

  test('resets the configured idle timeout on stdout bytes before a newline', async () => {
    const process = new FakeCodexProcess()
    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        idleTimeoutMs: 40,
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => process as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

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

    setTimeout(() => {
      process.stdout.write('partial')
    }, 25)
    setTimeout(() => {
      process.stdout.write(
        ' line\n{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n',
      )
      process.stdout.write(
        '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n',
      )
      process.stdout.end()
      process.stderr.end()
      process.emit('close', 0, null)
    }, 55)

    const { observed, summary } = await remaining
    expect(observed).toContainEqual({
      type: 'normalized_event',
      event: {
        type: 'assistant_text',
        itemId: 'item_0',
        text: 'OK',
      },
    })
    expect(observed).toContainEqual({
      type: 'normalized_event',
      event: {
        type: 'usage_updated',
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
      },
    })
    expect(observed).toContainEqual({
      type: 'normalized_event',
      event: {
        type: 'turn_completed',
      },
    })
    expect(summary).toMatchObject({
      threadId: null,
    })
    expect(process.killed).toBe(false)
  })

  test('terminates after the absolute timeout even when output is active', async () => {
    const process = new FakeCodexProcess()
    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        idleTimeoutMs: 100,
        absoluteTimeoutMs: 30,
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => process as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

    const activityHandle = setInterval(() => {
      process.stderr.write('still working\n')
    }, 10)
    setTimeout(() => {
      clearInterval(activityHandle)
      process.stdout.end()
      process.stderr.end()
      process.emit('close', null, 'SIGTERM')
    }, 40)

    try {
      while (!(await iterator.next()).done) {
        // Drain observations until timeout closes the fake process.
      }
      throw new Error('Expected timeout')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        'Codex native exec timed out after 30ms.',
      )
    }
    expect(process.killed).toBe(true)
    expect(process.killSignal).toBe('SIGTERM')
  })

  test('keeps the legacy timeoutMs option as an absolute timeout cap', async () => {
    const process = new FakeCodexProcess()
    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        timeoutMs: 1,
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.117.0',
        spawnProcess: () => process as never,
      },
    )

    const first = await iterator.next()
    expect(first.done).toBe(false)

    setTimeout(() => {
      process.stdout.end()
      process.stderr.end()
      process.emit('close', null, 'SIGTERM')
    }, 5)

    try {
      while (!(await iterator.next()).done) {
        // Drain observations until timeout closes the fake process.
      }
      throw new Error('Expected timeout')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        'Codex native exec timed out after 1ms.',
      )
    }
    expect(process.killed).toBe(true)
    expect(process.killSignal).toBe('SIGTERM')
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

  test('suppresses stdin and cleanup noise and rewrites analytics html spam into one warning', async () => {
    const process = new FakeCodexProcess()

    const iterator = runCodexNativeExec(
      {
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
      },
      {
        which: () => '/usr/local/bin/codex',
        resolveVersion: () => 'codex-cli 0.122.0',
        spawnProcess: () => process as never,
      },
    )

    await iterator.next()

    const remaining = (async () => {
      const observed = []
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          return observed
        }
        observed.push(next.value)
      }
    })()

    process.stderr.write('Reading additional input from stdin...\n')
    process.stderr.write(
      '2026-04-21T23:08:10.237795Z  WARN codex_analytics::client: events failed with status 403 Forbidden: <html>\n',
    )
    process.stderr.write('  <head>\n')
    process.stderr.write('  <body>\n')
    process.stderr.write(
      '2026-04-21T23:08:17.075276Z  WARN codex_rmcp_client::stdio_server_launcher: Failed to terminate MCP process group 50669: Operation not permitted (os error 1)\n',
    )
    process.stderr.write(
      '2026-04-21T23:08:18.208719Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at AbsolutePathBuf(\"/tmp/foo\"): Os { code: 2, kind: NotFound, message: \"No such file or directory\" }\n',
    )
    process.stderr.write('plain warning that should survive\n')
    process.stdout.write(
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n',
    )
    process.stdout.end()
    process.stderr.end()
    process.emit('close', 0, null)

    await expect(remaining).resolves.toEqual([
      {
        type: 'normalized_event',
        event: {
          type: 'warning',
          source: 'stderr',
          text: 'Codex analytics events were blocked with 403 Forbidden. Continuing without analytics.',
        },
      },
      {
        type: 'normalized_event',
        event: {
          type: 'warning',
          source: 'stderr',
          text: 'plain warning that should survive',
        },
      },
      {
        type: 'normalized_event',
        event: {
          type: 'usage_updated',
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
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
