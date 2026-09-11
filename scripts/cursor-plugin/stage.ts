import { access } from 'node:fs/promises'
import path from 'node:path'
import { buildCursorPluginArtifact } from './build.js'

const pluginWorkspace = path.join(import.meta.dir)

/**
 * The plugin is built from its pinned dependencies, which a fresh checkout does
 * not have. Installing them here keeps `bun run build` working on a clean clone
 * instead of failing on a missing package nobody was told to install.
 */
async function ensurePluginDependencies(): Promise<void> {
  const installed = path.join(pluginWorkspace, 'node_modules/@rama_nigg/open-cursor')
  if (await access(installed).then(() => true, () => false)) return
  const install = Bun.spawnSync(
    ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
    { cwd: pluginWorkspace, stdout: 'pipe', stderr: 'pipe' },
  )
  if (install.exitCode !== 0) {
    throw new Error(`Failed to install Cursor plugin dependencies: ${
      new TextDecoder().decode(install.stderr).trim().slice(-800)}`)
  }
}

/**
 * Produces the exact layout `resolveOpenCodeCursorManagedAssets` verifies.
 * Build-time only: user machines never compile or fetch anything here.
 */
export async function stageCursorManagedAssets(destination: string): Promise<string> {
  const root = path.resolve(destination)
  await ensurePluginDependencies()
  await buildCursorPluginArtifact(path.join(root, 'plugin'))
  return root
}

if (import.meta.main) {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: bun scripts/cursor-plugin/stage.ts <asset-root>')
  console.log(await stageCursorManagedAssets(output))
}
