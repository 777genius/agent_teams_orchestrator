import assert from 'node:assert/strict'
import { closeSync, existsSync, fstatSync, writeFileSync } from 'node:fs'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import type { readHostedControlBootstrapV2 } from '../../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import type { HostedControlInheritedActivationV2 } from '../../../../src/services/hostedControl/HostedControlInheritedActivationV2.js'
import type { HostedApprovalActivationConnection } from '../../../../src/services/hostedControl/HostedApprovalActivationSession.js'
import { retainNativeRawDescriptorV2 } from '../native-raw-descriptor-v2.js'

// Adversarial test actions only. Production never duplicates or changes flags.
const native = dlopen('libc.so.6', {
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
export async function checkRawDescriptor(
  bootstrap: Awaited<ReturnType<typeof readHostedControlBootstrapV2>>, scenario: string,
) {
  if (scenario === 'raw-codec-invalid') {
    assert.throws(() => retainNativeRawDescriptorV2(bootstrap.rawRetention, performance.now() + 5000,
      bootstrap.expectedHost.activation.controllerNonce))
    // Even a hash-authenticated prefix must decode before native writer transfer.
    assert.equal(bootstrap.rawRetention.resource.fd, 8)
    assert.equal(fstatSync(8).isFile(), true)
    return
  }
  if (scenario === 'raw-prefix-mismatch') {
    assert.throws(() => retainNativeRawDescriptorV2(bootstrap.rawRetention, performance.now() + 5000), /raw_prefix_changed/)
    // Rejected prefix never transfers the writer from bootstrap.
    assert.equal(bootstrap.rawRetention.resource.fd, 8)
    return
  }
  const writer = retainNativeRawDescriptorV2(bootstrap.rawRetention, performance.now() + 5000)
  assert.throws(() => bootstrap.rawRetention.resource.fd, /descriptor_consumed/)
  assert.equal(writer.readPrefix().toString(), 'actual inherited prefix\n')
  writer.readPrefix().fill(0)
  assert.equal(writer.readPrefix().toString(), 'actual inherited prefix\n')
  assert.equal(writer.isCurrent(), true)
  try {
    if (scenario === 'raw-prefix') {
      const bytes = Buffer.from('actual append\n')
      assert.equal(await writer.write(bytes, 0, bytes.length), bytes.length)
      await writer.sync()
      assert.equal(writer.isCurrent(), true)
    } else if (scenario === 'raw-flags') {
      const flags = native.symbols.fcntl(8, 3, 0)
      assert.equal(native.symbols.fcntl(8, 4, flags & ~0o2000), 0)
      assert.equal(writer.isCurrent(), false)
      assert.equal(native.symbols.fcntl(8, 4, flags), 0)
      assert.equal(writer.isCurrent(), false)
      await assert.rejects(writer.write(Buffer.from('x'), 0, 1), /raw_writer_unavailable/)
    } else if (scenario === 'raw-replacement') {
      const slots = new Int32Array(2)
      assert.equal(native.symbols.socketpair(1, 1 | 0x80000, 0, ptr(slots)), 0)
      try {
        const replacement = fstatSync(slots[0], { bigint: true })
        assert.equal(native.symbols.dup2(slots[0], 8), 8)
        assert.equal(writer.isCurrent(), false)
        await assert.rejects(writer.close(), /raw_close_changed/)
        await bootstrap.close()
        const after = fstatSync(8, { bigint: true })
        assert.equal(after.dev, replacement.dev); assert.equal(after.ino, replacement.ino)
      } finally { closeSync(8); closeSync(slots[0]); closeSync(slots[1]) }
    } else throw new Error('unknown raw descriptor scenario')
  } finally {
    if (scenario === 'raw-replacement') await assert.rejects(writer.close(), /raw_close_changed/)
    else await writer.close()
  }
  assert.equal(writer.isCurrent(), false)
  assert.equal(writer.close(), writer.close())
  if (scenario === 'raw-replacement') await assert.rejects(writer.close(), /raw_close_changed/)
  else await writer.close()
}
export async function checkPretransfer(
  bootstrap: Awaited<ReturnType<typeof readHostedControlBootstrapV2>>, scenario: string,
) {
  const slots = new Int32Array(2)
  assert.equal(native.symbols.socketpair(1, 1 | 0x80000, 0, ptr(slots)), 0)
  const replacement = fstatSync(slots[0], { bigint: true })
  let reused = false
  try {
    if (scenario === 'pretransfer-replacement') {
      assert.equal(native.symbols.dup2(slots[0], 5), 5); reused = true
      assert.throws(() => bootstrap.activation.take(), /activation_consumed/)
    } else {
      const flags = native.symbols.fcntl(5, 3, 0)
      assert.ok(flags >= 0)
      assert.equal(native.symbols.fcntl(5, 4, flags | 0o2000), 0) // O_APPEND on ORIGINAL socket
      if (scenario === 'pretransfer-drift-close') bootstrap.activation.close()
      else assert.throws(() => bootstrap.activation.take(), /activation_consumed/)
      assert.throws(() => fstatSync(5), { code: 'EBADF' })
      // Exact numeric FD5 reuse after original cleanup must survive all later cleanup.
      assert.equal(native.symbols.dup2(slots[0], 5), 5); reused = true
    }
    bootstrap.activation.close(); bootstrap.activation.close()
    await bootstrap.close()
    const after = fstatSync(5, { bigint: true })
    assert.equal(after.dev, replacement.dev); assert.equal(after.ino, replacement.ino)
    assert.throws(() => bootstrap.activation.take(), /activation_consumed/)
    return { originalClosed: scenario !== 'pretransfer-replacement', replacementPreserved: true, exactFd: 5 }
  } finally {
    if (reused) closeSync(5)
    closeSync(slots[0]); closeSync(slots[1])
  }
}
async function marker(path: string) {
  const deadline = performance.now() + 6000
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error('effect fixture marker deadline: ' + path)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
export async function checkEffect(
  connection: () => HostedApprovalActivationConnection, resource: HostedControlInheritedActivationV2, result: string,
) {
  await marker(result + '.arm') // Controller has verified the actual ready frame.
  const positive = connection().prepareEffectToken()
  assert.ok(positive); assert.equal(positive.consume(), true); assert.equal(positive.consume(), false)
  const token = connection().prepareEffectToken()
  assert.ok(token)
  writeFileSync(result + '.armed', 'armed')
  await marker(result + '.consume') // Peer send + optional SHUT_WR already completed.
  // Buffered input keeps the generic monitor current; the token is the negative boundary.
  const currentBefore = connection().isCurrent()
  const consumed = token.consume(), repeated = token.consume()
  writeFileSync(result + '.effect', JSON.stringify({ currentBefore, consumed, repeated,
    resourceCurrent: resource.isCurrent() }))
}
