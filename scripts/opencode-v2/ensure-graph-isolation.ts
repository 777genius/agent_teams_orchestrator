import { cp, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { openCodeV2GraphPackages, openCodeV2StagedVersions } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'

type PackageMetadata = {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

async function metadata(root: string): Promise<PackageMetadata> {
  const value: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string'
    || !('version' in value) || typeof value.version !== 'string') throw new Error('Invalid package metadata')
  return value as PackageMetadata
}

/** Server graph aliases staged by this install manifest; derived, never listed. */
export async function stagedServerAliases(sourceRoot: string): Promise<string[]> {
  const manifest = await metadata(sourceRoot)
  return openCodeV2StagedVersions(manifest.dependencies ?? {}).map(version => openCodeV2GraphPackages(version).server)
}

// Match Node/Bun's package lookup before reading exports. Package roots are not
// necessarily exported, and an alias's manifest has its official name.
export async function packageRoot(name: string, from: string): Promise<string | null> {
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

const declaresEffect = (info: PackageMetadata) =>
  'effect' in (info.dependencies ?? {}) || 'effect' in (info.optionalDependencies ?? {})
  || 'effect' in (info.peerDependencies ?? {})

/** Declared closure of effect binders that resolve a foreign physical Effect. */
export async function misplacedBinders(roots: readonly string[], graphEffect: string): Promise<Map<string, string>> {
  const misplaced = new Map<string, string>()
  const visited = new Set<string>()
  const walk = async (directory: string): Promise<void> => {
    if (visited.has(directory)) return
    visited.add(directory)
    const info = await metadata(directory)
    if (declaresEffect(info)) {
      const resolved = await packageRoot('effect', directory)
      if (resolved !== null && resolved !== graphEffect) misplaced.set(info.name, directory)
    }
    for (const dependency of [...new Set([...Object.keys(info.dependencies ?? {}),
      ...Object.keys(info.optionalDependencies ?? {}), ...Object.keys(info.peerDependencies ?? {})])].sort()) {
      const child = await packageRoot(dependency, directory)
      if (child) await walk(child)
    }
  }
  for (const root of roots) await walk(root)
  return misplaced
}

/** Copy only the binder's own bytes; its dependencies resolve from ancestors. */
async function nestBinder(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true, dereference: true, force: true,
    filter: async (file) => {
      const relative = path.relative(source, file)
      if (relative.split(path.sep).includes('node_modules')) return false
      if ((await lstat(file)).isSymbolicLink()) {
        const physical = await realpath(file)
        const escaped = path.relative(source, physical)
        if (escaped.startsWith('..') || path.isAbsolute(escaped)) throw new Error('Package asset escapes its package')
      }
      return true
    },
  })
}

if (import.meta.main) {
  const sourceRoot = await realpath(path.join(import.meta.dir, '..', '..'))
  for (const server of await stagedServerAliases(sourceRoot)) {
    const root = await packageRoot(server, sourceRoot)
    if (!root) throw new Error(`Missing selected package ${server}`)
    const graphEffect = await packageRoot('effect', root)
    if (!graphEffect) throw new Error(`Missing selected Effect for ${server}`)
    for (const [name, source] of await misplacedBinders([root], graphEffect)) {
      // The shared hoist binds the root Effect into this graph; nest the binder
      // under the graph root so its own Effect resolution lands on the graph copy.
      await nestBinder(source, path.join(root, 'node_modules', name))
    }
    for (const [name, source] of await misplacedBinders([root], graphEffect)) {
      throw new Error(`OpenCode V2 graph isolation failed: ${name} from ${source}`)
    }
  }
}
