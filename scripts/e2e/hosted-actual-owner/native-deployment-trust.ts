// Port of Product c16 hostedLifecycleProductionOwnerAdmission.ts release/root
// readers. Fixed deployment paths; no FD5/env-selected trust paths or keys.
import { createHash } from 'node:crypto'
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { requireReadonlyMount } from './native-readonly-mount.js'
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path'
import { recordV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'
const readExactRecord = (value: unknown, keys: string[]) => recordV2(value, keys.join(','))
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})+@sha256:[0-9a-f]{64}$/u
const ARTIFACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u
const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FORMAT = 'agent-teams.hosted-lifecycle-owner-release-pin/v2'
export const NATIVE_TRUST_ANCHOR_PATH = '/run/agent-teams-lifecycle-trust/trust-anchor'
export const NATIVE_RELEASE_PIN_PATH = '/run/agent-teams-lifecycle-trust/release-owner-pin.json'
type ParsedOwnerArtifact = { artifactDigest: `sha256:${string}`; imageReference: string; artifactVersion: string; protocolVersion: number }
type HostedLifecycleReleaseOwnerPin = ParsedOwnerArtifact & { launcherPublicKey: string; launcherKeyId: string }
type SecureFileSnapshot = { body: string; digest: `sha256:${string}` }
function decodeCanonicalBase64Url(value: string, length: number): Buffer {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error('native_release_key_encoding')
  return bytes
}
function assertCanonicalAbsolutePath(path: string): void {
  if (
    typeof path !== 'string' ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    normalize(path) !== path
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-path-invalid');
  }
}

function readSecureFile(
  path: string,
  expectedUid: number,
  expectedGid: number,
  expectedMode: number,
  maximumBytes: number,
  descriptor: number,
): SecureFileSnapshot {
  assertCanonicalAbsolutePath(path);
  const before = lstatSync(path, { bigint: true });
  {
    const opened = fstatSync(descriptor, { bigint: true });
    assertSecureFileStat(opened, expectedUid, expectedGid, expectedMode, maximumBytes);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    ) {
      throw new TypeError('hosted-lifecycle-owner-admission-file-substituted');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    const bytesRead = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    const after = fstatSync(descriptor, { bigint: true });
    const membership = lstatSync(path, { bigint: true });
    assertSecureFileStat(after, expectedUid, expectedGid, expectedMode, maximumBytes);
    if (
      bytesRead !== bytes.byteLength ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      membership.isSymbolicLink() ||
      membership.dev !== after.dev ||
      membership.ino !== after.ino
    ) {
      throw new TypeError('hosted-lifecycle-owner-admission-file-substituted');
    }
    return Object.freeze({
      body: bytes.toString('utf8'),
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  }
}

function assertSecureFileStat(
  stat: BigIntStats,
  expectedUid: number,
  expectedGid: number,
  expectedMode: number,
  maximumBytes: number
): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(expectedUid) ||
    stat.gid !== BigInt(expectedGid) ||
    Number(stat.mode & 0o777n) !== expectedMode ||
    stat.size < 1n ||
    stat.size > BigInt(maximumBytes)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-file-invalid');
  }
}

function assertLifecycleTrustDirectoryLayout(input: {
  readonly trustAnchorPath: string;
  readonly releasePinPath: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
}): void {
  assertCanonicalAbsolutePath(input.trustAnchorPath);
  assertCanonicalAbsolutePath(input.releasePinPath);
  const trustDirectory = dirname(input.trustAnchorPath);
  if (
    dirname(input.releasePinPath) !== trustDirectory ||
    input.releasePinPath === input.trustAnchorPath
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-trust-layout-invalid');
  }
  const directoryStat = lstatSync(trustDirectory, { bigint: true });
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    directoryStat.uid !== BigInt(input.expectedUid) ||
    directoryStat.gid !== BigInt(input.expectedGid) ||
    Number(directoryStat.mode & 0o777n) !== 0o700
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-trust-layout-invalid');
  }
  const expectedNames = [basename(input.trustAnchorPath), basename(input.releasePinPath)].sort();
  const entries = readdirSync(trustDirectory, { withFileTypes: true });
  if (
    entries.length !== expectedNames.length ||
    entries.some((entry) => !entry.isFile()) ||
    entries
      .map((entry) => entry.name)
      .sort()
      .some((name, index) => name !== expectedNames[index])
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-trust-layout-invalid');
  }
}

function parseOwnerArtifact(value: unknown): ParsedOwnerArtifact {
  const artifact = readExactRecord(value, [
    'artifactDigest',
    'imageReference',
    'artifactVersion',
    'protocolVersion',
  ]);
  if (
    typeof artifact.artifactDigest !== 'string' ||
    !ARTIFACT_DIGEST_PATTERN.test(artifact.artifactDigest) ||
    typeof artifact.imageReference !== 'string' ||
    !IMAGE_REFERENCE_PATTERN.test(artifact.imageReference) ||
    !artifact.imageReference.endsWith(`@${artifact.artifactDigest}`) ||
    typeof artifact.artifactVersion !== 'string' ||
    !ARTIFACT_VERSION_PATTERN.test(artifact.artifactVersion) ||
    !Number.isSafeInteger(artifact.protocolVersion) ||
    (artifact.protocolVersion as number) < 1 ||
    (artifact.protocolVersion as number) > 65_535
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-artifact-invalid');
  }
  return Object.freeze({
    artifactDigest: artifact.artifactDigest as `sha256:${string}`,
    imageReference: artifact.imageReference,
    artifactVersion: artifact.artifactVersion,
    protocolVersion: artifact.protocolVersion as number,
  });
}

function parseReleasePin(serialized: string): HostedLifecycleReleaseOwnerPin {
  const canonical = serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized;
  const parsed = JSON.parse(canonical) as unknown;
  if (JSON.stringify(parsed) !== canonical) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-noncanonical');
  }
  const envelope = readExactRecord(parsed, ['format', 'artifact', 'launcher']);
  if (envelope.format !== HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FORMAT) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-invalid');
  }
  const artifact = parseOwnerArtifact(envelope.artifact);
  const launcher = readExactRecord(envelope.launcher, ['algorithm', 'publicKey', 'keyId']);
  if (
    launcher.algorithm !== 'ed25519' ||
    typeof launcher.publicKey !== 'string' ||
    !ED25519_PUBLIC_KEY_PATTERN.test(launcher.publicKey) ||
    typeof launcher.keyId !== 'string' ||
    !SHA256_PATTERN.test(launcher.keyId)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-invalid');
  }
  const publicKeyBytes = decodeCanonicalBase64Url(launcher.publicKey, 32);
  const expectedKeyId = createHash('sha256').update(publicKeyBytes).digest('hex');
  if (launcher.keyId !== expectedKeyId) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-invalid');
  }
  return Object.freeze({
    ...artifact,
    launcherPublicKey: launcher.publicKey,
    launcherKeyId: launcher.keyId,
  });
}


/** All four Linux credentials must remain at the admitted real UID. In
 * particular NoNewPrivs does not prevent seteuid from restoring a saved UID. */
export function assertNativeDroppedCredentials(status: string, expectedUid: number): void {
  const rows = status.split('\n').filter(line => line.startsWith('Uid:'))
  const uids = rows.length === 1 ? /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(rows[0]!) : null
  if (!uids || uids.slice(1).some(value => Number(value) !== expectedUid) ||
    !/^NoNewPrivs:\s+1$/m.test(status)) throw new Error('native_release_privilege_regain')
  for (const field of ['CapEff', 'CapPrm', 'CapAmb']) {
    const value = new RegExp(`^${field}:\\s+([0-9a-f]+)$`, 'mi').exec(status)?.[1]
    if (!value || BigInt(`0x${value}`) !== 0n) throw new Error('native_release_privileged_owner')
  }
}

/** Uses the existing two-file private trust layout; the trust-anchor is the
 * bootstrap proof secret, never a replacement launcher public-key authority. */
export function retainNativeDeploymentTrust() {
  const expectedUid = process.getuid!(), expectedGid = process.getgid!()
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  type Anchor = { fd: number; stat: BigIntStats; mountId: string; parent: string | null }
  const anchors = new Map<string, Anchor>()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const anchor of [...anchors.values()].reverse()) { try { closeSync(anchor.fd) } catch {} }
    anchors.clear()
  }
  const mountId = (fd: number) => {
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    const id = /^mnt_id:\s+([0-9]+)$/m.exec(info)?.[1]
    if (info.length > 8192 || !id) throw new Error('native_release_mount_identity')
    return id
  }
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino &&
    a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink &&
    (a.isDirectory() || (a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs))
  const custody = () => {
    if (closed || process.platform !== 'linux') throw new Error('native_release_custody_lost')
    // An Owner able to remount or override ancestor permissions cannot serve as
    // its own deployment authority. The launcher provisions this namespace.
    const status = readFileSync('/proc/self/status', 'utf8')
    assertNativeDroppedCredentials(status, expectedUid)
    const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
    for (const [target, anchor] of anchors) {
      const current = fstatSync(anchor.fd, { bigint: true })
      if (!same(current, anchor.stat) || mountId(anchor.fd) !== anchor.mountId)
        throw new Error('native_release_custody_lost')
      // Leaves and their private directory MUST be immutable at admission and
      // consumption. Above that directory, root-owned ancestors may be writable
      // only when the unprivileged Owner cannot change their membership/modes.
      const privateInput = target === dirname(NATIVE_TRUST_ANCHOR_PATH) || current.isFile()
      const protectedByRoot = current.isDirectory() && current.uid === 0n &&
        expectedUid !== 0 && !(current.mode & 0o022n)
      if (privateInput || !protectedByRoot) requireReadonlyMount(mounts, anchor.mountId)
      const member = anchor.parent === null ? '/' :
        `/proc/self/fd/${anchors.get(anchor.parent)!.fd}/${basename(target)}`
      const fd = openSync(member, flags | (current.isDirectory() ? constants.O_DIRECTORY : 0))
      try {
        if (!same(fstatSync(fd, { bigint: true }), anchor.stat) || mountId(fd) !== anchor.mountId)
          throw new Error('native_release_custody_lost')
      } finally { closeSync(fd) }
    }
  }
  const retain = (target: string): void => {
    if (anchors.has(target)) return
    const parent = target === '/' ? null : dirname(target)
    if (parent) retain(parent)
    const leaf = target === NATIVE_TRUST_ANCHOR_PATH || target === NATIVE_RELEASE_PIN_PATH
    const fd = openSync(parent === null ? '/' :
      `/proc/self/fd/${anchors.get(parent)!.fd}/${basename(target)}`,
      flags | (leaf ? 0 : constants.O_DIRECTORY))
    try {
      const stat = fstatSync(fd, { bigint: true })
      if (leaf ? !stat.isFile() : !stat.isDirectory()) throw new Error('native_release_root_path')
      anchors.set(target, { fd, stat, mountId: mountId(fd), parent })
    } catch (error) { closeSync(fd); throw error }
  }
  const read = () => {
    custody()
    assertLifecycleTrustDirectoryLayout({ trustAnchorPath: NATIVE_TRUST_ANCHOR_PATH,
      releasePinPath: NATIVE_RELEASE_PIN_PATH, expectedUid, expectedGid })
    const anchor = readSecureFile(NATIVE_TRUST_ANCHOR_PATH, expectedUid, expectedGid, 0o400, 65,
      anchors.get(NATIVE_TRUST_ANCHOR_PATH)!.fd)
    const key = anchor.body.endsWith('\n') ? anchor.body.slice(0, -1) : anchor.body
    if (!SHA256_PATTERN.test(key)) throw new Error('native_release_root_encoding')
    const bytes = Buffer.from(key, 'hex')
    const proofKeyId = createHash('sha256').update(bytes).digest('hex'); bytes.fill(0)
    const release = readSecureFile(NATIVE_RELEASE_PIN_PATH, expectedUid, expectedGid, 0o400, 1024,
      anchors.get(NATIVE_RELEASE_PIN_PATH)!.fd)
    const pin = parseReleasePin(release.body)
    custody()
    return { pin, proofKeyId, releasePinDigest: release.digest, anchorDigest: anchor.digest }
  }
  try {
    retain(NATIVE_TRUST_ANCHOR_PATH); retain(NATIVE_RELEASE_PIN_PATH)
    // Read no authority bytes until independent immutable custody is verified.
    const retained = read()
    const current = () => {
      try { return JSON.stringify(read()) === JSON.stringify(retained) }
      catch { close(); return false }
    }
    return Object.freeze({ pin: Object.freeze({ ...retained.pin }), proofKeyId: retained.proofKeyId,
      releasePinDigest: retained.releasePinDigest, isCurrent: current, close })
  } catch { close(); throw new Error('native_release_custody_unavailable') }
}
