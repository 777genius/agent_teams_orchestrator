import path from 'node:path'
import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { mkdir, readFile, realpath, writeFile, readdir } from 'node:fs/promises'
import type { Artifact } from './fixture.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const within = (root: string, file: string) => { const relative = path.relative(root, file); if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('TEST bundle input escaped qualified install'); return relative }
async function packageIdentity(file: string): Promise<{ root: string; name: string; version: string }> {
  let root = path.dirname(file)
  for (;;) {
    const metadata: unknown = await readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null })
    if (metadata && typeof metadata === 'object' && ('name' in metadata || 'version' in metadata)) {
      if (!('name' in metadata) || typeof metadata.name !== 'string' || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('TEST bundle package identity malformed')
      return { root, name: metadata.name, version: metadata.version }
    }
    const parent = path.dirname(root); if (parent === root) throw new Error('TEST bundle package identity absent'); root = parent
  }
}

export async function stageBundledFixture(readonly: string): Promise<Artifact[]> {
  if (Bun.version !== '1.3.11' || process.platform !== 'win32') throw new Error('TEST bundle requires pinned Windows Bun')
  const sourceRoot = await realpath(path.resolve(import.meta.dir, '../../..'))
  const effectEntry = await realpath(Bun.resolveSync('effect', import.meta.dir))
  const effectIdentity = await packageIdentity(effectEntry)
  if (effectIdentity.name !== 'effect' || effectIdentity.version !== '4.0.0-rc.112') throw new Error('TEST bundle Effect pin mismatch')
  const selections: { pin: string; alias: string; entries: Record<string, string> }[] = []
  const imports: string[] = [`import { runOfficialShellCheckpoint } from ${JSON.stringify(path.join(import.meta.dir, 'checkpoint.ts').replaceAll('\\', '/'))};`]
  const tables: string[] = []
  for (const [index, [pin, alias]] of [['2.0.0', '@opencode/server-v2-floor'], ['2.0.21', '@opencode/server']].entries()) {
    const entry = await realpath(Bun.resolveSync(`${alias}/routes`, import.meta.dir))
    const entries: Record<string, string> = { routes: entry }
    for (const [key, specifier] of [['cross', '@opencode/util/cross-spawn-spawner'], ['locations', '@opencode/core/location-service-map'], ['location', '@opencode/core/location'], ['shell', '@opencode/core/shell'], ['schema', '@opencode/schema/schema'], ['http', '@effect/platform-node/NodeHttpServer']] as const) entries[key] = await realpath(Bun.resolveSync(specifier, path.dirname(entry)))
    for (const [key, file] of Object.entries(entries)) {
      within(sourceRoot, file)
      const identity = await packageIdentity(file)
      const expectedName = key === 'routes' ? '@opencode/server' : key === 'cross' ? '@opencode/util' : key === 'schema' ? '@opencode/schema' : key === 'http' ? '@effect/platform-node' : '@opencode/core'
      if (identity.name !== expectedName || (key !== 'http' && identity.version !== pin)) throw new Error('TEST bundle selected official package pin mismatch')
      if (await realpath(Bun.resolveSync('effect', path.dirname(file))) !== effectEntry) throw new Error('TEST bundle selected graph has a different Effect instance')
      imports.push(`import * as graph${index}_${key} from ${JSON.stringify(file.replaceAll('\\', '/'))};`)
    }
    selections.push({ pin: pin!, alias: alias!, entries })
    tables.push(`${JSON.stringify(alias)}: { ${Object.keys(entries).map(key => `${key}: graph${index}_${key}`).join(', ')}, entry: ${JSON.stringify(path.join(readonly, within(sourceRoot, entry)))} }`)
  }
  // Generated TS has static, exact per-pin imports; no runtime package resolver.
  const buildDirectory = path.join(path.dirname(readonly), 'bundle-build')
  await mkdir(buildDirectory, { recursive: true })
  const generatedEntry = path.join(buildDirectory, 'checkpoint-entry.ts')
  await writeFile(generatedEntry, `${imports.join('\n')}\nconst graphs = { ${tables.join(',\n')} };\nexport const runOfficialShellCheckpointBundled = (base: string) => runOfficialShellCheckpoint(base, async alias => { if (alias !== '@opencode/server-v2-floor' && alias !== '@opencode/server') throw new Error('TEST bundle pin not selected'); return graphs[alias]; });\n`)
  const inputs = new Map<string, Buffer>()
  const result = await Bun.build({ entrypoints: [generatedEntry], target: 'bun', format: 'esm', splitting: false, minify: false, metafile: true,
    plugins: [{ name: 'TEST-pinned-source-provenance', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('node:') || args.path.startsWith('bun:')) return { path: args.path, external: true }
        if (builtinModules.includes(args.path)) return { path: `node:${args.path}`, external: true }
        return undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
        const file = await realpath(args.path)
        if (file !== generatedEntry) within(sourceRoot, file)
        inputs.set(file, await readFile(file))
        return undefined
      })
    } }] })
  if (!result.success || result.outputs.filter(output => output.kind === 'entry-point').length !== 1) throw new Error('TEST bundled checkpoint build refused')
  if (!result.metafile) throw new Error('TEST bundle import metadata absent')
  for (const input of Object.values(result.metafile.inputs)) for (const imported of input.imports) {
    if (imported.external && !imported.path.startsWith('node:') && !imported.path.startsWith('bun:')) throw new Error('TEST bundle retained an external non-builtin import')
  }
  const artifacts: Artifact[] = [], provenance: { path: string; sha256: string; bytes: number; lf: number; crlf: number; dynamicReferences: string[] }[] = []
  const add = async (destination: string, bytes: Uint8Array, metadataReadInput: boolean) => {
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx' })
    artifacts.push({ path: path.relative(readonly, destination), sha256: hash(bytes), metadataReadInput })
  }
  const packageRoots = new Set<string>()
  for (const [file, bytes] of inputs) {
    if (hash(await readFile(file)) !== hash(bytes)) throw new Error('TEST bundle raw source changed during build')
    const relative = file === generatedEntry ? 'bundle-provenance/checkpoint-entry.ts' : within(sourceRoot, file)
    // Preserve vendor bytes at their original package-relative paths, rather
    // than treating bundled code as the original published source.
    await add(path.join(readonly, relative), bytes, false)
    const text = bytes.toString('utf8')
    provenance.push({ path: relative, sha256: hash(bytes), bytes: bytes.length, lf: (text.match(/\n/g) ?? []).length, crlf: (text.match(/\r\n/g) ?? []).length,
      dynamicReferences: text.split('\n').filter(line => /import\.meta\.(?:url|dir)|createRequire\(|(?:import|require\w*)\(\s*[^'"\s]/.test(line)).map(line => line.trim()).slice(0, 64) })
    if (file.includes(`${path.sep}node_modules${path.sep}`)) {
      const identity = await packageIdentity(file)
      if (identity.name === 'effect' && identity.root !== effectIdentity.root) throw new Error('TEST bundle consumed a second physical Effect instance')
      packageRoots.add(identity.root)
    }
  }
  const copied = new Set(artifacts.map(artifact => artifact.path))
  for (const root of packageRoots) {
    const manifest = path.join(root, 'package.json'), relative = within(sourceRoot, manifest)
    if (!copied.has(relative)) { await add(path.join(readonly, relative), await readFile(manifest), false); copied.add(relative) }
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(file)
        else if (entry.isFile() && /\.(?:node|dll|exe|wasm)$/i.test(entry.name)) {
          const relative = within(sourceRoot, file)
          if (!copied.has(relative)) { await add(path.join(readonly, relative), await readFile(file), true); copied.add(relative) }
        }
      }
    }
    await walk(root)
  }
  for (const output of result.outputs) {
    if (output.kind !== 'entry-point') throw new Error('TEST bundle emitted an unreviewed asset/chunk')
    const bytes = new Uint8Array(await output.arrayBuffer())
    await add(path.join(readonly, 'windows-official-shell', 'checkpoint-bundled.js'), bytes, true)
  }
  await add(path.join(readonly, 'windows-official-shell', 'bundle-provenance.json'), Buffer.from(JSON.stringify({ purpose: 'TEST-bundled-Shell-only', fullTaskQualified: false, bun: Bun.version, target: 'bun', format: 'esm', splitting: false, effectEntry: within(sourceRoot, effectEntry), selections, inputs: provenance, watcherDisabled: true, fffDisabled: true })), false)
  await add(path.join(readonly, 'windows-official-shell', 'bundle-metafile.json'), Buffer.from(JSON.stringify(result.metafile)), false)
  await writeFile(path.join(readonly, 'official-artifacts.json'), JSON.stringify(artifacts), { flag: 'wx' })
  return artifacts
}
