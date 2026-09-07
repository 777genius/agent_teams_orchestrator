import path from 'node:path'
import { buildCursorNativeAssets } from './build-native.js'
import { buildCursorPluginArtifact } from './build.js'

/**
 * Produces the exact layout `resolveOpenCodeCursorManagedAssets` verifies.
 * Build-time only: user machines never compile or fetch anything here.
 */
export async function stageCursorManagedAssets(destination: string): Promise<string> {
  const root = path.resolve(destination)
  await buildCursorPluginArtifact(path.join(root, 'plugin'))
  await buildCursorNativeAssets(path.join(root, 'native'))
  return root
}

if (import.meta.main) {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: bun scripts/cursor-plugin/stage.ts <asset-root>')
  console.log(await stageCursorManagedAssets(output))
}
