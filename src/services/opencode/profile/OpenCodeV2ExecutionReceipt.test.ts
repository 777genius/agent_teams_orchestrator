import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { test, expect, mock } from 'bun:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createOpenCodeV2ExecutionReceipt, resolveOpenCodeV2ReceiptPackageRoot, resolveOpenCodeV2DarwinControllerRuntimeClosure } from './OpenCodeV2ExecutionReceipt.js'
import { OpenCodeRuntimeDeadlineError } from '../OpenCodeRuntimeDeadline.js'
import * as executionDelivery from '../host/OpenCodeV2ExecutionDelivery.js'
import * as fsPromises from 'node:fs/promises'

const actualFs = { ...fsPromises }
const actualDelivery = { ...executionDelivery }
const deliveryModule = new URL('../host/OpenCodeV2ExecutionDelivery.js', import.meta.url).href


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
  expect(metadata).toMatchObject({ name: packageName, version: '2.0.32' })
  const executablePath = path.join(path.dirname(metadataPath), 'bin/opencode')
  const executableSha256 = createHash('sha256').update(await readFile(executablePath)).digest('hex')
  const f = await fixture()
  try {
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'TEST-receipt-controller', version: '1.0.0' }))
    const receipt = await createOpenCodeV2ExecutionReceipt('/TEST-unused-source-hint', {
      generation: 'v2', version: '2.0.32', dialect: 'v2-2.0.32', executablePath, executableSha256, packageName,
    }, { type: 'local', command: [process.execPath, f.entry] })
    expect(receipt.packageName).toBe(packageName)
    expect(receipt.executableSha256).toBe(executableSha256)
    expect(receipt.graph.files.some(row => row.path === process.execPath)).toBe(true)
    expect(receipt.graph.files.some(row => row.path === f.entry)).toBe(true)
    // The same installed package cannot acquire a receipt after selected bytes drift.
    await expect(createOpenCodeV2ExecutionReceipt('/TEST-unused-source-hint', {
      generation: 'v2', version: '2.0.32', dialect: 'v2-2.0.32', executablePath,
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

function macho(dependencies: readonly string[], rpaths: readonly string[] = [], cpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007): Buffer {
  const commands = [...dependencies.map(name => ({ kind: 0x0c, minimum: 24, name })),
    ...rpaths.map(name => ({ kind: 0x8000001c, minimum: 12, name }))].map(({ kind, minimum, name }) => {
      const text = Buffer.from(name + '\0'), command = Buffer.alloc(Math.ceil((minimum + text.length) / 8) * 8)
      command.writeUInt32LE(kind); command.writeUInt32LE(command.length, 4); command.writeUInt32LE(minimum, 8)
      text.copy(command, minimum); return command
    })
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(cpu, 4); header.writeUInt32LE(2, 12)
  header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((size, command) => size + command.length, 0), 20)
  return Buffer.concat([header, ...commands])
}

function peExecutable(payload = 'TEST canonical PE payload'): Buffer {
  const image = Buffer.alloc(0x400), pe = 0x40, optional = pe + 24
  image.write('MZ', 0, 'ascii'); image.writeUInt32LE(pe, 0x3c)
  image.write('PE\0\0', pe, 'ascii'); image.writeUInt16LE(0x8664, pe + 4); image.writeUInt16LE(1, pe + 6)
  image.writeUInt16LE(240, pe + 20); image.writeUInt16LE(0x0022, pe + 22)
  image.writeUInt16LE(0x20b, optional); image.writeUInt32LE(0x200, optional + 36)
  image.writeUInt32LE(0x1000, optional + 32); image.writeUInt32LE(0x1000, optional + 16)
  image.writeUInt32LE(0x200, optional + 4); image.writeUInt32LE(0x1000, optional + 20)
  image.writeBigUInt64LE(0x140000000n, optional + 24); image.writeUInt32LE(0x1000, optional + 56)
  image.writeUInt32LE(0x200, optional + 60); image.writeUInt16LE(3, optional + 68)
  const section = optional + 240
  image.write('.text\0', section, 'ascii'); image.writeUInt32LE(payload.length, section + 8)
  image.writeUInt32LE(0x1000, section + 12); image.writeUInt32LE(0x200, section + 16)
  image.writeUInt32LE(0x200, section + 20); image.writeUInt32LE(0x60000020, section + 36)
  image.write(payload, 0x200, 'utf8'); return image
}

test.skipIf(process.platform !== 'darwin')('selected runtime closure follows inherited rpaths, loader paths and exact symlinked files without granting their directories', async () => {
  const f = await fixture(), runtime = path.join(f.root, 'bin/node'), libraries = path.join(f.root, 'actual-lib')
  await mkdir(path.dirname(runtime)); await mkdir(libraries); await symlink(libraries, path.join(f.root, 'lib'), 'dir')
  const node = path.join(libraries, 'libnode.dylib'), child = path.join(libraries, 'libchild.dylib'), direct = path.join(libraries, 'libdirect.dylib')
  try {
    await writeFile(runtime, macho(['@rpath/libnode.dylib', '/usr/lib/libSystem.B.dylib'], ['@loader_path/../missing', '@loader_path/../lib']))
    await writeFile(node, macho(['@rpath/libchild.dylib', '@loader_path/libdirect.dylib']))
    await writeFile(child, macho([])); await writeFile(direct, macho(['@executable_path/../lib/libnode.dylib']))
    const closure = await resolveOpenCodeV2DarwinControllerRuntimeClosure(runtime)
    expect(closure.files.map(row => row.path).sort()).toEqual([runtime, node, child, direct].sort())
    expect(closure.aliases.map(alias => alias.target).sort()).toEqual(['libnode.dylib', 'libchild.dylib', 'libdirect.dylib'].map(name => path.join(f.root, 'lib', name)).sort())
    for (const row of closure.files) expect(row.sha256).toBe(createHash('sha256').update(await readFile(row.path)).digest('hex'))
    for (const alias of closure.aliases) expect(await realpath(alias.target)).toBe(alias.source)
    await rm(child)
    await expect(resolveOpenCodeV2DarwinControllerRuntimeClosure(runtime)).rejects.toThrow('controller_runtime_dependency_missing')
    await writeFile(child, 'wrong native image')
    await expect(resolveOpenCodeV2DarwinControllerRuntimeClosure(runtime)).rejects.toThrow('controller_runtime_macho_invalid')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'darwin')('selected runtime closure chooses the native universal slice and refuses malformed load commands', async () => {
  const f = await fixture(), nativeCpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007
  const selected = macho(['/usr/lib/libSystem.B.dylib']), foreign = macho(['/TEST-absent-foreign-library'], [], nativeCpu === 0x0100000c ? 0x01000007 : 0x0100000c)
  const universal = Buffer.alloc(48 + foreign.length + selected.length)
  universal.writeUInt32BE(0xcafebabe); universal.writeUInt32BE(2, 4)
  for (const [index, cpu, offset, bytes] of [[0, nativeCpu === 0x0100000c ? 0x01000007 : 0x0100000c, 48, foreign], [1, nativeCpu, 48 + foreign.length, selected]] as const) {
    const at = 8 + index * 20
    universal.writeUInt32BE(cpu, at); universal.writeUInt32BE(offset, at + 8); universal.writeUInt32BE(bytes.length, at + 12); bytes.copy(universal, offset)
  }
  try {
    await writeFile(f.entry, universal)
    expect((await resolveOpenCodeV2DarwinControllerRuntimeClosure(f.entry)).files).toHaveLength(1)
    const universal64 = Buffer.alloc(40 + selected.length)
    universal64.writeUInt32BE(0xcafebabf); universal64.writeUInt32BE(1, 4); universal64.writeUInt32BE(nativeCpu, 8)
    universal64.writeBigUInt64BE(40n, 16); universal64.writeBigUInt64BE(BigInt(selected.length), 24); selected.copy(universal64, 40)
    await writeFile(f.entry, universal64)
    expect((await resolveOpenCodeV2DarwinControllerRuntimeClosure(f.entry)).files).toHaveLength(1)
    const malformed = Buffer.from(selected); malformed.writeUInt32LE(malformed.length, 36)
    await writeFile(f.entry, malformed)
    await expect(resolveOpenCodeV2DarwinControllerRuntimeClosure(f.entry)).rejects.toThrow('controller_runtime_macho_invalid')
    await writeFile(f.entry, macho([], ['@rpath/unbound']))
    await expect(resolveOpenCodeV2DarwinControllerRuntimeClosure(f.entry)).rejects.toThrow('controller_runtime_dependency_unknown')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'darwin' || !process.env.OPENCODE_E2E_TEST_NODE)('genuine selected MCP Node dependency bytes and aliases are present in its installed receipt', async () => {
  const runtime = await realpath(process.env.OPENCODE_E2E_TEST_NODE!), packageName = `@opencode/cli-darwin-${process.arch}`
  const metadata = Bun.resolveSync(`${packageName}/package.json`, import.meta.dir), executablePath = path.join(path.dirname(metadata), 'bin/opencode')
  const executableSha256 = createHash('sha256').update(await readFile(executablePath)).digest('hex'), f = await fixture()
  try {
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'TEST-receipt-selected-node', version: '1.0.0' }))
    const closure = await resolveOpenCodeV2DarwinControllerRuntimeClosure(runtime)
    expect(closure.files.length).toBeGreaterThan(1); expect(closure.aliases.length).toBeGreaterThan(0)
    const receipt = await createOpenCodeV2ExecutionReceipt('/TEST-unused-source-hint', {
      generation: 'v2', version: '2.0.32', dialect: 'v2-2.0.32', executablePath, executableSha256, packageName,
    }, { type: 'local', command: [runtime, f.entry] })
    for (const row of closure.files) expect(receipt.graph.files).toContainEqual(row)
    for (const alias of closure.aliases) expect(await realpath(alias.target)).toBe(alias.source)
  } finally { await rm(f.root, { recursive: true, force: true }) }
}, 120_000)

async function receiptFixture(platform: NodeJS.Platform = 'darwin') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-receipt-admission-')))
  const writePackage = async (directory: string, name: string, entry: string, version = '1.0.0') => {
    await mkdir(path.join(directory, path.dirname(entry)), { recursive: true })
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, dependencies: {} }))
    await writeFile(path.join(directory, entry), `export {} // ${name}`)
    return path.join(directory, entry)
  }
  const server = await writePackage(path.join(root, 'packages/server'), '@opencode/server', 'process.js', '2.0.32')
  const client = await writePackage(path.join(root, 'packages/client'), '@opencode/client', 'index.js', '2.0.32')
  const effect = await writePackage(path.join(root, 'packages/effect'), 'effect', 'index.js', '4.0.1')
  const mcpSdk = await writePackage(path.join(root, 'packages/mcp'), '@modelcontextprotocol/sdk', 'client/index.js')
  await writePackage(path.join(root, 'controller'), 'TEST-controller-entry', 'dist/controller.js')
  const nativeRoot = path.join(root, 'native/package')
  const executableName = platform === 'win32' ? 'opencode.exe' : 'opencode'
  const executablePath = path.join(nativeRoot, 'bin', executableName)
  await mkdir(path.dirname(executablePath), { recursive: true })
  await writeFile(path.join(nativeRoot, 'package.json'), JSON.stringify({
    name: `@opencode/cli-${platform === 'win32' ? 'windows' : platform}-${process.arch}`, version: '2.0.32',
  }))
  await writeFile(executablePath, platform === 'win32' ? peExecutable('TEST selected opencode.exe') : macho([]))
  const identity = {
    generation: 'v2' as const, version: '2.0.32' as const, dialect: 'v2-2.0.32' as const,
    executablePath, executableSha256: createHash('sha256').update(await readFile(executablePath)).digest('hex'),
    packageName: `@opencode/cli-${platform === 'win32' ? 'windows' : platform}-${process.arch}`,
  }
  const resolution = {
    '@opencode/server-v2.0.32/process': server,
    '@opencode/client-v2.0.32': client,
    'effect': effect,
    '@modelcontextprotocol/sdk/client/index.js': mcpSdk,
  }
  return {
    root, identity, resolution,
    controllerEntry: path.join(root, 'controller/dist/controller.js'),
  }
}

async function importReceiptHarness(readFile?: typeof fsPromises.readFile) {
  const receiptModule = new URL('./OpenCodeV2ExecutionReceipt.ts', import.meta.url).href
  mock.module(deliveryModule, () => ({
    ...actualDelivery,
    resolveOpenCodeV2ExecutionDelivery: async () => ({
      runtimeMode: 'source' as const, root: '/TEST-receipt-root',
      entryPath: '/TEST-receipt-root/src/entrypoints/opencodeV2ExecutionServer.ts',
      entrySha256: '0'.repeat(64),
    }),
  }))
  mock.module('node:fs/promises', () => ({
    ...actualFs,
    ...(readFile ? { readFile } : {}),
  }))
  return await import(`${receiptModule}?optional-node-admission=${Math.random().toString(36).slice(2)}`)
}

async function callReceipt<T>(
  fixture: Awaited<ReturnType<typeof receiptFixture>>,
  which: () => string | null,
  operation: (receipt: typeof import('./OpenCodeV2ExecutionReceipt.js')) => Promise<T>,
  readFile?: typeof fsPromises.readFile,
  platform: NodeJS.Platform = 'darwin',
): Promise<T> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const versions = process.versions as Record<string, unknown>
  const bunVersion = Object.getOwnPropertyDescriptor(process.versions, 'bun')
  const originalWhich = Bun.which, originalResolve = Bun.resolveSync
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform })
  Object.defineProperty(process.versions, 'bun', { configurable: true, value: openCodeBunVersion() })
  Bun.which = which as typeof Bun.which
  Bun.resolveSync = ((name: string) => {
    const resolved = fixture.resolution[name as keyof typeof fixture.resolution]
    if (!resolved) throw new Error(`TEST unexpected resolution: ${name}`)
    return resolved
  }) as typeof Bun.resolveSync
  try {
    const receipt = await importReceiptHarness(readFile)
    return await operation(receipt)
  } finally {
    try {
      mock.module(deliveryModule, () => ({ ...actualDelivery }))
      mock.module('node:fs/promises', () => ({ ...actualFs }))
    } finally {
      Bun.which = originalWhich
      Bun.resolveSync = originalResolve
      Object.defineProperty(process, 'platform', platformDescriptor)
      if (bunVersion) Object.defineProperty(process.versions, 'bun', bunVersion)
      else Reflect.deleteProperty(versions, 'bun')
    }
  }
}

test('missing or unusable optional PATH Node omits taskNode and leaves no partial closure rows', async () => {
  const f = await receiptFixture()
  try {
    for (const selected of [null, path.join(f.root, 'TEST-absent-node')]) {
      const receipt = await callReceipt(f, () => selected, module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', f.identity))
      expect(receipt.taskNode).toBeUndefined()
    }
    const existing = path.join(f.root, 'optional-existing.dylib'), missing = path.join(f.root, 'optional-missing.dylib')
    await writeFile(path.join(f.root, 'optional-partial-node'), macho([existing, missing]))
    await writeFile(existing, macho([]))
    const receipt = await callReceipt(f, () => path.join(f.root, 'optional-partial-node'),
      module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', f.identity))
    expect(receipt.taskNode).toBeUndefined()
    expect(receipt.graph.files.some(row => row.path === existing)).toBe(false)
    expect(receipt.graph.files.some(row => row.path === missing)).toBe(false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('complete qualified optional PATH Node closure is fully hashed and admitted', async () => {
  const f = await receiptFixture()
  const node = path.join(f.root, 'optional-complete-node'), dependency = path.join(f.root, 'liboptional.dylib')
  try {
    await writeFile(node, macho(['@loader_path/liboptional.dylib']))
    await writeFile(dependency, macho([]))
    const receipt = await callReceipt(f, () => node,
      module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', f.identity))
    expect(receipt.taskNode).toEqual({
      path: node,
      sha256: createHash('sha256').update(await readFile(node)).digest('hex'),
    })
    for (const file of [node, dependency]) {
      expect(receipt.graph.files).toContainEqual({
        path: file,
        sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
      })
    }
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('optional admission preserves unknown, abort and deadline failures', async () => {
  const f = await receiptFixture()
  const failures = [
    new Error('TEST unknown optional discovery failure'),
    new DOMException('controller_runtime_dependency_missing', 'AbortError'),
    new OpenCodeRuntimeDeadlineError('host_start', 10, 11),
  ]
  try {
    for (const failure of failures) {
      let caught: unknown
      try {
        await callReceipt(f, () => { throw failure },
          module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', f.identity))
      } catch (error) { caught = error }
      expect(caught).toBe(failure)
    }
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('mandatory controller qualification and optional graph hash conflicts remain fail-closed', async () => {
  const f = await receiptFixture()
  const node = path.join(f.root, 'conflicting-node'), dependency = path.join(f.root, 'mandatory-missing.dylib')
  try {
    await writeFile(node, macho([dependency]))
    await expect(callReceipt(f, () => node,
      module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', f.identity, {
        type: 'local', command: [node, f.controllerEntry],
      }))).rejects.toThrow('controller_runtime_dependency_missing')

    const replacement = Buffer.concat([macho([]), Buffer.alloc(8)])
    const trigger = path.join(f.root, 'controller/package.json')
    const readFile = (async (...args: unknown[]) => {
      const value = await (actualFs.readFile as unknown as (...values: unknown[]) => Promise<unknown>)(...args)
      if (String(args[0]) === trigger) await actualFs.writeFile(node, replacement)
      return value
    }) as typeof fsPromises.readFile
    await writeFile(node, macho([]))
    await expect(callReceipt(f, () => node,
      module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', f.identity, {
        type: 'local', command: [node, f.controllerEntry],
      }), readFile)).rejects.toThrow('controller_runtime_changed')
    expect(fsPromises.readFile).toBe(actualFs.readFile)
    expect(fsPromises.writeFile).toBe(actualFs.writeFile)
    expect(executionDelivery.resolveOpenCodeV2ExecutionDelivery).toBe(actualDelivery.resolveOpenCodeV2ExecutionDelivery)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test.skipIf(process.arch !== 'x64')('Windows receipt admits a canonical x64 node.exe and hashes its complete inspected image', async () => {
  const f = await receiptFixture('win32'), runtime = path.join(f.root, 'node.exe')
  const image = peExecutable('TEST complete node.exe image including trailing evidence')
  try {
    await writeFile(runtime, image)
    const receipt = await callReceipt(f, () => null,
      module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', f.identity, {
        type: 'local', command: [runtime, f.controllerEntry],
      }), undefined, 'win32')
    expect(receipt.executableSha256).toBe(f.identity.executableSha256)
    expect(receipt.graph.files).toContainEqual({
      path: runtime,
      sha256: createHash('sha256').update(image).digest('hex'),
    })
    expect(receipt.graph.files).toContainEqual({
      path: f.controllerEntry,
      sha256: createHash('sha256').update(await readFile(f.controllerEntry)).digest('hex'),
    })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test.skipIf(process.arch !== 'x64')('Windows receipt rejects malformed, truncated, wrong-architecture and DLL PE sources', async () => {
  const malformed = peExecutable(), truncated = peExecutable().subarray(0, 0x50)
  malformed.writeUInt32LE(0x1000, 0x3c)
  const wrongArchitecture = peExecutable(); wrongArchitecture.writeUInt16LE(0x014c, 0x44)
  const dll = peExecutable(); dll.writeUInt16LE(0x2022, 0x56)
  const cases = [
    { name: 'malformed', image: malformed, expected: 'native_selection_changed' },
    { name: 'truncated', image: truncated, expected: 'native_selection_changed' },
    { name: 'wrongarch', image: wrongArchitecture, expected: 'native_selection_changed' },
    { name: 'dll', image: dll, expected: 'native_selection_changed' },
  ]
  for (const target of ['selected', 'controller'] as const) {
    const f = await receiptFixture('win32')
    try {
      for (const testCase of cases) {
        const runtime = target === 'controller' ? path.join(f.root, 'node.exe') : f.identity.executablePath
        await writeFile(runtime, testCase.image)
        const identity = target === 'selected'
          ? { ...f.identity, executablePath: runtime,
            executableSha256: createHash('sha256').update(testCase.image).digest('hex') }
          : f.identity
        const expected = target === 'controller' && testCase.name === 'wrongarch'
          ? 'controller_runtime_architecture_invalid'
          : target === 'controller' ? 'controller_runtime_pe_invalid' : testCase.expected
        await expect(callReceipt(f, () => null,
          module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', identity, target === 'controller'
            ? { type: 'local', command: [runtime, f.controllerEntry] } : undefined),
          undefined, 'win32')).rejects.toThrow(expected)
      }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
})


test('receipt preserves actual unlisted CLI and standalone provenance while graph stays on its persisted engine', async () => {
  const f = await receiptFixture()
  const metadata = path.join(path.dirname(path.dirname(f.identity.executablePath)), 'package.json')
  const identity = { ...f.identity, version: '2.99.0' as const, engineVersion: '2.0.32' as const, origin: 'npm' as const }
  try {
    await writeFile(metadata, JSON.stringify({ name: identity.packageName, version: identity.version }))
    const receipt = await callReceipt(f, () => null, module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', identity))
    expect(receipt).toMatchObject({ version: '2.99.0', engineVersion: '2.0.32', dialect: 'v2-2.0.32', origin: 'npm', packageName: identity.packageName })
    expect(receipt.graph.files.some(row => row.path === f.resolution['@opencode/server-v2.0.32/process'])).toBe(true)
    await rm(metadata)
    const standalone = await callReceipt(f, () => null, module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', {
      ...identity, origin: 'standalone', packageName: null,
    }))
    expect(standalone).toMatchObject({ version: '2.99.0', engineVersion: '2.0.32', origin: 'standalone', packageName: null })
    expect(standalone.graph).toEqual(receipt.graph)
    await expect(callReceipt(f, () => null, module => module.createOpenCodeV2ExecutionReceipt('/TEST-unused', {
      ...identity, origin: 'standalone', packageName: null, executableSha256: '0'.repeat(64),
    }))).rejects.toThrow('native_selection_changed')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
