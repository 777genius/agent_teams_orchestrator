import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { killCursorAgentTree, nativePorts, query } from './OpenCodeCursorAgentTreeKill.js'

function fixture() {
  const signals: number[] = []
  let now = 1
  const ports = nativePorts({ platform: 'linux', selfPid: 99, now: () => now,
    birth: async () => 10, tree: async () => [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }],
    auditIdentity: async pid => `darwin-audit:${pid}`,
    signalExact: async (pid, _birth, _identity, signal = 'SIGKILL') => {
      if (signal === 'SIGKILL') signals.push(pid)
      return true
    }, alive: pid => signals.includes(pid) ? 'gone' : 'alive', sleep: async ms => { now += ms } })
  const input = { pid: 1, expectedBirth: 10, deadline: 100, guard: () => {}, protectedPids: new Set<number>() }
  return { ports, input, signals }
}
test('kills descendants deepest first and waits for absence', async () => {
  const f = fixture()
  expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(true)
  expect(f.signals).toEqual([2, 1])
})
test('refuses self and ancestor trees', async () => {
  for (const selfPid of [1, 2]) {
    const f = fixture(); f.ports.selfPid = selfPid
    expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(false)
    expect(f.signals).toEqual([])
  }
})
test('recycled child prevents all signals', async () => {
  const f = fixture(); let reads = 0
  f.ports.birth = async pid => pid === 2 && ++reads > 1 ? 11 : 10
  expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(false)
  expect(f.signals).toEqual([])
})
test('compromise before signal refuses termination', async () => {
  const f = fixture(); let compromised = false
  f.ports.birth = async () => { compromised = true; return 10 }
  f.input.guard = () => { if (compromised) throw new Error('compromised') }
  expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(false)
  expect(f.signals).toEqual([])
})
test('Windows exact-tree completion is awaited and timeout is incomplete', async () => {
  const f = fixture(); f.ports.platform = 'win32'
  let finish!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.ports.terminateExactTree = async () => { entered(); await new Promise<void>(resolve => { finish = resolve }); return false }
  let settled = false
  const work = killCursorAgentTree(f.input, f.ports).then(result => { settled = true; return result })
  await started
  expect(settled).toBe(false)
  finish()
  expect((await work).complete).toBe(false)
  expect(f.signals).toEqual([])
})

test('replacement between enumeration and first birth read is rejected by ancestry', async () => {
  const f = fixture(); let enumerations = 0
  f.ports.tree = async () => ++enumerations === 1
    ? [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }]
    : [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 77 }]
  f.ports.birth = async pid => pid === 2 ? 11 : 10
  expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(false)
  expect(f.signals).toEqual([])
})

test('a replacement at the destructive boundary has no numeric-PID fallback', async () => {
  const f = fixture()
  let exactCalls = 0
  f.ports.signalExact = async () => { exactCalls += 1; return false }
  expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(false)
  expect(exactCalls).toBe(1)
  // The only production signal slot is identity-bound. A rejected handle
  // receipt must leave the reaper unresolved rather than call process.kill.
  expect(f.signals).toEqual([])
})

test('Windows stale parent PID cannot authorize an older child generation', async () => {
  const f = fixture(); f.ports.platform = 'win32'
  f.ports.birth = async pid => pid === 2 ? 9 : 10
  let taskkills = 0
  f.ports.terminateExactTree = async () => { taskkills += 1; return true }
  expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(false)
  expect(taskkills).toBe(0)
})

test('macOS captures and forwards a distinct per-agent audit identity before every signal', async () => {
  const f = fixture()
  f.ports.platform = 'darwin'
  let scans = 0
  const identities: Array<[number, string | undefined, NodeJS.Signals]> = []
  f.ports.tree = async () => {
    scans += 1
    return [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }]
  }
  let auditReads = 0
  f.ports.auditIdentity = async pid => {
    auditReads += 1
    return `darwin-audit:member-${pid}`
  }
  f.ports.signalExact = async (pid, _birth, identity, signal = 'SIGKILL') => {
    identities.push([pid, identity, signal])
    if (signal === 'SIGKILL') f.signals.push(pid)
    return true
  }
  const result = await killCursorAgentTree({
    ...f.input,
    expectedOsIdentity: 'darwin-audit:member-1',
  }, f.ports)
  expect(result.complete).toBe(true)
  expect(identities.filter(([pid]) => pid === 2).every(([, identity]) => identity === 'darwin-audit:member-2')).toBe(true)
  expect(identities.some(([, identity]) => identity === 'darwin-audit:member-1')).toBe(true)
  expect(auditReads).toBeGreaterThanOrEqual(identities.length)
  expect(scans).toBeGreaterThanOrEqual(4)
})

test('freezes the tree and captures a child spawned during shutdown before completion', async () => {
  const f = fixture()
  let scans = 0
  f.ports.tree = async () => {
    scans += 1
    return scans === 2
      ? [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }, { pid: 3, ppid: 1 }]
      : [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }, ...(scans > 2 ? [{ pid: 3, ppid: 1 }] : [])]
  }
  f.ports.birth = async pid => pid === 3 ? 11 : 10
  const result = await killCursorAgentTree(f.input, f.ports)
  expect(result.complete).toBe(true)
  expect(f.signals).toEqual([2, 3, 1])
})

test('revalidates a newly discovered descendant after identity capture before SIGSTOP', async () => {
  const f = fixture()
  let scans = 0
  const operations: Array<[number, NodeJS.Signals]> = []
  f.ports.tree = async () => {
    scans += 1
    if (scans === 1) return [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }]
    if (scans === 2) return [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }, { pid: 3, ppid: 1 }]
    return [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }, { pid: 3, ppid: 77 }]
  }
  f.ports.signalExact = async (pid, _birth, _identity, signal = 'SIGKILL') => {
    operations.push([pid, signal])
    return true
  }
  const result = await killCursorAgentTree(f.input, f.ports)
  expect(result.complete).toBe(false)
  expect(operations).toEqual([])
  expect(result.diagnostics.join('\n')).toContain('Process ancestry changed around identity capture pid=3')
})

test.each(['post-freeze rescan', 'pre-kill identity check', 'kill failure'] as const)(
  'resumes every exact temporary freeze after %s aborts', async seam => {
    const f = fixture()
    const operations: Array<[number, NodeJS.Signals]> = []
    let stopped = false
    let freezes = 0
    let readsAfterFreeze = 0
    f.ports.signalExact = async (pid, _birth, _identity, signal = 'SIGKILL') => {
      operations.push([pid, signal])
      if (signal === 'SIGSTOP') { stopped = true; freezes += 1 }
      return seam !== 'kill failure' || signal !== 'SIGKILL'
    }
    f.ports.tree = async () => {
      if (seam === 'post-freeze rescan' && freezes === 2) throw new Error('aborted after freeze')
      return [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }]
    }
    f.ports.birth = async pid => {
      if (seam === 'pre-kill identity check' && stopped && pid === 2 && ++readsAfterFreeze > 1) return 11
      return 10
    }
    const result = await killCursorAgentTree(f.input, f.ports)
    expect(result.complete).toBe(false)
    expect(operations.filter(([, signal]) => signal === 'SIGSTOP').map(([pid]) => pid).sort()).toEqual([1, 2])
    // SIGCONT uses the captured identity-bound handle. A PID reused after a
    // stop is not signalled by numeric fallback (the fake port merely records
    // the attempted exact cleanup receipt).
    expect(operations.filter(([, signal]) => signal === 'SIGCONT').map(([pid]) => pid).sort()).toEqual([1, 2])
  },
)

test('resumes a live freeze that a later enumeration drops', async () => {
  const f = fixture()
  const operations: Array<[number, NodeJS.Signals]> = []
  let childFrozen = false
  f.ports.signalExact = async (pid, _birth, _identity, signal = 'SIGKILL') => {
    operations.push([pid, signal])
    if (pid === 2 && signal === 'SIGSTOP') childFrozen = true
    return true
  }
  f.ports.tree = async () => childFrozen
    ? [{ pid: 1, ppid: 0 }]
    : [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }]
  const result = await killCursorAgentTree(f.input, f.ports)
  expect(result.complete).toBe(false)
  expect(operations.filter(([, signal]) => signal === 'SIGCONT').map(([pid]) => pid).sort()).toEqual([1, 2])
  expect(result.diagnostics.join('\n')).toContain('Frozen process dropped from enumeration pid=2')
})

test('rollback resumes exact frozen handles after the work guard expires', async () => {
  const f = fixture()
  const operations: Array<[number, NodeJS.Signals]> = []
  let stopped = false
  f.ports.signalExact = async (pid, _birth, _identity, signal = 'SIGKILL') => {
    operations.push([pid, signal])
    if (signal === 'SIGSTOP') stopped = true
    return true
  }
  f.ports.tree = async () => {
    if (stopped) throw new Error('force rollback after freeze')
    return [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }]
  }
  f.input.guard = () => { if (stopped) throw new Error('work authority expired') }
  const result = await killCursorAgentTree(f.input, f.ports)
  expect(result.complete).toBe(false)
  expect(operations.filter(([, signal]) => signal === 'SIGCONT').map(([pid]) => pid).sort()).toEqual([1, 2])
})

test('Darwin refuses a descendant whose audit identity changes after ancestry capture', async () => {
  const f = fixture()
  f.ports.platform = 'darwin'
  let reads = 0
  f.ports.auditIdentity = async pid => {
    if (pid !== 2) return 'darwin-audit:root'
    return ++reads === 1 ? 'darwin-audit:child-original' : 'darwin-audit:child-reused'
  }
  const result = await killCursorAgentTree({ ...f.input, expectedOsIdentity: 'darwin-audit:root' }, f.ports)
  expect(result.complete).toBe(false)
  expect(f.signals).toEqual([])
  expect(result.diagnostics.join('\n')).toContain('Reused native audit identity pid=2')
})

test.if(process.platform === 'linux')('production Linux tree reaping contains a real post-start child', async () => {
  const source = [
    "const { spawn } = require('node:child_process')",
    "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "process.stdout.write('ready\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const root = spawn(process.execPath, ['-e', source], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const pid = root.pid
  if (!pid) throw new Error('production reaper fixture did not start')
  try {
    await new Promise<void>((resolve, reject) => {
      root.stdout.once('data', () => resolve())
      root.once('error', reject)
      root.once('exit', () => reject(new Error('production reaper fixture exited early')))
    })
    const ports = nativePorts()
    const birth = await ports.birth(pid, 2_000)
    if (!birth) throw new Error('production reaper fixture has no native birth token')
    const result = await killCursorAgentTree({
      pid,
      expectedBirth: birth,
      deadline: Date.now() + 10_000,
      guard: () => {},
      protectedPids: new Set([process.pid]),
    }, ports)
    expect(result.complete).toBe(true)
  } finally {
    try { process.kill(-pid, 'SIGKILL') } catch {}
  }
})

test('failed helper timeout kill retains the operation until helper close', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(),
    kill: () => { child.emit('error', new Error('kill failed')); return false } })
  let settled = false
  const work = query('fake-helper', [], 5, (() => child) as never)
    .then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(settled).toBe(false)
  child.emit('close', 1)
  await work
  expect(settled).toBe(true)
})
