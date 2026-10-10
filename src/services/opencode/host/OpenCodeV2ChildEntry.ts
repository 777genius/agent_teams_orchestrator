import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** The compiled CLI cannot run a JS child with its own executable or resolve
 * the external official server graph from Bun's embedded filesystem. */
export async function resolveOpenCodeV2ChildEntry(): Promise<string> {
  const location = import.meta.url
  if ([location, Bun.main].some(value => value.includes('$bunfs') || /[/\\]~BUN[/\\]/.test(value))) {
    throw new Error('v2_compiled_runtime_unsupported')
  }
  const source = location.endsWith('/services/opencode/host/OpenCodeV2ChildEntry.ts')
  const bundled = /\/(?:cli|cli-dev)\.js$/.test(location)
  if (!source && !bundled) throw new Error('v2_child_layout_unsupported')
  // A missing packaged entry must fail; source files never rescue a JS bundle.
  return realpath(fileURLToPath(new URL(source
    ? '../../../entrypoints/opencodeV2Server.ts'
    : './opencodeV2Server.js', location)))
}
