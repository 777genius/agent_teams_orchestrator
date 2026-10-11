import { test, expect } from 'bun:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createOpenCodeV2ExecutionReceipt, resolveOpenCodeV2ReceiptPackageRoot } from './OpenCodeV2ExecutionReceipt.js'

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-receipt-package-')))
  const entry = path.join(root, 'dist/esm/client/index.js')
  await mkdir(path.dirname(entry), { recursive: true }); await writeFile(entry, 'export {}')
  return { root, entry, scope: path.join(root, 'dist/esm/package.json') }
}
test.skipIf(process.platform !== 'darwin')('Darwin receipt binds installed native bytes and a Mach-O local controller without starting either', async () => {
  const packageName = `@opencode/cli-darwin-${process.arch}`
  const metadataPath = Bun.resolveSync(`${packageName}/package.json`, import.meta.dir)
  const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'))
  expect(metadata).toMatchObject({ name: packageName, version: '2.0.21' })
  const executablePath = path.join(path.dirname(metadataPath), 'bin/opencode')
  const executableSha256 = createHash('sha256').update(await readFile(executablePath)).digest('hex')
  const f = await fixture()
  try {
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'TEST-receipt-controller', version: '1.0.0' }))
    const receipt = await createOpenCodeV2ExecutionReceipt('/TEST-unused-source-hint', {
      generation: 'v2', version: '2.0.21', dialect: 'v2-2.0.21', executablePath, executableSha256, packageName,
    }, { type: 'local', command: [process.execPath, f.entry] })
    expect(receipt.packageName).toBe(packageName)
    expect(receipt.executableSha256).toBe(executableSha256)
    expect(receipt.graph.files.some(row => row.path === process.execPath)).toBe(true)
    expect(receipt.graph.files.some(row => row.path === f.entry)).toBe(true)
    // The same installed package cannot acquire a receipt after selected bytes drift.
    await expect(createOpenCodeV2ExecutionReceipt('/TEST-unused-source-hint', {
      generation: 'v2', version: '2.0.21', dialect: 'v2-2.0.21', executablePath,
      executableSha256: '0'.repeat(64), packageName,
    })).rejects.toThrow('native_selection_changed')
  } finally { await rm(f.root, { recursive: true, force: true }) }
}, 120_000)
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
