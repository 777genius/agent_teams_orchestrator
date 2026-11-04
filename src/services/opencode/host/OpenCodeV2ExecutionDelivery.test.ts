import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { resolveOpenCodeV2ExecutionDelivery } from './OpenCodeV2ExecutionDelivery.js'
import { canonicalOpenCodeV2DeliveryManifest, OPENCODE_V2_SUPPORT_ROOT_ENV } from './OpenCodeV2DeliveryContract.js'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { openCodeV2QualifiedVersions, openCodeV2LaunchRefusal } from '../compatibility/OpenCodeV2Registry.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const workspace = path.resolve(import.meta.dir, '../../../..')

test('Windows source delivery canonicalizes only its admitted src subtree and refuses aliases', async () => {
  const source = await readFile(new URL('./OpenCodeV2ExecutionDelivery.ts', import.meta.url), 'utf8')
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf('/** Resolve only'))
    .replaceAll('export ', ''))
  for (const platform of ['win32', 'darwin'] as const) for (const mode of ['source'] as const) {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const root = platform === 'win32' ? 'C:\\TEST-sdk' : '/TEST-sdk'
    const src = paths.join(root, 'src'), location = mode === 'source'
      ? paths.join(src, 'services/opencode/host/OpenCodeV2ExecutionDelivery.ts') : paths.join(root, 'cli.js')
    for (const alias of [false, ...(platform === 'win32' && mode === 'source' ? [true] : [])]) {
      const observed: string[] = [], reads: string[] = []
      const scope = { path: paths, process: { platform }, Bun: { main: 'TEST-bun' }, createHash,
        fileURLToPath: () => location,
        executionAssert: (value: unknown, code: string) => { if (!value) throw new Error(code) },
        filesystem: { realpath: async (file: string) => {
          observed.push(file)
          if (platform === 'win32' && mode === 'source' && file === root)
            throw Object.assign(new Error('TEST_unadmitted_parent'), { code: 'EPERM', syscall: 'lstat' })
          return alias && file === src ? paths.join(root, 'TEST-alias/src') : file
        } },
        readFile: async (file: string) => { reads.push(file); return Buffer.from('TEST-entry-bytes') },
      }
      const resolve = new Function('scope', `const {${Object.keys(scope).join(',')}}=scope;${body};return resolveOpenCodeV2ExecutionDelivery;`)(scope)
      if (alias) {
        await expect(resolve('file:///TEST-location', 'execution')).rejects.toThrow('execution_entry_changed')
        expect(observed).toEqual([src]); expect(reads).toEqual([])
      } else for (const [child, name] of [['execution', 'opencodeV2ExecutionServer'], ['run-owner', 'opencodeV2RunOwner']] as const) {
        observed.length = 0; reads.length = 0
        const entry = paths.join(root, mode === 'source' ? `src/entrypoints/${name}.ts` : `${name}.js`)
        expect(await resolve('file:///TEST-location', child)).toEqual({ runtimeMode: mode, root, entryPath: entry,
          entrySha256: sha('TEST-entry-bytes') })
        expect(observed).toEqual([platform === 'win32' && mode === 'source' ? src : root, entry])
        expect(reads).toEqual([entry])
      }
    }
  }
})

const qualifiedHere = openCodeV2QualifiedVersions().filter(pin => openCodeV2LaunchRefusal(pin) === null)
// Actual JS resolution must use the pinned external instance, even with adjacent/source lookalikes.
test.skipIf(process.versions.bun !== openCodeBunVersion() || qualifiedHere.length === 0)('actual JS bundle binds external children and refuses a missing hook without source fallback', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-js-delivery-')))
  try {
    const entry = path.join(root, 'harness.ts'), bundle = path.join(root, 'cli.js')
    const cache = path.join(root, 'support'), instance = randomUUID(), archiveSha256 = 'b'.repeat(64)
    const parent = path.join(cache, '0.0.999', `${process.platform}-${process.arch}`, archiveSha256), actual = path.join(parent, instance)
    await mkdir(path.join(actual, 'local-cli'), { recursive: true })
    const names = ['opencode-v2-graphs.json', 'opencodeV2ExecutionServer.js', 'opencodeV2RunOwner.js', 'opencodeV2Server.js']
    for (const name of names) await writeFile(path.join(actual, 'local-cli', name), 'TEST', { mode: 0o644 })
    const identity = { schemaVersion: 1 as const, runtimeVersion: '0.0.999', sourceCommit: 'a'.repeat(40), bridgeProtocol: 1 as const,
      platform: process.platform, arch: process.arch, requiredBunVersion: openCodeBunVersion(), engineVersions: qualifiedHere }
    const manifest = canonicalOpenCodeV2DeliveryManifest({ ...identity,
      files: names.map(name => ({ path: `local-cli/${name}`, bytes: 4, sha256: sha('TEST'), executable: false })) })
    const descriptor = { ...identity, archive: { file: `agent-teams-opencode-v2-support-${process.platform}-${process.arch}-v0.0.999.zip`,
      kind: 'zip', sha256: archiveSha256, bytes: 100, entries: names.length + 1, expandedBytes: Buffer.byteLength(manifest) + names.length * 4 },
      manifest: { file: 'opencode-v2-engine-manifest.json', sha256: sha(manifest), bytes: Buffer.byteLength(manifest), files: names.length } }
    await writeFile(path.join(actual, descriptor.manifest.file), manifest)
    await writeFile(path.join(parent, 'installed.json'), JSON.stringify({ schemaVersion: 1, runtimeVersion: identity.runtimeVersion,
      sourceCommit: identity.sourceCommit, bridgeProtocol: 1, platform: process.platform, arch: process.arch,
      archiveSha256, manifestSha256: descriptor.manifest.sha256, instance }))
    await writeFile(entry, `import { resolveOpenCodeV2ExecutionDelivery as resolve } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeV2ExecutionDelivery.ts'))};\nconsole.log(JSON.stringify(await Promise.all(['execution', 'run-owner'].map(child => resolve(import.meta.url, child)))));\n`)
    const result = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', minify: true,
      define: { OPENCODE_V2_DELIVERY_DESCRIPTOR: JSON.stringify(descriptor), OPENCODE_RUNTIME_SOURCE_COMMIT: JSON.stringify(identity.sourceCommit),
        OPENCODE_RUNTIME_VERSION: JSON.stringify(identity.runtimeVersion) } })
    expect(result.success).toBe(true)
    await writeFile(bundle, await result.outputs[0]!.text())
    await rm(entry)
    for (const name of ['opencodeV2ExecutionServer', 'opencodeV2RunOwner']) await writeFile(path.join(root, `${name}.js`), `export const name = '${name}'`)
    const env = { ...process.env, [OPENCODE_V2_SUPPORT_ROOT_ENV]: cache }
    const child = Bun.spawn([process.execPath, '--no-install', bundle], { env, stdout: 'pipe', stderr: 'pipe' })
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(error).toBe(''); expect(code).toBe(0)
    const rows = JSON.parse(output) as Awaited<ReturnType<typeof resolveOpenCodeV2ExecutionDelivery>>[]
    expect(rows.map(row => row.runtimeMode)).toEqual(['packaged', 'packaged'])
    expect(rows.map(row => row.root)).toEqual([path.join(actual, 'local-cli'), path.join(actual, 'local-cli')])
    for (const [index, name] of ['opencodeV2ExecutionServer', 'opencodeV2RunOwner'].entries()) {
      expect(rows[index]!.entryPath).toBe(path.join(actual, 'local-cli', `${name}.js`))
      expect(rows[index]!.entrySha256).toBe(sha(await readFile(rows[index]!.entryPath)))
    }
    await rm(path.join(actual, 'local-cli/opencodeV2ExecutionServer.js'))
    await mkdir(path.join(root, 'src/entrypoints'), { recursive: true })
    await writeFile(path.join(root, 'src/entrypoints/opencodeV2ExecutionServer.ts'), 'export {}')
    const missing = Bun.spawn([process.execPath, '--no-install', bundle], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(await missing.exited).not.toBe(0)
    expect(await new Response(missing.stderr).text()).toContain('ENOENT')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('source delivery keeps genuine TypeScript child paths and byte identities', async () => {
  for (const location of [import.meta.url]) {
  for (const [child, name] of [['execution', 'opencodeV2ExecutionServer'], ['run-owner', 'opencodeV2RunOwner']] as const) {
    const delivery = await resolveOpenCodeV2ExecutionDelivery(location, child)
    expect(delivery.runtimeMode).toBe('source')
    expect(delivery.root).toBe(workspace)
    expect(delivery.entryPath).toBe(path.join(workspace, `src/entrypoints/${name}.ts`))
    expect(delivery.entrySha256).toBe(sha(await readFile(delivery.entryPath)))
  }
  }
})

// Embedded Bun executables cannot be used as a separate JS child interpreter.
test('actual compiled Bun executable refuses embedded delivery before resolving disk children', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-compiled-delivery-')))
  try {
    const entry = path.join(root, 'compiled.ts'), binary = path.join(root, 'compiled')
    await writeFile(entry, `import { resolveOpenCodeV2ExecutionDelivery as resolve } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeV2ExecutionDelivery.ts'))};\nawait resolve(import.meta.url, 'execution');\n`)
    const build = Bun.spawn([process.execPath, 'build', entry, '--compile', '--outfile', binary], { stdout: 'ignore', stderr: 'pipe' })
    expect(await build.exited).toBe(0)
    const child = Bun.spawn([binary], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain('v2_compiled_runtime_unsupported')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)

// Bun caches named/namespace builtin exports even after syncBuiltinESMExports.
// Native Windows installs its permission-error fallback after these imports.
test('early delivery/profile consumers observe the subsequently installed realpath facade', async () => {
  const script = `
    const {resolveOpenCodeV2ExecutionDelivery}=await import(${JSON.stringify(new URL('./OpenCodeV2ExecutionDelivery.ts', import.meta.url).href)});
    const {canonicalExecutionDirectory}=await import(${JSON.stringify(new URL('./OpenCodeV2ExecutionBinding.ts', import.meta.url).href)});
    const fs=require('node:fs/promises'), original=fs.realpath;
    let observed=0;
    fs.realpath=(...args)=>{observed++;return original(...args)};
    require('node:module').syncBuiltinESMExports();
    try {
      const delivery=await resolveOpenCodeV2ExecutionDelivery(${JSON.stringify(new URL('./OpenCodeV2ExecutionDelivery.ts', import.meta.url).href)},'execution');
      await canonicalExecutionDirectory(delivery.root);
      if(observed!==3)throw Error('TEST realpath facade bypassed');
    } finally { fs.realpath=original;require('node:module').syncBuiltinESMExports(); }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, output }).toEqual({ code: 0, output: '' })
})
