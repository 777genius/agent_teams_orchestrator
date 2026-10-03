import { assertExternalDestination, assertTestProject } from './isolation';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const evidence = await assertExternalDestination(process.env.S6_EVIDENCE_DIR!, process.env.S6_SOURCE_ROOT!);
await assertTestProject(process.env.S6_TEST_ROOT!, process.env.S6_SOURCE_ROOT!);
const digest = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('base64');
const records = [];
await mkdir(join(evidence, 'projects', 'archives'), { recursive: true });
for (const name of ['client', 'schema', 'protocol']) {
  const packageName = `@opencode/${name}`;
  const response = await fetch(`https://registry.npmjs.org/@opencode%2f${name}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Registry metadata unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const metadata = JSON.parse(new TextDecoder().decode(bytes));
  for (const version of ['2.0.0', '2.0.21']) {
    const selected = metadata.versions[version];
    if (!selected || selected.name !== packageName || selected.version !== version) throw new Error('Registry identity mismatch');
    const url = new URL(selected.dist.tarball);
    if (url.origin !== 'https://registry.npmjs.org') throw new Error('Foreign tarball');
    const archiveResponse = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!archiveResponse.ok) throw new Error('Registry archive unavailable');
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    const sri = 'sha512-' + digest('sha512', archive);
    if (sri !== selected.dist.integrity) throw new Error('Archive SRI mismatch');
    const archivePath = join(evidence, 'projects/archives', `${name}-${version}.tgz`);
    await writeFile(archivePath, archive);
    records.push({ packageName, selectedVersion: version, latest: metadata['dist-tags'].latest,
      selectionReason: 'Reviewed exact pins retained regardless of newer registry stable', refreshedAt: new Date().toISOString(),
      metadataSha256: createHash('sha256').update(bytes).digest('hex'), dist: selected.dist,
      dependencies: selected.dependencies, peerDependencies: selected.peerDependencies,
      archivePath, archiveSha256: createHash('sha256').update(archive).digest('hex'), verifiedSri: sri });
  }
}
await writeFile(join(evidence, 'registry.json'), JSON.stringify(records, null, 2));
