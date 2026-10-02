import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical, sha, SOURCE, within } from '../opencode-generation-spikes/sandbox';
import { NativeArtifact, unpackArchive, verifyElf, verifySri } from '../opencode-generation-spikes/artifacts';
import { anchor, bindArtifact } from './gate';
import type { Options } from './run';

async function absent(path: string) {
  try { await lstat(path); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
  throw new Error('existing root or Git ancestor refused: ' + path);
}
// No mkdir, Git command, ports or processes belong in admission.
export async function admitRoots(options: Pick<Options, 'root' | 'evidence' | 'bundle' | 'binary' | 'receipt' | 'acceptance'>, trusted: any) {
  const historical = [trusted.subject.root, trusted.subject.evidence,
    ...(trusted.receipt?.results ?? []).flatMap((r: any) => [r.evidence, r.acceptancePath, r.qualification])]
    .filter((p: unknown): p is string => typeof p === 'string' && isAbsolute(p));
  const binaryContainer = await canonical(dirname(options.binary));
  const protectedPaths = [SOURCE, binaryContainer, dirname(options.bundle), dirname(options.receipt.path), dirname(options.acceptance.path),
    ...historical.map(p => dirname(p))];
  const roots = [options.root, options.evidence];
  if (within(roots[0], roots[1]) || within(roots[1], roots[0])) throw new Error('disjoint TEST roots required');
  for (const path of roots) {
    if (!isAbsolute(path) || resolve(path) !== path || !basename(path).startsWith('TEST-') ||
        protectedPaths.some(p => within(p, path) || within(path, p))) throw new Error('protected/noncanonical TEST root refused');
    await canonical(dirname(path));
    await absent(path);
    for (let ancestor = dirname(path);; ancestor = dirname(ancestor)) {
      // lstat catches every marker kind, including dangling links and malformed files.
      await absent(join(ancestor, '.git'));
      if (ancestor === dirname(ancestor)) break;
    }
  }
}
async function boundedFile(path: string, cap: number) {
  await canonical(path);
  const before = await lstat(path);
  if (!before.isFile() || before.size > cap) throw new Error('nonregular/oversized artifact input');
  // A FIFO or symlink swapped in after lstat must never block or redirect acquisition.
  const flags = constants.O_RDONLY | (process.platform === 'linux' ? constants.O_NONBLOCK | constants.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > cap) throw new Error('nonregular/oversized artifact input');
    // Read at most cap+1 even if a regular input grows after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, cap + 1));
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error('artifact changed while reading');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
// Thin offline verifier: uses frozen parsers, never acquire or scratch extraction.
export async function preflightArtifact(options: Pick<Options, 'generation' | 'version' | 'scenario' | 'bundle' | 'binary' | 'platformMetadataSha256'>, subject: any) {
  const selected = anchor(options);
  if (!selected || !/^[0-9a-f]{64}$/.test(options.platformMetadataSha256) ||
      options.platformMetadataSha256 !== subject.platformMetadataSha256) throw new Error('selected metadata pin mismatch');
  await canonical(options.bundle);
  if (!(await lstat(options.bundle)).isDirectory()) throw new Error('official bundle directory required');
  const platform = options.generation === 'v1' ? `opencode-linux-${process.arch}` : `@opencode/cli-linux-${process.arch}`;
  const packages: Array<Record<string, unknown>> = [];
  let nativeBytes: Buffer | undefined;
  for (const [label, name] of [['root', selected.package], ['platform', platform]]) {
    const raw = await boundedFile(join(options.bundle, label + '.metadata.json'), 4 * 1024 * 1024);
    if (sha(raw) !== subject[label + 'MetadataSha256']) throw new Error('metadata differs from accepted S3a subject');
    const metadata = JSON.parse(raw.toString());
    if (metadata.name !== name || metadata.version !== options.version) throw new Error('package metadata identity mismatch');
    const url = new URL(metadata.dist?.tarball);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password) throw new Error('official tarball URL required');
    if (label === 'root' && (metadata.dist.integrity !== selected.rootSri || metadata.optionalDependencies?.[platform] !== options.version)) throw new Error('exact root/platform pin mismatch');
    if (label === 'platform' && metadata.dist.integrity !== subject.platformSri) throw new Error('platform SRI differs from S3a');
    const archive = await boundedFile(join(options.bundle, label + '.tgz'), 256 * 1024 * 1024);
    if (sha(archive) !== subject[label + 'ArchiveSha256']) throw new Error('archive differs from accepted S3a subject');
    verifySri(archive, metadata.dist.integrity);
    const files = unpackArchive(archive, label === 'root' && options.version === '2.0.21' ? ['bin/opencode.exe'] : []);
    const manifest = JSON.parse(files.get('package.json')?.toString() ?? 'null');
    if (manifest?.name !== name || manifest.version !== options.version) throw new Error('archive package identity mismatch');
    if (label === 'platform') {
      const candidates = [...files].filter(([p]) => p === 'bin/opencode' || p === 'bin/opencode.exe');
      if (candidates.length !== 1) throw new Error('ambiguous native executable');
      nativeBytes = candidates[0][1]; verifyElf(nativeBytes);
    }
    packages.push({ name, version: options.version, metadataSha256: sha(raw), archiveSha256: sha(archive), archiveSri: metadata.dist.integrity });
  }
  const explicit = await boundedFile(options.binary, 256 * 1024 * 1024);
  if (sha(explicit) !== sha(nativeBytes!)) throw new Error('explicit binary differs from official archive');
  const artifact = { binary: options.binary, sha256: sha(nativeBytes!), generation: options.generation, version: options.version, packages };
  bindArtifact(artifact, subject);
  return {
    artifact,
    async rebind(copied: NativeArtifact) {
      bindArtifact(copied, subject);
      // Re-read actual acquisition output before any executable/port/model startup.
      for (const [index, label] of ['root', 'platform'].entries()) {
        for (const [extension, key] of [['metadata.json', 'metadataSha256'], ['tgz', 'archiveSha256']]) {
          const bytes = await boundedFile(join(dirname(copied.binary), label + '.' + extension), extension === 'tgz' ? 256 * 1024 * 1024 : 4 * 1024 * 1024);
          if (sha(bytes) !== packages[index][key]) throw new Error('copied artifact changed after preflight');
        }
      }
      if (sha(await boundedFile(copied.binary, 256 * 1024 * 1024)) !== artifact.sha256) throw new Error('copied binary changed after preflight');
    },
  };
}
