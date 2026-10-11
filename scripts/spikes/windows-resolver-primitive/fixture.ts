import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'

type Artifact = { path: string; sha256: string; metadataReadInput: boolean }

// This copies published bytes only. It never imports Effect or stages its
// dependency graph, and cannot qualify an official runtime/model task.
export async function stagePrimitiveFixture(readonly: string): Promise<Artifact[]> {
  const manifest = await realpath(Bun.resolveSync('effect/package.json', import.meta.dir))
  const metadata: unknown = JSON.parse(await readFile(manifest, 'utf8'))
  if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== 'effect' || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('TEST primitive published Effect identity invalid')
  const entry = await realpath(Bun.resolveSync('effect', import.meta.dir))
  const packageRoot = path.dirname(manifest), relativeEntry = path.relative(packageRoot, entry)
  if (relativeEntry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntry)) throw new Error('TEST primitive Effect entry escaped package')
  const destinationRoot = path.join(readonly, 'node_modules', 'effect')
  const artifacts: Artifact[] = []
  for (const [source, destination] of [[manifest, path.join(destinationRoot, 'package.json')], [entry, path.join(destinationRoot, relativeEntry)]] as const) {
    const bytes = await readFile(source)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes, { flag: 'wx' })
    artifacts.push({ path: path.relative(readonly, destination), sha256: createHash('sha256').update(bytes).digest('hex'), metadataReadInput: true })
  }
  const directory = path.join(readonly, 'windows-official-shell')
  await mkdir(directory, { recursive: true })
  const resolution = [{ specifier: 'effect', entry: path.relative(readonly, path.join(destinationRoot, relativeEntry)), packageRoot: path.relative(readonly, destinationRoot), manifest: path.relative(readonly, path.join(destinationRoot, 'package.json')), packageName: metadata.name, packageVersion: metadata.version }]
  const resolutionBytes = Buffer.from(JSON.stringify(resolution))
  const resolutionPath = path.join(directory, 'resolution.json')
  await writeFile(resolutionPath, resolutionBytes, { flag: 'wx' })
  artifacts.push({ path: path.relative(readonly, resolutionPath), sha256: createHash('sha256').update(resolutionBytes).digest('hex'), metadataReadInput: true })
  await writeFile(path.join(readonly, 'official-artifacts.json'), JSON.stringify(artifacts), { flag: 'wx' })
  return artifacts
}

export async function verifyPrimitiveArtifacts(readonly: string, artifacts: readonly Artifact[]): Promise<void> {
  for (const artifact of artifacts) if (createHash('sha256').update(await readFile(path.join(readonly, artifact.path))).digest('hex') !== artifact.sha256) throw new Error('TEST primitive published bytes changed')
}
