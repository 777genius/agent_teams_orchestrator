import type { Metafile, Plugin } from 'esbuild'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile, readdir } from 'node:fs/promises'
import type { Artifact } from './fixture.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const within = (root: string, file: string) => { const relative = path.relative(root, file); if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('TEST bundle input escaped qualified install'); return relative }
export const bundledImportPath = (file: string): string => file.replaceAll('\\', '/')
export function renderBundledCheckpointEntry(imports: readonly string[], tables: readonly string[]): string {
  return `${imports.join('\n')}\nconst graphs = { ${tables.join(',\n')} };\nexport const runOfficialShellCheckpointBundled = (base: string) => runOfficialShellCheckpoint(base, async alias => { if (alias !== '@opencode/server-v2-floor' && alias !== '@opencode/server') throw new Error('TEST bundle pin not selected'); return graphs[alias]; });\n`
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

// Read independently in both processes; child-reported hashes are not authority.
export function readBundledCompilerIdentity(sourceRoot: string) {
  const manifest = realpathSync(Bun.resolveSync('esbuild/package.json', sourceRoot))
  const binaryManifest = realpathSync(Bun.resolveSync('@esbuild/win32-x64/package.json', sourceRoot))
  const binary = realpathSync(path.join(path.dirname(binaryManifest), 'esbuild.exe'))
  for (const file of [manifest, binaryManifest, binary]) within(sourceRoot, file)
  for (const [file, name] of [[manifest, 'esbuild'], [binaryManifest, '@esbuild/win32-x64']]) {
    const metadata: unknown = JSON.parse(readFileSync(file!, 'utf8'))
    if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== name || !('version' in metadata) || metadata.version !== '0.28.2') throw new Error('TEST compiler published identity mismatch')
    if (name === '@esbuild/win32-x64' && (!('os' in metadata) || !Array.isArray(metadata.os) || !metadata.os.includes('win32') || !('cpu' in metadata) || !Array.isArray(metadata.cpu) || !metadata.cpu.includes('x64'))) throw new Error('TEST compiler binary platform mismatch')
  }
  return { name: 'esbuild', version: '0.28.2', manifestSha256: hash(readFileSync(manifest)), binaryManifestSha256: hash(readFileSync(binaryManifest)), binarySha256: hash(readFileSync(binary)), lockSha256: hash(readFileSync(path.join(sourceRoot, 'bun.lock'))) }
}
export function verifyBundledCompilerIdentity(sourceRoot: string, expected: ReturnType<typeof readBundledCompilerIdentity>, reported: ReturnType<typeof readBundledCompilerIdentity>): void {
  if (JSON.stringify(readBundledCompilerIdentity(sourceRoot)) !== JSON.stringify(expected) || JSON.stringify(reported) !== JSON.stringify(expected)) throw new Error('TEST compiler changed or child identity disagrees')
}

export function resolveBundledJsoncEntry(importer: string, sourceRoot: string) {
  const file = realpathSync(importer)
  within(sourceRoot, file)
  const importers = [
    { file: path.join(sourceRoot, 'node_modules/@opencode/server-v2-floor/node_modules/@opencode/core/dist/chunks/aisdk-native-y9tfvs3x.js'), sha256: '589433c1718d8d2504d8bcbd2a0980b78b4ccf2a59f5590713ee62763f44c87d' },
    { file: path.join(sourceRoot, 'node_modules/@opencode/core/dist/chunks/job-f09mb087.js'), sha256: '4e3afaa397c91d4a7792214df5b9851e94a335d0bcac9d867ec8ccc6e7ddcd1e' },
  ]
  const selected = importers.find(item => realpathSync(item.file) === file)
  if (!selected || hash(readFileSync(file)) !== selected.sha256) throw new Error('TEST jsonc-parser importer differs from selected official config')
  const manifest = realpathSync(Bun.resolveSync('jsonc-parser/package.json', path.dirname(file)))
  within(sourceRoot, manifest)
  const manifestBytes = readFileSync(manifest), metadata: unknown = JSON.parse(manifestBytes.toString('utf8'))
  if (hash(manifestBytes) !== 'a7a9192caaac00d9330592f4fd572908bee037518128a0fc3db96d2cd652e2b5' || !metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== 'jsonc-parser' || !('version' in metadata) || metadata.version !== '3.3.1' || !('main' in metadata) || metadata.main !== './lib/umd/main.js' || !('module' in metadata) || metadata.module !== './lib/esm/main.js') throw new Error('TEST jsonc-parser published module identity mismatch')
  const root = path.dirname(manifest), entry = realpathSync(path.join(root, metadata.module)), original = realpathSync(path.join(root, metadata.main))
  within(root, entry); within(root, original)
  const entrySha256 = hash(readFileSync(entry)), originalSha256 = hash(readFileSync(original))
  if (entrySha256 !== '72ff182105e158a1505ca3ecbf3f30359abb138a3980edaef1db7f4010ffb7dc' || originalSha256 !== '6dc132e2e792a9616688ff93d10dd671c1fbcfa3301d76bff3e81193d049337d') throw new Error('TEST jsonc-parser published entry bytes mismatch')
  return { specifier: 'jsonc-parser', importer: file, importerSha256: selected.sha256, manifest, manifestSha256: hash(manifestBytes), original, originalSha256, entry, entrySha256 }
}

type BundleImportFailure = {
  kind: string; name?: string; _tag?: string; message?: string; stack?: string;
  value?: string | number | boolean | null; cause?: BundleImportFailure; error?: BundleImportFailure;
  defect?: BundleImportFailure; reasons?: BundleImportFailure[]; truncated?: boolean; unavailableFields?: string[];
}
// Only TEST compile/import failures, never native/model/provider response data.
export function describeBundleImportFailure(value: unknown): BundleImportFailure {
  const seen = new WeakSet<object>()
  let nodes = 0, fields = 0
  const visit = (value: unknown, depth: number): BundleImportFailure => {
    const kind = value === null ? 'null' : typeof value
    if (++nodes > 16 || depth > 2) return { kind, truncated: true }
    if (value === null) return { kind, value: null }
    if (typeof value === 'string') return { kind, value: value.slice(0, 2048) }
    if (typeof value === 'boolean') return { kind, value }
    if (typeof value === 'number') return { kind, value: Number.isFinite(value) ? value : String(value) }
    if (typeof value === 'bigint' || typeof value === 'symbol') return { kind, value: String(value).slice(0, 2048) }
    if (typeof value !== 'object' && typeof value !== 'function') return { kind }
    if (seen.has(value)) return { kind: 'circular' }
    seen.add(value)
    const result: BundleImportFailure = { kind }
    const field = (key: string): unknown => {
      if (++fields > 64) { result.truncated = true; return undefined }
      try { return Reflect.get(value, key) }
      catch { (result.unavailableFields ??= []).push(key); return undefined }
    }
    for (const [key, limit] of [['name', 128], ['_tag', 128], ['message', 2048], ['stack', 8192]] as const) {
      const found = field(key)
      if (typeof found === 'string') result[key] = found.slice(0, limit)
    }
    // Fixed fields preserve Error causes and Effect Fail(error)/Die(defect).
    for (const key of ['cause', 'error', 'defect'] as const) {
      const found = field(key)
      if (found !== undefined) result[key] = visit(found, depth + 1)
    }
    const reasons = field('reasons')
    try {
      if (Array.isArray(reasons)) {
        result.reasons = Array.prototype.slice.call(reasons, 0, 4).map(reason => visit(reason, depth + 1))
        if (reasons.length > 4) result.truncated = true
      }
    } catch { (result.unavailableFields ??= []).push('reasons') }
    return result
  }
  return visit(value, 0)
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
  let loggerSelection: { path: string; sha256: string; barrelPath: string; manifestPath: string; manifestSha256: string; name: string; version: string } | undefined
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
    const loggerBarrel = await realpath(Bun.resolveSync('drizzle-orm/effect-core', path.dirname(entry)))
    const loggerIdentity = await packageIdentity(loggerBarrel)
    if (loggerIdentity.name !== 'drizzle-orm' || loggerIdentity.version !== '1.0.0-rc.5-169397b') throw new Error('TEST bundle Drizzle pin mismatch')
    const loggerPath = await realpath(path.join(loggerIdentity.root, 'effect-core', 'logger.js'))
    const loggerManifest = path.join(loggerIdentity.root, 'package.json')
    within(sourceRoot, loggerBarrel); within(loggerIdentity.root, loggerPath); within(sourceRoot, loggerManifest)
    if (await realpath(Bun.resolveSync('effect', path.dirname(loggerPath))) !== effectEntry) throw new Error('TEST bundle logger has a different Effect instance')
    const selectedLogger = { path: loggerPath, sha256: hash(await readFile(loggerPath)), barrelPath: loggerBarrel, manifestPath: loggerManifest, manifestSha256: hash(await readFile(loggerManifest)), name: loggerIdentity.name, version: loggerIdentity.version }
    if (loggerSelection && JSON.stringify(loggerSelection) !== JSON.stringify(selectedLogger)) throw new Error('TEST bundle pins have different logger sources')
    loggerSelection = selectedLogger
    selections.push({ pin: pin!, alias: alias!, entries })
    tables.push(`${JSON.stringify(alias)}: { ${Object.keys(entries).map(key => `${key}: graph${index}_${key}`).join(', ')}, entry: ${JSON.stringify(path.join(readonly, within(sourceRoot, entry)))} }`)
  }
  if (!loggerSelection) throw new Error('TEST bundle logger selection absent')
  imports.push(`import { EffectLogger as diagnosticDirectLogger } from ${JSON.stringify(bundledImportPath(loggerSelection.path))};`)
  imports.push('export const bundledLoggerBinding = { direct: diagnosticDirectLogger };')
  // Generated TS has static, exact per-pin imports; no runtime package resolver.
  const generatedEntry = path.join(buildDirectory, 'checkpoint-entry.ts')
  await writeFile(generatedEntry, renderBundledCheckpointEntry(imports, tables))
  const stagePath = path.join(buildDirectory, 'stage.json')
  await writeFile(path.join(buildDirectory, 'selection.json'), JSON.stringify({ generatedEntry, generatedSha256: hash(await readFile(generatedEntry)), selections, effectEntry, loggerSelection, fullTaskQualified: false }))
  await writeFile(stagePath, JSON.stringify({ phase: 'generated-entry-ready', fullTaskQualified: false }))
  const buildOutput = path.join(buildDirectory, 'checkpoint-bundled.js')
  const resultPath = path.join(buildDirectory, 'build-result.json')
  const compilerBefore = readBundledCompilerIdentity(sourceRoot)
  const selectedSourcesBefore = [...new Set([generatedEntry, import.meta.filename, path.join(import.meta.dir, 'checkpoint.ts'), effectEntry, loggerSelection.path, ...selections.flatMap(selection => Object.values(selection.entries))])].map(file => ({ file, sha256: hash(readFileSync(file)) }))
  await writeFile(path.join(buildDirectory, 'parent-before.json'), JSON.stringify({ compiler: compilerBefore, sources: selectedSourcesBefore, fullTaskQualified: false }), { flag: 'wx' })
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
  const result: { inputs: { file: string; sha256: string }[]; transformations: never[]; resolutions: ReturnType<typeof resolveBundledJsoncEntry>[]; nativeAssets: { file: string; relative: string; sha256: string; manifest: string; manifestSha256: string; wrapper: string; wrapperSha256: string }[]; ptyAssets: { manifest: string; manifestSha256: string; terminal: string; terminalSha256: string; assets: { file: string; relative: string; sha256: string; wrapper: string; wrapperSha256: string }[] }; compiler: ReturnType<typeof readBundledCompilerIdentity>; assets: { path: string; sha256: string }[]; loggerBinding: { directExportRetained: boolean }, metafile: Metafile } = JSON.parse(await readFile(resultPath, 'utf8'))
  verifyBundledCompilerIdentity(sourceRoot, compilerBefore, result.compiler)
  for (const original of selectedSourcesBefore) if (hash(readFileSync(original.file)) !== original.sha256) throw new Error('TEST selected source changed during child build')
  const inputs = new Map<string, Buffer>()
  for (const input of result.inputs) {
    if (input.file !== generatedEntry) within(sourceRoot, input.file)
    const bytes = await readFile(input.file)
    if (hash(bytes) !== input.sha256) throw new Error('TEST bundle consumed source changed')
    inputs.set(input.file, bytes)
  }
  if (hash(inputs.get(loggerSelection.path) ?? Buffer.alloc(0)) !== loggerSelection.sha256 || result.loggerBinding.directExportRetained !== true || hash(await readFile(loggerSelection.manifestPath)) !== loggerSelection.manifestSha256) throw new Error('TEST bundle logger retained source binding absent')
  if (result.transformations.length !== 0 || result.compiler.name !== 'esbuild' || result.compiler.version !== '0.28.2' || result.compiler.lockSha256 !== hash(await readFile(path.join(sourceRoot, 'bun.lock')))) throw new Error('TEST clean compiler custody mismatch')
  if (result.resolutions.length !== 2 || new Set(result.resolutions.map(item => item.importer)).size !== 2) throw new Error('TEST jsonc-parser selected config resolutions incomplete')
  for (const resolution of result.resolutions) if (JSON.stringify(resolveBundledJsoncEntry(resolution.importer, sourceRoot)) !== JSON.stringify(resolution) || hash(inputs.get(resolution.entry) ?? Buffer.alloc(0)) !== resolution.entrySha256) throw new Error('TEST jsonc-parser published selection custody changed')
  for (const asset of [...result.nativeAssets, ...result.ptyAssets.assets]) {
    if (hash(inputs.get(asset.file) ?? Buffer.alloc(0)) !== asset.sha256 || hash(Buffer.from(asset.wrapper)) !== asset.wrapperSha256 || !result.assets.some(output => output.path === asset.relative && output.sha256 === asset.sha256)) throw new Error('TEST relocated asset source/output custody mismatch')
  }
  for (const asset of result.nativeAssets) if (hash(await readFile(asset.manifest)) !== asset.manifestSha256) throw new Error('TEST native asset manifest changed')
  if (hash(await readFile(result.ptyAssets.manifest)) !== result.ptyAssets.manifestSha256 || hash(inputs.get(result.ptyAssets.terminal) ?? Buffer.alloc(0)) !== result.ptyAssets.terminalSha256) throw new Error('TEST PTY filename consumer custody changed')
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
  await add(path.join(readonly, 'windows-official-shell', 'bundle-provenance.json'), Buffer.from(JSON.stringify({ purpose: 'TEST-bundled-Shell-only', fullTaskQualified: false, bun: Bun.version, compiler: result.compiler, platform: 'node', conditions: ['bun'], target: 'esnext', format: 'esm', splitting: false, effectEntry: within(sourceRoot, effectEntry), loggerSelection, loggerBinding: result.loggerBinding, selections, inputs: provenance, transformations: result.transformations, resolutions: result.resolutions, nativeAssets: result.nativeAssets, ptyAssets: result.ptyAssets, emittedAssets: result.assets, watcherDisabled: true, fffDisabled: true })), false)
  await add(path.join(readonly, 'windows-official-shell', 'bundle-metafile.json'), Buffer.from(JSON.stringify(result.metafile)), false)
  await writeFile(path.join(readonly, 'official-artifacts.json'), JSON.stringify(artifacts), { flag: 'wx' })
  return artifacts
}

// TEST-only published native addon relocation.
// CJS wrappers return native exports, not the string returned by esbuild's file loader.
function nativeAddonCustody(sourceRoot: string, outputRoot: string, expectedAddons: readonly { file: string; sha256: string }[]) {
  sourceRoot = realpathSync(sourceRoot)
  outputRoot = realpathSync(outputRoot)
  const symbol = '__TEST_ESBUILD_NATIVE_REQUIRE__'
  const names = [symbol, '__TEST_CREATE_NATIVE_REQUIRE__', '__TEST_NATIVE_FILE_URL__']
  const expected = new Map(expectedAddons.map(addon => [realpathSync(addon.file), addon.sha256]))
  if (expected.size !== expectedAddons.length || [...expected.values()].some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('TEST selected native hash inventory malformed')
  const assets = new Map<string, { source: string; target: string; bytes: Buffer; sha256: string; manifest: string; manifestSha256: string; wrapper: string; wrapperSha256: string }>()
  const platformNames = process.platform === 'linux' && process.arch === 'x64'
    ? ['@yuuang/ffi-rs-linux-x64-gnu', '@yuuang/ffi-rs-linux-x64-musl']
    : process.platform === 'win32' && process.arch === 'x64'
      ? ['@yuuang/ffi-rs-win32-x64-msvc'] : []
  if (!platformNames.length) throw new Error('TEST native asset proposal supports only measured Linux/Windows x64 graphs')
  const within = (file: string) => {
    const relative = path.relative(sourceRoot, file)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('TEST native addon outside frozen graph')
  }
  const plugin: Plugin = { name: 'TEST-exact-native-addon-custody', setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?)$/, namespace: 'file' }, args => {
      const text = readFileSync(args.path, 'utf8')
      if (names.some(name => text.includes(name))) throw new Error('TEST native banner identifier collides with raw source')
      return undefined
    })
    builder.onLoad({ filter: /\.node$/, namespace: 'file' }, args => {
      const file = realpathSync(args.path), root = path.dirname(file), manifest = path.join(root, 'package.json')
      within(file); within(manifest)
      const manifestBytes = readFileSync(manifest)
      const metadata: unknown = JSON.parse(manifestBytes.toString('utf8'))
      if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || typeof metadata.name !== 'string' || !platformNames.includes(metadata.name)
        || !('version' in metadata) || metadata.version !== '1.3.7' || !('main' in metadata) || typeof metadata.main !== 'string'
        || realpathSync(path.resolve(root, metadata.main)) !== file
        || !('os' in metadata) || !Array.isArray(metadata.os) || !metadata.os.includes(process.platform)
        || !('cpu' in metadata) || !Array.isArray(metadata.cpu) || !metadata.cpu.includes(process.arch)) throw new Error('TEST native addon published platform identity mismatch')
      const bytes = readFileSync(file), sha256 = hash(bytes)
      if (expected.get(file) !== sha256) throw new Error('TEST native addon differs from preselected raw hash')
      const relative = `native-assets/${sha256}-${path.basename(file)}`
      const target = path.join(outputRoot, relative)
      if (path.relative(outputRoot, target) !== relative.split('/').join(path.sep)) throw new Error('TEST native addon output escaped')
      const wrapper = `module.exports = ${symbol}(${JSON.stringify(`./${relative}`)});\n`
      const previous = assets.get(relative)
      if (previous && !previous.bytes.equals(bytes)) throw new Error('TEST native asset hash/path collision')
      assets.set(relative, { source: file, target, bytes, sha256, manifest, manifestSha256: hash(manifestBytes), wrapper, wrapperSha256: hash(Buffer.from(wrapper)) })
      return { contents: wrapper, loader: 'js', resolveDir: root }
    })
  } }
  // The banner is emitted ESM; wrappers remain CJS and are evaluated only by the
  // original ffi-rs branch's require. No vendor JS is changed and no npm is external.
  const banner = `import { createRequire as __TEST_CREATE_NATIVE_REQUIRE__ } from 'node:module';\nimport { fileURLToPath as __TEST_NATIVE_FILE_URL__ } from 'node:url';\nconst ${symbol} = relative => __TEST_CREATE_NATIVE_REQUIRE__(import.meta.url)(__TEST_NATIVE_FILE_URL__(new URL(relative, import.meta.url)));`
  const verifyUnchanged = () => {
    for (const asset of assets.values()) if (hash(readFileSync(asset.source)) !== asset.sha256 || hash(readFileSync(asset.manifest)) !== asset.manifestSha256) throw new Error('TEST native addon custody changed')
  }
  return { plugin, banner, symbol, assets, verifyUnchanged }
}

// TEST-only: bun-pty 0.4.8's published require-as-filename site.
function ptyLibraryCustody(sourceRoot: string, outputRoot: string, expected: readonly { file: string; sha256: string }[]) {
  const root = realpathSync(path.join(sourceRoot, 'node_modules/bun-pty'))
  const relativeRoot = path.relative(realpathSync(sourceRoot), root)
  if (!relativeRoot || relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) throw new Error('TEST PTY package escaped frozen graph')
  const manifest = path.join(root, 'package.json'), manifestBytes = readFileSync(manifest)
  const metadata: unknown = JSON.parse(manifestBytes.toString('utf8'))
  if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== 'bun-pty' || !('version' in metadata) || metadata.version !== '0.4.8') throw new Error('TEST PTY published package changed')
  const terminal = realpathSync(path.join(root, 'src/terminal.ts'))
  const terminalSha256 = hash(readFileSync(terminal))
  if (terminalSha256 !== '0c6cdf358568816ec96aef9b320239ef6f9552e9298f8609f0c94cfb12ad51f9') throw new Error('TEST PTY filename consumer source changed')
  const filenames = ['rust_pty.dll', 'librust_pty.dylib', 'librust_pty_arm64.dylib', 'librust_pty.so', 'librust_pty_arm64.so']
  const files = new Map(expected.map(asset => [realpathSync(asset.file), asset.sha256]))
  if (files.size !== filenames.length || expected.length !== filenames.length || filenames.some(name => !files.has(realpathSync(path.join(root, 'rust-pty/target/release', name)))) || [...files.values()].some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('TEST exact PTY library inventory required')
  const symbol = '__TEST_ESBUILD_LIBRARY_PATH__'
  const assets = new Map<string, { source: string; target: string; bytes: Buffer; sha256: string; wrapper: string; wrapperSha256: string }>()
  outputRoot = realpathSync(outputRoot)
  const plugin: Plugin = { name: 'TEST-exact-pty-library-paths', setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?)$/, namespace: 'file' }, args => {
      const text = readFileSync(args.path, 'utf8')
      if (text.includes(symbol) || text.includes('__TEST_PTY_FILE_URL__')) throw new Error('TEST PTY banner identifier collision')
      return undefined
    })
    builder.onResolve({ filter: /\.(?:dll|dylib|so)$/ }, args => {
      if (!args.importer || realpathSync(args.importer) !== terminal) throw new Error('TEST shared library has unsupported filename consumer')
      return undefined
    })
    builder.onLoad({ filter: /\.(?:dll|dylib|so)$/, namespace: 'file' }, args => {
      const file = realpathSync(args.path), bytes = readFileSync(file), sha256 = hash(bytes)
      if (files.get(file) !== sha256) throw new Error('TEST PTY library differs from selected raw custody')
      const relative = `pty-assets/${sha256}-${path.basename(file)}`, target = path.join(outputRoot, relative)
      if (path.relative(outputRoot, target) !== relative.split('/').join(path.sep)) throw new Error('TEST PTY output escaped')
      const wrapper = `module.exports = ${symbol}(${JSON.stringify(`./${relative}`)});\n`
      const previous = assets.get(relative)
      if (previous && !previous.bytes.equals(bytes)) throw new Error('TEST PTY asset collision')
      assets.set(relative, { source: file, target, bytes, sha256, wrapper, wrapperSha256: hash(Buffer.from(wrapper)) })
      return { contents: wrapper, loader: 'js', resolveDir: path.dirname(file) }
    })
  } }
  const banner = `import { fileURLToPath as __TEST_PTY_FILE_URL__ } from 'node:url';\nconst ${symbol} = relative => __TEST_PTY_FILE_URL__(new URL(relative, import.meta.url));`
  const verifyUnchanged = () => {
    if (hash(readFileSync(manifest)) !== hash(manifestBytes) || hash(readFileSync(terminal)) !== terminalSha256) throw new Error('TEST PTY consumer or manifest changed')
    for (const asset of assets.values()) if (hash(readFileSync(asset.source)) !== asset.sha256) throw new Error('TEST PTY library changed')
  }
  return { plugin, banner, assets, verifyUnchanged, manifest, manifestSha256: hash(manifestBytes), terminal, terminalSha256 }
}

async function buildOnly(generatedEntry: string, sourceRoot: string, output: string, resultPath: string, stagePath: string): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('TEST exact Windows compiler platform required')
  const inputs = new Map<string, Buffer>(), directory = realpathSync(path.dirname(output))
  const save = (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value), { flag: 'wx' })
  const stage = (phase: string) => writeFileSync(stagePath, JSON.stringify({ phase, inputCount: inputs.size, fullTaskQualified: false }))
  const selectedAddon = realpathSync(Bun.resolveSync('@yuuang/ffi-rs-win32-x64-msvc', sourceRoot))
  const selectedAddons = [{ file: selectedAddon, sha256: hash(readFileSync(selectedAddon)) }]
  const native = nativeAddonCustody(sourceRoot, directory, selectedAddons)
  const selectedPty = ['rust_pty.dll', 'librust_pty.dylib', 'librust_pty_arm64.dylib', 'librust_pty.so', 'librust_pty_arm64.so'].map(name => {
    const file = realpathSync(path.join(sourceRoot, 'node_modules/bun-pty/rust-pty/target/release', name))
    return { file, sha256: hash(readFileSync(file)) }
  })
  const pty = ptyLibraryCustody(sourceRoot, directory, selectedPty)
  const compiler = readBundledCompilerIdentity(sourceRoot)
  const { build, version: compilerVersion } = await import('esbuild')
  if (compilerVersion !== compiler.version) throw new Error('TEST loaded compiler version mismatch')
  await save('build-compiler.json', { ...compiler, selectedAddons, selectedPty, fullTaskQualified: false })
  const custody: Plugin = { name: 'TEST-raw-source-custody', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => isBuiltin(args.path) || args.path.startsWith('bun:') ? { path: args.path, external: true } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'file' }, args => {
      const file = realpathSync(args.path)
      if (file !== generatedEntry) within(sourceRoot, file)
      const bytes = readFileSync(file), previous = inputs.get(file)
      if (previous && !previous.equals(bytes)) throw new Error('TEST raw input changed during compiler read')
      inputs.set(file, bytes)
      return undefined
    })
  } }
  const resolutions: ReturnType<typeof resolveBundledJsoncEntry>[] = []
  const jsonc: Plugin = { name: 'TEST-published-jsonc-parser-ESM-entry', setup(builder) {
    builder.onResolve({ filter: /^jsonc-parser$/ }, args => {
      if (args.kind !== 'import-statement') throw new Error('TEST jsonc-parser config import kind changed')
      const selection = resolveBundledJsoncEntry(args.importer, sourceRoot)
      resolutions.push(selection)
      return { path: selection.entry }
    })
  } }
  stage('build-before-call')
  try {
    const result = await build({ absWorkingDir: sourceRoot, entryPoints: [generatedEntry], outdir: directory, entryNames: 'checkpoint-bundled', assetNames: 'assets/[name]-[hash]', bundle: true, platform: 'node', conditions: ['bun'], target: 'esnext', format: 'esm', splitting: false, minify: false, write: false, metafile: true, logLevel: 'silent', loader: { '.wasm': 'file' }, plugins: [custody, jsonc, native.plugin, pty.plugin], banner: { js: `${native.banner}\n${pty.banner}` } })
    stage('build-returned')
    await save('build-package-resolutions.json', resolutions)
    await save('build-diagnostics.json', { warnings: result.warnings, errors: result.errors, outputs: result.outputFiles?.map(item => ({ path: item.path, bytes: item.contents.byteLength, sha256: hash(item.contents) })), fullTaskQualified: false })
    await save('build-metafile.json', result.metafile)
    if (!result.metafile || !result.outputFiles) throw new Error('TEST successful compiler result lacks outputs')
    for (const file of Object.keys(result.metafile.inputs)) if (!inputs.has(realpathSync(path.resolve(sourceRoot, file)))) throw new Error('TEST metafile input not captured')
    const entries = Object.entries(result.metafile.outputs).filter(([, artifact]) => artifact.entryPoint !== undefined)
    if (entries.length !== 1 || !entries[0]) throw new Error('TEST exactly one emitted entry required')
    const entryPath = path.resolve(sourceRoot, entries[0][0]), entry = result.outputFiles.find(item => path.resolve(item.path) === entryPath)
    if (!entry || entryPath !== output) throw new Error('TEST emitted entry path mismatch')
    await save('build-transformations.json', [])
    await writeFile(path.join(directory, 'build-emitted-entry.js'), entry.contents, { flag: 'wx' })
    const allowed = (specifier: string) => isBuiltin(specifier) || specifier.startsWith('bun:')
    const emittedImports = new Bun.Transpiler({ loader: 'js', target: 'bun' }).scanImports(entry.contents).map(item => ({ ...item, allowed: allowed(item.path) }))
    const outputImports = Object.entries(result.metafile.outputs).flatMap(([file, artifact]) => artifact.imports.map(item => ({ file, ...item, allowed: !item.external || allowed(item.path) })))
    await save('build-externals.json', { emittedSha256: hash(entry.contents), emittedImports, outputImports, offenders: [...emittedImports, ...outputImports].filter(item => !item.allowed), fullTaskQualified: false })
    if ([...emittedImports, ...outputImports].some(item => !item.allowed)) throw new Error('TEST retained non-builtin external import')
    const outputs = new Map<string, Uint8Array>()
    for (const artifact of result.outputFiles) {
      const relative = within(directory, path.resolve(artifact.path))
      if (artifact !== entry && ![...inputs.values()].some(bytes => bytes.equals(artifact.contents))) throw new Error('TEST output asset lacks raw custody')
      const previous = outputs.get(relative)
      if (previous && !Buffer.from(previous).equals(artifact.contents)) throw new Error('TEST different output bytes collide')
      outputs.set(relative, artifact.contents)
    }
    const assets: { path: string; sha256: string }[] = []
    for (const [relative, bytes] of outputs) {
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), bytes, { flag: 'wx' })
      if (hash(await readFile(path.join(directory, relative))) !== hash(bytes)) throw new Error('TEST output hash changed')
      if (path.join(directory, relative) !== output) assets.push({ path: relative, sha256: hash(bytes) })
    }
    native.verifyUnchanged(); pty.verifyUnchanged()
    if (selectedAddons.some(addon => inputs.has(addon.file) !== [...native.assets.values()].some(asset => asset.source === addon.file && asset.sha256 === addon.sha256)) || pty.assets.size !== selectedPty.length) throw new Error('TEST native/library inventory differs from consumed inputs')
    for (const collection of [native.assets, pty.assets]) for (const [relative, asset] of collection) {
      if (!inputs.has(asset.source) || outputs.has(relative)) throw new Error('TEST raw binary observer or output collision failed')
      await mkdir(path.dirname(asset.target), { recursive: true }); await writeFile(asset.target, asset.bytes, { flag: 'wx' })
      if (hash(await readFile(asset.target)) !== asset.sha256) throw new Error('TEST relocated binary changed')
      assets.push({ path: relative, sha256: asset.sha256 })
    }
    const nativeAssets = [...native.assets].map(([relative, asset]) => ({ file: asset.source, relative, sha256: asset.sha256, manifest: asset.manifest, manifestSha256: asset.manifestSha256, wrapper: asset.wrapper, wrapperSha256: asset.wrapperSha256 }))
    const ptyAssets = { manifest: pty.manifest, manifestSha256: pty.manifestSha256, terminal: pty.terminal, terminalSha256: pty.terminalSha256, assets: [...pty.assets].map(([relative, asset]) => ({ file: asset.source, relative, sha256: asset.sha256, wrapper: asset.wrapper, wrapperSha256: asset.wrapperSha256 })) }
    await save('build-native-assets.json', { nativeAssets, ptyAssets, fullTaskQualified: false })
    const validationPath = path.join(directory, 'build-import-validation.json')
    const validation = { purpose: 'TEST-precontainment-import-only', bun: Bun.version, compiler, emittedSha256: hash(entry.contents), checkpointInvoked: false, fullTaskQualified: false }
    await writeFile(validationPath, JSON.stringify({ ...validation, phase: 'before-import' }))
    stage('build-before-import-validation')
    try {
      const loaded = await import(pathToFileURL(output).href)
      if (typeof loaded.runOfficialShellCheckpointBundled !== 'function' || typeof loaded.bundledLoggerBinding?.direct !== 'function' || loaded.bundledLoggerBinding.direct.Default === undefined) throw new Error('TEST full checkpoint/logger export absent')
      await writeFile(validationPath, JSON.stringify({ ...validation, phase: 'import-passed', passed: true, loggerBinding: { directExportRetained: true } }))
    } catch (error) {
      await writeFile(validationPath, JSON.stringify({ ...validation, phase: 'import-failed', passed: false, error: describeBundleImportFailure(error) }))
      throw new Error('TEST full checkpoint import refused; retained evidence')
    }
    await writeFile(resultPath, JSON.stringify({ inputs: [...inputs].map(([file, bytes]) => ({ file, sha256: hash(bytes) })), transformations: [], resolutions, nativeAssets, ptyAssets, assets, compiler, loggerBinding: { directExportRetained: true }, metafile: result.metafile }), { flag: 'wx' })
    stage('build-result-published')
  } catch (error) {
    if (error && typeof error === 'object' && 'errors' in error && 'warnings' in error) await save('build-failure-diagnostics.json', { errors: error.errors, warnings: error.warnings, fullTaskQualified: false })
    throw error
  } finally {
    native.verifyUnchanged(); pty.verifyUnchanged()
    for (const resolution of resolutions) if (JSON.stringify(resolveBundledJsoncEntry(resolution.importer, sourceRoot)) !== JSON.stringify(resolution)) throw new Error('TEST published jsonc-parser resolution changed')
    const unchanged = [...inputs].every(([file, bytes]) => hash(readFileSync(file)) === hash(bytes)) && JSON.stringify(readBundledCompilerIdentity(sourceRoot)) === JSON.stringify(compiler)
    await save('build-unchanged.json', { unchanged, inputCount: inputs.size, fullTaskQualified: false })
    if (!unchanged) throw new Error('TEST final source/compiler custody changed')
  }
}

if (process.argv[2] === '--build-only') {
  const [entry, root, output, result, stage] = process.argv.slice(3)
  if (!entry || !root || !output || !result || !stage || process.versions.bun !== '1.3.11') throw new Error('TEST bundle child inputs invalid')
  await buildOnly(entry, root, output, result, stage)
}
