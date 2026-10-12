import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import type { WindowsRealpathSelection } from '../../../src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.js'
const root = process.env.TEST_REALPATH_ROOT!
const p = FFIType.ptr, d = FFIType.u32, h = FFIType.u64, b = FFIType.bool
const kernel = dlopen('kernel32.dll', {
  CreateFileW: { args: [p, d, d, p, d, d, h], returns: h },
  CloseHandle: { args: [h], returns: b },
  GetFileInformationByHandleEx: { args: [h, d, p, d], returns: b },
  GetFinalPathNameByHandleW: { args: [h, p, d, d], returns: d },
  GetLastError: { args: [], returns: d },
  SetLastError: { args: [d], returns: FFIType.void },
  GetCurrentProcess: { args: [], returns: h },
  GetProcessTimes: { args: [h, p, p, p, p], returns: b },
})
const held = new Set<bigint>()
const wide = (value: string) => Buffer.from(value + '\0', 'utf16le')
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function openFile(value: string) {
  const name = wide('\\\\?\\' + value)
  const handle = BigInt(kernel.symbols.CreateFileW(ptr(name), 0x80, 7, null, 3, 0x02200000, 0n))
  assert.notEqual(handle, 0xffffffffffffffffn, `realpath_test_open:${kernel.symbols.GetLastError()}`)
  held.add(handle); return handle
}
function closeFile(handle: bigint) {
  assert.equal(kernel.symbols.CloseHandle(handle), true); held.delete(handle)
}
function observe(handle: bigint) {
  const id = Buffer.alloc(24)
  assert.equal(kernel.symbols.GetFileInformationByHandleEx(handle, 18, ptr(id), id.length), true)
  const names: Record<string, { count: number; error: number; value: string }> = {}
  for (const flags of [0, 8, 2]) {
    const name = Buffer.alloc(65536); kernel.symbols.SetLastError(0)
    const count = kernel.symbols.GetFinalPathNameByHandleW(handle, ptr(name), name.length / 2, flags)
    const error = count === 0 ? kernel.symbols.GetLastError() : 0
    assert.ok(count < name.length / 2)
    names[String(flags)] = { count, error, value: name.subarray(0, count * 2).toString('utf16le') }
  }
  return { volumeSerial: id.readBigUInt64LE(0).toString(), fileId: id.subarray(8).toString('hex'), names }
}
function currentBirth() {
  const handle = BigInt(kernel.symbols.GetCurrentProcess())
  const creation = Buffer.alloc(8), exit = Buffer.alloc(8), system = Buffer.alloc(8), user = Buffer.alloc(8)
  assert.equal(kernel.symbols.GetProcessTimes(handle, ptr(creation), ptr(exit), ptr(system), ptr(user)), true)
  // Pseudo-handle is borrowed, never published or closed.
  return creation.readBigUInt64LE(0)
}
async function run(prepare?: Record<string, unknown>, diagnostic?: (value: Record<string, unknown>) => void) {
  const creation = currentBirth()
  const controls: Record<string, unknown>[] = []
  const targets = [root, path.join(root, 'ordinary.txt'), process.env.TEST_REALPATH_LONG!]
  for (const target of targets) {
    const handle = openFile(target), observation = observe(handle)
    assert.ok(observation.names['2']!.count > 0)
    for (const flag of ['0', '8']) {
      if (prepare) {
        assert.equal(observation.names[flag]!.count, 0)
        assert.equal(observation.names[flag]!.error, 5)
      } else assert.ok(observation.names[flag]!.count > 0)
    }
    controls.push({ chars: target.length, volumeSerial: observation.volumeSerial,
      fileId: observation.fileId, dos0: observation.names['0']!.error,
      dos8: observation.names['8']!.error, nt2: observation.names['2']!.error })
    closeFile(handle)
  }
  if (!prepare) return { pid: process.pid, creation: creation.toString(), controls, kind: 'ordinary-dos-success' }
  assert.equal(record(prepare.birth).value, creation.toString())
  const receipt = record(prepare.realpathAnchors)
  assert.equal(receipt.nonce, prepare.nonce)
  assert.ok(Array.isArray(receipt.anchors)); assert.equal(receipt.anchors.length, 1)
  const supplied = record(receipt.anchors[0])
  assert.equal(supplied.admittedPath, root)
  assert.equal(path.win32.relative(root, String(supplied.dosPath)), '')
  const handle = openFile(root), observation = observe(handle); closeFile(handle)
  assert.equal(supplied.ntPath, observation.names['2']!.value)
  assert.equal(supplied.volumeSerial, observation.volumeSerial); assert.equal(supplied.fileId, observation.fileId)
  const selection: WindowsRealpathSelection = {
    dllPath: path.join(root, 'opencode-v2-windows-realpath.dll'), expectedPid: process.pid,
    expectedCreationFiletime: creation, anchors: [{ dosPath: String(supplied.dosPath),
      ntPath: String(supplied.ntPath), volumeSerial: BigInt(String(supplied.volumeSerial)), fileId: String(supplied.fileId) }],
  }
  const require = createRequire(import.meta.url)
  const fs = require('node:fs') as typeof import('node:fs')
  const original = fs.realpathSync, denied = targets[1]!, fileURL = pathToFileURL(denied)
  // Record actual Bun surfaces separately from the Win32 same-HANDLE denial.
  // Do not import ESM fs/promises before the production installation.
  const cjsBefore = require('node:fs/promises') as typeof import('node:fs/promises')
  const probe = async (target: string, operation: () => unknown) => {
    try {
      const value: unknown = await operation()
      return { succeeded: true, canonicalMatch: typeof value === 'string' && path.win32.relative(target, value) === '' }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      return { succeeded: false, code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : 'non_errno_error' }
    }
  }
  const surfaceControls: Record<string, unknown>[] = []
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!
    const callback = (native: boolean) => new Promise<string>((resolve, reject) => {
      ;(native ? fs.realpath.native : fs.realpath)(target, (error, value) => error ? reject(error) : resolve(value))
    })
    surfaceControls.push({ index, chars: target.length,
      sync: await probe(target, () => fs.realpathSync(target)),
      syncNative: await probe(target, () => fs.realpathSync.native(target)),
      callback: await probe(target, () => callback(false)),
      callbackNative: await probe(target, () => callback(true)),
      cjsPromises: await probe(target, () => cjsBefore.realpath(target)),
    })
  }
  diagnostic?.({ phase: 'before-facade', controls, surfaceControls })

  const errorOf = (operation: () => unknown): NodeJS.ErrnoException => {
    try { operation() } catch (error) {
      assert.ok(error instanceof Error && 'code' in error)
      const code = error.code
      assert.ok(code === 'EPERM' || code === 'EACCES')
      return Object.assign(error, { code })
    }
    throw new Error('realpath_fixture_not_denied')
  }
  for (const control of surfaceControls) {
    assert.deepEqual(control.sync, { succeeded: true, canonicalMatch: true })
    assert.deepEqual(control.callback, { succeeded: true, canonicalMatch: true })
    for (const field of ['syncNative', 'callbackNative', 'cjsPromises']) {
      assert.deepEqual(control[field], { succeeded: false, code: 'EPERM' })
    }
  }
  const originalError = errorOf(() => original.native(denied))
  const originalCallbackError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    fs.realpath.native(denied, error => error ? resolve(error) : reject(new Error('realpath_fixture_not_denied')))
  })
  assert.ok(originalCallbackError.code === 'EPERM' || originalCallbackError.code === 'EACCES')
  // Import the exact production facade before the first ESM node:fs/promises import.
  const facade: typeof import('../../../src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.js') =
    await import(pathToFileURL(path.join(root, 'facade.ts')).href)
  const installation = facade.installWindowsRealpathFallback(selection)
  const detachedSync = fs.realpathSync.native, detachedCallback = fs.realpath.native
  let pending: Promise<NodeJS.ErrnoException> | undefined, callbackCalls = 0, uninstalled = false
  try {
    for (const target of targets) {
      assert.equal(path.win32.relative(target, fs.realpathSync(target)), '')
      assert.equal(path.win32.relative(target, fs.realpathSync.native(target)), '')
    }
    const expected = fs.realpathSync(denied)
    assert.equal(path.win32.relative(denied, expected), '')
    assert.equal(fs.realpathSync(denied, 'hex'), Buffer.from(expected).toString('hex'))
    assert.deepEqual(fs.realpathSync(denied, { encoding: 'buffer' }), Buffer.from(expected))
    assert.equal(fs.realpathSync.native(denied, 'hex'), Buffer.from(expected).toString('hex'))
    assert.deepEqual(fs.realpathSync.native(denied, { encoding: 'buffer' }), Buffer.from(expected))
    assert.equal(fs.realpathSync(fileURL), expected)
    const callback = (native: boolean) => new Promise<string>((resolve, reject) => {
      ;(native ? fs.realpath.native : fs.realpath)(fileURL, (error, value) => error ? reject(error) : resolve(value))
    })
    assert.equal(await callback(false), expected); assert.equal(await callback(true), expected)
    const cjsPromises = require('node:fs/promises') as typeof import('node:fs/promises')
    const esmPromises = await import('node:fs/promises')
    assert.equal(await cjsPromises.realpath(denied), expected)
    assert.equal(await esmPromises.realpath(fileURL), expected)
    assert.equal(await esmPromises.default.realpath(denied), expected)
    assert.equal(fs.realpathSync('ordinary.txt'), expected)
    pending = new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      detachedCallback(denied, error => {
        callbackCalls++
        if (!uninstalled) reject(new Error('realpath_callback_not_pending'))
        else if (error) resolve(error)
        else reject(new Error('realpath_pending_succeeded_after_close'))
      })
    })
    assert.equal(callbackCalls, 0)
  } finally { installation.uninstall(); uninstalled = true }
  assert.notEqual(detachedSync, fs.realpathSync.native); assert.notEqual(detachedCallback, fs.realpath.native)
  const detachedError = errorOf(() => detachedSync(denied))
  assert.equal(detachedError.code, originalError.code); assert.equal(detachedError.message, originalError.message)
  assert.ok(pending)
  const pendingError = await pending
  assert.equal(pendingError.code, originalCallbackError.code); assert.equal(pendingError.message, originalCallbackError.message)
  assert.equal(callbackCalls, 1)
  const laterError = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    detachedCallback(denied, error => error ? resolve(error) : reject(new Error('realpath_detached_callback_succeeded')))
  })
  assert.equal(laterError.code, originalCallbackError.code); assert.equal(laterError.message, originalCallbackError.message)
  assert.equal(path.win32.relative(denied, fs.realpathSync(denied)), '')
  const ordinaryAfter = await new Promise<string>((resolve, reject) => {
    fs.realpath(denied, (error, value) => error ? reject(error) : resolve(value))
  })
  assert.equal(path.win32.relative(denied, ordinaryAfter), '')
  installation.uninstall()
  return { pid: process.pid, creation: creation.toString(), controls, kind: 'production-facade-genuine-appcontainer-dos5',
    sixSurfacesPassed: true, encodingAndFileURLPassed: true, relativePathPassed: true,
    pendingRetiredPassed: true, detachedRetiredPassed: true, longPathPassed: targets[2]!.length > 260 }
}
async function guardedRun(prepare?: Record<string, unknown>, diagnostic?: (value: Record<string, unknown>) => void) {
  try { return await run(prepare, diagnostic) }
  finally { for (const handle of held) closeFile(handle); kernel.close() }
}
if (process.argv[2] === 'ordinary') console.log(JSON.stringify(await guardedRun()))
else {
  const nonce = process.env.OPENCODE_V2_WINDOWS_NONCE, leaseOwnerId = process.env.OPENCODE_V2_WINDOWS_LEASE
  const socket = net.createConnection(process.env.OPENCODE_V2_WINDOWS_PIPE!), decoder = new TextDecoder()
  let buffer = '', prepared = false
  const send = (value: Record<string, unknown>) => socket.write(JSON.stringify({ ...value, nonce, leaseOwnerId }) + '\n')
  socket.on('error', () => process.exit(9)); socket.on('close', () => process.exit(0))
  socket.on('data', bytes => {
    buffer += decoder.decode(bytes, { stream: true }); assert.ok(buffer.length <= 65536)
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), message = record(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1)
      assert.equal(message.nonce, nonce); assert.equal(message.leaseOwnerId, leaseOwnerId)
      if (message.type === 'prepare') {
        assert.equal(prepared, false); prepared = true
        void guardedRun(message, facts => send({ type: 'realpathDiagnostic', facts })).then(result => send({ type: 'realpathResult', result }),
          error => send({ type: 'realpathFailed', error: error instanceof Error ? error.message.slice(0, 240) : 'realpath_test_unknown' }))
      }
    }
  })
}
