import { expect, test, spyOn } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { verifyBunPtyGraph, verifyGraphs } from './stage.js'

async function ptyFixture(root: string, pin: '2.0.0' | '2.0.32') {
  const core = path.join(root, 'node_modules', pin === '2.0.0' ? '@opencode/server-v2.0.0/node_modules/@opencode/core' : '@opencode/core')
  await mkdir(path.join(core, 'dist/pty'), { recursive: true })
  await writeFile(path.join(core, 'package.json'), JSON.stringify({
    name: '@opencode/core', version: pin, imports: { '#pty': './dist/pty/pty.bun.js' },
  }))
  const entry = path.join(core, 'dist/bus.js')
  await writeFile(entry, 'export {}')
  await writeFile(path.join(core, 'dist/pty/pty.bun.js'), 'import "bun-pty"')
  return { core, entry }
}

async function writePty(root: string, version: string) {
  const directory = path.join(root, 'node_modules/bun-pty')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'bun-pty', version, main: './index.js' }))
  const entry = path.join(directory, 'index.js')
  await writeFile(entry, 'export {}')
  return entry
}

test('Bun PTY graph resolves 0.4.11 through both selected physical adapters', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-pty-graphs-')))
  try {
    const expected = await writePty(root, '0.4.11')
    for (const pin of ['2.0.0', '2.0.32'] as const) {
      const { entry } = await ptyFixture(root, pin)
      expect(await verifyBunPtyGraph(entry, pin, root)).toBe(expected)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Bun PTY graph refuses an old floor payload even when the root is 0.4.11', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-pty-old-floor-')))
  try {
    await writePty(root, '0.4.11')
    const { core, entry } = await ptyFixture(root, '2.0.0')
    const old = await writePty(core, '0.4.8')
    expect(Bun.resolveSync('bun-pty', path.join(core, 'dist/pty'))).toBe(old)
    await expect(verifyBunPtyGraph(entry, '2.0.0', root)).rejects.toThrow('graph mismatch: bun-pty')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Bun PTY graph refuses an adapter-local old payload and a missing dependency', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-pty-adapter-')))
  try {
    const { core, entry } = await ptyFixture(root, '2.0.32')
    await expect(verifyBunPtyGraph(entry, '2.0.32', root)).rejects.toThrow()
    await writePty(root, '0.4.11')
    await writePty(path.join(core, 'dist/pty'), '0.4.8')
    await expect(verifyBunPtyGraph(entry, '2.0.32', root)).rejects.toThrow('graph mismatch: bun-pty')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Bun PTY graph refuses a valid dependency outside the staged owned root', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-pty-escape-')))
  try {
    await writePty(root, '0.4.11')
    const owned = path.join(root, 'staged')
    const { entry } = await ptyFixture(owned, '2.0.0')
    await expect(verifyBunPtyGraph(entry, '2.0.0', owned)).rejects.toThrow('escaped its bundle')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Bun PTY graph refuses an adapter from the other core pin', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-pty-core-pin-')))
  try {
    await writePty(root, '0.4.11')
    const { entry } = await ptyFixture(root, '2.0.0')
    await expect(verifyBunPtyGraph(entry, '2.0.32', root)).rejects.toThrow('graph mismatch: #pty')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// A hoisted shared effect binder must never satisfy the floor graph with the
// root Effect; exercise the staged verification against a poisoned binder.
test('a hoisted shared effect binder cannot pass staged verification with a second physical Effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-poisoned-binder-'))
  try {
    const drizzle = path.join(root, 'node_modules/drizzle-orm')
    await mkdir(drizzle, { recursive: true })
    await writeFile(path.join(drizzle, 'package.json'),
      JSON.stringify({ name: 'drizzle-orm', version: '1.0.0-rc.5-169397b', exports: './effect-core.js' }))
    await writeFile(path.join(drizzle, 'effect-core.js'), 'export {}')
    const effect = path.join(root, 'node_modules/effect')
    await mkdir(effect, { recursive: true })
    await writeFile(path.join(effect, 'package.json'),
      JSON.stringify({ name: 'effect', version: '4.0.1', exports: './index.js' }))
    await writeFile(path.join(effect, 'index.js'), 'export {}')
    const entry = path.join(drizzle, 'effect-core.js')
    const original = Bun.resolveSync
    const resolution = spyOn(Bun, 'resolveSync').mockImplementation((specifier, from) =>
      specifier === 'drizzle-orm/effect-core' ? entry : original(specifier, from))
    try {
      await expect(verifyGraphs(path.join(import.meta.dir, '..', '..'))).rejects.toThrow('mismatch')
    } finally { resolution.mockRestore() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
