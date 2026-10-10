import { test, expect } from 'bun:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolveOpenCodeV2ReceiptPackageRoot } from './OpenCodeV2ExecutionReceipt.js'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-receipt-package-'))
  const entry = path.join(root, 'dist/esm/client/index.js')
  await mkdir(path.dirname(entry), { recursive: true }); await writeFile(entry, 'export {}')
  return { root, entry, scope: path.join(root, 'dist/esm/package.json') }
}
test('actual installed MCP metadata-only module scope resolves to genuine named/versioned package root', async () => {
  const actual = Bun.resolveSync('@modelcontextprotocol/sdk/client/index.js', path.dirname(fileURLToPath(import.meta.url)))
  const scope = await readFile(path.resolve(path.dirname(actual), '../package.json'))
  const metadata = await readFile(path.resolve(path.dirname(actual), '../../../package.json'))
  expect(JSON.parse(scope.toString())).toEqual({ type: 'module' })
  expect(JSON.parse(metadata.toString()).name).toBe('@modelcontextprotocol/sdk')
  const f = await fixture()
  try {
    await writeFile(f.scope, scope); await writeFile(path.join(f.root, 'package.json'), metadata)
    expect(await resolveOpenCodeV2ReceiptPackageRoot(f.entry)).toBe(f.root)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('partially named/versioned or malformed scope manifests refuse rather than hide bad package identity', async () => {
  for (const scope of [{ name: 'TEST-partial' }, { version: '1.0.0' }, { name: null, version: null }]) {
    const f = await fixture()
    try {
      await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'TEST-real', version: '1.0.0' }))
      await writeFile(f.scope, JSON.stringify(scope))
      await expect(resolveOpenCodeV2ReceiptPackageRoot(f.entry)).rejects.toThrow('receipt_package_metadata_invalid')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
  const f = await fixture()
  try {
    await writeFile(f.scope, '{broken')
    await expect(resolveOpenCodeV2ReceiptPackageRoot(f.entry)).rejects.toThrow()
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
