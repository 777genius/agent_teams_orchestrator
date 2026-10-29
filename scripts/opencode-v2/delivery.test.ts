import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { inventoryOpenCodeV2Delivery, packageOpenCodeV2Delivery } from './delivery.js'

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-delivery-'))
  const payload = path.join(root, 'payload'), local = path.join(payload, 'local-cli')
  await mkdir(local, { recursive: true })
  for (const entry of ['opencodeV2Server', 'opencodeV2ExecutionServer', 'opencodeV2RunOwner']) {
    await writeFile(path.join(local, `${entry}.js`), 'export const TEST = true\n')
  }
  await writeFile(path.join(local, 'opencode-v2-graphs.json'), JSON.stringify({ schema: 2, platform: 'linux', arch: 'x64',
    graphs: ['2.0.0', '2.0.32', '2.1.4'].map(version => ({ version })) }))
  return { root, payload, local, options: { root: payload, outputDirectory: path.join(root, 'dist'),
    runtimeVersion: '0.0.999', sourceCommit: 'a'.repeat(40), platformKey: 'linux-x64' } }
}

test('producer emits one independently readable, byte-bound ZIP without a duplicate base', async () => {
  const f = await fixture()
  try {
    const helper = path.join(f.local, 'TEST-helper')
    await writeFile(helper, '#!/bin/sh\nexit 0\n')
    await chmod(helper, 0o755)
    const descriptor = await packageOpenCodeV2Delivery(f.options)
    const archive = await readFile(path.join(f.options.outputDirectory, descriptor.archive.file))
    const entries = unzipSync(archive)
    const manifestBytes = entries['opencode-v2-engine-manifest.json']!
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      files: { path: string; bytes: number; sha256: string; executable: boolean }[]
    }
    expect(descriptor.archive.sha256).toBe(sha(archive))
    expect(descriptor.archive.bytes).toBe(archive.length)
    expect(descriptor.archive.entries).toBe(Object.keys(entries).length)
    expect(descriptor.archive.expandedBytes).toBe(Object.values(entries).reduce((sum, bytes) => sum + bytes.length, 0))
    expect(descriptor.manifest.sha256).toBe(sha(manifestBytes))
    expect(descriptor.requiredBunVersion).toBe('1.3.11')
    expect(manifest.files.some(row => row.path === descriptor.manifest.file)).toBe(false)
    expect(manifest.files.some(row => row.path === 'local-cli/cli.js')).toBe(false)
    expect(manifest.files.find(row => row.path === 'local-cli/TEST-helper')).toMatchObject({ executable: process.platform !== 'win32' })
    for (const row of manifest.files) {
      expect(entries[row.path]?.length).toBe(row.bytes)
      expect(sha(entries[row.path]!)).toBe(row.sha256)
    }
    expect(JSON.parse(await readFile(path.join(f.options.outputDirectory, 'opencode-v2-delivery.json'), 'utf8'))).toEqual(descriptor)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a payload with an unqualified or incomplete engine roster never publishes a descriptor', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.local, 'opencode-v2-graphs.json'), JSON.stringify({ platform: 'linux', arch: 'x64', graphs: [{ version: '2.1.4' }] }))
    await expect(packageOpenCodeV2Delivery(f.options)).rejects.toThrow('graph roster mismatch')
    await expect(packageOpenCodeV2Delivery({ ...f.options, platformKey: 'win32-arm64' })).rejects.toThrow('not qualified')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('inventory refuses a linked graph file instead of archiving a followed dependency', async () => {
  if (process.platform === 'win32') return
  const f = await fixture()
  try {
    const outside = path.join(f.root, 'TEST-outside')
    await writeFile(outside, 'TEST')
    await symlink(outside, path.join(f.local, 'TEST-linked'))
    await expect(inventoryOpenCodeV2Delivery(f.payload)).rejects.toThrow('Unsupported')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
