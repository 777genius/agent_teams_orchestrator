import { expect, spyOn, test } from 'bun:test'
import filesystem, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { readWindowsRealpathFailure, retainWindowsRealpathFailure } from './OpenCodeV2WindowsRealpath.js'

for (const pin of ['2.0.0', '2.0.32'] as const)
test(`selected ${pin} filesystem replacement reaches direct and transitive consumers without changing refusal semantics`, async () => {
  const directory = path.dirname(Bun.resolveSync(pin === '2.0.0' ? '@opencode/server-v2-floor/options' : '@opencode/server/options', import.meta.dir))
  const load = <T>(specifier: string): Promise<T> => import(pathToFileURL(Bun.resolveSync(specifier, directory)).href)
  const effect = await load<typeof import('effect')>('effect')
  const { Effect, Layer, FileSystem, Exit, PlatformError } = effect
  const platform = await load<typeof import('@opencode/util/effect/app-node-platform')>('@opencode/util/effect/app-node-platform')
  const nodes = await load<typeof import('@opencode/util/effect/layer-node')>('@opencode/util/effect/layer-node')
  const { FSUtil } = await load<typeof import('@opencode/util/fs-util')>('@opencode/util/fs-util')
  const source = await readFile(new URL('./OpenCodeV2WindowsRuntime.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('const filesystemNode ='), source.indexOf('\n  const error ='))
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(block)
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-windows-selected-fs-'))
  const input = path.join(root, 'project.txt'), outside = path.join(root, 'outside.txt'), missing = path.join(root, 'TEST-absent')
  await writeFile(input, 'TEST-physical-project'); await writeFile(outside, 'TEST-physical-outside')
  const nativeRealpath = filesystem.realpath.bind(filesystem)
  const originalCause = Object.assign(new Error('TEST-original-callback-refusal'), { code: 'EPERM' })
  let refusal = effect.PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method: 'realPath', pathOrDescriptor: input, cause: originalCause })
  let defect = false, original: import('effect').FileSystem.FileSystem | undefined
  // The selected official Node filesystem reads the real TEST object first.
  // Only its callback permission result is simulated; the promise port remains
  // the real OS filesystem and the production replacement expression is used.
  const simulated = platform.filesystem.mapLayer(layer => Layer.effect(FileSystem.FileSystem, Effect.gen(function* () {
    const native = yield* FileSystem.FileSystem
    original = { ...native, realPath: target => (target === missing ? Effect.void : native.realPath(target)).pipe(Effect.flatMap(() => defect ? Effect.die(refusal) : Effect.fail(refusal))) }
    return original
  })).pipe(Layer.provide(layer)))
  const filesystemNode: typeof platform.filesystem = new Function('platform', 'Effect', 'Layer', 'FileSystem', 'PlatformError', 'filesystem', 'types', 'retainWindowsRealpathFailure', 'readWindowsRealpathFailure', `${body};return filesystemNode;`)(
    { filesystem: simulated }, Effect, Layer, FileSystem, PlatformError, filesystem, types, retainWindowsRealpathFailure, readWindowsRealpathFailure)
  const selected = nodes.compile(nodes.group([platform.filesystem, FSUtil.node]), {
    replacements: [platform.filesystem.replace(filesystemNode)],
  })
  const calls: string[] = []
  const promise = spyOn(filesystem, 'realpath').mockImplementation(async target => {
    calls.push(String(target))
    if (target !== input && target !== missing) throw Object.assign(new Error('TEST-outside-refusal'), { code: 'EPERM' })
    return nativeRealpath(target)
  })
  const assertOriginal = (exit: import('effect').Exit.Exit<unknown, unknown>, kind: 'Fail' | 'Die' = 'Fail') => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const reason = exit.cause.reasons[0]
    expect(reason?._tag).toBe(kind)
    if (reason?._tag === 'Fail') expect(reason.error).toBe(refusal)
    if (reason?._tag === 'Die') expect(reason.defect).toBe(refusal)
  }
  try {
    const services = await Effect.runPromise(Effect.gen(function* () {
      return { direct: yield* FileSystem.FileSystem, indirect: yield* FSUtil.Service }
    }).pipe(Effect.provide(selected)))
    expect(original).toBeDefined()
    for (const key of Reflect.ownKeys(original!)) if (key !== 'realPath')
      expect(Reflect.get(services.direct, key)).toBe(Reflect.get(original!, key))
    expect(await Effect.runPromise(services.direct.realPath(input))).toBe(await nativeRealpath(input))
    expect(await Effect.runPromise(services.indirect.resolve(input))).toBe(await nativeRealpath(input))
    expect(calls).toEqual([input, input])
    const absent = await Effect.runPromiseExit(services.direct.realPath(missing))
    expect(Exit.isFailure(absent)).toBe(true)
    if (Exit.isFailure(absent)) {
      const reason = absent.cause.reasons[0]
      expect(reason?._tag).toBe('Fail')
      if (reason?._tag === 'Fail') expect(reason.error).toMatchObject({ _tag: 'PlatformError', reason: { _tag: 'NotFound', module: 'FileSystem', method: 'realPath' } })
    }
    expect(await Effect.runPromise(services.indirect.resolve(missing))).toBe(missing)
    const eperm = refusal
    refusal = effect.PlatformError.systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'realPath',
      cause: Object.assign(new Error('TEST-callback-EACCES'), { code: 'EACCES' }) })
    expect(await Effect.runPromise(services.direct.realPath(input))).toBe(await nativeRealpath(input))
    refusal = eperm
    const failed = await Effect.runPromiseExit(services.direct.realPath(outside))
    assertOriginal(failed)
    expect(calls.at(-1)).toBe(outside)
    let conversionGetterCalls = 0
    const codeGetter = Object.defineProperty(new Error('TEST-forged-missing'), 'code', { get() { conversionGetterCalls++; throw new Error('TEST-code-getter') } })
    for (const failure of [{ code: 'ENOENT' }, codeGetter, new Proxy(Object.assign(new Error('TEST-proxy'), { code: 'ENOENT' }), {
      getOwnPropertyDescriptor() { conversionGetterCalls++; throw new Error('TEST-proxy-trap') },
    })]) {
      promise.mockRejectedValue(failure)
      assertOriginal(await Effect.runPromiseExit(services.direct.realPath(input)))
    }
    expect(conversionGetterCalls).toBe(0)
    // Changing/uninstalling the live promise surface affects an existing layer;
    // neither a successful path nor the installed wrapper is cached by it.
    promise.mockRejectedValue(Object.assign(new Error('TEST-uninstalled'), { code: 'EPERM' }))
    let exit = await Effect.runPromiseExit(services.direct.realPath(input))
    assertOriginal(exit)
    const originalRefusal = refusal
    let getterCalls = 0
    const forbidden = () => { getterCalls++; throw new Error('TEST-getter') }
    for (const next of [effect.PlatformError.systemError({ _tag: 'NotFound', module: 'FileSystem', method: 'realPath' }),
      effect.PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method: 'realPath' }),
      effect.PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method: 'realPath', cause: Object.defineProperty({}, 'code', { get: forbidden }) }),
      effect.PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method: 'realPath', cause: new Proxy({}, { getOwnPropertyDescriptor: forbidden }) })]) {
      refusal = next; promise.mockClear()
      exit = await Effect.runPromiseExit(services.direct.realPath(input))
      assertOriginal(exit)
      expect(promise).not.toHaveBeenCalled()
    }
    refusal = originalRefusal; defect = true; promise.mockClear()
    exit = await Effect.runPromiseExit(services.direct.realPath(input))
    assertOriginal(exit, 'Die')
    expect(promise).not.toHaveBeenCalled(); expect(getterCalls).toBe(0)
  } finally { promise.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

test('Bun captured callback namespace ignores a later installation while the default promise surface stays live', async () => {
  // Isolated JS runtime: changing builtin surfaces must not leak into this
  // runner or another test. The actual selected NodeFileSystem is imported.
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const root = await fs.promises.mkdtemp(path.join(process.env.TMPDIR, 'TEST-fs-capture-'));
    const input = path.join(root, 'physical.txt'); await fs.promises.writeFile(input, 'TEST');
    const callback = fs.realpath, promise = fs.promises.realpath;
    const denied = Object.assign(new Error('TEST-captured-refusal'), { code: 'EPERM' });
    fs.realpath = (target, cb) => target === input ? queueMicrotask(() => cb(denied)) : callback(target, cb);
    const captured = await import('node:fs');
    fs.realpath = (target, cb) => promise(target).then(value => cb(null, value), cb);
    require('node:module').syncBuiltinESMExports();
    const selected = path.dirname(Bun.resolveSync('@opencode/server/options', process.cwd()));
    const effect = await import(Bun.resolveSync('effect', selected));
    const node = await import(Bun.resolveSync('@effect/platform-node/NodeFileSystem', selected));
    const exit = await effect.Effect.runPromiseExit(effect.Effect.flatMap(effect.FileSystem.FileSystem, service => service.realPath(input)).pipe(effect.Effect.provide(node.layer)));
    const failure = exit.cause?.reasons?.[0]?.error;
    const platform = await import(Bun.resolveSync('@opencode/util/effect/app-node-platform', selected));
    const nodes = await import(Bun.resolveSync('@opencode/util/effect/layer-node', selected));
    const realpath = await import('./src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.ts');
    const source = await Bun.file('./src/services/opencode/host/windows/OpenCodeV2WindowsRuntime.ts').text();
    const block = source.slice(source.indexOf('const filesystemNode ='), source.indexOf('\\n  const error ='));
    const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(block);
    const replacement = new Function('platform', 'Effect', 'Layer', 'FileSystem', 'PlatformError', 'filesystem', 'types', 'retainWindowsRealpathFailure', 'readWindowsRealpathFailure', body + ';return filesystemNode;')(
      platform, effect.Effect, effect.Layer, effect.FileSystem, effect.PlatformError, fs.promises, require('node:util').types, realpath.retainWindowsRealpathFailure, realpath.readWindowsRealpathFailure);
    const fixed = nodes.compile(platform.filesystem, { replacements: [platform.filesystem.replace(replacement)] });
    const corrected = await effect.Effect.runPromise(effect.Effect.flatMap(effect.FileSystem.FileSystem, service => service.realPath(input)).pipe(effect.Effect.provide(fixed)));
    console.log(JSON.stringify({ failed: exit._tag === 'Failure', sameCause: failure?.reason?.cause === denied,
      stale: captured.realpath !== fs.realpath, physical: await fs.promises.realpath(input) === input, corrected: corrected === input }));
    fs.realpath = callback; await fs.promises.rm(root, { recursive: true });
  `
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0); expect(stderr).toBe('')
  expect(JSON.parse(output)).toEqual({ failed: true, sameCause: true, stale: true, physical: true, corrected: true })
})
