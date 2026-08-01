import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { OpenCodeCursorNativeFailureProbe } from './OpenCodeCursorNativeFailureProbe.js'

import type { ChildProcess, SpawnOptions } from 'node:child_process'

function createFakeChild(pid = 4321): {
  child: ChildProcess
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
} {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(emitter, {
    pid,
    exitCode: null,
    signalCode: null,
    stdin,
    stdout,
    stderr,
    kill: () => true,
  }) as unknown as ChildProcess
  return { child, stdin, stdout, stderr }
}

describe('OpenCodeCursorNativeFailureProbe', () => {
  test('uses the managed profile environment and captures a terminal Cursor error', async () => {
    const fake = createFakeChild()
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const env = {
      CURSOR_AGENT_EXECUTABLE: '/managed/profile/cursor-agent',
      PATH: '/managed/profile/bin',
    }
    let spawnedCommand: string | null = null
    let spawnedArgs: string[] = []
    let spawnedOptions: SpawnOptions | undefined
    let prompt = ''
    fake.stdin.on('data', chunk => {
      prompt += String(chunk)
    })

    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      forceKillDelayMs: 1_000,
      now: (() => {
        const values = [100, 112]
        return () => values.shift() ?? 112
      })(),
      spawnProcess: (command, args, options) => {
        spawnedCommand = command
        spawnedArgs = args
        spawnedOptions = options
        queueMicrotask(() => {
          fake.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
          fake.stderr.write(
            'Bearer bearer-secret authorization="Bearer json-secret" '
              + 'CURSOR_API_KEY=cursor-secret sk-abcdefghijklmnop '
              + 'grpc_code=resource_exhausted error_code=upgrade',
          )
          fake.child.emit('close', 1)
        })
        return fake.child
      },
      killProcess: (pid, signal = 'SIGTERM') => {
        kills.push({ pid: pid ?? 0, signal })
      },
    })

    const result = await probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
      env,
    })

    expect(spawnedCommand).toBe(env.CURSOR_AGENT_EXECUTABLE)
    expect(spawnedArgs).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--mode',
      'ask',
      '--workspace',
      '/sandbox/project',
      '--model',
      'auto',
    ])
    expect(spawnedOptions?.cwd).toBe('/sandbox/project')
    expect(spawnedOptions?.env).toBe(env)
    expect(spawnedOptions?.windowsHide).toBe(true)
    expect(spawnedOptions?.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(prompt).toBe('Output only the single word PONG.')
    expect(result).toEqual({
      outcome: 'failure',
      message: 'Bearer [redacted] authorization="[redacted]" '
        + 'CURSOR_API_KEY=[redacted] [redacted-api-key] '
        + 'grpc_code=resource_exhausted error_code=upgrade',
      durationMs: 12,
      exitCode: null,
    })
    expect(kills).toEqual([{ pid: 4321, signal: 'SIGTERM' }])
  })

  test('kills the spawned process tree when the caller aborts', async () => {
    const fake = createFakeChild(6789)
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const controller = new AbortController()
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      forceKillDelayMs: 1_000,
      spawnProcess: () => fake.child,
      killProcess: (pid, signal = 'SIGTERM') => {
        kills.push({ pid: pid ?? 0, signal })
      },
    })

    const pending = probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
      signal: controller.signal,
    })
    controller.abort()
    fake.child.emit('exit', null, 'SIGTERM')

    await expect(pending).resolves.toBeNull()
    expect(kills).toEqual([{ pid: 6789, signal: 'SIGTERM' }])
    expect(fake.stdin.destroyed).toBe(true)
    expect(fake.stdout.destroyed).toBe(true)
    expect(fake.stderr.destroyed).toBe(true)
  })

  test('returns a bounded timeout and kills the spawned process tree', async () => {
    const fake = createFakeChild(6790)
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 5,
      forceKillDelayMs: 0,
      spawnProcess: () => fake.child,
      killProcess: (pid, signal = 'SIGTERM') => {
        kills.push({ pid: pid ?? 0, signal })
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toMatchObject({
      outcome: 'timeout',
      message: 'Cursor native execution preflight timed out after 5ms',
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(kills).toEqual([
      { pid: 6790, signal: 'SIGTERM' },
      { pid: 6790, signal: 'SIGKILL' },
    ])
  })

  test('kills a spawned child that emits an error after receiving a pid', async () => {
    const fake = createFakeChild(9876)
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      forceKillDelayMs: 0,
      spawnProcess: () => {
        queueMicrotask(() => fake.child.emit('error', new Error('stream setup failed')))
        return fake.child
      },
      killProcess: (pid, signal = 'SIGTERM') => {
        kills.push({ pid: pid ?? 0, signal })
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toBeNull()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(kills).toEqual([
      { pid: 9876, signal: 'SIGTERM' },
      { pid: 9876, signal: 'SIGKILL' },
    ])
  })

  test('returns a terminal stdout marker before close and force-kills a stuck child', async () => {
    const fake = createFakeChild()
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      forceKillDelayMs: 0,
      killProcess: (pid, signal = 'SIGTERM') => {
        kills.push({ pid: pid ?? 0, signal })
      },
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stderr.write('cursor-agent diagnostic warning')
          fake.stdout.write('{"error":{"grpcCode":8}}')
        })
        return fake.child
      },
    })

    const result = await probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })

    expect(result?.message).toContain('grpcCode')
    expect(result?.outcome).toBe('failure')
    expect(result?.message).not.toContain('diagnostic warning')
    expect(result?.exitCode).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(kills).toEqual([
      { pid: 4321, signal: 'SIGTERM' },
      { pid: 4321, signal: 'SIGKILL' },
    ])
    expect(fake.stdin.destroyed).toBe(true)
    expect(fake.stdout.destroyed).toBe(true)
    expect(fake.stderr.destroyed).toBe(true)
  })

  test('returns a retryable network failure without waiting for a stuck child to close', async () => {
    const fake = createFakeChild()
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 60_000,
      forceKillDelayMs: 0,
      killProcess: (pid, signal = 'SIGTERM') => {
        kills.push({ pid: pid ?? 0, signal })
      },
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stderr.write('Connection reset by server')
        })
        return fake.child
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toMatchObject({
      outcome: 'retryable',
      message: 'Connection reset by server',
      exitCode: null,
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(kills).toEqual([
      { pid: 4321, signal: 'SIGTERM' },
      { pid: 4321, signal: 'SIGKILL' },
    ])
  })

  test('does not treat a token count of 429 as an HTTP failure', async () => {
    const fake = createFakeChild()
    const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stdout.write(
            '{"type":"result","subtype":"success","is_error":false,'
              + '"usage":{"input_tokens":429},"result":"PONG"}',
          )
          fake.stdout.end()
          fake.stderr.end()
          fake.child.emit('exit', 0)
          fake.child.emit('close', 0)
        })
        return fake.child
      },
      killProcess: (pid, signal = 'SIGTERM') => {
        kills.push({ pid: pid ?? 0, signal })
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toMatchObject({
      outcome: 'available',
      message: null,
      exitCode: 0,
    })
    expect(kills).toEqual([])
  })

  test('treats an empty zero exit as inconclusive', async () => {
    const fake = createFakeChild()
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stdout.end()
          fake.stderr.end()
          fake.child.emit('exit', 0)
          fake.child.emit('close', 0)
        })
        return fake.child
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toBeNull()
  })

  test('does not accept initialization-only output as execution proof', async () => {
    const fake = createFakeChild()
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stdout.write('{"type":"system","subtype":"init","model":"Auto"}\n')
          fake.stdout.end()
          fake.stderr.end()
          fake.child.emit('exit', 0)
          fake.child.emit('close', 0)
        })
        return fake.child
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toBeNull()
  })

  test('does not accept an error terminal result as execution proof', async () => {
    const fake = createFakeChild()
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stdout.write(
            '{"type":"result","subtype":"error","is_error":true,"result":"PONG"}\n',
          )
          fake.stdout.end()
          fake.stderr.end()
          fake.child.emit('exit', 0)
          fake.child.emit('close', 0)
        })
        return fake.child
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toBeNull()
  })

  test('redacts secrets from an unclassified non-zero failure', async () => {
    const fake = createFakeChild()
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stderr.write('CURSOR_API_KEY=cursor-secret unexpected native failure')
          fake.stderr.end()
          fake.stdout.end()
          fake.child.emit('exit', 1)
          fake.child.emit('close', 1)
        })
        return fake.child
      },
    })

    await expect(probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/sandbox/project',
    })).resolves.toMatchObject({
      outcome: 'failure',
      message: 'CURSOR_API_KEY=[redacted] unexpected native failure',
    })
  })
})
