import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = import.meta.dir
export const CURSOR_PLUGIN_VERSION = '2.5.2'
export const CURSOR_PLUGIN_SOURCE_SHA256 = '9afffb392a99ced5d7a30a08cef1b7abf41df17251592f7d9db0117084c92be3'
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Build-time only. Never patches OpenCode's shared/user package cache. */
export async function buildCursorPluginArtifact(outputDirectory: string): Promise<string> {
  const packageRoot = path.join(root, 'node_modules/@rama_nigg/open-cursor')
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const source = await readFile(path.join(packageRoot, 'src/plugin.ts'), 'utf8')
  if (metadata.name !== '@rama_nigg/open-cursor' || metadata.version !== CURSOR_PLUGIN_VERSION
    || sha256(source) !== CURSOR_PLUGIN_SOURCE_SHA256) {
    throw new Error('Cursor plugin source does not match the reviewed pin')
  }
  const staging = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-cursor-build-'))
  try {
    await cp(path.join(packageRoot, 'src'), path.join(staging, 'src'), { recursive: true })
    await symlink(path.join(root, 'node_modules'), path.join(staging, 'node_modules'), 'junction')
    const patch = path.join(root, 'cancellation.patch')
    for (const check of [true, false]) {
      const result = Bun.spawnSync(['git', 'apply', ...(check ? ['--check'] : []), patch], {
        cwd: staging, stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error('Reviewed Cursor cancellation patch did not apply')
    }
    const build = async (entry: string, target: 'bun' | 'node' = 'bun') => {
      const result = await Bun.build({
        entrypoints: [path.join(staging, entry)],
        target, format: 'esm', minify: true, splitting: false,
        external: ['@cursor/sdk'],
      })
      if (!result.success || result.outputs.length !== 1) {
        throw new AggregateError(result.logs, `Cursor artifact build failed: ${entry}`)
      }
      return new Uint8Array(await result.outputs[0]!.arrayBuffer())
    }
    const artifact = await build('src/plugin-entry.ts')
    // The plugin's own MCP CLI is how an agent reaches OpenCode MCP servers.
    // Without it on the agent's PATH the bridge registers tools nobody can call.
    // The CLI loads the MCP SDK through a dynamic import, which a standalone
    // bundle cannot resolve at runtime, so pull it into the module graph first.
    await writeFile(path.join(staging, 'src/agent-teams-mcptool-entry.ts'), [
      "import '@modelcontextprotocol/sdk/client/index.js'",
      "import '@modelcontextprotocol/sdk/client/stdio.js'",
      "import './cli/mcptool.js'",
      '',
    ].join('\n'))
    // The CLI runs standalone from the agent shell, where node is far more
    // likely to exist than bun, so it is built for node rather than the runtime.
    const mcpToolArtifact = await build('src/agent-teams-mcptool-entry.ts', 'node')
    const destination = path.resolve(outputDirectory)
    await mkdir(path.join(destination, 'dist/cli'), { recursive: true })
    await writeFile(path.join(destination, 'dist/plugin-entry.js'), artifact)
    await writeFile(path.join(destination, 'dist/cli/mcptool.js'), mcpToolArtifact)
    // Native backend does not use SDK fallback. Keep upstream runner locations valid.
    await cp(path.join(packageRoot, 'scripts'), path.join(destination, 'scripts'), { recursive: true })
    await writeFile(path.join(destination, 'package.json'), JSON.stringify({
      name: 'agent-teams-managed-cursor-plugin', type: 'module', private: true,
    }) + '\n')
    const manifest = {
      schema: 1, upstreamPackage: metadata.name, upstreamVersion: CURSOR_PLUGIN_VERSION,
      sourceSha256: CURSOR_PLUGIN_SOURCE_SHA256,
      patchSha256: sha256(await readFile(patch)),
      lockSha256: sha256(await readFile(path.join(root, 'bun.lock'))),
      artifactSha256: sha256(artifact), bunVersion: Bun.version,
      entrypoint: 'dist/plugin-entry.js', backend: 'cursor-agent',
      mcpToolEntrypoint: 'dist/cli/mcptool.js', mcpToolSha256: sha256(mcpToolArtifact),
    }
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    return path.join(destination, manifest.entrypoint)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: bun scripts/cursor-plugin/build.ts <artifact-directory>')
  console.log(await buildCursorPluginArtifact(output))
}
