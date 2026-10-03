import { readFile, lstat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { canonical, sha, within, SOURCE } from '../opencode-generation-spikes/sandbox';
import { ANCHORS, NativeArtifact } from '../opencode-generation-spikes/artifacts';
import { SOURCE_SHA, Selection } from './contracts';
import manifest from './native-manifest.json';

export type PinFile = { path: string; sha256: string };
export async function pinned(file: PinFile, exclude: string[] = []) {
  if (!isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || exclude.some(p => within(p, file.path))) throw new Error('caller-supplied independent pinned file required');
  await canonical(file.path);
  const stat = await lstat(file.path);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('invalid pinned file');
  const bytes = await readFile(file.path);
  if (sha(bytes) !== file.sha256) throw new Error('pinned file digest mismatch');
  return JSON.parse(bytes.toString());
}
export async function trustedSource() {
  if (sha(JSON.stringify(manifest, null, 2) + '\n') !== SOURCE_SHA) throw new Error('accepted source manifest identity changed');
  for (const file of manifest.files) {
    const path = resolve(SOURCE, file.path); await canonical(path);
    if (sha(await readFile(path)) !== file.sha256) throw new Error('accepted native source changed: ' + file.path);
  }
}
// Receipt schema is the independently supplied S3a summary and its existing exact
// observation acceptance subject. We do not manufacture an acceptance in the producer.
export async function prerequisite(s: Selection, receiptFile: PinFile, acceptanceFile: PinFile, roots: string[]) {
  await trustedSource();
  const receipt = await pinned(receiptFile, roots), acceptance = await pinned(acceptanceFile, roots);
  if (receipt.sourceManifestSha256 !== SOURCE_SHA || receipt.fullS3aLinuxX64BundledFourPins !== true) throw new Error('unqualified S3a summary');
  const selected = receipt.results?.filter((r: any) => r.generation === s.generation && r.version === s.version);
  if (selected?.length !== 1 || selected[0].qualificationStatus !== 'PASS' || selected[0].sourceManifestSha256 !== SOURCE_SHA || selected[0].acceptanceSha256 !== acceptanceFile.sha256) throw new Error('pin lacks independent S3a acceptance');
  const subject = acceptance.subject;
  if (acceptance.schemaVersion !== 1 || acceptance.kind !== 'fresh-schema2-observation-acceptance' || acceptance.decision !== 'accepted' ||
      subject?.generation !== s.generation || subject.version !== s.version || subject.sourceManifestSha256 !== SOURCE_SHA || subject.ruleID !== selected[0].ruleID ||
      !['native-openai-compatible-branch', '@opencode/ai/providers/openai-compatible'].includes(subject.logicalImplementation) ||
      subject.reportedSelector !== (s.generation === 'v1' ? null : s.version === '2.0.0' ? 'aisdk:@ai-sdk/openai-compatible' : '@opencode/ai/providers/openai-compatible') ||
      subject.configuredSelector !== (s.generation === 'v1' ? '@ai-sdk/openai-compatible' : 'aisdk:@ai-sdk/openai-compatible') ||
      !/^[a-f0-9]{64}$/.test(subject.binarySha256) || !/^[a-f0-9]{64}$/.test(subject.resolverSha256)) throw new Error('accepted route/subject mismatch');
  return { receiptFile, acceptanceFile, receipt, subject, selected: selected[0] };
}
export function bindArtifact(artifact: NativeArtifact, subject: any) {
  if (artifact.sha256 !== subject.binarySha256 || artifact.generation !== subject.generation || artifact.version !== subject.version) throw new Error('selected native binary differs from S3a');
  const [root, platform] = artifact.packages;
  if (root.archiveSha256 !== subject.rootArchiveSha256 || platform.archiveSha256 !== subject.platformArchiveSha256 ||
      root.metadataSha256 !== subject.rootMetadataSha256 || platform.metadataSha256 !== subject.platformMetadataSha256 || platform.archiveSri !== subject.platformSri) throw new Error('official archive differs from accepted S3a subject');
}
export function anchor(s: Selection) { return ANCHORS.find(a => a.generation === s.generation && a.version === s.version)!; }
