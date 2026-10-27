import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

import { observeCodexNativeChild } from './runnerLifecycle.js'

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TEST child observation timed out')), 3_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('native child lifecycle evidence', () => {
  for (const stdio of ['pipe', 'ignore'] as const) {
    test(`recognizes an actual failed spawn with ${stdio} stdio before relying on close`, async () => {
      const missing = path.join(tmpdir(), `TEST-missing-codex-${randomUUID()}`)
      const child = spawn(missing, [], { stdio })
      // The observer is deliberately the only error listener. An early runner
      // failure must not leave the child error event unhandled.
      const observer = observeCodexNativeChild(child)
      await bounded(observer.closed)
      expect(child.pid).toBeUndefined()
      expect(observer.didFailToSpawn()).toBe(true)
      expect(observer.isStopped()).toBe(true)
      expect(await observer.shutdown(0)).toBe(true)
    })
  }

  test('a failed spawn needs no later close event to establish that no child exists', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined, stdin: null,
      kill: () => { throw new Error('TEST no process can be signalled') },
    })
    const observer = observeCodexNativeChild(child)
    child.emit('error', Object.assign(new Error('TEST spawn failed'), { code: 'ENOENT' }))
    expect(await bounded(observer.closed)).toEqual({ code: null, signal: null })
    expect(observer.didFailToSpawn()).toBe(true)
    expect(await observer.shutdown(0)).toBe(true)
  })

  test('an error from an actual spawned process is not proof of physical shutdown', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', detached: process.platform !== 'win32',
    })
    const observer = observeCodexNativeChild(child)
    try {
      await bounded(new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      }))
      expect(child.pid).toBeGreaterThan(1)
      child.emit('error', new Error('TEST transport failure while the process is still alive'))
      expect(observer.didFailToSpawn()).toBe(false)
      expect(observer.isStopped()).toBe(false)
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
      let observedClose = false
      child.once('close', () => { observedClose = true })
      expect(await observer.shutdown(0)).toBe(true)
      expect(observedClose).toBe(true)
      expect(observer.isStopped()).toBe(true)
      expect(observer.didFailToSpawn()).toBe(false)
    } finally {
      if (!observer.isStopped()) child.kill('SIGKILL')
      await bounded(observer.closed)
    }
  })
})
