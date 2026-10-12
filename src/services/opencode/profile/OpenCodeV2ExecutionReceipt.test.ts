import { test, expect } from 'bun:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createOpenCodeV2ExecutionReceipt, resolveOpenCodeV2ReceiptPackageRoot, resolveOpenCodeV2DarwinControllerRuntimeClosure } from './OpenCodeV2ExecutionReceipt.js'
import { DARWIN_SCOPE_POLICY } from '../host/darwin/OpenCodeV2DarwinPolicy.js'

test.skipIf(process.platform !== 'darwin')('selected native Node closure executes while an unrelated TEST sibling stays unreadable', async () => {
  const selected = Bun.which('node')
  expect(selected).not.toBeNull()
  const node = await realpath(selected!)
  const closure = await resolveOpenCodeV2DarwinControllerRuntimeClosure(node)
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-native-node-')))
  const project = path.join(root, 'project'), sentinel = path.join(root, 'foreign.txt')
  await mkdir(project); await writeFile(sentinel, 'TEST unrelated sibling')
  const quote = (value: string) => JSON.stringify(value)
  const policy = ['(version 1)', '(deny default)', '(import "system.sb")',
    '(allow process-exec)', '(allow file-read-metadata)', '(allow sysctl-read)', DARWIN_SCOPE_POLICY,
    '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin"))',
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom"))',
    ...closure.files.map(file => `(allow file-read* (literal ${quote(file.path)}))`),
    ...closure.aliases.map(alias => `(allow file-read* (literal ${quote(alias.target)}))`),
    `(allow file-read* file-write* (subpath ${quote(project)}))`,
  ].join('\n')
  try {
    const program = `const fs=require('node:fs'),a=require('node:assert/strict');
      a.equal(process.execPath,${JSON.stringify(node)});
      a.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}),e=>['EPERM','EACCES'].includes(e.code));
      a.equal(require('node:crypto').randomBytes(4).length,4);
      a.ok(new Intl.NumberFormat('en').format(123));
      fs.writeFileSync('result.txt','TEST native Node passed\\n');`
    const child = Bun.spawn(['/usr/bin/sandbox-exec', '-p', policy, '/bin/sh', '-c', `node -e ${"'" + program.replaceAll("'", "'\\''") + "'"}`],
      { cwd: project, env: { PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: project, OPENSSL_CONF: '/dev/null' }, stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode, stderr).toBe(0)
    expect(await readFile(path.join(project, 'result.txt'), 'utf8')).toBe('TEST native Node passed\n')
    expect(await readFile(sentinel, 'utf8')).toBe('TEST unrelated sibling')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15_000)

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
      generation: 'v2', version: '2.0.21', dialect: 'v2-2.0.21', executablePath, executableSha256, packageName,
    }, { type: 'local', command: [runtime, f.entry] })
    for (const row of closure.files) expect(receipt.graph.files).toContainEqual(row)
    for (const alias of closure.aliases) expect(await realpath(alias.target)).toBe(alias.source)
  } finally { await rm(f.root, { recursive: true, force: true }) }
}, 120_000)
