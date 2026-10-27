import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildCodexNativeExecArgs,
  runCodexNativeExec,
} from './execRunner.js'
import { CodexNativeRunnerError } from './runnerLifecycle.js'

const CONTINUITY_THREAD = '591b2560-ff9b-4620-b30e-8ca38ad2abf3'

async function drainExec(iterator: ReturnType<typeof runCodexNativeExec>) {
  while (true) {
    const next = await iterator.next()
    if (next.done) return next.value
  }
}

describe('exec owned conversation continuity', () => {
  test('keeps shared flags before exact resume UUID and new images after resume', () => {
    const args = buildCodexNativeExecArgs({
      prompt: 'new input', cwd: tmpdir(), ephemeral: false, resumeThreadId: CONTINUITY_THREAD,
      sessionsDirectory: tmpdir(), model: 'TEST-new-model', reasoningEffort: 'high',
      approvalPolicy: 'never', sandboxMode: 'workspace-write', imagePaths: [path.join(tmpdir(), 'TEST.png')],
      ignoreUserConfig: true, configOverrides: ['mcp_servers.TEST.enabled=false'],
    })
    const resume = args.indexOf('resume')
    expect(args.slice(resume)).toEqual(['resume', CONTINUITY_THREAD, '--image', path.join(tmpdir(), 'TEST.png'), '-'])
    expect(args.indexOf('--sandbox')).toBeLessThan(resume)
    expect(args.indexOf('TEST-new-model')).toBeLessThan(resume)
    expect(args.indexOf('mcp_servers.TEST.enabled=false')).toBeLessThan(resume)
    expect(args).not.toContain('--ephemeral')
    expect(args).not.toContain('--last')
  })

  test('rejects invalid resume identity before spawning with safe failure evidence', async () => {
    let spawned = false
    const error = await drainExec(runCodexNativeExec({
      prompt: 'must not submit', cwd: tmpdir(), ephemeral: false,
      sessionsDirectory: tmpdir(), resumeThreadId: 'friendly-title',
    }, { spawnProcess: () => { spawned = true; throw new Error('unexpected spawn') } }))
      .then(() => null, error => error)
    expect(spawned).toBe(false)
    expect(error).toBeInstanceOf(CodexNativeRunnerError)
    expect(error.lifecycle).toEqual({ submissionMayHaveStarted: false, turnTerminal: false, childStopped: true })
  })

  test('uses fresh isolated profiles over the same sessions, preserving explicit user config and secret env', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-codex-exec-continuity-'))
    const source = path.join(root, 'source')
    const sessions = path.join(root, 'sessions')
    await mkdir(source)
    await mkdir(sessions)
    await writeFile(path.join(source, 'config.toml'), 'model = "TEST-user"\n')
    const homes: string[] = []
    try {
      for (let turn = 0; turn < 2; turn++) {
        const child = new FakeCodexProcess()
        const stdin: string[] = []
        child.stdin.on('data', chunk => stdin.push(String(chunk)))
        const iterator = runCodexNativeExec({
          prompt: `only new prompt ${turn}`, cwd: root, model: 'TEST-current', ephemeral: false,
          sessionsDirectory: sessions, ...(turn ? { resumeThreadId: CONTINUITY_THREAD } : {}),
          ignoreUserConfig: false, extraEnv: { CODEX_HOME: source, CODEX_SQLITE_HOME: source, TEST_LOOPBACK_TOKEN: 'test-secret' },
          loopbackOverlayToml: '[model_providers.TEST]\nexperimental_bearer_token="test-secret"\n',
          configOverrides: ['model_providers.TEST.env_key="TEST_LOOPBACK_TOKEN"', `sqlite_home=${JSON.stringify(source)}`],
        }, { which: () => '/TEST/codex', resolveVersion: () => 'TEST',
          spawnProcess: (_binary, args, options) => {
            homes.push(options.env.CODEX_HOME!)
            expect(options.env.CODEX_SQLITE_HOME).toBe(options.env.CODEX_HOME)
            expect(options.env.TEST_LOOPBACK_TOKEN).toBe('test-secret')
            expect(args.join(' ')).not.toContain('test-secret')
            expect(args.filter(arg => arg.startsWith('sqlite_home=')).at(-1))
              .toBe(`sqlite_home=${JSON.stringify(options.env.CODEX_HOME)}`)
            expect(args.includes('resume')).toBe(Boolean(turn))
            return child as never
          },
        })
        await iterator.next()
        expect(stdin.join('')).toBe(`only new prompt ${turn}`)
        expect(await readFile(path.join(homes[turn]!, 'config.toml'), 'utf8')).toBe('model = "TEST-user"\n')
        await writeFile(path.join(homes[turn]!, 'sessions', 'sentinel'), 'owned')
        const remaining = drainExec(iterator)
        child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: CONTINUITY_THREAD }) + '\n')
        child.stdout.write('{"type":"turn.completed","usage":{}}\n')
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0, null)
        expect((await remaining).threadId).toBe(CONTINUITY_THREAD)
        expect(existsSync(homes[turn]!)).toBe(false)
        expect(await readFile(path.join(sessions, 'sentinel'), 'utf8')).toBe('owned')
      }
      expect(homes[0]).not.toBe(homes[1])
      expect(await readFile(path.join(source, 'config.toml'), 'utf8')).toBe('model = "TEST-user"\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  for (const terminal of [true, false]) {
    test(`reports terminal=${terminal} separately from confirmed process shutdown`, async () => {
      const child = new FakeCodexProcess()
      const iterator = runCodexNativeExec({ prompt: 'TEST lifecycle', cwd: tmpdir() }, {
        which: () => '/TEST/codex', resolveVersion: () => 'TEST', spawnProcess: () => child as never,
      })
      await iterator.next()
      const remaining = drainExec(iterator).then(() => null, error => error)
      child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: CONTINUITY_THREAD }) + '\n')
      if (terminal) child.stdout.write('{"type":"turn.failed","error":{"message":"TEST provider failed"}}\n')
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 1, null)
      const error = await remaining
      expect(error).toBeInstanceOf(CodexNativeRunnerError)
      expect(error.lifecycle).toEqual({ submissionMayHaveStarted: true, turnTerminal: terminal, childStopped: true })
    })
  }

  test('escalates despite child.killed and retains uncertainty plus overlay until close is observed', async () => {
    const sessions = await mkdtemp(path.join(tmpdir(), 'TEST-codex-unstopped-'))
    const child = new FakeCodexProcess()
    const signals: Array<NodeJS.Signals | number | undefined> = []
    child.kill = signal => { child.killed = true; signals.push(signal); return true }
    let home = ''
    try {
      const error = await drainExec(runCodexNativeExec({
        prompt: 'TEST hung process', cwd: sessions, ephemeral: false, sessionsDirectory: sessions,
        ignoreUserConfig: true, extraEnv: { CODEX_HOME: path.join(sessions, 'absent-profile') }, idleTimeoutMs: 1,
      }, { which: () => '/TEST/codex', resolveVersion: () => 'TEST',
        spawnProcess: (_binary, _args, options) => { home = options.env.CODEX_HOME!; return child as never } }))
        .then(() => null, error => error)
      expect(error.lifecycle).toEqual({ submissionMayHaveStarted: true, turnTerminal: false, childStopped: false })
      expect(signals).toContain('SIGTERM')
      expect(signals).toContain('SIGKILL')
      expect(existsSync(home)).toBe(true)
      child.emit('close', null, 'SIGKILL')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(existsSync(home)).toBe(false)
      expect(existsSync(sessions)).toBe(true)
    } finally { await rm(sessions, { recursive: true, force: true }) }
  })
})

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
    queueMicrotask(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('close', null, signal ?? 'SIGTERM')
    })
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

  test('passes approval policy as a Codex config override', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Inspect the repo and summarize it.',
        cwd: '/tmp/demo',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      '-c',
      'approval_policy="never"',
      '--sandbox',
      'danger-full-access',
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

  test('passes Codex max reasoning through model_reasoning_effort config', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'max',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="max"',
      '-',
    ])
  })

  test('passes Codex ultra reasoning through model_reasoning_effort config', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'ultra',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="ultra"',
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

  test('can ignore user config without dropping dynamic MCP overrides', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        ignoreUserConfig: true,
        configOverrides: [
          'mcp_servers.agent-teams.command="/usr/local/bin/node"',
        ],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ignore-user-config',
      '--ephemeral',
      '-c',
      'mcp_servers.agent-teams.command="/usr/local/bin/node"',
      '-',
    ])
  })

  test('passes disabled Codex feature flags without dropping user config overrides', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Reply only with OK',
        cwd: '/tmp/demo',
        forcedLoginMethod: 'api',
        configOverrides: [
          'mcp_servers.agent-teams.command="/usr/local/bin/node"',
        ],
        disabledFeatures: ['plugins'],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      '-c',
      'forced_login_method="api"',
      '-c',
      'mcp_servers.agent-teams.command="/usr/local/bin/node"',
      '--disable',
      'plugins',
      '-',
    ])
  })

  test('passes image paths before stdin marker', () => {
    expect(
      buildCodexNativeExecArgs({
        prompt: 'Look at the screenshot.',
        cwd: '/tmp/demo',
        imagePaths: ['/tmp/red.png', '/tmp/blue.jpg'],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/demo',
      '--ephemeral',
      '--image',
      '/tmp/red.png',
      '--image',
      '/tmp/blue.jpg',
      '-',
    ])
  })

  test('rejects non-absolute image paths before building args', () => {
    expect(() =>
      buildCodexNativeExecArgs({
        prompt: 'Look at the screenshot.',
        cwd: '/tmp/demo',
        imagePaths: ['relative.png'],
      }),
    ).toThrow(/must be absolute/)
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

    const nativeProcess = new FakeCodexProcess()
    nativeProcess.pid = 4343
    const processKill = spyOn(process, 'kill')
      .mockImplementation((() => {
        queueMicrotask(() => nativeProcess.emit('close', null, 'SIGTERM'))
        return true
      }) as typeof process.kill)

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

  test('includes Codex JSON error diagnostics when codex exits non-zero without stderr', async () => {
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

    process.stdout.write(
      '{"type":"error","message":"Quota exceeded. Check your plan and billing details."}\n',
    )
    process.stdout.write(
      '{"type":"turn.failed","error":{"message":"Quota exceeded. Check your plan and billing details."}}\n',
    )
    process.stdout.end()
    process.stderr.end()
    process.emit('close', 1, null)

    await expect(remaining).rejects.toThrow(
      'Codex native exec exited with code 1: Codex native error: Quota exceeded. Check your plan and billing details.',
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

  test('scrubs ambient native credentials when ChatGPT login is forced', async () => {
    const originalCodexApiKey = process.env.CODEX_API_KEY
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.CODEX_API_KEY = 'ambient-native-key'
    process.env.OPENAI_API_KEY = 'ambient-openai-key'
    let observedEnv: NodeJS.ProcessEnv | undefined

    try {
      const process = new FakeCodexProcess()
      const iterator = runCodexNativeExec(
        {
          prompt: 'Reply only with OK',
          cwd: '/tmp/demo',
          ephemeral: false,
          forcedLoginMethod: 'chatgpt',
        },
        {
          which: () => '/usr/local/bin/codex',
          resolveVersion: () => 'codex-cli 0.117.0',
          spawnProcess: (_executablePath, _args, options) => {
            observedEnv = options.env
            return process as never
          },
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
        '{"type":"thread.started","thread_id":"thread-3"}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n',
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
        threadId: 'thread-3',
        credentialSource: 'none',
        completionPolicy: 'persistent',
        finalHistoryCompleteness: 'explicit-hydration-required',
        finalUsageAuthority: 'live-turn-completed',
      })
      expect(observedEnv?.CODEX_API_KEY).toBeUndefined()
      expect(observedEnv?.OPENAI_API_KEY).toBeUndefined()
    } finally {
      if (originalCodexApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalCodexApiKey
      }
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey
      }
    }
  })

  test('uses CODEX_CLI_PATH before PATH lookup when spawning codex exec', async () => {
    const originalCodexCliPath = process.env.CODEX_CLI_PATH
    process.env.CODEX_CLI_PATH = '/opt/codex/bin/codex.cmd'

    try {
      const process = new FakeCodexProcess()
      const spawnProcess = mock(() => process)
      const iterator = runCodexNativeExec(
        {
          prompt: 'Reply only with OK',
          cwd: '/tmp/demo',
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
            executablePath: '/opt/codex/bin/codex.cmd',
            executableSource: 'configured-env',
            version: 'codex-cli 0.117.0',
          },
        },
      })
      expect(spawnProcess).toHaveBeenCalledWith(
        '/opt/codex/bin/codex.cmd',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CODEX_CLI_PATH: '/opt/codex/bin/codex.cmd',
          }),
        }),
      )

      await iterator.return(undefined as never)
    } finally {
      if (originalCodexCliPath === undefined) {
        delete process.env.CODEX_CLI_PATH
      } else {
        process.env.CODEX_CLI_PATH = originalCodexCliPath
      }
    }
  })
})
