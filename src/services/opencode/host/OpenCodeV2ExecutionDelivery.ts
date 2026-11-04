import path from 'node:path'
import filesystem, { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'
import { resolveOpenCodeV2Delivery, resolveOpenCodeV2DeliveryEntry, type OpenCodeV2DeliveryBinding } from './OpenCodeV2DeliveryManifest.js'

/** Resolve only the current delivery layout. A JS bundle never falls back to source. */
export function classifyOpenCodeV2ExecutionDelivery(location: string) {
  executionAssert(![location, Bun.main].some(value => value.includes('$bunfs') || /[/\\]~BUN[/\\]/.test(value)), 'v2_compiled_runtime_unsupported')
  const file = fileURLToPath(location)
  // Match the same closed layouts after Windows URL conversion, while retaining
  // the native path for canonical filesystem identity and child resolution.
  const layout = process.platform === 'win32' ? file.replaceAll('\\', '/') : file
  const source = /\/src\/(?:services\/opencode\/(?:host|profile|bridge)\/[^/]+|entrypoints\/opencodeV2(?:ExecutionServer|RunOwner))\.ts$/.test(layout)
  const packaged = /\/(?:cli|cli-dev|opencodeV2ExecutionServer|opencodeV2RunOwner)\.js$/.test(layout)
  executionAssert(source || packaged, 'v2_execution_layout_unsupported')
  return { file, source }
}

export async function resolveOpenCodeV2ExecutionDelivery(location: string, child: 'execution' | 'run-owner', binding?: OpenCodeV2DeliveryBinding) {
  const { file, source } = classifyOpenCodeV2ExecutionDelivery(location)
  const name = child === 'execution' ? 'opencodeV2ExecutionServer' : 'opencodeV2RunOwner'
  if (!source) {
    const delivery = await resolveOpenCodeV2Delivery(binding)
    const entry = await resolveOpenCodeV2DeliveryEntry(delivery, name)
    if (!/[/\\](?:cli|cli-dev)\.js$/.test(file))
      executionAssert(file === path.join(delivery.root, path.basename(file)), 'execution_entry_changed')
    return { runtimeMode: 'packaged' as const, root: delivery.root, ...entry, binding: delivery.binding,
      ...(/[/\\](?:cli|cli-dev)\.js$/.test(file) ? { baseEntryPath: await filesystem.realpath(file) } : {}) }
  }
  const directory = source ? file.slice(0, file.lastIndexOf(`${path.sep}src${path.sep}`)) : path.dirname(file)
  let root: string
  if (process.platform === 'win32' && source) {
    // The source subtree is admitted; its parent has metadata access only.
    const expected = path.join(directory, 'src')
    const canonical = await filesystem.realpath(expected)
    executionAssert(canonical === expected, 'execution_entry_changed')
    root = path.dirname(canonical)
  } else root = await filesystem.realpath(directory)
  const entryPath = await filesystem.realpath(path.join(root, source ? `src/entrypoints/${name}.ts` : `${name}.js`))
  executionAssert(entryPath === path.join(root, source ? `src/entrypoints/${name}.ts` : `${name}.js`), 'execution_entry_changed')
  return { runtimeMode: source ? 'source' as const : 'packaged' as const, root, entryPath,
    entrySha256: createHash('sha256').update(await readFile(entryPath)).digest('hex'), binding: undefined, baseEntryPath: undefined }
}
