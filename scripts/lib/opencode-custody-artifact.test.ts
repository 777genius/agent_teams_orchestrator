import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { verifyLinuxCustodyArtifact, verifyStaticPieCustodyElf } from './opencode-custody-artifact.ts'

function staticPie(machine = 62): Buffer {
  const bytes = Buffer.alloc(512)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18); bytes.writeUInt32LE(1, 20)
  bytes.writeBigUInt64LE(256n, 24); bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(2, 56)
  // One executable PT_LOAD containing the header, entry and self-relocation table.
  bytes.writeUInt32LE(1, 64); bytes.writeUInt32LE(5, 68)
  bytes.writeBigUInt64LE(512n, 96); bytes.writeBigUInt64LE(512n, 104); bytes.writeBigUInt64LE(4096n, 112)
  bytes.writeUInt32LE(2, 120); bytes.writeBigUInt64LE(192n, 128); bytes.writeBigUInt64LE(192n, 136)
  bytes.writeBigUInt64LE(32n, 152); bytes.writeBigUInt64LE(32n, 160)
  bytes.writeBigInt64LE(0x6ffffffbn, 192); bytes.writeBigUInt64LE(0x8000000n, 200) // DF_1_PIE
  return bytes
}

test('static PIE admits self-relocation metadata on the exact physical target', () => {
  assert.doesNotThrow(() => verifyStaticPieCustodyElf(staticPie(), 'linux-x64'))
  assert.doesNotThrow(() => verifyStaticPieCustodyElf(staticPie(183), 'linux-arm64'))
  assert.throws(() => verifyStaticPieCustodyElf(staticPie(183), 'linux-x64'), /static PIE/)
  const executable = staticPie(); executable.writeUInt16LE(2, 16)
  assert.throws(() => verifyStaticPieCustodyElf(executable, 'linux-x64'), /static PIE/)
})

test('loader, shared-library and external symbol-version requirements cannot masquerade as static PIE', () => {
  const interpreter = staticPie(); interpreter.writeUInt32LE(3, 120)
  assert.throws(() => verifyStaticPieCustodyElf(interpreter, 'linux-x64'), /static PIE/)
  for (const tag of [1n, 15n, 29n, 0x6ffffffen, 0x6fffffffn, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn]) {
    const bytes = staticPie(); bytes.writeBigInt64LE(tag, 192); bytes.writeBigUInt64LE(1n, 200)
    assert.throws(() => verifyStaticPieCustodyElf(bytes, 'linux-x64'), /static PIE/)
  }
  const versionSection = staticPie()
  versionSection.writeBigUInt64LE(256n, 40); versionSection.writeUInt16LE(64, 58); versionSection.writeUInt16LE(2, 60)
  versionSection.writeUInt32LE(0x6ffffffe, 324); versionSection.writeBigUInt64LE(480n, 344); versionSection.writeBigUInt64LE(16n, 352)
  assert.throws(() => verifyStaticPieCustodyElf(versionSection, 'linux-x64'), /static PIE/)
})

test('malformed or unbounded ELF tables fail without following offsets outside the image', () => {
  const changes: Array<(bytes: Buffer) => void> = [
    b => { b.writeBigUInt64LE(0xffffffffffffffffn, 32) },
    b => { b.writeUInt16LE(0xffff, 56) },
    b => { b.writeUInt16LE(55, 54) },
    b => { b.writeUInt16LE(0, 56) },
    b => { b.writeBigUInt64LE(0xffffffffffffffffn, 96) },
    b => { b.writeBigUInt64LE(0xffffffffffffffffn, 80) },
    b => { b.writeBigUInt64LE(511n, 104) },
    b => { b.writeBigUInt64LE(3n, 112) },
    b => { b.writeBigUInt64LE(480n, 128) },
    b => { b.writeBigUInt64LE(31n, 152) },
    b => { b.writeBigUInt64LE(32n, 136) },
    b => { b.writeBigUInt64LE(600n, 24) },
    b => { b.writeBigInt64LE(30n, 208) }, // No DT_NULL terminator.
    b => { b.writeBigUInt64LE(0n, 200) }, // No DF_1_PIE.
    b => { b.writeBigUInt64LE(480n, 40); b.writeUInt16LE(64, 58); b.writeUInt16LE(2, 60) },
    b => { b.writeUInt16LE(1, 60) },
  ]
  for (const change of changes) {
    const bytes = staticPie(); change(bytes)
    assert.throws(() => verifyStaticPieCustodyElf(bytes, 'linux-x64'), /static PIE/)
  }
  for (const bytes of [Buffer.alloc(0), staticPie().subarray(0, 63), Buffer.alloc(16 * 1024 * 1024 + 1)])
    assert.throws(() => verifyStaticPieCustodyElf(bytes, 'linux-x64'), /static PIE/)
})

test('binds a delivery asset to exact source, bytes and physical target architecture', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'TEST-custody-artifact-'))
  try {
    const file = path.join(root, 'opencode-custody/linux-x64/custodian'), source = path.join(root, 'linux.c')
    mkdirSync(path.dirname(file), { recursive: true })
    const bytes = staticPie()
    writeFileSync(file, bytes, { mode: 0o555 }); writeFileSync(source, 'TEST source bytes')
    const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x64', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex') }
    writeFileSync(`${file}.json`, JSON.stringify(manifest))
    assert.equal(verifyLinuxCustodyArtifact(root, 'linux-x64', source).sha256, manifest.sha256)
    assert.throws(() => verifyLinuxCustodyArtifact(root, 'win32-x64', source), /Unsupported/)
    writeFileSync(source, 'different source')
    assert.throws(() => verifyLinuxCustodyArtifact(root, 'linux-x64', source), /identity mismatch/)
    writeFileSync(source, 'TEST source bytes')
    chmodSync(file, 0o755)
    const tampered = Buffer.from(bytes); tampered[63] = 1
    writeFileSync(file, tampered); chmodSync(file, 0o555)
    assert.throws(() => verifyLinuxCustodyArtifact(root, 'linux-x64', source), /identity mismatch/)
    chmodSync(file, 0o755); bytes.writeUInt16LE(183, 18); writeFileSync(file, bytes); chmodSync(file, 0o555)
    writeFileSync(`${file}.json`, JSON.stringify({ ...manifest, sha256: createHash('sha256').update(bytes).digest('hex') }))
    assert.throws(() => verifyLinuxCustodyArtifact(root, 'linux-x64', source), /identity mismatch/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
