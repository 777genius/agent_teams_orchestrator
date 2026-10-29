import path from 'node:path'
import { readdir, realpath } from 'node:fs/promises'
import { executionAssert, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import { hashOpenCodeFile, readOpenCodePackageManifest } from '../compatibility/OpenCodeNativeIdentity.js'
import type { OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'
import { resolveOpenCodeV2GraphEntry } from './OpenCodeV2ServerGraph.js'
import { resolveOpenCodeV2Delivery, verifyOpenCodeV2DeliveryFile, type OpenCodeV2DeliveryBinding } from './OpenCodeV2DeliveryManifest.js'

/** A nested module-scope manifest is not the named/versioned installed package root. */
export async function resolveOpenCodeV2ReceiptPackageRoot(file: string): Promise<string> {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    let metadata: Record<string, unknown> | undefined
    try { metadata = executionRecord(await readOpenCodePackageManifest(path.join(directory, 'package.json'))) }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
    if (metadata) {
      if (typeof metadata.name === 'string' && typeof metadata.version === 'string') return directory
      executionAssert(metadata.name === undefined && metadata.version === undefined, 'receipt_package_metadata_invalid')
    }
    executionAssert(path.dirname(directory) !== directory, 'package_root_missing')
  }
}

/** One complete selected closure, shared by execution receipts and finite catalog acquisition. */
export async function collectOpenCodeV2GraphFiles(pin: OpenCodeV2Pin, resolutionRoot: string,
  binding?: OpenCodeV2DeliveryBinding, signal?: AbortSignal) {
  const delivery = binding ? await resolveOpenCodeV2Delivery(binding) : undefined
  const server = await resolveOpenCodeV2GraphEntry(pin, 'server', 'process', resolutionRoot, binding)
  const client = await resolveOpenCodeV2GraphEntry(pin, 'client', undefined, resolutionRoot, binding)
  const effect = await realpath(Bun.resolveSync('effect', path.dirname(server)))
  const effectVersion = executionRecord(await readOpenCodePackageManifest(path.join(await resolveOpenCodeV2ReceiptPackageRoot(effect), 'package.json'))).version
  executionAssert(typeof effectVersion === 'string' && effectVersion.length > 0, 'effect_pin_mismatch')
  const visited = new Set<string>(), files: { path: string; sha256: string }[] = []
  async function locate(name: string, from: string): Promise<string | undefined> {
    executionAssert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name))
    for (let directory = from; ; directory = path.dirname(directory)) {
      try { return await realpath(path.join(directory, 'node_modules', name)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (path.dirname(directory) === directory) return undefined
    }
  }
  async function visit(root: string, expectedName?: string, payload = false): Promise<void> {
    signal?.throwIfAborted()
    if (visited.has(root)) return
    executionAssert(visited.size < 1000, 'graph_package_budget'); visited.add(root)
    const metadata = executionRecord(await readOpenCodePackageManifest(path.join(root, 'package.json')))
    executionAssert(typeof metadata.name === 'string' && typeof metadata.version === 'string')
    if (expectedName) executionAssert(metadata.name === expectedName, 'package_name_mismatch')
    if (/^@opencode\//.test(metadata.name)) executionAssert(metadata.version === pin, 'package_pin_mismatch')
    if (metadata.name === 'effect' || metadata.name === '@effect/platform-node' || metadata.name === '@effect/platform-node-shared')
      executionAssert(metadata.version === effectVersion, 'effect_pin_mismatch')
    async function walk(directory: string): Promise<void> {
      signal?.throwIfAborted()
      const pending: string[] = []
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.name === 'node_modules') continue
        const file = path.join(directory, item.name)
        executionAssert(!item.isSymbolicLink(), 'graph_symlink_not_supported')
        if (item.isDirectory()) await walk(file)
        else { executionAssert(item.isFile(), 'graph_file_budget'); pending.push(file) }
      }
      executionAssert(files.length + pending.length <= 65_536, 'graph_file_budget')
      for (let offset = 0; offset < pending.length; offset += 16) {
        const outcomes = await Promise.allSettled(pending.slice(offset, offset + 16).map(async file => {
          const sha256 = await hashOpenCodeFile(file, signal)
          if (payload && delivery) await verifyOpenCodeV2DeliveryFile(delivery, file, sha256)
          return { path: file, sha256 }
        }))
        const failed = outcomes.find(row => row.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        files.push(...outcomes.flatMap(row => row.status === 'fulfilled' ? [row.value] : []))
      }
    }
    await walk(root)
    for (const optional of [false, true]) {
      const raw = metadata[optional ? 'optionalDependencies' : 'dependencies']
      if (raw === undefined) continue
      const dependencies = executionRecord(raw)
      for (const name of Object.keys(dependencies)) {
        const dependency = await locate(name, root)
        if (!dependency && optional) continue
        executionAssert(dependency, 'graph_dependency_missing:' + name)
        const specification = dependencies[name]
        executionAssert(typeof specification === 'string', 'graph_dependency_invalid')
        const alias = specification.startsWith('npm:') ? /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[^\s]+)?$/.exec(specification) : null
        executionAssert(!specification.startsWith('npm:') || alias, 'graph_dependency_invalid')
        await visit(dependency, alias ? alias[1]! : name, payload)
      }
    }
  }
  await visit(await resolveOpenCodeV2ReceiptPackageRoot(server), '@opencode/server', true)
  await visit(await resolveOpenCodeV2ReceiptPackageRoot(client), '@opencode/client', true)
  await visit(await resolveOpenCodeV2ReceiptPackageRoot(effect), 'effect', true)
  const mcp = await realpath(Bun.resolveSync('@modelcontextprotocol/sdk/client/index.js', resolutionRoot))
  await visit(await resolveOpenCodeV2ReceiptPackageRoot(mcp), '@modelcontextprotocol/sdk', true)
  return { files, visit }
}
