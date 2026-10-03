// Isolated TEST archive/ELF bytes: never an executable and never native qualification.
import { expect, mock } from 'bun:test';
import { writeFile, readFile, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { testSpace } from './test-space';
import { sha } from '../opencode-generation-spikes/sandbox';
import { bindArtifact } from './gate';
const sri = (b: Buffer) => 'sha512-' + createHash('sha512').update(b).digest('base64');
function archive(files: Record<string, Buffer>) {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    const h = Buffer.alloc(512); h.write('package/' + name); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write('0', 156);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const parent = await testSpace('artifact'), bundle = join(parent, 'TEST-bundle'); await mkdir(bundle);
const elf = Buffer.alloc(64); elf.write('7f454c46', 'hex'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(process.arch === 'x64' ? 62 : 183, 18);
const platform = `@opencode/cli-linux-${process.arch}`, version = '2.0.0';
const rootArchive = archive({ 'package.json': Buffer.from(JSON.stringify({ name: '@opencode/cli', version })) });
const nativeArchive = archive({ 'package.json': Buffer.from(JSON.stringify({ name: platform, version })), 'bin/opencode': elf });
const rootMeta = Buffer.from(JSON.stringify({ name: '@opencode/cli', version, optionalDependencies: { [platform]: version }, dist: { tarball: 'https://registry.npmjs.org/TEST/root.tgz', integrity: sri(rootArchive) } }));
const platformMeta = Buffer.from(JSON.stringify({ name: platform, version, dist: { tarball: 'https://registry.npmjs.org/TEST/platform.tgz', integrity: sri(nativeArchive) } }));
// Only the trust anchor changes to explicitly TEST data; frozen archive/SRI/ELF parsers remain real.
mock.module('./gate', () => ({ bindArtifact, anchor: () => ({ generation: 'v2', version, package: '@opencode/cli', rootSri: sri(rootArchive) }) }));
const { preflightArtifact } = await import('./preflight');
const inputs: Record<string, Buffer> = { 'root.metadata.json': rootMeta, 'platform.metadata.json': platformMeta, 'root.tgz': rootArchive, 'platform.tgz': nativeArchive };
for (const [name, bytes] of Object.entries(inputs)) await writeFile(join(bundle, name), bytes);
const binary = join(parent, 'TEST-binary'); await writeFile(binary, elf);
const subject = { generation: 'v2', version, binarySha256: sha(elf), rootMetadataSha256: sha(rootMeta), platformMetadataSha256: sha(platformMeta), rootArchiveSha256: sha(rootArchive), platformArchiveSha256: sha(nativeArchive), platformSri: sri(nativeArchive) };
const selected = { generation: 'v2', version, scenario: 'default', bundle, binary, platformMetadataSha256: sha(platformMeta) } as const;
try {
  const before = await readdir(bundle), checked = await preflightArtifact(selected, subject);
  expect(await readdir(bundle)).toEqual(before);
  await expect(preflightArtifact({ ...selected, platformMetadataSha256: '0'.repeat(64) }, subject)).rejects.toThrow('metadata pin');
  for (const [name, bytes] of Object.entries(inputs)) {
    await writeFile(join(bundle, name), Buffer.concat([bytes, Buffer.from('changed')]));
    await expect(preflightArtifact(selected, subject)).rejects.toThrow();
    await writeFile(join(bundle, name), bytes);
  }
  await writeFile(binary, 'wrong'); await expect(preflightArtifact(selected, subject)).rejects.toThrow('binary differs'); await writeFile(binary, elf);
  await rm(binary); await symlink(join(bundle, 'root.tgz'), binary);
  await expect(preflightArtifact(selected, subject)).rejects.toThrow('symlink'); await rm(binary); await writeFile(binary, elf);
  const copied = join(parent, 'TEST-copied'); await mkdir(copied);
  for (const [name, bytes] of Object.entries(inputs)) await writeFile(join(copied, name), bytes);
  const copiedBinary = join(copied, 'native-opencode'); await writeFile(copiedBinary, elf);
  await checked.rebind({ ...checked.artifact, binary: copiedBinary });
  await writeFile(join(copied, 'platform.tgz'), 'changed after acquire');
  await expect(checked.rebind({ ...checked.artifact, binary: copiedBinary })).rejects.toThrow('copied artifact changed');
  expect(await readFile(binary)).toEqual(elf);
} finally { await rm(parent, { recursive: true, force: true }); }
