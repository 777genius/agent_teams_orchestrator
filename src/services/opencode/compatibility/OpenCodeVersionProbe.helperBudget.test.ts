import { afterEach, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import * as portable from '../../../utils/portableCli.js'
import * as native from '../OpenCodeCursorAgentTreeKill.js'
import type { NativeHelperFailure } from '../OpenCodeCursorAgentTreeKill.js'
import type { OpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { OpenCodeVersionProbeCleanupError, readOpenCodeOwnedVersion, VERSION_ACQUISITION_MS,
  VERSION_PROBE_DEADLINE_MS } from './OpenCodeVersionProbe.js'

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

test('Windows helper headroom is clipped by the original probe remainder', async () => {
  const f = fixture('win32', [1500], 1, VERSION_PROBE_DEADLINE_MS - 4000)
  expect(await f.run()).toBe('1.18.34\n')
  expect(f.budgets).toEqual([4000])
  expect(f.elapsed()).toBe(VERSION_PROBE_DEADLINE_MS - 2500)
  expect(f.removed()).toBe(1)
})

test('a hung Windows helper exhausts the original remainder without a retirement receipt', async () => {
  const f = fixture('win32', [5000, 5000, 5000, 4000], 5)
  let failure: unknown
  try { await f.run() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(OpenCodeVersionProbeCleanupError)
  expect((failure as OpenCodeVersionProbeCleanupError).message).toBe('cleanup_unknown')
  expect((failure as OpenCodeVersionProbeCleanupError).helperFailure).toMatchObject({ operation: 'tree', reason: 'helper_timeout' })
  expect(f.budgets).toEqual([5000, 5000, 5000, VERSION_PROBE_DEADLINE_MS - 15_075])
  expect(f.elapsed()).toBe(VERSION_PROBE_DEADLINE_MS)
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
    if (ms !== VERSION_ACQUISITION_MS || acquisitionHandle !== undefined) return realSetTimeout(callback, ms, ...args)
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
    // Birth and census together reach the acquisition deadline at a late close.
    birth: async () => { clock += VERSION_ACQUISITION_MS / 2; return null },
    tree: async () => {
      clock += VERSION_ACQUISITION_MS / 2
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

// A real catalog trace captured root -> relay -> leaf, then the leaf vanished
// during its first birth read after the wrapper closed. A tree row alone must
// never become signal authority, nor hide an orphan in the next full census.
function additionFixture(mode: 'gone' | 'alive' | 'unknown' | 'orphan' | 'reused' | 'older' | 'expired' |
  'confirmation-gone' | 'confirmation-live' | 'confirmation-reused' | 'stale-gone' | 'stale-live' |
  'late-orphan' | 'open', platform: NodeJS.Platform = 'win32', reverseRows = false) {
  Object.defineProperty(process, 'platform', { value: platform })
  const root = 900_010, relay = 900_011, leaf = 900_012
  let clock = 1_000_000, removed = 0, trees = 0, closed = false, leafReads = 0
  const signalled: number[] = [], budgets: number[] = [], aliveReads: number[] = []
  const events: Array<'census:rows' | 'census:empty' | 'remove'> = []
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: root, stdout: new PassThrough() })
  const rows = [{ pid: root, ppid: process.pid }, { pid: relay, ppid: root },
    { pid: leaf, ppid: platform === 'darwin' ? 1 : relay }]
  const readRows = (budget: number) => {
    budgets.push(budget)
    trees++
    if (trees === 1) return reverseRows ? [...rows].reverse() : rows
    if (trees === 2 && (mode === 'orphan' || mode === 'late-orphan')) return mode === 'orphan' ? [{ pid: 900_013, ppid: leaf }] : []
    if (trees === 2 && mode === 'reused') return [{ pid: leaf, ppid: 900_099 }]
    if (trees === 2 && (mode === 'confirmation-reused' || mode.startsWith('stale-'))) return rows
    if (trees === 4 && mode === 'late-orphan') return [{ pid: 900_013, ppid: leaf }]
    return []
  }
  const date = spyOn(Date, 'now').mockImplementation(() => clock)
  const launcher = spyOn(portable, 'resolveDirectWindowsLauncher').mockReturnValue({ command: '/TEST/native', argsPrefix: [] })
  const spawn = spyOn(portable, 'spawnPortableCli').mockImplementation(() => {
    queueMicrotask(() => child.stdout!.emit('data', Buffer.from('1.19.0\n')))
    return child
  })
  const ports = spyOn(native, 'nativePorts').mockImplementation(() => ({
    platform, selfPid: process.pid, now: () => clock,
    birth: async (target, budget) => {
      budgets.push(budget)
      clock += 10
      if (target === leaf) {
        leafReads++
        if (leafReads === 1 && mode !== 'open') {
          child.emit('exit', 0); child.emit('close', 0); closed = true
        }
        if (mode === 'expired') clock += VERSION_PROBE_DEADLINE_MS
        if (mode === 'older') return 5
        if (mode.startsWith('confirmation-')) return leafReads === 1 ? 30 : mode === 'confirmation-reused' ? 31 : null
        if (mode.startsWith('stale-')) return leafReads === 1 ? 30 : null
        return null
      }
      return closed ? null : target === root ? 10 : 20
    },
    tree: async budget => readRows(budget),
    alive: target => {
      aliveReads.push(target)
      return target === leaf && (mode === 'alive' || mode === 'confirmation-live' || mode === 'confirmation-reused' || mode === 'stale-live') ? 'alive'
        : target === leaf && mode === 'unknown' ? 'unknown' : 'gone'
    },
    signal: target => { signalled.push(target); throw new Error('TEST must not signal uncaptured candidate') },
    taskkill: async () => { throw new Error('TEST must not kill uncaptured candidate') },
    sleep: async ms => { clock += ms },
  }))
  restore.push(() => date.mockRestore(), () => launcher.mockRestore(), () => spawn.mockRestore(), () => ports.mockRestore())
  if (platform === 'darwin') {
    const posix = spyOn(native, 'query').mockImplementation(async (command, args, budget) => {
      expect(command).toBe('ps')
      expect(args).toEqual(['-e', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat='])
      const census = readRows(budget)
      events.push(census.length ? 'census:rows' : 'census:empty')
      return census.map(row => `${row.pid} ${row.ppid} ${root} S`).join('\n')
    })
    restore.push(() => posix.mockRestore())
  }
  const roots = { root: '/TEST/private', env: {}, remove: async () => { events.push('remove'); removed++ } } as OpenCodeV2ReadRoots
  return { run: () => readOpenCodeOwnedVersion('/TEST/native', roots), removed: () => removed,
    trees: () => trees, leafReads: () => leafReads, signalled, budgets, aliveReads, events, leaf }
}

for (const mode of ['gone', 'confirmation-gone', 'stale-gone'] as const) {
  test(`Windows ${mode} snapshot addition retires only after independent absence and fresh full tables`, async () => {
    const f = additionFixture(mode)
    expect(await f.run()).toBe('1.19.0\n')
    expect(f.aliveReads).toContain(f.leaf)
    expect(f.trees()).toBeGreaterThanOrEqual(4)
    expect(f.removed()).toBe(1)
    expect(f.signalled).toEqual([])
    expect(f.budgets.every(budget => budget > 0 && budget <= 5000)).toBe(true)
    if (mode === 'stale-gone') expect(f.leafReads()).toBe(2)
  })
}

for (const mode of ['alive', 'unknown', 'orphan', 'reused', 'older', 'expired',
  'confirmation-live', 'confirmation-reused', 'stale-live', 'late-orphan', 'open'] as const) {
  test(`Windows ${mode} snapshot addition remains unknown without deleting private roots or signalling candidates`, async () => {
    const f = additionFixture(mode)
    await expect(f.run()).rejects.toThrow('cleanup_unknown')
    expect(f.removed()).toBe(0)
    expect(f.signalled).toEqual([])
    if (mode === 'stale-live') expect(f.leafReads()).toBe(2)
  })
}

test('darwin gone group member with reparented PPID requires absence and final census before retirement', async () => {
  const f = additionFixture('gone', 'darwin')
  expect(await f.run()).toBe('1.19.0\n')
  expect(f.leafReads()).toBe(1)
  expect(f.aliveReads).toContain(f.leaf)
  expect(f.trees()).toBeGreaterThanOrEqual(4)
  expect(f.removed()).toBe(1)
  expect(f.signalled).toEqual([])
  expect(f.budgets.every(budget => budget > 0 && budget <= 2000)).toBe(true)
  expect(f.events.slice(-2)).toEqual(['census:empty', 'remove'])
})

// The wrapper can close before the first birth helper completes while WMI still
// returns its old tree. These rows must never confer birth or signal authority.
function unanchoredFixture(mode: 'gone' | 'alive' | 'unknown' | 'orphan' | 'reused' | 'persistent' | 'final-reappeared' | 'absence-before-close' | 'root-reused' | 'protected' | 'unsuccessful', captured = false) {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const root = 900_020, relay = 900_021, leaf = 900_022, orphan = 900_023, grandchild = 900_024
  let clock = 1_000_000, removed = 0, trees = 0, births = 0
  const budgets: number[] = [], signals: number[] = [], taskkills: number[] = [], aliveReads: number[] = []
  const events: string[] = []
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: root, stdout: new PassThrough() })
  const initialRows = [{ pid: root, ppid: process.pid }, { pid: relay, ppid: root }, { pid: mode === 'protected' ? process.pid : leaf, ppid: relay }]
  const date = spyOn(Date, 'now').mockImplementation(() => clock)
  const launcher = spyOn(portable, 'resolveDirectWindowsLauncher').mockReturnValue({ command: '/TEST/native', argsPrefix: [] })
  const spawn = spyOn(portable, 'spawnPortableCli').mockImplementation(() => {
    queueMicrotask(() => {
      child.stdout!.emit('data', Buffer.from('1.19.0\n'))
      const exitCode = mode === 'unsuccessful' ? 1 : 0
      child.emit('exit', exitCode)
      if (mode !== 'absence-before-close') child.emit('close', exitCode)
    })
    return child
  })
  const ports = spyOn(native, 'nativePorts').mockImplementation(() => ({
    platform: 'win32', selfPid: process.pid, now: () => clock,
    birth: async (_target, budget) => { births++; budgets.push(budget); clock += 350; return captured && births === 1 ? 10 : null },
    tree: async budget => {
      budgets.push(budget); trees++
      let rows = trees === 1 || mode === 'persistent' ? initialRows : []
      if (trees === 2 && mode === 'orphan') rows = [{ pid: grandchild, ppid: orphan }, { pid: orphan, ppid: leaf }]
      if (trees === 2 && mode === 'reused') rows = [{ pid: leaf, ppid: 900_099 }]
      if (trees === 2 && mode === 'root-reused') rows = [{ pid: root, ppid: 900_099 }]
      if (trees === 3 && mode === 'final-reappeared') rows = [{ pid: orphan, ppid: leaf }]
      events.push(rows.length ? 'census:rows' : 'census:empty')
      return rows
    },
    alive: target => {
      aliveReads.push(target)
      if ((mode === 'alive' && target === leaf) || (mode === 'orphan' && target === grandchild) ||
        (mode === 'reused' && trees === 2 && target === leaf) ||
        (mode === 'root-reused' && trees === 2 && target === root)) return 'alive'
      return mode === 'unknown' && target === leaf ? 'unknown' : 'gone'
    },
    signal: target => { signals.push(target) },
    taskkill: async target => { taskkills.push(target); throw new Error('TEST unowned process kill') },
    sleep: async ms => {
      clock += ms
      if (mode === 'absence-before-close' && trees === 2) {
        expect(removed).toBe(0)
        events.push('close'); child.emit('close', 0)
      }
    },
  }))
  restore.push(() => date.mockRestore(), () => launcher.mockRestore(), () => spawn.mockRestore(), () => ports.mockRestore())
  const roots = { root: '/TEST/private', env: {}, remove: async () => { events.push('remove'); removed++ } } as OpenCodeV2ReadRoots
  return { run: () => readOpenCodeOwnedVersion('/TEST/native', roots), removed: () => removed,
    trees: () => trees, births: () => births, elapsed: () => clock - 1_000_000,
    budgets, signals, taskkills, aliveReads, events, root, relay, leaf, orphan, grandchild }
}

test('Windows unanchored gone rows require independent gone checks, raw absence and strict final census', async () => {
  const f = unanchoredFixture('gone')
  expect(await f.run()).toBe('1.19.0\n')
  expect(f.aliveReads).toEqual([f.root, f.relay, f.leaf])
  expect(f.events).toEqual(['census:rows', 'census:empty', 'census:empty', 'remove'])
  expect(f.births()).toBe(1)
  expect(f.signals).toEqual([])
  expect(f.taskkills).toEqual([])
  expect(f.budgets).toEqual([5000, 5000, 5000, 5000])
  expect(f.removed()).toBe(1)
})

test('Windows unanchored census absence waits for child close before strict final census and removal', async () => {
  const f = unanchoredFixture('absence-before-close')
  expect(await f.run()).toBe('1.19.0\n')
  expect(f.events).toEqual(['census:rows', 'census:empty', 'close', 'census:empty', 'census:empty', 'remove'])
  expect(f.births()).toBe(1)
  expect(f.signals).toEqual([])
  expect(f.taskkills).toEqual([])
  expect(f.removed()).toBe(1)
})

for (const mode of ['alive', 'unknown', 'orphan', 'reused', 'persistent', 'final-reappeared'] as const) {
  test(`Windows unanchored ${mode} census cannot retire or signal numeric candidates`, async () => {
    const f = unanchoredFixture(mode)
    await expect(f.run()).rejects.toThrow('cleanup_unknown')
    expect(f.removed()).toBe(0)
    expect(f.signals).toEqual([])
    expect(f.taskkills).toEqual([])
    expect(f.births()).toBe(1)
    expect(f.aliveReads).toContain(f.leaf)
    expect(f.budgets.every(budget => budget > 0 && budget <= 5000)).toBe(true)
    if (mode === 'orphan') { expect(f.trees()).toBe(2); expect(f.aliveReads).toContain(f.grandchild) }
    if (mode === 'reused') expect(f.trees()).toBe(2)
    if (mode === 'final-reappeared') expect(f.trees()).toBe(3)
    if (mode === 'persistent') expect(f.elapsed()).toBe(VERSION_PROBE_DEADLINE_MS)
  })
}

// Actual Windows trace: captured owner exited0/closed, birth lookup then found
// it gone, but WMI still included that owner and two already-gone descendants.
test('Windows captured successful owner waits out stale gone descendants without acquiring signal authority', async () => {
  const f = unanchoredFixture('gone', true)
  expect(await f.run()).toBe('1.19.0\n')
  expect(f.births()).toBe(2)
  for (const target of [f.root, f.relay, f.leaf]) expect(f.aliveReads).toContain(target)
  expect(f.events).toEqual(['census:rows', 'census:empty', 'census:empty', 'remove'])
  expect(f.signals).toEqual([])
  expect(f.taskkills).toEqual([])
  expect(f.budgets.every(budget => budget > 0 && budget <= 5000)).toBe(true)
  expect(f.removed()).toBe(1)
})

for (const mode of ['root-reused', 'protected', 'absence-before-close', 'unsuccessful'] as const) {
  test(`Windows captured ${mode} owner cannot use stale-census waiting to retire or signal`, async () => {
    const f = unanchoredFixture(mode, true)
    await expect(f.run()).rejects.toThrow('cleanup_unknown')
    expect(f.removed()).toBe(0)
    expect(f.signals).toEqual([])
    expect(f.taskkills).toEqual([])
    expect(f.births()).toBe(2)
    if (mode === 'root-reused') {
      expect(f.trees()).toBe(2)
      expect(f.aliveReads).toContain(f.root)
    }
  })
}

// Native Windows process tables need not list a parent before its child.
test('Windows reverse census acquires parent births before a valid descendant and still proves retirement', async () => {
  const f = additionFixture('confirmation-gone', 'win32', true)
  expect(await f.run()).toBe('1.19.0\n')
  expect(f.leafReads()).toBe(1)
  expect(f.aliveReads).toContain(f.leaf)
  expect(f.trees()).toBeGreaterThanOrEqual(4)
  expect(f.removed()).toBe(1)
  expect(f.signalled).toEqual([])
  expect(f.budgets.every(budget => budget > 0 && budget <= 5000)).toBe(true)
})

test('Windows reverse census still refuses a child born before its captured parent', async () => {
  const f = additionFixture('older', 'win32', true)
  let failure: unknown
  try { await f.run() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(OpenCodeVersionProbeCleanupError)
  expect((failure as OpenCodeVersionProbeCleanupError).terminalDiagnostic).toMatchObject({
    phase: 'addition_identity', guard: 'parent_identity', birthsCount: 2,
  })
  expect(f.removed()).toBe(0)
  expect(f.signalled).toEqual([])
})
