import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const OPENCODE_V2_EXTERNALS = ['@opencode/*', 'effect', 'effect/*']
const selections = [
  ['@opencode/server-v2-floor', '@opencode/server', '2.0.0'],
  ['@opencode/server', '@opencode/server', '2.0.21'],
  ['@opencode/client-v2-floor', '@opencode/client', '2.0.0'],
  ['@opencode/client', '@opencode/client', '2.0.21'],
  ['effect', 'effect', '4.0.0-rc.112'],
  ['@opencode/schema', '@opencode/schema', '2.0.21'],
  ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk', '1.29.0'],
] as const
type PackageMetadata = {
  name: string; version: string
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
type PackageNode = { source: string; target: string; metadata: PackageMetadata }

async function metadata(root: string): Promise<PackageMetadata> {
  const value: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string'
    || !('version' in value) || typeof value.version !== 'string') throw new Error('Invalid package metadata')
  return value as PackageMetadata
}

// Match Node/Bun's package lookup before reading exports. Package roots are not
// necessarily exported, and the floor alias's manifest has its official name.
async function packageRoot(name: string, from: string): Promise<string | null> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Invalid dependency name')
  let directory = from
  for (;;) {
    const candidate = path.join(directory, 'node_modules', name)
    try { return await realpath(candidate) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
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

async function assertEntry(specifier: string, from: string, name: string, version: string, ownedRoot?: string): Promise<string> {
  const entry = await realpath(Bun.resolveSync(specifier, from))
  if (ownedRoot) {
    const relative = path.relative(ownedRoot, entry)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Staged graph escaped its bundle')
  }
  const info = await packageAt(entry)
  if (info.name !== name || info.version !== version) throw new Error(`OpenCode V2 graph mismatch: ${specifier}`)
  return entry
}

/** Validate from each selected server/client's own physical resolution context. */
async function verifyGraphs(from: string, ownedRoot?: string): Promise<void> {
  // Root model mapping and its schemas must share one physical Effect instance.
  const effect = await assertEntry('effect', from, 'effect', '4.0.0-rc.112', ownedRoot)
  for (const specifier of ['@opencode/schema/config/provider', '@opencode/schema/model']) {
    const schema = await assertEntry(specifier, from, '@opencode/schema', '2.0.21', ownedRoot)
    if (await assertEntry('effect', path.dirname(schema), 'effect', '4.0.0-rc.112', ownedRoot) !== effect) {
      throw new Error('OpenCode V2 schema Effect graph mismatch')
    }
  }
  await assertEntry('@modelcontextprotocol/sdk/client/index.js', from, '@modelcontextprotocol/sdk', '1.29.0', ownedRoot)
  for (const pin of ['2.0.0', '2.0.21'] as const) {
    const server = await assertEntry(pin === '2.0.0' ? '@opencode/server-v2-floor/process' : '@opencode/server/process',
      from, '@opencode/server', pin, ownedRoot)
    for (const [dependency, subpath] of [['core', 'bus'], ['protocol', 'groups/pty'],
      ['schema', 'installation-event'], ['util', 'effect/layer-node'], ['simulation', 'backend']]) {
      await assertEntry(`@opencode/${dependency}/${subpath}`, path.dirname(server), `@opencode/${dependency}`, pin, ownedRoot)
    }
    await assertEntry('effect', path.dirname(server), 'effect', '4.0.0-rc.112', ownedRoot)
    const client = await assertEntry(pin === '2.0.0' ? '@opencode/client-v2-floor' : '@opencode/client',
      from, '@opencode/client', pin, ownedRoot)
    for (const [dependency, subpath] of [['protocol', 'groups/pty'], ['schema', 'installation-event']]) {
      await assertEntry(`@opencode/${dependency}/${subpath}`, path.dirname(client), `@opencode/${dependency}`, pin, ownedRoot)
    }
  }
}

/** Build-time staging only. No installs or runtime fallbacks. All package bytes
 * and installed native assets are copied, preserving separate physical graphs. */
export async function stageOpenCodeV2Graphs(sourceRoot: string, bundleDirectory: string): Promise<void> {
  sourceRoot = await realpath(sourceRoot)
  const destination = path.resolve(bundleDirectory, 'node_modules')
  await verifyGraphs(sourceRoot)
  await mkdir(destination, { recursive: true })
  const packages = new Map<string, PackageNode>()
  const link = async (directory: string, name: string, target: string) => {
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
    const target = path.join(destination, '.opencode-v2', id)
    const node = { source, target, metadata: info }
    packages.set(source, node)
    await cp(source, target, { recursive: true, dereference: true, filter: async file => {
      const relative = path.relative(source, file)
      if (relative.split(path.sep).includes('node_modules')) return false
      if ((await lstat(file)).isSymbolicLink()) {
        const physical = await realpath(file)
        if (path.relative(source, physical).startsWith('..') || path.isAbsolute(path.relative(source, physical))) {
          throw new Error('Package asset escapes its package')
        }
      }
      return true
    } })
    const optional = info.optionalDependencies ?? {}
    const required = info.dependencies ?? {}
    const peers = info.peerDependencies ?? {}
    for (const dependency of [...new Set([...Object.keys(required), ...Object.keys(optional), ...Object.keys(peers)])].sort()) {
      const resolved = await packageRoot(dependency, source)
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
  for (const [alias, name, version] of selections) {
    const source = await packageRoot(alias, sourceRoot)
    if (!source) throw new Error(`Missing selected package ${alias}`)
    const node = await copy(source)
    if (node.metadata.name !== name || node.metadata.version !== version) throw new Error(`Wrong selected package ${alias}`)
    await link(destination, alias, node.target)
  }
  await verifyGraphs(path.resolve(bundleDirectory), destination)
  await writeFile(path.join(bundleDirectory, 'opencode-v2-graphs.json'), JSON.stringify({
    schema: 1, pins: ['2.0.0', '2.0.21'], effect: '4.0.0-rc.112', platform: process.platform, arch: process.arch,
    packages: [...packages.values()].map(node => ({ name: node.metadata.name, version: node.metadata.version,
      path: path.relative(bundleDirectory, node.target),
    })),
  }, null, 2) + '\n')
}
