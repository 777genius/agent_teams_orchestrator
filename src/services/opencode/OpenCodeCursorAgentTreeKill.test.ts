import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { killCursorAgentTree, nativePorts, query } from './OpenCodeCursorAgentTreeKill.js'

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

test('Windows stale parent PID cannot authorize an older child generation', async () => {
  const f = fixture(); f.ports.platform = 'win32'
  f.ports.birth = async pid => pid === 2 ? 9 : 10
  let taskkills = 0
  f.ports.taskkill = async () => { taskkills += 1 }
  expect((await killCursorAgentTree(f.input, f.ports)).complete).toBe(false)
  expect(taskkills).toBe(0)
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


test('native birth failures retain finite helper evidence before returning null', async () => {
  const module = import.meta.resolve('./OpenCodeCursorAgentTreeKill.ts')
  const script = `
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    import {EventEmitter} from 'node:events'
    const original=await import('node:child_process')
    let mode='exit'
    mock.module('node:child_process',()=>({...original,spawn:()=>{
      const child=Object.assign(new EventEmitter(),{pid:123,stdout:new EventEmitter(),
        kill:()=>{queueMicrotask(()=>child.emit('close',null));return true}})
      if(mode==='exit')queueMicrotask(()=>child.emit('close',7))
      return child
    }}))
    Object.defineProperty(process,'platform',{value:'win32'})
    const {nativePorts}=await import(${JSON.stringify(module)})
    for(mode of ['exit','timeout']) {
      const failures=[]
      const ports=nativePorts({},failure=>failures.push(failure))
      assert.equal(await ports.birth(123,10),null)
      assert.equal(failures.length,1)
      assert.equal(failures[0].operation,'birth')
      assert.equal(failures[0].reason,mode==='exit'?'helper_nonzero':'helper_timeout')
      assert.equal(failures[0].exitCode,mode==='exit'?7:null)
      assert(Number.isFinite(failures[0].elapsedMs)&&failures[0].elapsedMs>=0)
    }
    console.log('TEST actual helper failure retained')
  `
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  expect({exit,stderr}).toEqual({exit:0,stderr:''})
  expect(stdout.trim()).toBe('TEST actual helper failure retained')
},15000)
