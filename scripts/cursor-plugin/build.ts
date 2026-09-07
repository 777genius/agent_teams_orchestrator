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
    await cp(path.join(root, 'managed-control.ts'), path.join(staging, 'src/agent-teams-cursor-control.ts'))
    await symlink(path.join(root, 'node_modules'), path.join(staging, 'node_modules'), 'junction')
    const patch = path.join(root, 'cancellation.patch')
    for (const check of [true, false]) {
      const result = Bun.spawnSync(['git', 'apply', ...(check ? ['--check'] : []), patch], {
        cwd: staging, stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error('Reviewed Cursor cancellation patch did not apply')
    }
    const result = await Bun.build({
      entrypoints: [path.join(staging, 'src/plugin-entry.ts')],
      target: 'bun', format: 'esm', minify: true, splitting: false,
      external: ['@cursor/sdk'],
    })
    if (!result.success || result.outputs.length !== 1) {
      throw new AggregateError(result.logs, 'Cursor plugin artifact build failed')
    }
    const artifact = new Uint8Array(await result.outputs[0]!.arrayBuffer())
    const destination = path.resolve(outputDirectory)
    await mkdir(path.join(destination, 'dist'), { recursive: true })
    await writeFile(path.join(destination, 'dist/plugin-entry.js'), artifact)
    // Native backend does not use SDK fallback. Keep upstream runner locations valid.
    await cp(path.join(packageRoot, 'scripts'), path.join(destination, 'scripts'), { recursive: true })
    await writeFile(path.join(destination, 'package.json'), JSON.stringify({
      name: 'agent-teams-managed-cursor-plugin', type: 'module', private: true,
    }) + '\n')
    const manifest = {
      schema: 1, upstreamPackage: metadata.name, upstreamVersion: CURSOR_PLUGIN_VERSION,
      sourceSha256: CURSOR_PLUGIN_SOURCE_SHA256,
      patchSha256: sha256(await readFile(patch)),
      controlSourceSha256: sha256(await readFile(path.join(root, 'managed-control.ts'))),
      lockSha256: sha256(await readFile(path.join(root, 'bun.lock'))),
      artifactSha256: sha256(artifact), bunVersion: Bun.version,
      entrypoint: 'dist/plugin-entry.js', backend: 'cursor-agent',
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
