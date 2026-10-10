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

function fixture(platform: NodeJS.Platform, durations: number[], closeAt = 1) {
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
    return { platform, selfPid: process.pid, now: () => clock, birth: async () => null,
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
  const f = fixture('win32', [4000, 1000], 2)
  expect(await f.run()).toBe('1.18.34\n')
  expect(f.budgets).toEqual([5000, 3975])
  expect(f.elapsed()).toBe(5025)
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
