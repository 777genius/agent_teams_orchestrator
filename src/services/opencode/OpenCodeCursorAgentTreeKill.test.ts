import { expect, test } from 'bun:test'
import { killCursorAgentTree, nativePorts } from './OpenCodeCursorAgentTreeKill.js'

function fixture() {
  const signals: number[] = []
  let now = 1
  const ports = nativePorts({ platform: 'linux', selfPid: 99, now: () => now,
    birth: async () => 10, tree: async () => [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }],
    signal: pid => { signals.push(pid) }, alive: pid => signals.includes(pid) ? 'gone' : 'alive', sleep: async ms => { now += ms } })
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
test('Windows helper completion is awaited and timeout is incomplete', async () => {
  const f = fixture(); f.ports.platform = 'win32'
  let finish!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.ports.taskkill = async () => { entered(); await new Promise<void>(resolve => { finish = resolve }); throw new Error('helper timeout') }
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
