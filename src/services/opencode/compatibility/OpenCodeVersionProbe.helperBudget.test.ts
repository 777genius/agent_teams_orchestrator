import { afterEach, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import * as portable from '../../../utils/portableCli.js'
import * as native from '../OpenCodeCursorAgentTreeKill.js'
import type { NativeHelperFailure } from '../OpenCodeCursorAgentTreeKill.js'
import type { OpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { OpenCodeVersionProbeCleanupError, readOpenCodeOwnedVersion } from './OpenCodeVersionProbe.js'

const originalPlatform = process.platform
const restore: Array<() => void> = []
afterEach(() => {
  for (const release of restore.splice(0).reverse()) release()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

function fixture(platform: NodeJS.Platform, durations: number[], closeAt = 1, initialBirthMs = 0) {
  Object.defineProperty(process, 'platform', { value: platform })
  let clock = 1_000_000, removed = 0, calls = 0
  const budgets: number[] = []
  let reportFailure: ((failure: NativeHelperFailure) => void) | undefined
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: 900_001, stdout: new PassThrough() })
  const close = () => { child.emit('exit', 0); child.emit('close', 0) }
  const query = async (budget: number) => {
    budgets.push(budget)
    const duration = durations[calls++] ?? 0
    if (duration > budget) {
      clock += budget
      reportFailure?.({ operation: 'tree', reason: 'helper_timeout', exitCode: null, elapsedMs: budget })
      throw new Error('Native helper timed out')
    }
    clock += duration
    if (calls >= closeAt) close()
    return []
  }
  const date = spyOn(Date, 'now').mockImplementation(() => clock)
  const launcher = spyOn(portable, 'resolveDirectWindowsLauncher').mockReturnValue({ command: '/TEST/native', argsPrefix: [] })
  const spawn = spyOn(portable, 'spawnPortableCli').mockImplementation(() => {
    queueMicrotask(() => child.stdout!.emit('data', Buffer.from('1.18.34\n')))
    return child
  })
  const ports = spyOn(native, 'nativePorts').mockImplementation((_overrides, onFailure) => {
    reportFailure = onFailure
    return { platform, selfPid: process.pid, now: () => clock, birth: async () => {
        clock += initialBirthMs
        if (initialBirthMs) close()
        return null
      },
      tree: query, signal: () => { throw new Error('TEST unowned process signal') },
      alive: () => 'gone', taskkill: async () => { throw new Error('TEST unowned process kill') },
      sleep: async ms => { clock += ms } }
  })
  const posix = spyOn(native, 'query').mockImplementation(async (_command, _args, budget) => {
    await query(budget)
    return ''
  })
  restore.push(() => date.mockRestore(), () => launcher.mockRestore(), () => spawn.mockRestore(),
    () => ports.mockRestore(), () => posix.mockRestore())
  const roots = { root: '/TEST/private', env: {}, remove: async () => { removed++ } } as OpenCodeV2ReadRoots
  return { run: () => readOpenCodeOwnedVersion('/TEST/native', roots), budgets,
    removed: () => removed, elapsed: () => clock - 1_000_000 }
}

test('Windows cold process-table read beyond two seconds still requires physical close', async () => {
  const f = fixture('win32', [2200])
  expect(await f.run()).toBe('1.18.34\n')
  expect(f.budgets[0]).toBeGreaterThanOrEqual(2200)
  expect(f.budgets[0]).toBeLessThanOrEqual(5000)
  expect(f.removed()).toBe(1)
})

test('Windows helper headroom is clipped by the original eight-second probe remainder', async () => {
  const f = fixture('win32', [1500], 1, 4000)
  expect(await f.run()).toBe('1.18.34\n')
  expect(f.budgets).toEqual([4000])
  expect(f.elapsed()).toBe(5500)
  expect(f.removed()).toBe(1)
})

test('a hung Windows helper exhausts the original remainder without a retirement receipt', async () => {
  const f = fixture('win32', [5000, 4000], 2)
  let failure: unknown
  try { await f.run() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(OpenCodeVersionProbeCleanupError)
  expect((failure as OpenCodeVersionProbeCleanupError).message).toBe('cleanup_unknown')
  expect((failure as OpenCodeVersionProbeCleanupError).helperFailure).toMatchObject({ operation: 'tree', reason: 'helper_timeout' })
  expect(f.budgets).toEqual([5000, 2975])
  expect(f.elapsed()).toBe(8000)
  expect(f.removed()).toBe(0)
})

test('POSIX process-table helpers keep their two-second cap', async () => {
  const f = fixture('linux', [1000])
  expect(await f.run()).toBe('1.18.34\n')
  expect(f.budgets).toEqual([2000])
  expect(f.removed()).toBe(1)
})

function acquisitionFixture(mode: 'closed' | 'open' | 'exit-only' | 'late-close' | 'abort') {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let clock = 1_000_000, removed = 0, acquisitionActive = false
  let fireAcquisition: (() => void) | undefined
  let acquisitionHandle: ReturnType<typeof setTimeout> | undefined
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
  const controller = new AbortController()
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: 900_002, stdout: new PassThrough() })
  const close = () => { child.emit('exit', 0); child.emit('close', 0) }
  const date = spyOn(Date, 'now').mockImplementation(() => clock)
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign((...[callback, ms, ...args]: Parameters<typeof setTimeout>) => {
    if (ms !== 5000 || acquisitionHandle !== undefined) return realSetTimeout(callback, ms, ...args)
    acquisitionActive = true
    fireAcquisition = () => { if (acquisitionActive) callback(...args) }
    acquisitionHandle = realSetTimeout(() => undefined, 60_000)
    return acquisitionHandle
  }, { __promisify__: realSetTimeout.__promisify__ }))
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
    if (handle === acquisitionHandle) acquisitionActive = false
    realClearTimeout(handle)
  })
  const launcher = spyOn(portable, 'resolveDirectWindowsLauncher').mockReturnValue({ command: '/TEST/native', argsPrefix: [] })
  const spawn = spyOn(portable, 'spawnPortableCli').mockImplementation(() => {
    queueMicrotask(() => {
      child.stdout!.emit('data', Buffer.from('1.18.34\n'))
      if (mode === 'closed' || mode === 'abort') close()
      if (mode === 'exit-only') child.emit('exit', 0)
    })
    return child
  })
  const ports = spyOn(native, 'nativePorts').mockImplementation(() => ({
    platform: 'win32', selfPid: process.pid, now: () => clock,
    birth: async () => { clock += 3000; return null },
    tree: async () => {
      clock += 3000
      // Exercise the acquisition callback while a successful OS cleanup read
      // is still outstanding; advancing Date.now alone cannot catch this race.
      if (mode !== 'late-close') fireAcquisition!()
      if (mode === 'open' || mode === 'exit-only' || mode === 'late-close') close()
      if (mode === 'abort') controller.abort()
      return []
    },
    signal: () => { throw new Error('TEST unowned process signal') },
    alive: () => 'gone', taskkill: async () => { throw new Error('TEST unowned process kill') },
    sleep: async ms => { clock += ms },
  }))
  restore.push(() => date.mockRestore(), () => timers.mockRestore(), () => clear.mockRestore(),
    () => launcher.mockRestore(), () => spawn.mockRestore(), () => ports.mockRestore())
  const roots = { root: '/TEST/private', env: {}, remove: async () => { removed++ } } as OpenCodeV2ReadRoots
  return { run: () => readOpenCodeOwnedVersion('/TEST/native', roots, controller.signal), removed: () => removed }
}

test('observed version child close ends acquisition while bounded Windows cleanup continues', async () => {
  const f = acquisitionFixture('closed')
  expect(await f.run()).toBe('1.18.34\n')
  expect(f.removed()).toBe(1)
})

for (const mode of ['open', 'exit-only', 'late-close', 'abort'] as const) {
  test(`version acquisition still refuses ${mode} despite eventual physical retirement`, async () => {
    const f = acquisitionFixture(mode)
    await expect(f.run()).rejects.toThrow('selection_unavailable')
    expect(f.removed()).toBe(1)
  })
}
