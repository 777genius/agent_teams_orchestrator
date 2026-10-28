import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { verifyLinuxCustodyArtifact } from './opencode-custody-artifact.ts'

test('binds a delivery asset to exact source, bytes and physical target architecture', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'TEST-custody-artifact-'))
  try {
    const file = path.join(root, 'opencode-custody/linux-x64/custodian'), source = path.join(root, 'linux.c')
    mkdirSync(path.dirname(file), { recursive: true })
    const bytes = Buffer.alloc(64)
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18)
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
