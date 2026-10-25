import { openCodeV2GraphPackages, openCodeV2StagedVersions, openCodeV2Wire, type OpenCodeV2Pin } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { OPENCODE_V2_CLIENT_GRAPH_ENTRIES, OPENCODE_V2_EFFECT_PLATFORM_ENTRIES,
  OPENCODE_V2_SERVER_GRAPH_ENTRIES } from '../../src/services/opencode/host/OpenCodeV2ServerGraph.js'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, realpath, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stagedPackageFilter, type StagedPackageManifest, type StagedTarget } from './staged-files.js'

export const OPENCODE_V2_EXTERNALS = ['@opencode/*', 'effect', 'effect/*']
// Root packages the bundled CLI imports directly. Official core chunks import
// NodeSocket without declaring @effect/platform-node; preserve the root resolution.
const ROOT_PACKAGES = ['effect', '@effect/platform-node', '@effect/platform-node-shared', '@opencode/schema',
  '@modelcontextprotocol/sdk'] as const
const EXACT_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const RUNTIME_ROOT = path.join(import.meta.dir, '..', '..')
type PackageMetadata = StagedPackageManifest & {
  name: string; version: string
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  overrides?: Record<string, string>
}
type PackageNode = { source: string; target: string; metadata: PackageMetadata }
/** Everything staging needs is derived from the runtime install manifest and installed npm metadata. */
export type OpenCodeV2StagePlan = Readonly<{
  versions: readonly OpenCodeV2Pin[]
  root: Readonly<Record<typeof ROOT_PACKAGES[number], string>>
  ptyVersion: string
}>

async function metadata(root: string): Promise<PackageMetadata> {
  const value: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string'
    || !('version' in value) || typeof value.version !== 'string') throw new Error('Invalid package metadata')
  return value as PackageMetadata
}

// Match Node/Bun's package lookup before reading exports. Package roots are not
// necessarily exported, and an alias's manifest has its official name.
async function packageRoot(name: string, from: string, physical = false): Promise<string | null> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Invalid dependency name')
  let directory = from
  for (;;) {
    const candidate = path.join(directory, 'node_modules', name)
    try {
      if (physical && !(await lstat(candidate)).isDirectory()) throw new Error('Portable graph requires a physical hoisted install')
      return await realpath(candidate)
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/** Derive staged versions, root package versions and the PTY pin from the source install. */
export async function planOpenCodeV2Stage(sourceRoot: string = RUNTIME_ROOT): Promise<OpenCodeV2StagePlan> {
  const manifest = await metadata(sourceRoot)
  const versions = openCodeV2StagedVersions(manifest.dependencies ?? {})
  if (versions.length === 0) throw new Error('No OpenCode V2 graph is staged')
  const root = {} as Record<typeof ROOT_PACKAGES[number], string>
  for (const name of ROOT_PACKAGES) {
    const directory = await packageRoot(name, sourceRoot)
    if (!directory) throw new Error(`Missing root package ${name}`)
    const installed = (await metadata(directory)).version
    const declared = manifest.dependencies?.[name]
    if (declared !== undefined && EXACT_RELEASE.test(declared) && declared !== installed) throw new Error(`Root package drift ${name}`)
    root[name] = installed
  }
  const ptyVersion = manifest.overrides?.['bun-pty']
  if (typeof ptyVersion !== 'string' || !EXACT_RELEASE.test(ptyVersion)) throw new Error('bun-pty override must pin an exact release')
  return { versions, root, ptyVersion }
}

async function packageAt(entry: string): Promise<PackageMetadata> {
  let directory = path.dirname(await realpath(entry))
  for (;;) {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
      // The SDK's dist/esm manifest only selects module format; identity lives above it.
      if (!value || typeof value !== 'object' || Array.isArray(value) || 'name' in value || 'version' in value) return await metadata(directory)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error('Package manifest missing')
    directory = parent
  }
}

async function assertEntry(specifier: string, from: string, name: string, version?: string, ownedRoot?: string): Promise<string> {
  const entry = await realpath(Bun.resolveSync(specifier, from))
  if (ownedRoot) {
    const relative = path.relative(ownedRoot, entry)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Staged graph escaped its bundle')
  }
  const info = await packageAt(entry)
  if (info.name !== name || (version !== undefined && info.version !== version)) throw new Error(`OpenCode V2 graph mismatch: ${specifier}`)
  return entry
}

/** Verify the exact dependency used by each selected core's Bun PTY adapter. */
export async function verifyBunPtyGraph(coreEntry: string, pin: OpenCodeV2Pin, ownedRoot?: string,
  ptyVersion?: string): Promise<string> {
  const adapter = await assertEntry('#pty', path.dirname(coreEntry), '@opencode/core', pin, ownedRoot)
  return assertEntry('bun-pty', path.dirname(adapter), 'bun-pty', ptyVersion ?? (await planOpenCodeV2Stage()).ptyVersion, ownedRoot)
}

/** The selected server pins every official @opencode dependency and Effect to exact releases. */
async function serverEffectVersion(server: string, pin: OpenCodeV2Pin): Promise<string> {
  const info = await packageAt(server)
  for (const [name, version] of Object.entries(info.dependencies ?? {})) {
    if (name.startsWith('@opencode/') && version !== pin) throw new Error(`OpenCode V2 graph mismatch: ${name}@${version}`)
  }
  const effect = info.dependencies?.effect
  if (typeof effect !== 'string' || !EXACT_RELEASE.test(effect)) throw new Error('OpenCode V2 graph mismatch: effect')
  return effect
}

/** Validate from each selected server/client's own physical resolution context. */
export async function verifyGraphs(from: string, ownedRoot?: string, plan?: OpenCodeV2StagePlan): Promise<void> {
  plan ??= await planOpenCodeV2Stage(from)
  // Root model mapping and its schemas must share one physical Effect instance.
  const effect = await assertEntry('effect', from, 'effect', plan.root.effect, ownedRoot)
  await assertEntry('@effect/platform-node/NodeSocket', from, '@effect/platform-node', plan.root['@effect/platform-node'], ownedRoot)
  for (const specifier of ['@opencode/schema/config/provider', '@opencode/schema/model']) {
    const schema = await assertEntry(specifier, from, '@opencode/schema', plan.root['@opencode/schema'], ownedRoot)
    if (await assertEntry('effect', path.dirname(schema), 'effect', plan.root.effect, ownedRoot) !== effect) {
      throw new Error('OpenCode V2 schema Effect graph mismatch')
    }
  }
  await assertEntry('@modelcontextprotocol/sdk/client/index.js', from, '@modelcontextprotocol/sdk', plan.root['@modelcontextprotocol/sdk'], ownedRoot)
  for (const pin of plan.versions) {
    const packages = openCodeV2GraphPackages(pin)
    const server = await assertEntry(`${packages.server}/process`, from, '@opencode/server', pin, ownedRoot)
    const version = await serverEffectVersion(server, pin)
    const selectedEffect = await assertEntry('effect', path.dirname(server), 'effect', version, ownedRoot)
    const sameEffect = async (entry: string) => {
      if (await assertEntry('effect', path.dirname(entry), 'effect', version, ownedRoot) !== selectedEffect) {
        throw new Error('OpenCode V2 selected Effect graph mismatch')
      }
    }
    for (const [dependency, subpath] of OPENCODE_V2_SERVER_GRAPH_ENTRIES) {
      const entry = await assertEntry(`@opencode/${dependency}/${subpath}`, path.dirname(server), `@opencode/${dependency}`, pin, ownedRoot)
      await sameEffect(entry)
      if (dependency === 'core') {
        await verifyBunPtyGraph(entry, pin, ownedRoot, plan.ptyVersion)
        const ai = await assertEntry('@opencode/ai/route/client', path.dirname(entry), '@opencode/ai', pin, ownedRoot)
        await sameEffect(ai)
        // A hoisted shared effect binder must never decode with a foreign Effect.
        const drizzle = await assertEntry('drizzle-orm/effect-core', path.dirname(entry), 'drizzle-orm', undefined, ownedRoot)
        await sameEffect(drizzle)
      }
    }
    for (const [dependency, subpath] of OPENCODE_V2_EFFECT_PLATFORM_ENTRIES) {
      const entry = await assertEntry(`${dependency}/${subpath}`, path.dirname(server), dependency, version, ownedRoot)
      await sameEffect(entry)
    }
    const client = await assertEntry(packages.client, from, '@opencode/client', pin, ownedRoot)
    // Promise adapters exchange plain JSON and do not execute the optional
    // Effect client entrypoint. Its schema/protocol packages keep the exact pin.
    for (const [dependency, subpath] of OPENCODE_V2_CLIENT_GRAPH_ENTRIES) {
      const entry = await assertEntry(`@opencode/${dependency}/${subpath}`, path.dirname(client), `@opencode/${dependency}`, pin, ownedRoot)
      await assertEntry('effect', path.dirname(entry), 'effect', version, ownedRoot)
    }
  }
}

// Staging leaves out files Bun never loads (staged-files.ts); three graphs then
// carry about 42k files. Signing, notarization and antivirus scans of the desktop
// app scale with this count, so a new graph or a staging regression has to raise
// the budget deliberately.
export const MAX_STAGED_GRAPH_FILES = 50_000

export type StagedFileTotals = { kept: { files: number; bytes: number }; excluded: { files: number; bytes: number } }

async function treeSize(directory: string): Promise<{ files: number; bytes: number }> {
  const size = { files: 0, bytes: 0 }
  for (const relative of await readdir(directory, { recursive: true })) {
    const entry = await stat(path.join(directory, relative))
    if (!entry.isFile()) continue
    size.files += 1
    size.bytes += entry.size
  }
  return size
}

/** Remove directories that excluded files left empty, never the package root itself. */
async function removeEmptied(directory: string, root: string): Promise<void> {
  for (let current = directory; current.startsWith(root + path.sep); current = path.dirname(current)) {
    let entries: string[]
    try { entries = await readdir(current) }
    catch (error) {
      // A deeper pass already removed it; its parent may be empty now too.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (entries.length > 0) return
    await rmdir(current)
  }
}

/** Copy one package root without its nested node_modules (staged separately) and
 * without the files staged-files.ts leaves out. A symlink may not leave the package. */
export async function copyStagedPackage(source: string, target: string, manifest: StagedPackageManifest,
  stagedTarget: StagedTarget, totals: StagedFileTotals): Promise<void> {
  const keep = stagedPackageFilter(manifest, stagedTarget, await readdir(source))
  const emptied = new Set<string>()
  await cp(source, target, { recursive: true, dereference: true, filter: async file => {
    const relative = path.relative(source, file)
    if (relative.split(path.sep).includes('node_modules')) return false
    if ((await lstat(file)).isSymbolicLink()) {
      const physical = await realpath(file)
      if (path.relative(source, physical).startsWith('..') || path.isAbsolute(path.relative(source, physical))) {
        throw new Error('Package asset escapes its package')
      }
    }
    if (!relative) return true
    const entry = await stat(file)
    if (keep(relative.split(path.sep).join('/'), entry.isDirectory())) {
      if (entry.isFile()) { totals.kept.files += 1; totals.kept.bytes += entry.size }
      return true
    }
    const size = entry.isDirectory() ? await treeSize(file) : { files: 1, bytes: entry.size }
    totals.excluded.files += size.files
    totals.excluded.bytes += size.bytes
    emptied.add(path.dirname(path.join(target, relative)))
    return false
  } })
  // Excluded files can leave directories that no longer hold anything.
  for (const directory of [...emptied].sort((left, right) => right.length - left.length)) {
    await removeEmptied(directory, target)
  }
}

/** Build-time staging only. No installs or runtime fallbacks. Package code, data and
 * the staged platform's native assets are copied byte for byte, preserving separate
 * physical graphs; files Bun never loads are left out (see staged-files.ts). */
export async function stageOpenCodeV2Graphs(sourceRoot: string, bundleDirectory: string,
  options: { portable?: boolean; platform?: string; arch?: string } = {}): Promise<void> {
  sourceRoot = await realpath(sourceRoot)
  const destination = path.resolve(bundleDirectory, 'node_modules')
  const plan = await planOpenCodeV2Stage(sourceRoot)
  await verifyGraphs(sourceRoot, undefined, plan)
  await mkdir(destination, { recursive: true })
  const stagedTarget = { platform: options.platform ?? process.platform, arch: options.arch ?? process.arch }
  const totals: StagedFileTotals = { kept: { files: 0, bytes: 0 }, excluded: { files: 0, bytes: 0 } }
  const packages = new Map<string, PackageNode>()
  const link = async (directory: string, name: string, target: string) => {
    // Portable packages retain the source hoisted/nested positions. The normal
    // ancestor lookup already reaches their copied dependencies; no links needed.
    if (options.portable) return
    const location = path.join(directory, name)
    await mkdir(path.dirname(location), { recursive: true })
    // Relative directory links make the complete bundle relocatable.
    await symlink(path.relative(path.dirname(location), target), location, 'dir')
  }
  const copy = async (source: string): Promise<PackageNode> => {
    const existing = packages.get(source)
    if (existing) return existing
    const info = await metadata(source)
    const id = createHash('sha256').update(path.relative(sourceRoot, source)).digest('hex').slice(0, 24)
    const physicalRelative = path.relative(path.join(sourceRoot, 'node_modules'), source)
    if (options.portable && (physicalRelative.startsWith('..') || path.isAbsolute(physicalRelative))) {
      throw new Error('Portable graph escaped the hoisted install')
    }
    const target = options.portable ? path.join(destination, physicalRelative) : path.join(destination, '.opencode-v2', id)
    const node = { source, target, metadata: info }
    packages.set(source, node)
    await copyStagedPackage(source, target, info, stagedTarget, totals)
    const optional = info.optionalDependencies ?? {}
    const required = info.dependencies ?? {}
    const peers = info.peerDependencies ?? {}
    for (const dependency of [...new Set([...Object.keys(required), ...Object.keys(optional), ...Object.keys(peers)])].sort()) {
      const resolved = await packageRoot(dependency, source, options.portable)
      if (!resolved) {
        if ((dependency in required && !(dependency in optional)) ||
          (dependency in peers && !info.peerDependenciesMeta?.[dependency]?.optional)) {
          throw new Error(`Missing dependency ${info.name}: ${dependency}`)
        }
        continue // Only installed optional/native packages are staged.
      }
      const child = await copy(resolved)
      await link(path.join(target, 'node_modules'), dependency, child.target)
    }
    return node
  }
  const selections = [
    ...plan.versions.flatMap(pin => {
      const aliases = openCodeV2GraphPackages(pin)
      return [[aliases.server, '@opencode/server', pin], [aliases.client, '@opencode/client', pin]] as const
    }),
    ...Object.entries(plan.root).map(([name, version]) => [name, name, version] as const),
  ]
  for (const [alias, name, version] of selections) {
    const source = await packageRoot(alias, sourceRoot, options.portable)
    if (!source) throw new Error(`Missing selected package ${alias}`)
    const node = await copy(source)
    if (node.metadata.name !== name || node.metadata.version !== version) throw new Error(`Wrong selected package ${alias}`)
    await link(destination, alias, node.target)
  }
  if (totals.kept.files > MAX_STAGED_GRAPH_FILES) {
    throw new Error(`Staged OpenCode V2 graphs carry ${totals.kept.files} files, above the ${MAX_STAGED_GRAPH_FILES} budget`)
  }
  await verifyGraphs(path.resolve(bundleDirectory), destination, plan)
  // Consumers (packaging, smokes) read the staged graphs from here instead of
  // repeating versions or alias names.
  const graphs = []
  for (const version of plan.versions) {
    const aliases = openCodeV2GraphPackages(version)
    const effect = await serverEffectVersion(await realpath(Bun.resolveSync(`${aliases.server}/process`, bundleDirectory)), version)
    graphs.push({ version, server: aliases.server, client: aliases.client, effect, wire: openCodeV2Wire(version) })
  }
  await writeFile(path.join(bundleDirectory, 'opencode-v2-graphs.json'), JSON.stringify({
    schema: 2, graphs, effect: plan.root.effect, pty: plan.ptyVersion, platform: stagedTarget.platform, arch: stagedTarget.arch,
    packages: [...packages.values()].map(node => ({ name: node.metadata.name, version: node.metadata.version,
      path: path.relative(bundleDirectory, node.target),
    })),
  }, null, 2) + '\n')
  const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1)
  console.log(`Staged ${packages.size} OpenCode V2 graph packages for ${stagedTarget.platform}-${stagedTarget.arch}: ` +
    `${totals.kept.files} files (${megabytes(totals.kept.bytes)} MB); left out ${totals.excluded.files} files ` +
    `(${megabytes(totals.excluded.bytes)} MB) that Bun never loads`)
}
