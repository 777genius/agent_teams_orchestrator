import path from 'node:path'
import { resolveOpenCodeV2ExecutionDelivery } from '../host/OpenCodeV2ExecutionDelivery.js'
import { createHash } from 'node:crypto'
import { readFile, realpath, readdir, lstat } from 'node:fs/promises'
import { executionHash, executionAssert, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionMcpConfig } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionBinding.js'

/** Read-only installed graph receipt; no server import, CLI execution, or output file. */
export async function createOpenCodeV2ExecutionReceipt(_sourceRoot: string, identity: import('../compatibility/OpenCodeNativeIdentity.js').OpenCodeV2NativeIdentity, controller?: ExecutionMcpConfig): Promise<ValidatedExecutionNative> {
const cli = await realpath(identity.executablePath), bun = await realpath(process.execPath), pin = identity.version
executionAssert(process.platform === 'linux' && process.versions.bun === '1.3.11' && identity.generation === 'v2', 'source_linux_required')
const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution')
// Legacy callers supply a source root; delivery is derived from this module, never that hint.
const resolutionRoot = delivery.runtimeMode === 'source' ? path.join(delivery.root, 'src/services/opencode/host') : delivery.root
const server = await realpath(Bun.resolveSync(pin === '2.0.0' ? '@opencode/server-v2-floor/process' : '@opencode/server/process', resolutionRoot))
const client = await realpath(Bun.resolveSync(pin === '2.0.0' ? '@opencode/client-v2-floor' : '@opencode/client', resolutionRoot))
const effect = await realpath(Bun.resolveSync('effect', path.dirname(server)))
async function locate(name: string, from: string): Promise<string | undefined> {
  executionAssert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name))
  for (let directory = from; ; directory = path.dirname(directory)) {
    try { return await realpath(path.join(directory, 'node_modules', name)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (path.dirname(directory) === directory) return undefined
  }
}
const visited = new Set<string>(), files: { path: string; sha256: string }[] = []
async function visit(root: string, expectedName?: string): Promise<void> {
  if (visited.has(root)) return
  executionAssert(visited.size < 1000, 'graph_package_budget'); visited.add(root)
  const metadata = executionRecord(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')))
  executionAssert(typeof metadata.name === 'string' && typeof metadata.version === 'string')
  if (expectedName) executionAssert(metadata.name === expectedName, 'package_name_mismatch')
  if (/^@opencode\/(?:client|server|core|schema|protocol|util|simulation)$/.test(metadata.name)) executionAssert(metadata.version === pin, 'package_pin_mismatch')
  if (metadata.name === 'effect') executionAssert(metadata.version === '4.0.0-rc.112', 'effect_pin_mismatch')
  async function walk(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue
      const file = path.join(directory, item.name)
      executionAssert(!item.isSymbolicLink(), 'graph_symlink_not_supported')
      if (item.isDirectory()) await walk(file)
      else { executionAssert(item.isFile() && files.length < 65_536, 'graph_file_budget'); files.push({ path: file, sha256: await sha(file) }) }
    }
  }
  await walk(root)
  for (const optional of [false, true]) {
    const deps = metadata[optional ? 'optionalDependencies' : 'dependencies']
    if (deps === undefined) continue
    for (const name of Object.keys(executionRecord(deps))) {
      const dependency = await locate(name, root)
      if (!dependency && optional) continue
      executionAssert(dependency, 'graph_dependency_missing:' + name); await visit(dependency, name)
    }
  }
}
await visit(await resolveOpenCodeV2ReceiptPackageRoot(server), '@opencode/server')
await visit(await resolveOpenCodeV2ReceiptPackageRoot(client), '@opencode/client')
await visit(await resolveOpenCodeV2ReceiptPackageRoot(effect), 'effect')
// The bridge's SDK tools/list client and the exact selected native local MCP
// command need their own genuine closure inside the read-only execution graph.
const mcpSdk = await realpath(Bun.resolveSync('@modelcontextprotocol/sdk/client/index.js', resolutionRoot))
await visit(await resolveOpenCodeV2ReceiptPackageRoot(mcpSdk), '@modelcontextprotocol/sdk')
if (controller?.type === 'local') {
  executionAssert(controller.command.length >= 2 && path.isAbsolute(controller.command[0]!), 'controller_runtime_missing')
  const runtime = await realpath(controller.command[0]!)
  executionAssert(runtime === controller.command[0] && (await lstat(runtime)).isFile() &&
    (await readFile(runtime)).subarray(0, 4).toString('hex') === '7f454c46', 'controller_runtime_invalid')
  files.push({ path: runtime, sha256: await sha(runtime) })
  let entries = 0
  for (const argument of controller.command.slice(1)) {
    if (argument.startsWith('-')) continue
    executionAssert(path.isAbsolute(argument), 'controller_entry_not_absolute')
    const entry = await realpath(argument)
    executionAssert(entry === argument && (await lstat(entry)).isFile(), 'controller_entry_invalid')
    await visit(await resolveOpenCodeV2ReceiptPackageRoot(entry)); entries++
  }
  executionAssert(entries > 0, 'controller_entry_missing')
}
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
executionAssert(new Set(files.map(row => row.path)).size === files.length)
const cliMetadata = executionRecord(JSON.parse(await readFile(path.join(path.dirname(path.dirname(cli)), 'package.json'), 'utf8')))
executionAssert(typeof cliMetadata.name === 'string' && cliMetadata.name.startsWith('@opencode/cli-linux-') && cliMetadata.version === pin)
executionAssert((await readFile(cli)).subarray(0, 4).toString('hex') === '7f454c46')
const native = { generation: 'v2', version: pin, dialect: `v2-${pin}`, runtimeMode: delivery.runtimeMode, executablePath: cli,
  executableSha256: await sha(cli), packageName: cliMetadata.name, entrySha256: delivery.entrySha256,
  bun: { path: bun, sha256: await sha(bun) }, graph: { sha256: executionHash(files), files } } satisfies ValidatedExecutionNative
executionAssert(native.executableSha256 === identity.executableSha256 && native.packageName === identity.packageName, 'native_selection_changed')
return native
}

/** A nested module-scope manifest is not the named/versioned installed package root. */
export async function resolveOpenCodeV2ReceiptPackageRoot(file: string): Promise<string> {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    let metadata: Record<string, unknown> | undefined
    try { metadata = executionRecord(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))) }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
    if (metadata) {
      if (typeof metadata.name === 'string' && typeof metadata.version === 'string') return directory
      executionAssert(metadata.name === undefined && metadata.version === undefined, 'receipt_package_metadata_invalid')
    }
    executionAssert(path.dirname(directory) !== directory, 'package_root_missing')
  }
}
