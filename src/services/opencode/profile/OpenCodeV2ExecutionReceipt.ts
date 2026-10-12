import path from 'node:path'
import { resolveOpenCodeV2ExecutionDelivery } from '../host/OpenCodeV2ExecutionDelivery.js'
import { assertExecutionPlatformAvailable } from '../host/OpenCodeV2ExecutionPlatform.js'
import { validateExecutionNative } from '../host/OpenCodeV2ExecutionBinding.js'
import { createHash } from 'node:crypto'
import { readFile, realpath, readdir, lstat } from 'node:fs/promises'
import { executionHash, executionAssert, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionMcpConfig } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionBinding.js'

/** Read-only installed graph receipt; no server import, CLI execution, or output file. */
export async function createOpenCodeV2ExecutionReceipt(_sourceRoot: string, identity: import('../compatibility/OpenCodeNativeIdentity.js').OpenCodeV2NativeIdentity, controller?: ExecutionMcpConfig): Promise<ValidatedExecutionNative> {
assertExecutionPlatformAvailable()
executionAssert(process.versions.bun === '1.3.11' && identity.generation === 'v2', 'source_bun_required')
const cli = await realpath(identity.executablePath), bun = await realpath(process.execPath), pin = identity.version
const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const cliSha256 = await sha(cli)
executionAssert(cliSha256 === identity.executableSha256, 'native_selection_changed')
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
    const pending: string[] = []
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue
      const file = path.join(directory, item.name)
      executionAssert(!item.isSymbolicLink(), 'graph_symlink_not_supported')
      if (item.isDirectory()) await walk(file)
      else { executionAssert(item.isFile(), 'graph_file_budget'); pending.push(file) }
    }
    executionAssert(files.length + pending.length <= 65_536, 'graph_file_budget')
    // Preserve complete byte verification while bounding independent filesystem reads.
    for (let offset = 0; offset < pending.length; offset += 16)
      files.push(...await Promise.all(pending.slice(offset, offset + 16).map(async file => ({ path: file, sha256: await sha(file) }))))
  }
  await walk(root)
  for (const optional of [false, true]) {
    const deps = metadata[optional ? 'optionalDependencies' : 'dependencies']
    if (deps === undefined) continue
    const dependencies = executionRecord(deps)
    for (const name of Object.keys(dependencies)) {
      const dependency = await locate(name, root)
      if (!dependency && optional) continue
      executionAssert(dependency, 'graph_dependency_missing:' + name)
      const specification = dependencies[name]
      executionAssert(typeof specification === 'string', 'graph_dependency_invalid')
      const alias = specification.startsWith('npm:')
        ? /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[^\s]+)?$/.exec(specification) : null
      executionAssert(!specification.startsWith('npm:') || alias, 'graph_dependency_invalid')
      await visit(dependency, alias ? alias[1]! : name)
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
  const magic = (await readFile(runtime)).subarray(0, 4).toString('hex')
  executionAssert(runtime === controller.command[0] && (await lstat(runtime)).isFile() &&
    (process.platform === 'linux' ? magic === '7f454c46' :
      ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)), 'controller_runtime_invalid')
  const runtimeFiles = process.platform === 'darwin'
    ? (await resolveOpenCodeV2DarwinControllerRuntimeClosure(runtime)).files
    : [{ path: runtime, sha256: await sha(runtime) }]
  for (const row of runtimeFiles) {
    const previous = files.find(file => file.path === row.path)
    executionAssert(!previous || previous.sha256 === row.sha256, 'controller_runtime_changed')
    if (!previous) files.push(row)
  }
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
executionAssert(typeof cliMetadata.name === 'string' && cliMetadata.version === pin)
const native = { generation: 'v2', version: pin, dialect: `v2-${pin}`, runtimeMode: delivery.runtimeMode, executablePath: cli,
  executableSha256: cliSha256, packageName: cliMetadata.name, entrySha256: delivery.entrySha256,
  bun: { path: bun, sha256: await sha(bun) }, graph: { sha256: executionHash(files), files } } satisfies ValidatedExecutionNative
executionAssert(native.executableSha256 === identity.executableSha256 && native.packageName === identity.packageName, 'native_selection_changed')
await validateExecutionNative(native)
return native
}

export type DarwinControllerRuntimeClosure = Readonly<{
  files: readonly Readonly<{ path: string; sha256: string }>[]
  aliases: readonly Readonly<{ source: string; target: string }>[]
}>

/** Bind the selected Mach-O runtime's load commands and their exact file aliases.
 * System shared-cache images retain the existing Darwin system-policy scope. */
export async function resolveOpenCodeV2DarwinControllerRuntimeClosure(runtime: string): Promise<DarwinControllerRuntimeClosure> {
  executionAssert(process.platform === 'darwin' && path.isAbsolute(runtime) && await realpath(runtime) === runtime,
    'controller_runtime_invalid')
  const files = new Map<string, Readonly<{ path: string; sha256: string }>>()
  const aliases = new Map<string, Readonly<{ source: string; target: string }>>()
  const cpu = process.arch === 'arm64' ? 0x0100000c : process.arch === 'x64' ? 0x01000007 : 0
  executionAssert(cpu !== 0, 'controller_runtime_architecture_invalid')
  let totalBytes = 0
  const system = (file: string) => file.startsWith('/usr/lib/') || file.startsWith('/System/Library/')
  const expand = (name: string, image: string): string => {
    if (name === '@loader_path' || name.startsWith('@loader_path/')) return path.resolve(path.dirname(image), name.slice(13))
    if (name === '@executable_path' || name.startsWith('@executable_path/')) return path.resolve(path.dirname(runtime), name.slice(17))
    executionAssert(path.isAbsolute(name), 'controller_runtime_dependency_unknown')
    return path.normalize(name)
  }
  const commands = (bytes: Buffer): { dependencies: string[]; rpaths: string[] } => {
    executionAssert(bytes.length >= 28, 'controller_runtime_macho_invalid')
    let image = bytes
    const fatMagic = bytes.subarray(0, 4).toString('hex')
    if (['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(fatMagic)) {
      const little = fatMagic === 'bebafeca' || fatMagic === 'bfbafeca', wide = fatMagic === 'cafebabf' || fatMagic === 'bfbafeca'
      const number = (offset: number) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
      const count = number(4), stride = wide ? 32 : 20
      executionAssert(count > 0 && count <= 64 && 8 + count * stride <= bytes.length, 'controller_runtime_macho_invalid')
      let selected: Buffer | undefined
      for (let index = 0; index < count; index++) {
        const at = 8 + index * stride
        if (number(at) !== cpu) continue
        const integer = (offset: number) => wide
          ? Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)) : number(offset)
        const offset = integer(at + 8), size = integer(at + (wide ? 16 : 12))
        executionAssert(!selected && Number.isSafeInteger(offset) && Number.isSafeInteger(size) &&
          offset >= 8 + count * stride && size >= 28 && offset + size <= bytes.length, 'controller_runtime_macho_invalid')
        selected = bytes.subarray(offset, offset + size)
      }
      executionAssert(selected, 'controller_runtime_architecture_invalid'); image = selected
    }
    const magic = image.subarray(0, 4).toString('hex'), little = magic === 'cffaedfe' || magic === 'cefaedfe'
    executionAssert(little || magic === 'feedfacf' || magic === 'feedface', 'controller_runtime_macho_invalid')
    const number = (offset: number) => little ? image.readUInt32LE(offset) : image.readUInt32BE(offset)
    const header = magic === 'cffaedfe' || magic === 'feedfacf' ? 32 : 28
    executionAssert(image.length >= header && number(4) === cpu, 'controller_runtime_architecture_invalid')
    const count = number(16), commandBytes = number(20), end = header + commandBytes
    executionAssert(count <= 4096 && commandBytes <= 8 * 1024 * 1024 && end <= image.length, 'controller_runtime_macho_invalid')
    const dependencies: string[] = [], rpaths: string[] = []
    let at = header
    for (let index = 0; index < count; index++) {
      executionAssert(at + 8 <= end, 'controller_runtime_macho_invalid')
      const kind = number(at), size = number(at + 4)
      executionAssert(size >= 8 && size % 4 === 0 && at + size <= end, 'controller_runtime_macho_invalid')
      const dylib = [0x0c, 0x80000018, 0x8000001f, 0x20, 0x80000023].includes(kind)
      if (dylib || kind === 0x8000001c) {
        const minimum = dylib ? 24 : 12
        executionAssert(size >= minimum, 'controller_runtime_macho_invalid')
        const offset = number(at + 8), nul = image.indexOf(0, at + offset)
        executionAssert(offset >= minimum && offset < size && nul >= at + offset && nul < at + size,
          'controller_runtime_macho_invalid')
        const name = new TextDecoder('utf-8', { fatal: true }).decode(image.subarray(at + offset, nul))
        executionAssert(name.length > 0, 'controller_runtime_macho_invalid')
        ;(dylib ? dependencies : rpaths).push(name)
      }
      at += size
    }
    executionAssert(at === end, 'controller_runtime_macho_invalid')
    return { dependencies, rpaths }
  }
  async function visit(target: string, inheritedRpaths: readonly string[]): Promise<void> {
    const source = await realpath(target)
    if (source !== target) aliases.set(target, Object.freeze({ source, target }))
    if (files.has(source)) return
    const stat = await lstat(source)
    executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024 * 1024 && files.size < 256,
      'controller_runtime_dependency_budget')
    totalBytes += stat.size
    executionAssert(totalBytes <= 512 * 1024 * 1024, 'controller_runtime_dependency_budget')
    const bytes = await readFile(source), parsed = commands(bytes)
    files.set(source, Object.freeze({ path: source, sha256: createHash('sha256').update(bytes).digest('hex') }))
    const rpaths = [...new Set([...parsed.rpaths.map(name => expand(name, target)), ...inheritedRpaths])]
    for (const name of parsed.dependencies) {
      const candidates = name.startsWith('@rpath/') ? rpaths.map(root => path.resolve(root, name.slice(7))) : [expand(name, target)]
      let selected: string | undefined
      for (const candidate of candidates) {
        if (system(candidate)) { selected = candidate; break }
        try { await realpath(candidate); selected = candidate; break }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
      executionAssert(selected, 'controller_runtime_dependency_missing')
      if (!system(selected)) await visit(selected, rpaths)
    }
  }
  await visit(runtime, [])
  for (const alias of aliases.values()) executionAssert(await realpath(alias.target) === alias.source, 'controller_runtime_changed')
  const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  return Object.freeze({ files: Object.freeze([...files.values()].sort(byPath)),
    aliases: Object.freeze([...aliases.values()].sort((a, b) => byPath({ path: a.target }, { path: b.target }))) })
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
