import path from 'node:path'
import { cp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { stageOpenCodeV2Graphs } from '../../opencode-v2/stage.ts'

export type Artifact = { path: string; sha256: string; metadataReadInput: boolean }
export async function stageFixture(readonly: string): Promise<Artifact[]> {
  await stageOpenCodeV2Graphs(path.resolve(import.meta.dir, '../../..'), readonly, { portable: true, platform: 'win32', arch: 'x64' })
  await cp(import.meta.dir, path.join(readonly, 'windows-official-shell'), { recursive: true })
  // Verify the actual child import location, not merely the graph root. Keep
  // the finite expected physical entries for ACL/resolver failure diagnostics.
  const resolution = []
  for (const specifier of ['effect', 'effect/unstable/process/ChildProcessSpawner', '@opencode/server-v2-floor/routes', '@opencode/server/routes']) {
    const entry = await realpath(Bun.resolveSync(specifier, path.join(readonly, 'windows-official-shell')))
    const relative = path.relative(readonly, entry)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('TEST official child import escaped its staged graph')
    resolution.push({ specifier, entry: relative })
  }
  await writeFile(path.join(readonly, 'windows-official-shell', 'resolution.json'), JSON.stringify(resolution))
  const artifacts: Artifact[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) artifacts.push({ path: path.relative(readonly, file), sha256: createHash('sha256').update(await readFile(file)).digest('hex'), metadataReadInput: /\.(?:js|json|node|wasm)$/.test(file) || ['checkpoint.ts', 'spawner.ts', 'native-command.ts'].includes(entry.name) })
      else throw new Error('TEST runtime graph contains a non-regular artifact')
    }
  }
  await walk(path.join(readonly, 'node_modules'))
  await walk(path.join(readonly, 'windows-official-shell'))
  await writeFile(path.join(readonly, 'official-artifacts.json'), JSON.stringify(artifacts))
  return artifacts
}
export async function verifyArtifacts(readonly: string, artifacts: Artifact[]) {
  for (const artifact of artifacts) if (createHash('sha256').update(await readFile(path.join(readonly, artifact.path))).digest('hex') !== artifact.sha256) throw new Error(`TEST official runtime artifact changed: ${artifact.path}`)
}
