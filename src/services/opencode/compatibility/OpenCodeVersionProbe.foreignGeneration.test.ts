import { afterEach, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import * as portable from '../../../utils/portableCli.js'
import * as windows from '../../../utils/windowsNativeProcess.js'
import * as native from '../OpenCodeCursorAgentTreeKill.js'
import type { NativeGeneration } from '../OpenCodeCursorAgentTreeKill.js'
import type { OpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { OpenCodeVersionProbeCleanupError, readOpenCodeOwnedVersion, versionAcquisitionMs } from './OpenCodeVersionProbe.js'

const originalPlatform = process.platform
const restore: Array<() => void> = []
afterEach(() => {
  for (const release of restore.splice(0).reverse()) release()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

type Mode = 'valid' | 'no-witness' | 'witness-error' | 'after-root' | 'fresh-missing' | 'fresh-reused'
  | 'confirmation-reused' | 'changed-ppid' | 'confirmation-ppid' | 'root-reused' | 'root-missing'
  | 'root-gone' | 'late-reused' | 'late-missing' | 'final-reused' | 'new-after-root' | 'protected' | 'owned-under-foreign' | 'witness-expired' | 'witness-abort' | 'malformed-witness' | 'late-ppid' | 'witness-hung'
  | 'absent-stable' | 'absent-gone' | 'absent-reused' | 'absent-unknown' | 'absent-unreadable' | 'owned-under-absent' | 'retained-candidate-under-foreign'

function fixture(mode: Mode) {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const root = 7780, relay = 7552, foreign = 7564, leaf = 900_101, sibling = 900_102, extra = 900_103
  const rootBirth = 1792533167851, relayBirth = 1792533167894
  const foreignBirth = mode === 'after-root' ? rootBirth + 10 : 1792532409706
  let spawned = false, closed = false, removed = 0, tables = 0, witnessCalls = 0, foreignReads = 0, rootReads = 0
  let clock = 1_000_000
  const startedAt = clock
  const witnessObservations: Array<{ spawned: boolean; deadline: number; now: number }> = []
  const signals: number[] = [], taskkills: number[] = [], birthReads: number[] = [], budgets: number[] = []
  const events: string[] = []
  const controller = new AbortController()
  let releaseWitness: (() => void) | undefined
  if (mode === 'witness-hung') {
    const original = globalThis.setTimeout
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(
      ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => original(callback, ms === 15000 ? 0 : ms, ...args)) as typeof setTimeout,
      { __promisify__: original.__promisify__ }))
    restore.push(() => timers.mockRestore())
  }
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: root, stdout: new PassThrough() })
  const rows = [
    { pid: mode === 'protected' ? process.pid : leaf, ppid: foreign },
    { pid: foreign, ppid: mode === 'changed-ppid' ? root : relay },
    { pid: sibling, ppid: root }, { pid: relay, ppid: root }, { pid: root, ppid: process.pid },
  ]
  const witness: NativeGeneration[] = [{ pid: foreign, ppid: relay, birth: foreignBirth },
    { pid: extra, ppid: root, birth: foreignBirth - 1 },
    { pid: root, ppid: process.pid, birth: foreignBirth - 2 }]
  const date = spyOn(Date, 'now').mockImplementation(() => clock)
  const launcher = spyOn(portable, 'resolveDirectWindowsLauncher').mockReturnValue({ command: '/TEST/native', argsPrefix: [] })
  const spawn = spyOn(portable, 'spawnPortableCli').mockImplementation(() => {
    spawned = true; events.push('spawn')
    queueMicrotask(() => child.stdout!.emit('data', Buffer.from('1.19.0\n')))
    return child
  })
  const ports = spyOn(native, 'nativePorts').mockImplementation(() => ({
    platform: 'win32', selfPid: process.pid, now: () => clock,
    existingWindows: async deadline => {
      witnessObservations.push({ spawned, deadline, now: clock })
      witnessCalls++; events.push('witness')
      if (mode === 'witness-hung') return await new Promise<null>(resolve => { releaseWitness = () => resolve(null) })
      if (mode === 'witness-error') throw new Error('TEST native witness unavailable')
      if (mode === 'witness-expired') clock = deadline
      if (mode === 'witness-abort') controller.abort()
      if (mode === 'malformed-witness') return [witness[0]!, witness[0]!]
      return mode === 'no-witness' ? null : witness
    },
    birth: async (target, budget) => {
      budgets.push(budget); birthReads.push(target); clock++
      if (target === foreign) {
        foreignReads++
        if (tables >= 4 && (mode === 'absent-gone' || mode === 'absent-unknown' || mode === 'absent-unreadable')) return null
        if (tables >= 4 && mode === 'absent-reused') return foreignBirth + 1
        if (mode === 'fresh-missing' || mode === 'late-missing' && foreignReads >= 3) return null
        if (mode === 'fresh-reused' || mode === 'confirmation-reused' && foreignReads >= 2
          || mode === 'late-reused' && foreignReads >= 3 || mode === 'final-reused' && tables >= 5) return foreignBirth + 1
        return foreignBirth
      }
      if (mode === 'retained-candidate-under-foreign' && target === leaf) return null
      if (target === extra) return foreignBirth - 1
      if (target === root) {
        rootReads++
        if (rootReads > 1 && mode === 'root-reused') return rootBirth + 1
        if (rootReads > 1 && (mode === 'root-missing' || mode === 'root-gone')) return null
        return closed ? null : rootBirth
      }
      return closed && !((mode === 'owned-under-foreign' || mode === 'owned-under-absent') && target === sibling) ? null
        : target === relay ? relayBirth : rootBirth + 100
    },
    tree: async budget => {
      budgets.push(budget); tables++; events.push(`table:${tables}`)
      if (mode === 'retained-candidate-under-foreign') {
        const owned = rows.filter(row => row.pid !== leaf && row.pid !== foreign)
        if (tables === 1) return [...owned, { pid: leaf, ppid: relay }]
        if (tables === 2) return owned
        if (tables <= 5) return rows
      }
      if (tables <= 3) return rows.map(row => ((tables === 2 && mode === 'confirmation-ppid') || (tables >= 3 && mode === 'late-ppid')) && row.pid === foreign
        ? { ...row, ppid: root } : row)
      if (!closed) { closed = true; child.emit('exit', 0); child.emit('close', 0); events.push('close') }
      return [...(mode.startsWith('absent-') || mode === 'owned-under-absent' ? [] : [rows[1]!]), rows[0]!, ...(mode === 'new-after-root' ? [{ pid: extra, ppid: root }] : []),
        ...(mode === 'owned-under-foreign' || mode === 'owned-under-absent' ? [{ pid: sibling, ppid: foreign }] : [])]
    },
    alive: target => mode === 'retained-candidate-under-foreign' && target === leaf && tables <= 2 ? 'gone'
      : target === foreign && tables >= 4 && mode === 'absent-gone' ? 'gone'
      : target === foreign && tables >= 4 && mode === 'absent-unknown' ? 'unknown'
        : target === foreign || target === leaf || target === extra
      || (mode === 'owned-under-foreign' || mode === 'owned-under-absent') && target === sibling ? 'alive'
      : target === root && mode === 'root-gone' && rootReads > 1 ? 'gone'
        : !closed && (target === root || target === relay || target === sibling) ? 'alive' : 'gone',
    signal: target => { signals.push(target); throw new Error('TEST no OS signals') },
    taskkill: async target => { taskkills.push(target); throw new Error('TEST no OS taskkill') },
    sleep: async ms => { clock += ms },
  }))
  restore.push(() => date.mockRestore(), () => launcher.mockRestore(), () => spawn.mockRestore(), () => ports.mockRestore())
  const roots = { root: '/TEST/private', env: {}, remove: async () => { removed++; events.push('remove') } } as OpenCodeV2ReadRoots
  return { run: () => readOpenCodeOwnedVersion('/TEST/native', roots, controller.signal), root, relay, foreign, leaf, sibling,
    signals, taskkills, birthReads, budgets, events, startedAt, witnessObservations, removed: () => removed, witnessCalls: () => witnessCalls,
    releaseWitness: () => releaseWitness?.(), spawned: () => spawned, tables: () => tables, foreignReads: () => foreignReads }
}

function expectPreSpawnWitness(f: ReturnType<typeof fixture>) {
  expect(f.witnessObservations).toHaveLength(1)
  const observation = f.witnessObservations[0]!
  expect(observation.spawned).toBe(false)
  expect(observation.now).toBe(f.startedAt)
  expect(observation.deadline).toBe(f.startedAt + versionAcquisitionMs('win32'))
}

test('pre-spawn589 foreign generation stays alive while the original probe and owned children naturally retire', async () => {
  const f = fixture('valid')
  expect(await f.run()).toBe('1.19.0\n')
  expectPreSpawnWitness(f)
  expect(f.events[0]).toBe('witness'); expect(f.events[1]).toBe('spawn')
  expect(f.witnessCalls()).toBe(1); expect(f.tables()).toBe(5); expect(f.foreignReads()).toBe(5)
  expect(f.birthReads).not.toContain(f.leaf) // No ownership through the excluded edge.
  expect(f.birthReads).toContain(f.relay); expect(f.birthReads).toContain(f.sibling)
  expect(f.signals).toEqual([]); expect(f.taskkills).toEqual([]); expect(f.removed()).toBe(1)
  expect(f.budgets.every(value => value > 0 && value <= 5000)).toBe(true)
  expect(f.events.slice(-3)).toEqual(['close', 'table:5', 'remove'])
})

for (const mode of ['no-witness', 'witness-error', 'after-root', 'fresh-missing', 'fresh-reused', 'confirmation-reused',
  'changed-ppid', 'confirmation-ppid', 'root-reused', 'root-missing', 'root-gone', 'late-reused', 'late-missing',
  'final-reused', 'new-after-root', 'protected', 'malformed-witness', 'late-ppid', 'absent-reused', 'absent-unknown', 'absent-unreadable', 'retained-candidate-under-foreign'] as const) {
  test(`foreign generation ${mode} remains UNKNOWN without signals or root removal`, async () => {
    const f = fixture(mode)
    let failure: unknown
    try { await f.run() } catch (error) { failure = error }
    expectPreSpawnWitness(f)
    expect(failure).toBeInstanceOf(OpenCodeVersionProbeCleanupError)
    if (mode === 'retained-candidate-under-foreign') expect((failure as OpenCodeVersionProbeCleanupError).terminalDiagnostic)
      .toMatchObject({ guard: 'strict_candidate_census', candidatesCount: 1, birthsCount: 3 })
    expect(f.signals).toEqual([]); expect(f.taskkills).toEqual([]); expect(f.removed()).toBe(0)
    expect(f.budgets.every(value => value > 0 && value <= 5000)).toBe(true)
  })
}

for (const mode of ['witness-expired', 'witness-abort', 'witness-hung'] as const) {
  test(`${mode} cannot start a child or retain private roots`, async () => {
    const f = fixture(mode)
    try { await expect(f.run()).rejects.toThrow() } finally { f.releaseWitness() }
    expectPreSpawnWitness(f)
    expect(f.spawned()).toBe(false); expect(f.tables()).toBe(0)
    expect(f.signals).toEqual([]); expect(f.taskkills).toEqual([]); expect(f.removed()).toBe(1)
  })
}

for (const mode of ['absent-stable', 'absent-gone'] as const) {
  test(`${mode} seed grants no branch cut while its foreign orphan stays unowned`, async () => {
    const f = fixture(mode)
    expect(await f.run()).toBe('1.19.0\n')
    expectPreSpawnWitness(f)
    expect(f.tables()).toBe(5); expect(f.foreignReads()).toBe(5)
    expect(f.birthReads).not.toContain(f.leaf)
    expect(f.signals).toEqual([]); expect(f.taskkills).toEqual([]); expect(f.removed()).toBe(1)
  })
}

for (const mode of ['owned-under-foreign', 'owned-under-absent'] as const) {
 test(`${mode}: a previously captured child cannot be pruned through the foreign branch`, async () => {
  const f = fixture(mode)
  await expect(f.run()).rejects.toThrow('cleanup_unknown')
  expectPreSpawnWitness(f)
  expect(f.signals).toEqual([f.sibling]); expect(f.signals).not.toContain(f.foreign)
  expect(f.taskkills).toEqual([]); expect(f.removed()).toBe(0)
 })
}

function nativeWitness(mode: 'valid' | 'unavailable' | 'changed' | 'duplicate' | 'deadline' | 'oversized') {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let clock = 1000, calls = 0
  const reads: number[] = [], a = 900_201, b = 900_202
  const date = spyOn(Date, 'now').mockImplementation(() => clock)
  const kernel = spyOn(windows, 'windowsNativeProcess').mockResolvedValue(mode === 'unavailable' ? null : {
    table: () => {
      calls++
      if (mode === 'oversized') return Array.from({ length: 4097 }, (_, i) => ({ pid: i, ppid: 0 }))
      return [{ pid: 0, ppid: 0 }, { pid: process.pid, ppid: process.ppid }, { pid: a, ppid: 7 },
        { pid: mode === 'duplicate' ? a : b, ppid: 8 }]
    },
    birth: pid => {
      reads.push(pid)
      if (mode === 'deadline') clock = 1020
      return pid === a ? mode === 'changed' && reads.filter(p => p === a).length > 1 ? 11 : 10 : null
    },
  })
  restore.push(() => date.mockRestore(), () => kernel.mockRestore())
  return { run: () => native.nativePorts().existingWindows!(1010), reads, a, calls: () => calls }
}

test('native pre-spawn witness confirms only exact readable live generations without protected reads', async () => {
  const f = nativeWitness('valid')
  expect(await f.run()).toEqual([{ pid: f.a, ppid: 7, birth: 10 }])
  expect(f.calls()).toBe(2); expect(f.reads).toEqual([f.a, 900_202, f.a])
})

test('native-unavailable witness returns null without a PowerShell fallback', async () => {
  const f = nativeWitness('unavailable')
  expect(await f.run()).toBeNull(); expect(f.calls()).toBe(0); expect(f.reads).toEqual([])
})

test('a generation changed during pre-spawn confirmation confers no exclusion', async () => {
  const f = nativeWitness('changed')
  expect(await f.run()).toEqual([])
})

for (const mode of ['duplicate', 'deadline', 'oversized'] as const) {
  test(`native witness ${mode} stops without an unbounded process-query loop`, async () => {
    const f = nativeWitness(mode)
    await expect(f.run()).rejects.toThrow()
    expect(f.calls()).toBe(1)
    expect(f.reads.length).toBeLessThanOrEqual(1)
  })
}
