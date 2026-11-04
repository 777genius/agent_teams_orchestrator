import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveOpenCodeV2Delivery, resolveOpenCodeV2DeliveryEntry, type OpenCodeV2DeliveryBinding } from './OpenCodeV2DeliveryManifest.js'

/** The compiled CLI cannot run a JS child with its own executable or resolve
 * the external official server graph from Bun's embedded filesystem. */
export async function resolveOpenCodeV2ChildDelivery(binding?: OpenCodeV2DeliveryBinding) {
  const location = import.meta.url
  if ([location, Bun.main].some(value => value.includes('$bunfs') || /[/\\]~BUN[/\\]/.test(value))) {
    throw new Error('v2_compiled_runtime_unsupported')
  }
  const source = location.endsWith('/services/opencode/host/OpenCodeV2ChildEntry.ts')
  const bundled = /\/(?:cli|cli-dev)\.js$/.test(location)
  if (!source && !bundled) throw new Error('v2_child_layout_unsupported')
  if (!source) {
    const delivery = await resolveOpenCodeV2Delivery(binding)
    return { ...await resolveOpenCodeV2DeliveryEntry(delivery, 'opencodeV2Server'), root: delivery.root, binding: delivery.binding }
  }
  const entryPath = await realpath(fileURLToPath(new URL('../../../entrypoints/opencodeV2Server.ts', location)))
  return { entryPath, root: path.dirname(entryPath), binding: undefined }
}

export async function resolveOpenCodeV2ChildEntry(): Promise<string> { return (await resolveOpenCodeV2ChildDelivery()).entryPath }
