import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { dlopen, FFIType, ptr } from 'bun:ffi'

const root = process.env.TEST_REALPATH_ROOT!
const p = FFIType.ptr, d = FFIType.u32, h = FFIType.u64, b = FFIType.bool
const native = dlopen(path.join(root, 'realpath-test.dll'), {
  RP_OpenV1: { args: [d, h, p, d, p, p], returns: FFIType.i32 },
  RP_ResolveV1: { args: [h, p, d, p, d, p, p], returns: FFIType.i32 },
  RP_CloseV1: { args: [h, p], returns: FFIType.i32 },
})
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
function run(prepare?: Record<string, unknown>) {
  let context = 0n
  try {
    const creation = currentBirth(), rootHandle = openFile(root), observed = observe(rootHandle)
    const parentHandle = openFile(path.dirname(root)), parentIdentity = observe(parentHandle)
    closeFile(parentHandle); closeFile(rootHandle)
    let anchor = { dosPath: root, ntPath: observed.names['2']!.value, volumeSerial: observed.volumeSerial, fileId: observed.fileId }
    assert.ok(observed.names['2']!.count > 0 && anchor.ntPath.startsWith('\\Device\\'))
    if (prepare) {
      assert.equal(record(prepare.birth).value, creation.toString())
      const receipt = record(prepare.realpathAnchors)
      assert.ok(Array.isArray(receipt.anchors)); assert.equal(receipt.anchors.length, 1)
      const supplied = record(receipt.anchors[0])
      assert.equal(supplied.admittedPath, root); assert.equal(path.win32.relative(root, String(supplied.dosPath)), '')
      assert.equal(supplied.ntPath, anchor.ntPath); assert.equal(supplied.volumeSerial, anchor.volumeSerial); assert.equal(supplied.fileId, anchor.fileId)
      anchor = { dosPath: String(supplied.dosPath), ntPath: String(supplied.ntPath), volumeSerial: String(supplied.volumeSerial), fileId: String(supplied.fileId) }
    }
    const dos = wide(anchor.dosPath), nt = wide(anchor.ntPath), pod = Buffer.alloc(56), id = Buffer.alloc(8), error = Buffer.alloc(8)
    pod.writeBigUInt64LE(BigInt(ptr(dos)), 0); pod.writeUInt32LE(anchor.dosPath.length, 8)
    pod.writeBigUInt64LE(BigInt(ptr(nt)), 16); pod.writeUInt32LE(anchor.ntPath.length, 24)
    pod.writeBigUInt64LE(BigInt(anchor.volumeSerial), 32); Buffer.from(anchor.fileId, 'hex').copy(pod, 40)
    id.writeBigUInt64LE(123n)
    assert.equal(native.symbols.RP_OpenV1(process.pid, creation, ptr(pod), 1, ptr(id), null), 2); assert.equal(id.readBigUInt64LE(0), 0n)
    assert.equal(native.symbols.RP_OpenV1(process.pid, creation + 1n, ptr(pod), 1, ptr(id), ptr(error)), 2)
    assert.equal(id.readBigUInt64LE(0), 0n); assert.equal(error.readUInt32LE(0), 2)
    Buffer.from(parentIdentity.fileId, 'hex').copy(pod, 40)
    assert.notEqual(parentIdentity.fileId, anchor.fileId)
    assert.equal(native.symbols.RP_OpenV1(process.pid, creation, ptr(pod), 1, ptr(id), ptr(error)), 2)
    assert.equal(id.readBigUInt64LE(0), 0n); assert.equal(error.readUInt32LE(0), 4)
    Buffer.from(anchor.fileId, 'hex').copy(pod, 40)
    assert.equal(native.symbols.RP_OpenV1(process.pid, creation, ptr(pod), 1, ptr(id), ptr(error)), 0)
    context = id.readBigUInt64LE(0); assert.ok(context > 0n)
    const controls: Record<string, unknown>[] = []
    for (const target of [root, path.join(root, 'ordinary.txt'), process.env.TEST_REALPATH_LONG!]) {
      const handle = openFile(target), before = observe(handle), input = wide(target), output = Buffer.alloc(65536), count = Buffer.alloc(4)
      assert.ok(before.names['2']!.count > 0)
      for (const flags of ['0', '8']) {
        if (prepare) { assert.equal(before.names[flags]!.count, 0); assert.equal(before.names[flags]!.error, 5) }
        else assert.ok(before.names[flags]!.count > 0)
      }
      count.writeUInt32LE(777)
      assert.equal(native.symbols.RP_ResolveV1(context, ptr(input), target.length, ptr(output), 32768, ptr(count), null), 2)
      assert.equal(count.readUInt32LE(0), 0)
      const status = native.symbols.RP_ResolveV1(context, ptr(input), target.length, ptr(output), 32768, ptr(count), ptr(error))
      assert.equal(status, prepare ? 0 : 1)
      if (prepare) {
        const chars = count.readUInt32LE(0), resolved = output.subarray(0, chars * 2).toString('utf16le')
        assert.equal(path.win32.relative(target, resolved), ''); assert.equal(output.readUInt16LE(chars * 2), 0)
        const joined = openFile(resolved), after = observe(joined)
        assert.equal(after.volumeSerial, before.volumeSerial); assert.equal(after.fileId, before.fileId); closeFile(joined)
        count.writeUInt32LE(777)
        assert.equal(native.symbols.RP_ResolveV1(context, ptr(input), target.length, ptr(output), 1, ptr(count), ptr(error)), 2)
        assert.equal(count.readUInt32LE(0), 0); assert.equal(error.readUInt32LE(4), 122)
      } else assert.equal(count.readUInt32LE(0), 0)
      controls.push({ targetChars: target.length, volumeSerial: before.volumeSerial, fileId: before.fileId, queries: before.names, status })
      closeFile(handle)
    }
    assert.ok(process.env.TEST_REALPATH_LONG!.length > 260)
    assert.equal(native.symbols.RP_CloseV1(context, ptr(error)), 0)
    assert.equal(native.symbols.RP_CloseV1(context, ptr(error)), 0)
    const input = wide(root), output = Buffer.alloc(65536), count = Buffer.alloc(4); count.writeUInt32LE(777)
    assert.equal(native.symbols.RP_ResolveV1(context, ptr(input), root.length, ptr(output), 32768, ptr(count), ptr(error)), 3)
    assert.equal(count.readUInt32LE(0), 0); context = 0n
    return { pid: process.pid, creation: creation.toString(), kind: prepare ? 'genuine-appcontainer-dos5' : 'ordinary-dos-success', controls, wrongBirthRejected: true, actualParentFileIdRejected: true, staleOutputsZero: true, longPathPassed: true, closeRetirementPassed: true }
  } finally {
    if (context) { const error = Buffer.alloc(8); assert.equal(native.symbols.RP_CloseV1(context, ptr(error)), 0) }
    for (const handle of held) closeFile(handle)
    native.close(); kernel.close()
  }
}

if (process.argv[2] === 'ordinary') console.log(JSON.stringify(run()))
else {
  const nonce = process.env.OPENCODE_V2_WINDOWS_NONCE, leaseOwnerId = process.env.OPENCODE_V2_WINDOWS_LEASE
  const socket = net.createConnection(process.env.OPENCODE_V2_WINDOWS_PIPE!), decoder = new TextDecoder()
  let buffer = '', prepared = false
  const send = (value: Record<string, unknown>) => socket.write(JSON.stringify({ ...value, nonce, leaseOwnerId }) + '\n')
  socket.on('error', () => process.exit(9))
  socket.on('close', () => process.exit(0))
  socket.on('data', bytes => {
    buffer += decoder.decode(bytes, { stream: true })
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), message = record(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1)
      assert.equal(message.nonce, nonce); assert.equal(message.leaseOwnerId, leaseOwnerId)
      if (message.type === 'prepare') {
        assert.equal(prepared, false); prepared = true
        try { send({ type: 'realpathResult', result: run(message) }) }
        catch (error) { send({ type: 'realpathFailed', error: error instanceof Error ? error.message.slice(0, 240) : 'realpath_test_unknown' }) }
      }
    }
  })
}
