import path from 'node:path'
import { readExecutionPlatformBirth } from './OpenCodeV2ExecutionPlatform.js'
import filesystem, { lstat, open, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { hashOpenCodeFile, readOpenCodePackageManifest, type OpenCodeV2NativeIdentity } from '../compatibility/OpenCodeNativeIdentity.js'
import { assertExecutionSelectedModel, executionAssert, executionHash, executionRecord,
  type ExecutionSelectedModel, type ExecutionBirth } from '../execution/OpenCodeV2ExecutionContracts.js'
import { verifyOpenCodeV2ServerGraph } from './OpenCodeV2ServerGraph.js'

export type ExecutionGraph = Readonly<{ sha256: string; files: readonly Readonly<{ path: string; sha256: string }>[] }>
export type ExecutionSelection = Readonly<{
  agent: string; model: ExecutionSelectedModel
  permissions: readonly Readonly<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>[]
}>
export type ValidatedExecutionNative = OpenCodeV2NativeIdentity & Readonly<{
  runtimeMode: 'source' | 'packaged'; entrySha256: string
  bun: Readonly<{ path: string; sha256: string }>; graph: ExecutionGraph
  taskNode?: Readonly<{ path: string; sha256: string }>
}>
/** The profile owner supplies this immutable epoch; acquisition never discovers HOME or copies auth. */
export type SelectedExecutionProfile = Readonly<{
  epoch: string; root: string; directory: string; databasePath: string
  env: Readonly<Record<string, string>>; envSha256: string
  config: Readonly<{ directory: string; content: string; sha256: string }>
  authSha256?: string; models?: Readonly<{ path: string; sha256: string }>; selection: ExecutionSelection
}>

export type CatalogExecutionProfile = Omit<SelectedExecutionProfile, 'selection'> & Readonly<{ selection: Readonly<{ purpose: 'catalog' }> }>
export type OwnedNativeProfile = SelectedExecutionProfile | CatalogExecutionProfile

export async function canonicalExecutionDirectory(directory: string): Promise<void> {
  executionAssert(path.isAbsolute(directory) && await filesystem.realpath(directory) === directory, 'execution_identity_mismatch')
  const info = await lstat(directory)
  executionAssert(info.isDirectory() && !info.isSymbolicLink(), 'execution_identity_mismatch')
}
const inside = (root: string, file: string) => file.startsWith(root + path.sep)
export async function validateExecutionProfile(profile: OwnedNativeProfile): Promise<void> {
  executionAssert(profile.epoch.length > 0)
  if ('purpose' in profile.selection) executionAssert(profile.selection.purpose === 'catalog')
  else { executionAssert(profile.selection.agent.length > 0); assertExecutionSelectedModel(profile.selection.model) }
  await canonicalExecutionDirectory(profile.root)
  await canonicalExecutionDirectory(profile.directory)
  executionAssert(await lstat(profile.root).then(info => process.platform === 'win32' || (info.mode & 0o077) === 0), 'execution_profile_not_private')
  executionAssert(executionHash(profile.env) === profile.envSha256, 'execution_profile_changed')
  executionAssert(Object.entries(profile.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0')))
  executionAssert(!Object.keys(profile.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|BUN_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS)$/i.test(key)), 'execution_environment_injection')
  executionAssert(createHash('sha256').update(profile.config.content).digest('hex') === profile.config.sha256, 'execution_profile_changed')
  executionRecord(JSON.parse(profile.config.content))
  for (const [key, relative] of Object.entries({ HOME: 'home', USERPROFILE: 'home', XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', TMPDIR: 'tmp', TMP: 'tmp', TEMP: 'tmp',
    APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' })) {
    executionAssert(profile.env[key] === path.join(profile.root, relative), 'execution_profile_changed')
    await canonicalExecutionDirectory(profile.env[key]!)
    executionAssert(await lstat(profile.env[key]!).then(info => process.platform === 'win32' || (info.mode & 0o077) === 0), 'execution_profile_not_private')
  }
  executionAssert(inside(profile.root, profile.config.directory) && inside(profile.root, profile.databasePath), 'execution_profile_changed')
  await canonicalExecutionDirectory(profile.config.directory)
  await canonicalExecutionDirectory(path.dirname(profile.databasePath))
  for (const directory of [profile.config.directory, path.dirname(profile.databasePath)]) {
    executionAssert(await lstat(directory).then(info => process.platform === 'win32' || (info.mode & 0o077) === 0), 'execution_profile_not_private')
  }
  const db = await lstat(profile.databasePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  })
  executionAssert(!db || (db.isFile() && !db.isSymbolicLink()), 'execution_profile_changed')
  if (profile.models) {
    executionAssert(inside(profile.root, profile.models.path) && await filesystem.realpath(profile.models.path) === profile.models.path)
    executionAssert(await lstat(profile.models.path).then(info => info.isFile() && !info.isSymbolicLink()), 'execution_profile_changed')
    executionAssert(await hashOpenCodeFile(profile.models.path) === profile.models.sha256, 'execution_profile_changed')
  }
}

/** Receipt covers the owner's reviewed graph, including generated client and server dependencies. */
export type ExecutionGraphProgress = Readonly<{ phase: 'hash' | 'closure'; completed: number; total: number }>
export async function validateExecutionGraph(pin: '2.0.0' | '2.0.21', receipt: ExecutionGraph,
  progress?: (value: ExecutionGraphProgress) => void) {
  executionAssert(receipt.files.length > 0 && receipt.files.length <= 65_536)
  const rows = [...receipt.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  executionAssert(new Set(rows.map(row => row.path)).size === rows.length && executionHash(rows) === receipt.sha256, 'execution_graph_changed')
  progress?.({ phase: 'hash', completed: 0, total: rows.length })
  // Official graphs contain tens of thousands of independent files. Bound
  // concurrent reads instead of serializing each filesystem round trip.
  let next = 0, completed = 0, failed = false
  let failure: unknown
  const worker = async () => {
    try {
      while (!failed) {
        const row = rows[next++]
        if (!row) return
        executionAssert(/^[a-f0-9]{64}$/.test(row.sha256) && path.isAbsolute(row.path) && await filesystem.realpath(row.path) === row.path)
        executionAssert(await hashOpenCodeFile(row.path) === row.sha256, 'execution_graph_changed')
        completed++
        if (completed % 16 === 0 || completed === rows.length) progress?.({ phase: 'hash', completed, total: rows.length })
      }
    } catch (error) {
      if (!failed) { failed = true; failure = error }
      throw error
    }
  }
  // A failed row stops new claims; join every already claimed read before reject.
  await Promise.allSettled(Array.from({ length: Math.min(16, rows.length) }, worker))
  if (failed) throw failure
  progress?.({ phase: 'closure', completed: rows.length, total: rows.length })
  const graph = await verifyOpenCodeV2ServerGraph(pin)
  executionAssert(rows.some(row => row.path === graph.modulePath && row.sha256 === graph.moduleSha256) &&
    rows.some(row => row.path === graph.effectPath), 'execution_graph_incomplete')
  const listed = new Set(rows.map(row => row.path)), visited = new Set<string>()
  const locate = async (name: string, from: string): Promise<string> => {
    executionAssert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name), 'execution_graph_incomplete')
    for (let directory = from; ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, 'node_modules', name)
      try { return await filesystem.realpath(candidate) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      executionAssert(path.dirname(directory) !== directory, 'execution_graph_dependency_missing')
    }
  }
  const packageRoot = async (entry: string): Promise<string> => {
    for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
      try { await lstat(path.join(directory, 'package.json')); return directory } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      executionAssert(path.dirname(directory) !== directory, 'execution_graph_incomplete')
    }
  }
  const visit = async (root: string, expectedName: string): Promise<void> => {
    const metadata = executionRecord(await readOpenCodePackageManifest(path.join(root, 'package.json')))
    executionAssert(metadata.name === expectedName && typeof metadata.version === 'string', 'execution_graph_changed')
    if (visited.has(root)) return
    executionAssert(visited.size < 1000, 'execution_graph_incomplete'); visited.add(root)
    if (/^@opencode\/(?:client|server|core|schema|protocol|util|simulation)$/.test(metadata.name)) executionAssert(metadata.version === pin, 'execution_graph_changed')
    if (metadata.name === 'effect') executionAssert(metadata.version === '4.0.0-rc.112', 'execution_graph_changed')
    const walk = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.name === 'node_modules') continue
        const file = path.join(directory, item.name)
        executionAssert(!item.isSymbolicLink(), 'execution_graph_incomplete')
        if (item.isDirectory()) await walk(file)
        else executionAssert(item.isFile() && listed.has(file), 'execution_graph_incomplete')
      }
    }
    await walk(root)
    const dependencies = metadata.dependencies === undefined ? {} : metadata.dependencies as Record<string, unknown>
    executionAssert(dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies))
    for (const name of Object.keys(dependencies)) await visit(await locate(name, root), dependencyPackageName(name, dependencies[name]))
    const optional = metadata.optionalDependencies === undefined ? {} : metadata.optionalDependencies as Record<string, unknown>
    executionAssert(optional !== null && typeof optional === 'object' && !Array.isArray(optional))
    for (const name of Object.keys(optional)) {
      let resolved: string
      try { resolved = await locate(name, root) } catch (error) {
        if (!(error instanceof Error) || error.message !== 'execution_graph_dependency_missing') throw error
        continue
      }
      await visit(resolved, dependencyPackageName(name, optional[name]))
    }
  }
  const client = await filesystem.realpath(Bun.resolveSync(pin === '2.0.0' ? '@opencode/client-v2-floor' : '@opencode/client', import.meta.dir))
  await visit(await packageRoot(graph.modulePath), '@opencode/server')
  await visit(await packageRoot(graph.effectPath), 'effect')
  await visit(await packageRoot(client), '@opencode/client')
  return graph
}

/** npm aliases keep the dependency lookup key but declare another package name.
 * The installed target still passes the same pin and complete byte checks. */
function dependencyPackageName(name: string, specification: unknown): string {
  executionAssert(typeof specification === 'string', 'execution_graph_changed')
  if (!specification.startsWith('npm:')) return name
  const alias = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[^\s]+)?$/.exec(specification)
  executionAssert(alias, 'execution_graph_changed')
  return alias[1]!
}

export async function validateExecutionNative(native: ValidatedExecutionNative): Promise<void> {
  executionAssert(await filesystem.realpath(native.executablePath) === native.executablePath && /^opencode(?:\.exe)?$/.test(path.basename(native.executablePath)), 'execution_identity_mismatch')
  const metadata = executionRecord(await readOpenCodePackageManifest(path.join(path.dirname(path.dirname(native.executablePath)), 'package.json')))
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  executionAssert(metadata.name === native.packageName && metadata.version === native.version &&
    native.packageName.startsWith(`@opencode/cli-${platform}-${process.arch}`), 'execution_identity_mismatch')
  executionAssert(await hashOpenCodeFile(native.executablePath) === native.executableSha256, 'execution_identity_mismatch')
  const handle = await open(native.executablePath, 'r')
  try {
    const header = Buffer.alloc(4); await handle.read(header, 0, 4, 0)
    const magic = header.toString('hex')
    executionAssert(process.platform === 'linux' ? magic === '7f454c46' : process.platform === 'win32' ? magic.startsWith('4d5a') :
      ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(magic), 'execution_identity_mismatch')
  } finally { await handle.close() }
}

export type { ExecutionBirth } from '../execution/OpenCodeV2ExecutionContracts.js'
/** Native Linux ticks and Darwin process versions are never compared with a wall clock. */
export async function readExecutionBirth(pid: number): Promise<ExecutionBirth | null> {
  if (process.platform === 'linux' || process.platform === 'darwin') return readExecutionPlatformBirth(pid)
  // Windows birth is a native FILETIME identity. Do not substitute a POSIX
  // process-start clock or treat a missing PID as proof that a process exited.
  if (pid === process.pid && process.env.OPENCODE_V2_WINDOWS_PIPE) {
    const { windowsExecutionSelfBirth } = await import('./windows/OpenCodeV2WindowsChildControl.js')
    return windowsExecutionSelfBirth()
  }
  const { windowsBirth } = await import('./windows/OpenCodeV2WindowsExecution.js')
  return windowsBirth(pid)
}
