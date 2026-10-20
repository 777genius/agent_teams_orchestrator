import { expect, test } from 'bun:test'
import path from 'node:path'
import { types } from 'node:util'
import { pathToFileURL } from 'node:url'
import { verifyOpenCodeV2ServerGraph } from '../OpenCodeV2ServerGraph.js'
import { readWindowsRealpathFailure, retainWindowsRealpathFailure } from './OpenCodeV2WindowsRealpath.js'

// Execute the actual private resolver and observer with the selected Effect.
// Only filesystem failure injection is substituted; no command is spawned.
async function resolver() {
  const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
  const effect: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const source = await Bun.file(path.join(import.meta.dir, 'OpenCodeV2WindowsRuntime.ts')).text()
  const transpile = (value: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(value).replace(/^export /gm, '')
  const observer = source.slice(source.indexOf('export const windowsCommandResolvePhases'), source.indexOf('\nfunction requireValue'))
  const diagnostics = new Function('types', 'retainWindowsRealpathFailure', transpile(observer) +
    ';return {retainCommandResolveFailure,readWindowsCommandResolveFailure}')(types, retainWindowsRealpathFailure)
  const body = source.slice(source.indexOf('let resolutionPhase:'), source.indexOf('\n    let retired:'))
  const run = new Function('Effect', 'PlatformError', 'filesystem', 'stat', 'path', 'command', 'retainCommandResolveFailure',
    `const baseline={PATH:'C:\\Windows\\System32'};const streamInput=undefined;
     const commandEnvironment=value=>value;
     const requireValue=value=>{if(!value)throw new Error('execution_windows_runtime_invalid')};
     const error=method=>PlatformError.systemError({_tag:'Unknown',module:'ChildProcess',method,description:'Windows owned command operation failed'});
     return Effect.gen(${transpile('function* resolve(){' + body + ';return input}').replace(/^function\* resolve/, 'function*')});`)
  return { effect, read: diagnostics.readWindowsCommandResolveFailure,
    async fail(original: unknown, atCwd = false) {
      const filesystem = { realpath: async (input: string) => {
        if (atCwd || input.endsWith('cmd.exe')) throw original
        return input
      } }
      const command = { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'TEST'], options: { cwd: 'C:\\TEST-project' } }
      const exit = await effect.Effect.runPromiseExit(run(effect.Effect, effect.PlatformError, filesystem,
        async () => ({ isDirectory: () => true, isFile: () => true }), path.win32, command, diagnostics.retainCommandResolveFailure))
      if (!effect.Exit.isFailure(exit) || exit.cause.reasons[0]?._tag !== 'Fail') throw new Error('TEST_expected_resolve_refusal')
      return exit.cause.reasons[0].error as ReturnType<typeof effect.PlatformError.systemError>
    } }
}

test('actual resolver keeps concurrent refusal phases private on the same normalized errors', async () => {
  const fixture = await resolver()
  const original = Object.assign(new Error('TEST-private-path'), { code: 'EPERM', syscall: 'realpath', path: 'TEST-private' })
  const [executable, cwd] = await Promise.all([fixture.fail(original), fixture.fail(original, true)])
  expect(fixture.read(executable)).toEqual({ phase: 'executable-realpath', errno: 'EPERM', operation: 'realpath' })
  expect(fixture.read(cwd)).toEqual({ phase: 'cwd-realpath', errno: 'EPERM', operation: 'realpath' })
  expect(executable).not.toBe(cwd)
  expect(executable.message).toBe('Unknown: ChildProcess.resolve: Windows owned command operation failed')
  expect(Object.getOwnPropertyDescriptor(executable.reason, 'cause')?.value).toBeUndefined()
  expect(fixture.read(original)).toBeUndefined()
  expect(fixture.read(Object.assign({}, executable))).toBeUndefined()
})

test('resolve observation ignores hostile metadata and public native-fact forgeries', async () => {
  const fixture = await resolver()
  let reads = 0
  const original = Object.assign(new Error('TEST-private'), { realpath: { status: 1, operation: 19, win32: 5, anchorCount: 1, matchingAnchorIndex: -1 } })
  Object.defineProperty(original, 'code', { get() { reads++; throw new Error('TEST_getter') } })
  const failure = await fixture.fail(original)
  expect(fixture.read(failure)).toEqual({ phase: 'executable-realpath' })
  expect(readWindowsRealpathFailure(failure)).toBeUndefined()
  expect(reads).toBe(0)
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { reads++; throw new Error('TEST_proxy') } })
  const proxied = await fixture.fail(proxy)
  expect(fixture.read(proxied)).toEqual({ phase: 'executable-realpath' })
  expect(reads).toBe(0)
  expect(Object.getOwnPropertyDescriptor(proxied.reason, 'cause')?.value).toBeUndefined()
})
