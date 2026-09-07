import { beforeDeadlineV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Descriptors.js';
// Owner read-only admission port of frozen Product bd91501036637c76ffcfcc5584ecdd26e9a64a98.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';

import {
  assertFileCurrent,
  assertRootCurrent,
  descriptorMountId,
  openFileAnchor,
  procFdPath,
  type FileAnchor,
  type RootAnchor,
} from './native-controller-anchors.js';
import { canonicalJson, sha256 } from './native-http-contract.js';
import { safeRelativePath, type ClosurePin } from './native-controller-contract.js';

const LEAF_DOMAIN = Buffer.from('p3c-closure-leaf-v1\0');
const NODE_DOMAIN = Buffer.from('p3c-closure-node-v1\0');
const MAX_FILE_BYTES = 1024 ** 3;

export interface ClosureEntry {
  readonly path: string;
  readonly mode: 292 | 365;
  readonly size: number;
  readonly sha256: string;
}

export interface ClosureEvidence {
  readonly manifestSha256: string;
  readonly merkleRoot: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly entries: readonly ClosureEntry[];
}

function stable(stat: import('node:fs').BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ]
    .map(String)
    .join(':');
}

export async function readStable(file: FileAnchor, maximum = MAX_FILE_BYTES, deadline = Infinity): Promise<Buffer> {
  beforeDeadlineV2(deadline);
  await assertFileCurrent(file);
  const before = await file.handle.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum))
    throw new Error('p3c_secure_file_bounds');
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    beforeDeadlineV2(deadline);
    const { bytesRead } = await file.handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new Error('p3c_secure_file_short_read');
    offset += bytesRead;
  }
  const after = await file.handle.stat({ bigint: true });
  if (stable(before) !== stable(after)) throw new Error('p3c_secure_file_changed_during_read');
  if (sha256(bytes) !== file.pin.sha256) throw new Error('p3c_secure_file_digest');
  return bytes;
}

export async function verifyStableDigest(
  file: FileAnchor,
  maximum = MAX_FILE_BYTES, deadline = Infinity
): Promise<void> {
  beforeDeadlineV2(deadline);
  await assertFileCurrent(file);
  const before = await file.handle.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum))
    throw new Error('p3c_secure_file_bounds');
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Number(before.size)));
  let offset = 0;
  while (offset < Number(before.size)) {
        beforeDeadlineV2(deadline);
    const { bytesRead } = await file.handle.read(
      chunk,
      0,
      Math.min(chunk.length, Number(before.size) - offset),
      offset
    );
    if (!bytesRead) throw new Error('p3c_secure_file_short_read');
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await file.handle.stat({ bigint: true });
  if (stable(before) !== stable(after)) throw new Error('p3c_secure_file_changed_during_read');
  if (hash.digest('hex') !== file.pin.sha256) throw new Error('p3c_secure_file_digest');
}

function closureMerkle(entries: readonly ClosureEntry[]): string {
  let level = entries.map((entry) =>
    createHash('sha256')
      .update(LEAF_DOMAIN)
      .update(entry.path)
      .update('\0')
      .update(String(entry.mode))
      .update('\0')
      .update(String(entry.size))
      .update('\0')
      .update(entry.sha256)
      .digest()
  );
  if (level.length === 0) throw new Error('p3c_closure_empty');
  while (level.length > 1) {
    const next: typeof level = [];
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1] ?? level[index];
      next.push(
        createHash('sha256').update(NODE_DOMAIN).update(level[index]).update(right).digest()
      );
    }
    level = next;
  }
  return level[0].toString('hex');
}

function parseClosureManifest(bytes: Buffer): readonly ClosureEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('p3c_closure_manifest_json');
  }
  if (canonicalJson(value) !== bytes.toString('utf8') || !Array.isArray(value))
    throw new Error('p3c_closure_manifest_noncanonical');
  const entries = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('p3c_closure_entry');
    const item = candidate as Record<string, unknown>;
    if (
      canonicalJson(Object.keys(item).sort()) !== canonicalJson(['mode', 'path', 'sha256', 'size'])
    )
      throw new Error('p3c_closure_entry_keys');
    const path = safeRelativePath(item.path, 'closure_path');
    if (
      ![0o444, 0o555].includes(item.mode as number) ||
      !Number.isSafeInteger(item.size) ||
      (item.size as number) < 1 ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(item.sha256)
    )
      throw new Error('p3c_closure_entry_value');
    return Object.freeze({
      path,
      mode: item.mode as 292 | 365,
      size: item.size as number,
      sha256: item.sha256,
    });
  });
  const sorted = [...entries].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path))
  );
  if (
    new Set(entries.map(({ path }) => path)).size !== entries.length ||
    canonicalJson(entries) !== canonicalJson(sorted)
  )
    throw new Error('p3c_closure_manifest_order');
  return Object.freeze(entries);
}

async function walkDirectory(
  root: RootAnchor,
  directory: FileHandle,
  prefix: string,
  manifestPath: string,
  output: ClosureEntry[], deadline: number, budget: { bytes: number; count: number }
): Promise<void> {
  beforeDeadlineV2(deadline);
  const beforeDirectory = await directory.stat({ bigint: true });
  const expectedUid = process.getuid?.();
  if (
    !beforeDirectory.isDirectory() ||
    beforeDirectory.nlink < 2n ||
    Number(beforeDirectory.mode & 0o777n) !== 0o700 ||
    expectedUid === undefined ||
    beforeDirectory.uid !== BigInt(expectedUid) ||
    String(beforeDirectory.dev) !== root.identity.device ||
    (await descriptorMountId(directory)) !== root.pin.mountId
  )
    throw new Error('p3c_closure_directory_metadata');
  const names = (await readdir(procFdPath(directory))).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  for (const name of names) {
    beforeDeadlineV2(deadline);
    safeRelativePath(name, 'closure_name');
    const path = prefix ? `${prefix}/${name}` : name;
    let childDirectory: FileHandle | undefined;
    try {
      childDirectory = await open(
        `${procFdPath(directory)}/${name}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR')
        throw new Error('p3c_closure_special_entry');
    }
    if (childDirectory) {
      try {
        const stat = await childDirectory.stat({ bigint: true });
        if (
          !stat.isDirectory() ||
          stat.nlink < 2n ||
          Number(stat.mode & 0o777n) !== 0o700 ||
          expectedUid === undefined ||
          stat.uid !== BigInt(expectedUid) ||
          String(stat.dev) !== root.identity.device ||
          (await descriptorMountId(childDirectory)) !== root.pin.mountId
        )
          throw new Error('p3c_closure_directory_metadata');
        await walkDirectory(root, childDirectory, path, manifestPath, output, deadline, budget);
      } finally {
        await childDirectory.close();
      }
      continue;
    }
    if (path === manifestPath) continue;
    const handle = await open(
      `${procFdPath(directory)}/${name}`,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    try {
      const before = await handle.stat({ bigint: true });
      const mode = Number(before.mode & 0o777n);
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        ![0o444, 0o555].includes(mode) ||
        before.size < 1n ||
        before.size > BigInt(MAX_FILE_BYTES) ||
        expectedUid === undefined ||
        before.uid !== BigInt(expectedUid) ||
        String(before.dev) !== root.identity.device ||
        (await descriptorMountId(handle)) !== root.pin.mountId
      )
        throw new Error('p3c_closure_file_metadata');
      if (++budget.count > 200_000 || (budget.bytes += Number(before.size)) > 8 * 1024 ** 3)
        throw new Error('p3c_closure_aggregate_limit');
      const hash = createHash('sha256');
      const chunk = Buffer.alloc(Math.min(1024 * 1024, Number(before.size)));
      let offset = 0;
      while (offset < Number(before.size)) {
        beforeDeadlineV2(deadline);
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, Number(before.size) - offset),
          offset
        );
        if (!bytesRead) throw new Error('p3c_closure_short_read');
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (stable(before) !== stable(after)) throw new Error('p3c_closure_file_changed');
      output.push(
        Object.freeze({
          path,
          mode: mode as 292 | 365,
          size: Number(before.size),
          sha256: hash.digest('hex'),
        })
      );
    } finally {
      await handle.close();
    }
  }
  const afterDirectory = await directory.stat({ bigint: true });
  if (stable(beforeDirectory) !== stable(afterDirectory))
    throw new Error('p3c_closure_directory_changed');
}

export async function verifyClosure(root: RootAnchor, pin: ClosurePin, deadline = Infinity): Promise<ClosureEvidence> {
  beforeDeadlineV2(deadline);
  if (pin.manifest.root !== root.name) throw new Error('p3c_closure_wrong_root');
  await assertRootCurrent(root);
  const manifestAnchor = await openFileAnchor(root, pin.manifest);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readStable(manifestAnchor, 64 * 1024 * 1024, deadline);
  } finally {
    await manifestAnchor.handle.close();
  }
  beforeDeadlineV2(deadline);
  const declared = parseClosureManifest(manifestBytes);
  if (declared.length !== pin.fileCount) throw new Error('p3c_closure_count');
  const actual: ClosureEntry[] = [];
  await walkDirectory(root, root.handle, '', pin.manifest.relativePath, actual, deadline, { bytes: 0, count: 0 });
  actual.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const totalBytes = actual.reduce((total, entry) => total + entry.size, 0);
  const merkleRoot = closureMerkle(actual);
  beforeDeadlineV2(deadline);
  if (
    canonicalJson(actual) !== canonicalJson(declared) ||
    sha256(manifestBytes) !== pin.manifestSha256 ||
    actual.length !== pin.fileCount ||
    totalBytes !== pin.totalBytes ||
    merkleRoot !== pin.merkleRoot
  )
    throw new Error('p3c_closure_disagreement');
  return Object.freeze({
    manifestSha256: pin.manifestSha256,
    merkleRoot,
    fileCount: actual.length,
    totalBytes,
    entries: Object.freeze(actual),
  });
}
