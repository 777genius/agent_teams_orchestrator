// Owner port of frozen r1029 namespace public artifact admission.
import { beforeDeadlineV2, hashDescriptorV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Descriptors.js';
import { constants, closeSync, fstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { sha256 } from './native-http-contract.js';

/** Selected public evidence only. Roots are independently provisioned in the
 * selected executable/module, never read from these artifacts or from FD5. */
export interface ReadonlyArtifactPin {
  readonly relativePath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly sha256: string;
  readonly mode?: number;
}

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`selected_readonly_artifact_${reason}`);
}

/** proc files report size zero; checking a completed read's length does not
 * bound allocation. Read at most maximum + 1 bytes from the retained proc file
 * and reject overflow before decoding or splitting mount records. */
function readProcMetadata(path: string, maximum: number, reason: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check(fstatSync(fd).isFile(), 'proc_file');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    check(length <= maximum, reason);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

function readonlyMount(fd: number): void {
  const info = readProcMetadata(`/proc/self/fdinfo/${fd}`, 8192, 'fdinfo_bound');
  const id = /^mnt_id:\s+([0-9]+)$/mu.exec(info)?.[1];
  check(id, 'mount_id');
  const mounts = readProcMetadata('/proc/self/mountinfo', 1024 * 1024, 'mountinfo_bound');
  const matches = mounts.split('\n').filter(line => line.startsWith(`${id} `));
  check(matches.length === 1, 'mount_identity');
  const fields = matches[0].split(' ');
  const separator = fields.indexOf('-');
  check(separator >= 6 && fields.length === separator + 4 && fields[5].split(',').includes('ro') &&
    !fields[5].split(',').includes('rw'), 'mount_writable');
}

/** Walk each component under a retained root with O_NOFOLLOW. No path supplied
 * by a document can switch roots, traverse a symlink, or resolve in /sandbox.
 * The caller owns the root descriptor throughout this synchronous operation. */
function withReadonlyArtifact<T>(rootFd: number, pin: ReadonlyArtifactPin, maximum: number,
  deadline: number, consume: (fd: number, stat: BigIntStats) => T): T {
  beforeDeadlineV2(deadline);
  const selected = { ...pin };
  check(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 1024 ** 3 &&
    Number.isSafeInteger(selected.size) && selected.size > 0 && selected.size <= maximum &&
    /^[0-9a-f]{64}$/u.test(selected.sha256) &&
    /^(?:0|[1-9][0-9]{0,19})$/u.test(selected.device) &&
    /^[1-9][0-9]{0,19}$/u.test(selected.inode), 'pin');
  check(typeof selected.relativePath === 'string' &&
    /^[\x21-\x7e]{1,512}$/u.test(selected.relativePath) && !selected.relativePath.includes('\\'), 'path');
  const parts = selected.relativePath.split('/');
  check(parts.every(part => part && part !== '.' && part !== '..'), 'path_segment');
  const root = fstatSync(rootFd, { bigint: true });
  check(root.isDirectory() && root.uid === 0n && !(root.mode & 0o022n), 'root');
  readonlyMount(rootFd);
  const owned: number[] = [];
  let parent = rootFd;
  try {
    for (let index = 0; index < parts.length; index++) {
      beforeDeadlineV2(deadline);
      const last = index === parts.length - 1;
      const fd = openSync(`/proc/self/fd/${parent}/${parts[index]}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
        (last ? 0 : constants.O_DIRECTORY));
      owned.push(fd);
      const stat = fstatSync(fd, { bigint: true });
      check(stat.uid === 0n && !(stat.mode & 0o022n), 'ownership');
      readonlyMount(fd);
      if (!last) { check(stat.isDirectory(), 'directory'); parent = fd; continue; }
      check(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(selected.size) &&
        String(stat.dev) === selected.device && String(stat.ino) === selected.inode &&
        (selected.mode === undefined || Number(stat.mode & 0o7777n) === selected.mode), 'identity');
      const result = consume(fd, stat);
      const after = fstatSync(fd, { bigint: true });
      check(sameImageStat(stat, after), 'changed');
      readonlyMount(fd);
      beforeDeadlineV2(deadline);
      return result;
    }
    throw new Error('selected_readonly_artifact_empty');
  } finally {
    // Attempt all owned closes without ever closing the borrowed root.
    let failed: unknown;
    for (const fd of owned.reverse()) {
      try { closeSync(fd); } catch (error) { failed ??= error; }
    }
    if (failed) throw failed;
  }
}

function sameImageStat(a: BigIntStats, b: BigIntStats): boolean {
  return (['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'gid', 'mtimeNs', 'ctimeNs'] as const)
    .every(key => a[key] === b[key]);
}

/** Buffered documents/source keep their original 32 MiB hard ceiling. */
export function readReadonlyArtifact(rootFd: number, pin: ReadonlyArtifactPin, maximum: number, deadline = Infinity): Buffer {
  beforeDeadlineV2(deadline);
  check(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 32 * 1024 * 1024, 'pin');
  return withReadonlyArtifact(rootFd, pin, maximum, deadline, (fd, stat) => {
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      beforeDeadlineV2(deadline);
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      check(count > 0, 'truncated'); offset += count;
    }
    check(sha256(bytes) === pin.sha256, 'changed');
    return bytes;
  });
}

/** Retain a separate CLOEXEC handle after FD11 consumption. The borrowed root
 * must outlive this handle. Currentness re-walks the selected path and mount;
 * a retained old inode alone cannot authorize a substituted path. */
export function retainReadonlyImage(rootFd: number, pin: ReadonlyArtifactPin & { mode: number }, deadline = Infinity) {
  const selected = Object.freeze({ ...pin });
  check(selected.mode === 0o500, 'image_mode');
  let retained: number | undefined;
  let identity!: BigIntStats;
  const verify = (fd: number, stat: BigIntStats, limit: number) => {
    check(Number(stat.mode & 0o7777n) === 0o500 && stat.gid === 0n, 'image_mode');
    const magic = Buffer.alloc(4);
    check(readSync(fd, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'image_elf');
    check(hashDescriptorV2(fd, stat, limit) === selected.sha256, 'changed');
  };
  try {
    withReadonlyArtifact(rootFd, selected, 1024 ** 3, deadline, (fd, stat) => {
      verify(fd, stat, deadline);
      retained = openSync(`/proc/self/fd/${fd}`, constants.O_RDONLY | 0o2000000 /* O_CLOEXEC */);
      identity = fstatSync(retained, { bigint: true });
      check(sameImageStat(stat, identity), 'changed');
    });
  } catch (error) { if (retained !== undefined) closeSync(retained); throw error; }
  return Object.freeze({
    assertCurrent(limit = Infinity) {
      check(retained !== undefined, 'image_closed');
      check(sameImageStat(identity, fstatSync(retained, { bigint: true })), 'changed');
      readonlyMount(retained);
      withReadonlyArtifact(rootFd, selected, 1024 ** 3, limit, (fd, stat) => {
        check(sameImageStat(identity, stat), 'changed');
        verify(fd, stat, limit);
      });
    },
    close() {
      const fd = retained; retained = undefined;
      if (fd !== undefined) closeSync(fd);
    },
  });
}
