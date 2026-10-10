import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, realpath, readdir, lstat, mkdir, writeFile } from 'node:fs/promises'
import { executionHash, executionAssert, executionRecord } from '../src/services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import type { ValidatedExecutionNative } from '../src/services/opencode/host/OpenCodeV2ExecutionBinding.js'

// Read-only public package discovery. Does not import/launch an official server or CLI.
const input = executionRecord(JSON.parse(await readFile(process.argv[2]!, 'utf8')))
function string(key: string): string { const value = input[key]; executionAssert(typeof value === 'string' && path.isAbsolute(value)); return value }
const sourceRoot = await realpath(string('sourceRoot')), cli = await realpath(string('cliPath'))
const bun = await realpath(string('bunPath')), output = string('outputRoot')
const pin = input.pin; executionAssert(pin === '2.0.0' || pin === '2.0.21')
executionAssert(path.basename(output).startsWith('TEST-') || output.split(path.sep).some(x => x.startsWith('TEST-')), 'owned_TEST_output_required')
const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const binding = path.join(sourceRoot, 'src/services/opencode/host/OpenCodeV2ExecutionBinding.ts')
const entry = path.join(sourceRoot, 'src/entrypoints/opencodeV2ExecutionServer.ts')
const server = await realpath(Bun.resolveSync(pin === '2.0.0' ? '@opencode/server-v2-floor/process' : '@opencode/server/process', path.dirname(binding)))
const client = await realpath(Bun.resolveSync(pin === '2.0.0' ? '@opencode/client-v2-floor' : '@opencode/client', path.dirname(binding)))
const effect = await realpath(Bun.resolveSync('effect', path.dirname(server)))
async function packageRoot(file: string): Promise<string> {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    try { await lstat(path.join(directory, 'package.json')); return directory } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    executionAssert(path.dirname(directory) !== directory, 'package_root_missing')
  }
}
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
await visit(await packageRoot(server), '@opencode/server')
await visit(await packageRoot(client), '@opencode/client')
await visit(await packageRoot(effect), 'effect')
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
executionAssert(new Set(files.map(row => row.path)).size === files.length)
const cliMetadata = executionRecord(JSON.parse(await readFile(path.join(path.dirname(path.dirname(cli)), 'package.json'), 'utf8')))
executionAssert(typeof cliMetadata.name === 'string' && cliMetadata.name.startsWith('@opencode/cli-linux-') && cliMetadata.version === pin)
executionAssert((await readFile(cli)).subarray(0, 4).toString('hex') === '7f454c46')
const native = { generation: 'v2', version: pin, dialect: `v2-${pin}`, runtimeMode: 'source', executablePath: cli,
  executableSha256: await sha(cli), packageName: cliMetadata.name, entrySha256: await sha(entry),
  bun: { path: bun, sha256: await sha(bun) }, graph: { sha256: executionHash(files), files } } satisfies ValidatedExecutionNative
await mkdir(output, { recursive: true, mode: 0o700 })
await writeFile(path.join(output, `native-${pin}.json`), JSON.stringify(native, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ pin, graphFiles: files.length, packages: visited.size, graphSha256: native.graph.sha256, sourceRoot, output, nativeExecuted: false }))
