import path from 'node:path'
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { stageOpenCodeV2Graphs } from '../../opencode-v2/stage.ts'

export type Artifact = { path: string; sha256: string; metadataReadInput: boolean }
export async function stageFixture(readonly: string): Promise<Artifact[]> {
  await stageOpenCodeV2Graphs(path.resolve(import.meta.dir, '../../..'), readonly, { portable: true, platform: 'win32', arch: 'x64' })
  await cp(import.meta.dir, path.join(readonly, 'windows-official-shell'), { recursive: true })
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
