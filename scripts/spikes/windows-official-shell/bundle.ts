import path from 'node:path'
import { createHash } from 'node:crypto'
import { builtinModules, isBuiltin } from 'node:module'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile, readdir } from 'node:fs/promises'
import type { Artifact } from './fixture.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const within = (root: string, file: string) => { const relative = path.relative(root, file); if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('TEST bundle input escaped qualified install'); return relative }
export const bundledImportPath = (file: string): string => file.replaceAll('\\', '/')
export function renderBundledCheckpointEntry(imports: readonly string[], tables: readonly string[]): string {
  return `${imports.join('\n')}\nconst graphs = { ${tables.join(',\n')} };\nexport const runOfficialShellCheckpointBundled = (base: string) => runOfficialShellCheckpoint(base, async alias => { if (alias !== '@opencode/server-v2-floor' && alias !== '@opencode/server') throw new Error('TEST bundle pin not selected'); return graphs[alias]; });\n`
}
export async function collectBundledOutputs(outputs: readonly Bun.BuildArtifact[], directory: string, rawInputs: readonly Uint8Array[]) {
  const entries = outputs.filter(artifact => artifact.kind === 'entry-point')
  if (entries.length !== 1 || !entries[0]) throw new Error('TEST bundle requires exactly one entry point')
  const assets = new Map<string, { bytes: Buffer; sha256: string }>()
  for (const artifact of outputs) {
    if (artifact.kind === 'entry-point') continue
    if (artifact.kind !== 'asset' || artifact.loader !== 'file') throw new Error('TEST bundle unexpected non-asset output')
    const relative = within(directory, path.resolve(directory, artifact.path))
    if (!relative || relative === 'checkpoint-bundled.js') throw new Error('TEST bundle asset output collision')
    const bytes = Buffer.from(await artifact.arrayBuffer())
    if (!rawInputs.some(input => input.byteLength === bytes.byteLength && bytes.equals(input))) throw new Error('TEST bundle asset lacks exact raw input custody')
    const previous = assets.get(relative)
    if (previous && !previous.bytes.equals(bytes)) throw new Error('TEST bundle asset path has different bytes')
    if (!previous) assets.set(relative, { bytes, sha256: hash(bytes) })
  }
  return { entry: entries[0], assets }
}
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
  const buildDirectory = path.join(path.dirname(readonly), 'bundle-build')
  await mkdir(buildDirectory, { recursive: true })
  await writeFile(path.join(buildDirectory, 'stage.json'), JSON.stringify({ phase: 'select-before-effect-resolution', fullTaskQualified: false }))
  const sourceRoot = await realpath(path.resolve(import.meta.dir, '../../..'))
  const effectEntry = await realpath(Bun.resolveSync('effect', import.meta.dir))
  const effectIdentity = await packageIdentity(effectEntry)
  if (effectIdentity.name !== 'effect' || effectIdentity.version !== '4.0.0-rc.112') throw new Error('TEST bundle Effect pin mismatch')
  const selections: { pin: string; alias: string; entries: Record<string, string> }[] = []
  const imports: string[] = [`import { runOfficialShellCheckpoint } from ${JSON.stringify(bundledImportPath(path.join(import.meta.dir, 'checkpoint.ts')))};`]
  const tables: string[] = []
  for (const [index, [pin, alias]] of [['2.0.0', '@opencode/server-v2-floor'], ['2.0.21', '@opencode/server']].entries()) {
    await writeFile(path.join(buildDirectory, 'stage.json'), JSON.stringify({ phase: 'select-before-pin-resolution', pin, alias, fullTaskQualified: false }))
    const entry = await realpath(Bun.resolveSync(`${alias}/routes`, import.meta.dir))
    const entries: Record<string, string> = { routes: entry }
    for (const [key, specifier] of [['cross', '@opencode/util/cross-spawn-spawner'], ['locations', '@opencode/core/location-service-map'], ['location', '@opencode/core/location'], ['shell', '@opencode/core/shell'], ['schema', '@opencode/schema/schema'], ['http', '@effect/platform-node/NodeHttpServer']] as const) entries[key] = await realpath(Bun.resolveSync(specifier, path.dirname(entry)))
    for (const [key, file] of Object.entries(entries)) {
      within(sourceRoot, file)
      const identity = await packageIdentity(file)
      const expectedName = key === 'routes' ? '@opencode/server' : key === 'cross' ? '@opencode/util' : key === 'schema' ? '@opencode/schema' : key === 'http' ? '@effect/platform-node' : '@opencode/core'
      if (identity.name !== expectedName || (key !== 'http' && identity.version !== pin)) throw new Error('TEST bundle selected official package pin mismatch')
      if (await realpath(Bun.resolveSync('effect', path.dirname(file))) !== effectEntry) throw new Error('TEST bundle selected graph has a different Effect instance')
      imports.push(`import * as graph${index}_${key} from ${JSON.stringify(bundledImportPath(file))};`)
    }
    selections.push({ pin: pin!, alias: alias!, entries })
    tables.push(`${JSON.stringify(alias)}: { ${Object.keys(entries).map(key => `${key}: graph${index}_${key}`).join(', ')}, entry: ${JSON.stringify(path.join(readonly, within(sourceRoot, entry)))} }`)
  }
  // Generated TS has static, exact per-pin imports; no runtime package resolver.
  const generatedEntry = path.join(buildDirectory, 'checkpoint-entry.ts')
  await writeFile(generatedEntry, renderBundledCheckpointEntry(imports, tables))
  const stagePath = path.join(buildDirectory, 'stage.json')
  await writeFile(path.join(buildDirectory, 'selection.json'), JSON.stringify({ generatedEntry, generatedSha256: hash(await readFile(generatedEntry)), selections, effectEntry, fullTaskQualified: false }))
  await writeFile(stagePath, JSON.stringify({ phase: 'generated-entry-ready', fullTaskQualified: false }))
  const buildOutput = path.join(buildDirectory, 'checkpoint-bundled.js')
  const resultPath = path.join(buildDirectory, 'build-result.json')
  const child = Bun.spawn([process.execPath, import.meta.filename, '--build-only', generatedEntry, sourceRoot, buildOutput, resultPath, stagePath], {
    cwd: sourceRoot, env: { ...process.env }, stdout: Bun.file(path.join(buildDirectory, 'build.stdout')), stderr: Bun.file(path.join(buildDirectory, 'build.stderr')),
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000)
  let code: number
  try { code = await child.exited } finally { clearTimeout(timeout) }
  if (code !== 0) {
    await writeFile(path.join(buildDirectory, 'parent-result.json'), JSON.stringify({ phase: 'build-child-failed', code, signal: child.signalCode, fullTaskQualified: false }))
    throw new Error('TEST bundle child failed; retained build phase evidence')
  }
  const result: { inputs: { file: string; sha256: string }[]; assets: { path: string; sha256: string }[]; metafile: Bun.BuildMetafile } = JSON.parse(await readFile(resultPath, 'utf8'))
  const inputs = new Map<string, Buffer>()
  for (const input of result.inputs) {
    if (input.file !== generatedEntry) within(sourceRoot, input.file)
    const bytes = await readFile(input.file)
    if (hash(bytes) !== input.sha256) throw new Error('TEST bundle consumed source changed')
    inputs.set(input.file, bytes)
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
  await add(path.join(readonly, 'windows-official-shell', 'checkpoint-bundled.js'), await readFile(buildOutput), true)
  for (const asset of result.assets) {
    within(buildDirectory, path.resolve(buildDirectory, asset.path))
    const bytes = await readFile(path.join(buildDirectory, asset.path))
    if (hash(bytes) !== asset.sha256) throw new Error('TEST bundle emitted asset changed')
    await add(path.join(readonly, 'windows-official-shell', asset.path), bytes, true)
  }
  await add(path.join(readonly, 'windows-official-shell', 'bundle-provenance.json'), Buffer.from(JSON.stringify({ purpose: 'TEST-bundled-Shell-only', fullTaskQualified: false, bun: Bun.version, target: 'bun', format: 'esm', splitting: false, effectEntry: within(sourceRoot, effectEntry), selections, inputs: provenance, emittedAssets: result.assets, watcherDisabled: true, fffDisabled: true })), false)
  await add(path.join(readonly, 'windows-official-shell', 'bundle-metafile.json'), Buffer.from(JSON.stringify(result.metafile)), false)
  await writeFile(path.join(readonly, 'official-artifacts.json'), JSON.stringify(artifacts), { flag: 'wx' })
  return artifacts
}

async function buildOnly(generatedEntry: string, sourceRoot: string, output: string, resultPath: string, stagePath: string): Promise<void> {
  const inputs = new Map<string, Buffer>()
  const stage = (phase: string) => writeFileSync(stagePath, JSON.stringify({ phase, inputCount: inputs.size, fullTaskQualified: false }))
  stage('build-before-call')
  const result = await Bun.build({ entrypoints: [generatedEntry], target: 'bun', format: 'esm', splitting: false, minify: false, metafile: true,
    plugins: [{ name: 'TEST-pinned-source-provenance', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('node:') || args.path.startsWith('bun:')) return { path: args.path, external: true }
        if (builtinModules.includes(args.path)) return { path: `node:${args.path}`, external: true }
        return undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'file' }, args => {
        const file = realpathSync(args.path)
        if (file !== generatedEntry) within(sourceRoot, file)
        const bytes = readFileSync(file)
        inputs.set(file, bytes)
        if (inputs.size === 1) stage('build-first-source-loaded')
        return { contents: bytes, loader: args.loader }
      })
    } }] })
  stage('build-returned')
  await writeFile(path.join(path.dirname(stagePath), 'build-diagnostics.json'), JSON.stringify({
    success: result.success,
    outputCount: result.outputs.length,
    outputs: result.outputs.map(artifact => ({ path: artifact.path, kind: artifact.kind, loader: artifact.loader, bytes: artifact.size, hash: artifact.hash })),
    metafilePresent: result.metafile !== undefined && result.metafile !== null,
    logs: result.logs.map(log => ({ name: log.name, message: log.message, level: log.level, position: log.position })),
    fullTaskQualified: false,
  }), { flag: 'wx' })
  await writeFile(path.join(path.dirname(stagePath), 'build-metafile.json'), JSON.stringify(result.metafile ?? null), { flag: 'wx' })
  if (!result.success || !result.metafile) throw new Error('TEST bundled checkpoint build refused')
  const externalImports = Object.entries(result.metafile.inputs).flatMap(([source, input]) => input.imports.filter(imported => imported.external).map(imported => ({ source, ...imported, allowed: isBuiltin(imported.path) || imported.path.startsWith('bun:') })))
  await writeFile(path.join(path.dirname(stagePath), 'build-externals.json'), JSON.stringify({ imports: externalImports, offenders: externalImports.filter(imported => !imported.allowed), fullTaskQualified: false }), { flag: 'wx' })
  if (externalImports.some(imported => !imported.allowed)) throw new Error('TEST bundle retained an external non-builtin import')
  const emitted = await collectBundledOutputs(result.outputs, path.dirname(output), [...inputs.values()])
  const assets: { path: string; sha256: string }[] = []
  for (const [relative, asset] of emitted.assets) {
    await mkdir(path.dirname(path.join(path.dirname(output), relative)), { recursive: true })
    await writeFile(path.join(path.dirname(output), relative), asset.bytes, { flag: 'wx' })
    assets.push({ path: relative, sha256: asset.sha256 })
  }
  await writeFile(output, new Uint8Array(await emitted.entry.arrayBuffer()), { flag: 'wx' })
  await writeFile(resultPath, JSON.stringify({ inputs: [...inputs].map(([file, bytes]) => ({ file, sha256: hash(bytes) })), assets, metafile: result.metafile }), { flag: 'wx' })
  stage('build-result-published')
}
if (process.argv[2] === '--build-only') {
  const [entry, root, output, result, stage] = process.argv.slice(3)
  if (!entry || !root || !output || !result || !stage || process.versions.bun !== '1.3.11') throw new Error('TEST bundle child inputs invalid')
  await buildOnly(entry, root, output, result, stage)
}
