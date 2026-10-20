import { expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { types } from 'node:util'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import filesystem from 'node:fs/promises'
import { projectWindowsRealpathFailure } from './windows/OpenCodeV2WindowsRealpath.js'
import { validateExecutionGraph, readExecutionGraphFailure } from './OpenCodeV2ExecutionBinding.js'

type RealpathNativeCall = (context: bigint, input: Buffer, chars: number, output: Buffer,
  capacity: number, count: Buffer, error: Buffer) => number
async function actualRealpathInstallation(resolve: RealpathNativeCall) {
  const source = await Bun.file(new URL('windows/OpenCodeV2WindowsRealpath.ts', import.meta.url)).text()
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(/^import .*\n/gm, '').replace(/^export /gm, ''))
  const allocations: number[] = []
  const buffers = new Proxy(Buffer, { get(target, key, receiver) {
    if (key === 'alloc') return (size: number) => { allocations.push(size); return Buffer.alloc(size) }
    return Reflect.get(target, key, receiver)
  } })
  // Execute the actual installer/resolver, replacing only native load and the
  // process-global filesystem patch boundary. No Windows DLL or host is opened.
  const create = new Function('path', 'fileURLToPath', 'Buffer', 'process', 'require', 'nativePort', `${body}
    openNative = () => ({ library: nativePort, context: 1n });
    surfaces = () => []; syncExports = () => {};
    return { install: installWindowsRealpathFallback,
      resolve: (input, encoding, error) => resolveNative(active, input, undefined, encoding, error),
      promise: (original, input) => callPromise(original, undefined, [input]),
      retain: retainWindowsRealpathFailure, failure: readWindowsRealpathFailure };
  `)(path, () => { throw new Error('TEST-url-not-used') }, buffers, { platform: 'win32', pid: 1 },
    () => ({ ptr: (bytes: Buffer) => bytes }), { symbols: { RP_ResolveV1: resolve, RP_CloseV1: () => 0 }, close() {} }) as {
      install(selection: unknown): { uninstall(): void }
      resolve(input: string, encoding: { kind: 'default' | 'buffer' }, error: Error): { handled: boolean; value?: string | Buffer }
      promise(original: (input: string) => Promise<string>, input: string): Promise<string>
      retain(source: unknown, target: unknown): void
      failure(error: Error): unknown
    }
  const owned = create.install({ dllPath: 'C:\\TEST\\realpath.dll', expectedPid: 1, expectedCreationFiletime: 1n,
    anchors: [{ dosPath: 'C:\\TEST', ntPath: '\\Device\\TEST', volumeSerial: 1n, fileId: 'a'.repeat(32) }] })
  return { ...create, allocations, close: () => owned.uninstall() }
}

test('actual Windows realpath clears reused scratch and refuses partial or malformed native output', async () => {
  const expected = 'C:\\TEST\\long-original-name.js', outputBuffers: Buffer[] = []
  let calls = 0
  const install = await actualRealpathInstallation((_context, _input, _chars, output, capacity, count, error) => {
    expect(capacity).toBe(32768)
    expect(output.every(byte => byte === 0) && count.every(byte => byte === 0) && error.every(byte => byte === 0)).toBe(true)
    outputBuffers.push(output)
    if (++calls === 1) {
      output.fill(0x61); output.write(expected, 'utf16le'); output.writeUInt16LE(0, expected.length * 2)
      count.writeUInt32LE(expected.length); error.fill(0x77); return 0
    }
    if (calls === 2) { output.write('C:', 'utf16le'); count.writeUInt32LE(expected.length); return 0 }
    if (calls === 3) { error.writeUInt32LE(13); error.writeUInt32LE(5, 4); return 2 }
    output.writeUInt16LE(0xd800); count.writeUInt32LE(1); return 0
  })
  const original = new Error('TEST-original-realpath')
  try {
    expect(install.resolve(expected, { kind: 'default' }, original)).toEqual({ handled: true, value: expected })
    expect(install.resolve(expected, { kind: 'default' }, original)).toEqual({ handled: false })
    expect(install.resolve(expected, { kind: 'default' }, original)).toEqual({ handled: false })
    expect(install.failure(original)).toEqual({ status: 2, operation: 13, win32: 5, anchorCount: 1, matchingAnchorIndex: 0 })
    expect(install.resolve(expected, { kind: 'default' }, original)).toEqual({ handled: false })
    expect(outputBuffers.every(output => output === outputBuffers[0])).toBe(true)
    expect(install.allocations.filter(size => size === 65536)).toHaveLength(1)
  } finally { install.close() }
})

test('native realpath install/uninstall and immutable copied refusal facts survive the same selected cause chain', async () => {
  const admitted = 'C:\\TEST\\project', outside = 'C:\\outside\\project'
  let denied = false
  const install = await actualRealpathInstallation((_context, input, chars, output, _capacity, count, error) => {
    const target = input.subarray(0, chars * 2).toString('utf16le')
    if (denied || target !== admitted) { error.writeUInt32LE(18); error.writeUInt32LE(5, 4); return 2 }
    output.write(target, 'utf16le'); count.writeUInt32LE(target.length); return 0
  })
  const original = Object.assign(new Error('TEST-private-native-refusal'), { code: 'EPERM' })
  const legacy = async () => { throw original }
  try {
    expect(await install.promise(legacy, admitted)).toBe(admitted)
    await expect(install.promise(legacy, outside)).rejects.toBe(original)
    denied = true
    await expect(install.promise(legacy, admitted)).rejects.toBe(original)
    const selected = Object.assign(new Error('TEST-original-selected-refusal'), { _tag: 'PlatformError', reason: { _tag: 'Unknown', cause: original } })
    const descriptors = Object.getOwnPropertyDescriptors(selected)
    install.retain(original, selected)
    const expected = { status: 2, operation: 18, win32: 5, anchorCount: 1, matchingAnchorIndex: 0 }
    expect(install.failure(selected)).toEqual(expected)
    expect(Object.getOwnPropertyDescriptors(selected)).toEqual(descriptors)
    const source = await Bun.file(new URL('../execution/OpenCodeV2ServerFailure.ts', import.meta.url)).text()
    const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(/^import .*\n/gm, '').replace(/^export /gm, ''))
    const project = new Function('types', 'readWindowsRealpathFailure', `${body};return projectOpenCodeV2LocationCause;`)(types, install.failure)
    expect(project({ reasons: [{ _tag: 'Fail', error: selected }, { _tag: 'Die', defect: { code: 'ENOENT' } }] }).realpath).toEqual(expected)
    expect(project({ reasons: [{ _tag: 'Fail', error: { realpath: expected } }] }).realpath).toBeUndefined()
    const forged = Object.assign(new Error('TEST-forged'), { realpath: expected, ...expected })
    const target = new Error('TEST-target')
    install.retain(forged, target); expect(install.failure(target)).toBeUndefined()
    install.close()
    await expect(install.promise(legacy, admitted)).rejects.toBe(original)
  } finally { install.close() }
})

test('actual Windows realpath scratch belongs to its installation and returned buffers remain independent', async () => {
  const outputs: Buffer[] = [], counts: Buffer[] = [], errors: Buffer[] = []
  let current = 'C:\\TEST\\first.js'
  const native: RealpathNativeCall = (_context, _input, _chars, output, _capacity, count, error) => {
    outputs.push(output); counts.push(count); errors.push(error)
    output.write(current, 'utf16le'); count.writeUInt32LE(current.length); return 0
  }
  const first = await actualRealpathInstallation(native), second = await actualRealpathInstallation(native)
  try {
    const original = new Error('TEST-original-realpath')
    const a = first.resolve(current, { kind: 'buffer' }, original)
    current = 'C:\\TEST\\b.js'
    const b = first.resolve(current, { kind: 'buffer' }, original)
    const c = second.resolve(current, { kind: 'buffer' }, original)
    expect(a.value).toEqual(Buffer.from('C:\\TEST\\first.js'))
    expect(b.value).toEqual(Buffer.from(current)); expect(c.value).toEqual(Buffer.from(current))
    expect(a.value).not.toBe(b.value); expect(b.value).not.toBe(c.value)
    expect(outputs[0]).toBe(outputs[1]); expect(outputs[0]).not.toBe(outputs[2])
    expect(counts[0]).toBe(counts[1]); expect(counts[0]).not.toBe(counts[2])
    expect(errors[0]).toBe(errors[1]); expect(errors[0]).not.toBe(errors[2])
    expect(first.allocations.filter(size => size === 65536)).toHaveLength(1)
    expect(second.allocations.filter(size => size === 65536)).toHaveLength(1)
  } finally { first.close(); second.close() }
})

test('graph cancellation drains claimed hashes and rejects before runtime closure traversal', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-graph-cancel-')))
  const controller = new AbortController(), reason = new Error('TEST-graph-cancelled')
  const content = Buffer.alloc(129 * 1024, 37)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const files = Array.from({ length: 48 }, (_, index) => ({ path: path.join(root, `${String(index).padStart(2, '0')}.bin`), sha256 }))
  try {
    await Promise.all(files.map(file => writeFile(file.path, content)))
    const phases: string[] = []
    await expect(validateExecutionGraph('2.0.0', { files, sha256: executionHash(files) }, value => {
      phases.push(value.phase)
      if (value.completed >= 16) controller.abort(reason)
    }, controller.signal)).rejects.toBe(reason)
    expect(phases).toContain('hash')
    expect(phases).not.toContain('closure')
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('graph failure keeps exact original error and sorted row identity without raw path', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-graph-failure-')))
  const files = ['b.bin', 'a.bin'].map(name => ({ path: path.join(root, name), sha256: 'a'.repeat(64) }))
  const original = Object.assign(new Error('SECRET-original-path'), { code: 'EPERM', syscall: 'lstat' })
  const probe = spyOn(filesystem, 'realpath').mockRejectedValue(original)
  try {
    await expect(validateExecutionGraph('2.0.0', { files, sha256: executionHash([...files].sort((a,b)=>a.path < b.path ? -1 : 1)) })).rejects.toBe(original)
    const facts = readExecutionGraphFailure(original)
    expect(facts?.index).toBe(0)
    expect(facts?.total).toBe(2)
    expect(facts?.readPhase).toBe('realpath')
    expect(facts?.realpath).toBeUndefined()
    expect(facts?.pathSha256).toBe(createHash('sha256').update(files[1]!.path).digest('hex'))
    expect(JSON.stringify(facts)).not.toContain(root)
    expect(JSON.stringify(facts)).not.toContain('SECRET')
  } finally { probe.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

test('realpath native diagnostic keeps closed operation and admitted coverage without paths', () => {
  const anchors = [{ dosPath: 'C:\\TEST-sdk', ntPath: 'SECRET', volumeSerial: 1n, fileId: 'a'.repeat(32) }]
  expect(projectWindowsRealpathFailure(1, 15, 0, anchors, 'C:\\TEST-sdk\\node_modules\\x.js')).toEqual({ status: 1, operation: 15, win32: 0, anchorCount: 1, matchingAnchorIndex: 0 })
  expect(projectWindowsRealpathFailure(2, 18, 5, anchors, 'C:\\other\\x.js')?.matchingAnchorIndex).toBe(-1)
  expect(projectWindowsRealpathFailure(9, 15, 0, anchors, 'C:\\TEST-sdk')).toBeUndefined()
  expect(projectWindowsRealpathFailure(1, 99, 0, anchors, 'C:\\TEST-sdk')).toBeUndefined()
  expect(projectWindowsRealpathFailure(4, 25, 5, anchors, 'C:\\TEST-sdk')?.operation).toBe(25)
  expect(projectWindowsRealpathFailure(4, 26, 5, anchors, 'C:\\TEST-sdk')).toBeUndefined()
  expect(JSON.stringify(projectWindowsRealpathFailure(1, 15, 0, anchors, 'C:\\TEST-sdk'))).not.toContain('SECRET')
})


test('malformed graph path preserves the original TypeError instead of diagnostic failure', async () => {
  const files = [{ path: 42, sha256: 'a'.repeat(64) }] as unknown as Parameters<typeof validateExecutionGraph>[1]['files']
  const original = new TypeError('TEST-original-path-type')
  const check = spyOn(path, 'isAbsolute').mockImplementation(() => { throw original })
  try {
    await expect(validateExecutionGraph('2.0.0', { files, sha256: executionHash(files) })).rejects.toBe(original)
    expect(readExecutionGraphFailure(original)).toBeUndefined()
  } finally { check.mockRestore() }
})
