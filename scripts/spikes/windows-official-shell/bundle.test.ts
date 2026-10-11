import { test, expect } from 'bun:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readBundledCompilerIdentity, verifyBundledCompilerIdentity } from './bundle.ts'

// Metadata-only custody fixture, not an executable compiler or native qualification.
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-bundle-compiler-')))
  const manifest = path.join(root, 'node_modules/esbuild/package.json')
  const binaryManifest = path.join(root, 'node_modules/@esbuild/win32-x64/package.json')
  const binary = path.join(path.dirname(binaryManifest), 'esbuild.exe')
  await mkdir(path.dirname(manifest), { recursive: true })
  await mkdir(path.dirname(binaryManifest), { recursive: true })
  await writeFile(manifest, JSON.stringify({ name: 'esbuild', version: '0.28.2' }))
  await writeFile(binaryManifest, JSON.stringify({ name: '@esbuild/win32-x64', version: '0.28.2', os: ['win32'], cpu: ['x64'] }))
  await writeFile(binary, 'TEST non-executable compiler bytes')
  await writeFile(path.join(root, 'bun.lock'), 'TEST immutable lock bytes')
  return { root, manifest, binaryManifest, binary }
}
test('parent independently verifies selected compiler bytes and refuses a spoofed child hash', async () => {
  const value = await fixture()
  try {
    const before = readBundledCompilerIdentity(value.root)
    expect(before.binarySha256).toBe(createHash('sha256').update('TEST non-executable compiler bytes').digest('hex'))
    expect(() => verifyBundledCompilerIdentity(value.root, before, { ...before })).not.toThrow()
    expect(() => verifyBundledCompilerIdentity(value.root, before, { ...before, binarySha256: '0'.repeat(64) })).toThrow('child identity disagrees')
  } finally { await rm(value.root, { recursive: true, force: true }) }
})
test('a changed binary or manifest refuses even when child echoes the original valid snapshot', async () => {
  const value = await fixture()
  try {
    const before = readBundledCompilerIdentity(value.root)
    await writeFile(value.binary, 'TEST changed compiler bytes')
    expect(() => verifyBundledCompilerIdentity(value.root, before, before)).toThrow('compiler changed')
    await writeFile(value.binary, 'TEST non-executable compiler bytes')
    await writeFile(value.manifest, JSON.stringify({ name: 'esbuild', version: '0.28.2', changed: true }))
    expect(() => verifyBundledCompilerIdentity(value.root, before, before)).toThrow('compiler changed')
  } finally { await rm(value.root, { recursive: true, force: true }) }
})
test('compiler version and actual Windows binary package selection remain pinned', async () => {
  const value = await fixture()
  try {
    await writeFile(value.binaryManifest, JSON.stringify({ name: '@esbuild/win32-x64', version: '0.28.2', os: ['linux'], cpu: ['x64'] }))
    expect(() => readBundledCompilerIdentity(value.root)).toThrow('binary platform mismatch')
    await writeFile(value.binaryManifest, JSON.stringify({ name: '@esbuild/win32-x64', version: '0.28.3', os: ['win32'], cpu: ['x64'] }))
    expect(() => readBundledCompilerIdentity(value.root)).toThrow('published identity mismatch')
  } finally { await rm(value.root, { recursive: true, force: true }) }
})
