import { expect, test, spyOn } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { selectOpenCodeV2StageVersions, stageOpenCodeV2Graphs, verifyBunPtyGraph, verifyGraphs } from './stage.js'

test('release staging preserves every exact platform engine without adding a new qualification', () => {
  const staged = ['2.0.0', '2.0.32', '2.1.4'] as const
  expect(selectOpenCodeV2StageVersions(staged, 'darwin-x64')).toEqual(['2.0.0', '2.0.32'])
  expect(selectOpenCodeV2StageVersions(staged, 'win32-x64')).toEqual(['2.1.4'])
  expect(selectOpenCodeV2StageVersions(staged, 'win32-arm64')).toEqual([])
  expect(() => selectOpenCodeV2StageVersions(['2.0.32'], 'linux-x64')).toThrow('not installed')
})

/** Tiny real package/export closure: exercises staging without copying the installed vendor graph. */
async function linkedInstallFixture(root: string, outsideDependency = false) {
  const source = path.join(root, 'source'), install = path.join(root, 'shared/node_modules'), pin = '2.0.32'
  await mkdir(source, { recursive: true }); await mkdir(install, { recursive: true })
  await symlink(install, path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const writePackage = async (alias: string, name: string, version: string, exports: Record<string, string>,
    dependencies: Record<string, string> = {}, imports?: Record<string, string>, modules = install) => {
    const directory = path.join(modules, alias)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, exports, dependencies, ...(imports ? { imports } : {}) }))
    for (const file of new Set([...Object.values(exports), ...Object.values(imports ?? {})])) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), `export const marker = ${JSON.stringify(name)}\n`)
    }
  }
  const effect = { effect: '4.0.1' }
  await writePackage('effect', 'effect', '4.0.1', { '.': './index.js' })
  await writePackage('@effect/platform-node', '@effect/platform-node', '4.0.1',
    { './NodeSocket': './socket.js', './NodeHttpServer': './server.js' }, effect)
  await writePackage('@effect/platform-node-shared', '@effect/platform-node-shared', '4.0.1', { './NodeStream': './stream.js' }, effect)
  await writePackage('@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk', '1.29.0', { './client/index.js': './client.js' })
  await writePackage('bun-pty', 'bun-pty', '0.4.11', { '.': './index.js' })
  await writePackage('drizzle-orm', 'drizzle-orm', '1.0.0', { './effect-core': './effect-core.js' }, effect)
  await writePackage('@opencode/ai', '@opencode/ai', pin, { './route/client': './client.js' }, effect)
  await writePackage('@opencode/core', '@opencode/core', pin, { './bus': './bus.js' },
    { ...effect, '@opencode/ai': pin, 'drizzle-orm': '1.0.0', 'bun-pty': '0.4.11' }, { '#pty': './pty.bun.js' })
  await writePackage('@opencode/schema', '@opencode/schema', pin,
    { './config/provider': './provider.js', './model': './model.js', './installation-event': './event.js' }, effect)
  await writePackage('@opencode/protocol', '@opencode/protocol', pin, { './groups/pty': './pty.js' }, effect)
  await writePackage('@opencode/util', '@opencode/util', pin, { './effect/layer-node': './layer.js' }, effect)
  await writePackage('@opencode/simulation', '@opencode/simulation', pin, { './backend': './backend.js' }, effect)
  await writePackage('@opencode/client-v2.0.32', '@opencode/client', pin, { '.': './index.js' },
    { '@opencode/schema': pin, '@opencode/protocol': pin })
  await writePackage('@opencode/server-v2.0.32', '@opencode/server', pin, { './process': './process.js' },
    { ...effect, ...Object.fromEntries(['core', 'schema', 'protocol', 'util', 'simulation'].map(name => [`@opencode/${name}`, pin])),
      ...(outsideDependency ? { outside: '1.0.0' } : {}) })
  if (outsideDependency) await writePackage('outside', 'outside', '1.0.0', { '.': './index.js' }, {}, undefined, path.join(root, 'node_modules'))
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'TEST-linked-install', version: '1.0.0',
    dependencies: { '@opencode/server-v2.0.32': `npm:@opencode/server@${pin}`, '@opencode/client-v2.0.32': `npm:@opencode/client@${pin}` },
    overrides: { 'bun-pty': '0.4.11' } }))
  return { source, install, bundle: path.join(root, 'bundle') }
}

test('portable staging accepts a linked hoisted install and produces a self-contained physical graph', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-linked-install-')))
  try {
    const fixture = await linkedInstallFixture(root)
    await stageOpenCodeV2Graphs(fixture.source, fixture.bundle, { portable: true })
    const server = path.join(fixture.bundle, 'node_modules/@opencode/server-v2.0.32/process.js')
    expect(await readFile(server, 'utf8')).toContain('@opencode/server')
    expect((await lstat(path.dirname(server))).isSymbolicLink()).toBe(false)
    expect(await realpath(Bun.resolveSync('@opencode/server-v2.0.32/process', fixture.bundle))).toBe(server)
    const manifest = JSON.parse(await readFile(path.join(fixture.bundle, 'opencode-v2-graphs.json'), 'utf8'))
    expect(manifest.graphs.map((row: { version: string }) => row.version)).toEqual(['2.0.32'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('portable staging rejects an ancestor dependency outside the frozen canonical install root', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-linked-escape-')))
  try {
    const fixture = await linkedInstallFixture(root, true)
    await expect(stageOpenCodeV2Graphs(fixture.source, fixture.bundle, { portable: true })).rejects.toThrow('Portable graph escaped the hoisted install')
    expect(await lstat(path.join(fixture.bundle, 'node_modules/outside')).then(() => true, () => false)).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

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
