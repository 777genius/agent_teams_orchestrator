#!/usr/bin/env bun
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { computeHostedNativeEnvelopeDigest, type HostedNativeLaunchEnvelope } from '../../src/services/teamBootstrap/hostedNativeLaunch.js'
import type { HostedCanonicalAuthorityProtectedRecord } from '../../src/services/teamBootstrap/hostedCanonicalAuthorityStartup.js'

const MAX_ENVELOPE_BYTES = 256 * 1024

function fail(message: string): never { throw new Error(`host canonical authority issuer: ${message}`) }

function cloexec(): number {
  if (typeof constants.O_CLOEXEC === 'number' && constants.O_CLOEXEC !== 0) return constants.O_CLOEXEC
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) return 0o2000000
  return fail('Linux O_CLOEXEC is required')
}

function safeComponent(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')) fail(`${label} is unsafe`)
}

function mountId(fd: number): number {
  const match = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
  if (!match) return fail('kernel mount identity is unavailable')
  return Number(match[1])
}

function identity(fd: number): { dev: number; ino: number; mountId: number } {
  const stats = fstatSync(fd)
  return { dev: stats.dev, ino: stats.ino, mountId: mountId(fd) }
}

function pathIdentity(path: string): string {
  const stats = lstatSync(path)
  return `${stats.dev}:${stats.ino}`
}

function assertCanonical(path: string, label: string): void {
  if (!isAbsolute(path) || realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) {
    fail(`${label} is not an absolute symlink-free real path`)
  }
}

function assertRootProtectedDirectory(path: string, label: string): void {
  assertCanonical(path, label)
  const stats = lstatSync(path)
  if (!stats.isDirectory() || stats.uid !== 0 || (stats.mode & 0o022) !== 0) {
    fail(`${label} must be a root-owned directory without group/other write bits`)
  }
}

function assertIssuedFile(path: string, label: string): void {
  const stats = lstatSync(path)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== 0 ||
    stats.nlink !== 1 || (stats.mode & 0o7777) !== 0o444) {
    fail(`${label} is not a root-owned 0444 single-link regular file`)
  }
}

function readBoundEnvelope(path: string): HostedNativeLaunchEnvelope {
  assertCanonical(path, 'launch envelope')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | cloexec())
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ENVELOPE_BYTES) fail('launch envelope is not a bounded regular file')
    const bytes = Buffer.alloc(stats.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) fail('launch envelope was truncated')
      offset += count
    }
    const envelope = JSON.parse(bytes.toString('utf8')) as HostedNativeLaunchEnvelope
    if (!envelope || envelope.version !== 1 || envelope.role !== 'native-lead') fail('launch envelope schema is unsupported')
    const { envelopeDigest: _digest, ...unsigned } = envelope
    if (computeHostedNativeEnvelopeDigest(unsigned) !== envelope.envelopeDigest) fail('launch envelope digest is invalid')
    return envelope
  } finally {
    closeSync(fd)
  }
}

export type IssuedHostedCanonicalAuthority = {
  anchorPath: string
  bindingRecordPath: string
  record: HostedCanonicalAuthorityProtectedRecord
}

export type HostedCanonicalAuthorityIssuerEffects = {
  open: typeof openSync
  close: typeof closeSync
  chmod: typeof fchmodSync
  write: typeof writeSync
  unlink: typeof unlinkSync
}

const defaultIssuerEffects: HostedCanonicalAuthorityIssuerEffects = {
  open: openSync,
  close: closeSync,
  chmod: fchmodSync,
  write: writeSync,
  unlink: unlinkSync,
}

/**
 * Trusted deployment/root entry point. It only creates the two named registry
 * artifacts with O_EXCL; it never creates, replaces, reclaims, or deletes a
 * team, tasks, data, or foreign registry directory.
 */
export function issueHostedCanonicalAuthority(params: {
  envelope: HostedNativeLaunchEnvelope
  effects?: Partial<HostedCanonicalAuthorityIssuerEffects>
}): IssuedHostedCanonicalAuthority {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) fail('issuer must run as root on Linux')
  const { envelope } = params
  const reference = envelope.canonicalAuthority
  if (!reference || reference.version !== 1) fail('launch envelope lacks its registration reference')
  safeComponent(reference.registrationId, 'registrationId')
  safeComponent(reference.anchorName, 'anchorName')
  safeComponent(reference.bindingRecordName, 'bindingRecordName')
  if (reference.anchorName === reference.bindingRecordName || !reference.storageGeneration || !reference.admittedWriterImage) {
    fail('storage/image registration is incomplete')
  }
  for (const [path, label] of [
    [envelope.canonicalDataRoot, 'canonical data root'],
    [envelope.canonicalTeamRoot, 'canonical team root'],
    [envelope.canonicalTasksRoot, 'canonical tasks root'],
    [envelope.canonicalCwd, 'canonical cwd'],
    [reference.registryRoot, 'authority registry root'],
  ] as const) assertCanonical(path, label)
  if (envelope.canonicalTeamRoot !== join(envelope.canonicalDataRoot, 'teams', envelope.legacyKey) ||
    envelope.canonicalTasksRoot !== join(envelope.canonicalDataRoot, 'tasks', envelope.legacyKey)) {
    fail('team/tasks paths do not use the conventional envelope derivation')
  }
  if (pathIdentity(envelope.canonicalDataRoot) !== envelope.dataRootIdentity ||
    pathIdentity(envelope.canonicalTeamRoot) !== envelope.teamRootIdentity ||
    pathIdentity(envelope.canonicalTasksRoot) !== envelope.tasksRootIdentity) {
    fail('launch directory identities are stale or substituted')
  }
  assertRootProtectedDirectory(dirname(envelope.canonicalTeamRoot), 'canonical team root parent')
  assertRootProtectedDirectory(reference.registryRoot, 'authority registry root')
  if (!lstatSync(envelope.canonicalTeamRoot).isDirectory() || !lstatSync(envelope.canonicalTasksRoot).isDirectory()) {
    fail('pre-provisioned team/tasks roots must be directories')
  }

  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0) | cloexec()
  const readonlyFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0) | cloexec()
  const anchorPath = join(reference.registryRoot, reference.anchorName)
  const bindingRecordPath = join(reference.registryRoot, reference.bindingRecordName)
  const effects = { ...defaultIssuerEffects, ...params.effects }
  const descriptors = new Set<number>()
  const cleanupErrors: unknown[] = []
  let anchorCreated = false
  let recordCreated = false
  let retainedAnchorPath: string | undefined
  let retainedRecordPath: string | undefined
  let issued: IssuedHostedCanonicalAuthority | undefined
  let originalError: unknown

  const acquire = (...args: Parameters<typeof openSync>): number => {
    const fd = effects.open(...args)
    descriptors.add(fd)
    return fd
  }
  const release = (fd: number): void => {
    effects.close(fd)
    descriptors.delete(fd)
  }
  const withDescriptor = <T>(fd: number, action: () => T): T => {
    let result: T | undefined
    let actionError: unknown
    try {
      result = action()
    } catch (error) {
      actionError = error
    }
    let closeError: unknown
    try {
      release(fd)
    } catch (error) {
      closeError = error
    }
    if (actionError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [actionError, closeError],
        'host canonical authority descriptor operation and close failed',
      )
    }
    if (actionError !== undefined) throw actionError
    if (closeError !== undefined) throw closeError
    return result as T
  }

  try {
    const rootParentFd = acquire(dirname(envelope.canonicalTeamRoot), directoryFlags)
    const rootFd = acquire(`/proc/self/fd/${rootParentFd}/${basename(envelope.canonicalTeamRoot)}`, directoryFlags)
    const anchorParentFd = acquire(reference.registryRoot, directoryFlags)
    retainedAnchorPath = `/proc/self/fd/${anchorParentFd}/${reference.anchorName}`
    retainedRecordPath = `/proc/self/fd/${anchorParentFd}/${reference.bindingRecordName}`

    const createdAnchorFd = acquire(retainedAnchorPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | cloexec(), 0o444)
    anchorCreated = true
    withDescriptor(createdAnchorFd, () => {
      effects.chmod(createdAnchorFd, 0o444)
    })
    const anchorFd = acquire(retainedAnchorPath, readonlyFlags)
    const record: HostedCanonicalAuthorityProtectedRecord = {
      protocolVersion: 1,
      registrationId: reference.registrationId,
      publicTeamId: envelope.publicTeamId,
      legacyKey: envelope.legacyKey,
      storageGeneration: reference.storageGeneration,
      admittedWriterImage: reference.admittedWriterImage,
      canonicalTeamRoot: envelope.canonicalTeamRoot,
      root: identity(rootFd),
      rootParent: identity(rootParentFd),
      anchor: identity(anchorFd),
      anchorParent: identity(anchorParentFd),
      recordVersion: 1,
      registration: reference,
      launch: {
        version: envelope.version,
        role: envelope.role,
        publicTeamId: envelope.publicTeamId,
        legacyKey: envelope.legacyKey,
        canonicalDataRoot: envelope.canonicalDataRoot,
        canonicalTeamRoot: envelope.canonicalTeamRoot,
        canonicalTasksRoot: envelope.canonicalTasksRoot,
        canonicalCwd: envelope.canonicalCwd,
        dataRootIdentity: envelope.dataRootIdentity,
        teamRootIdentity: envelope.teamRootIdentity,
        tasksRootIdentity: envelope.tasksRootIdentity,
        runId: envelope.runId,
        primary: envelope.primary,
        primaryAlias: envelope.primaryAlias,
        launchIdentityToken: envelope.launchIdentityToken,
        materialDigest: envelope.materialDigest,
        profileDigest: envelope.profileDigest,
        settingsDigest: envelope.settingsDigest,
        mcpDigest: envelope.mcpDigest,
        settingsPath: envelope.settingsPath,
        mcpConfigPath: envelope.mcpConfigPath,
        bootstrapSpecPath: envelope.bootstrapSpecPath,
        bootstrapSpecDigest: envelope.bootstrapSpecDigest,
        userPromptFilePath: envelope.userPromptFilePath,
        userPromptDigest: envelope.userPromptDigest,
        permissionMode: envelope.permissionMode,
        readyAckPath: envelope.readyAckPath,
        ...(envelope.mailboxPollMs === undefined ? {} : { mailboxPollMs: envelope.mailboxPollMs }),
        envelopeDigest: envelope.envelopeDigest,
      },
    }
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
    if (bytes.length > 64 * 1024) fail('protected binding record is too large')
    const bindingFd = acquire(retainedRecordPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | cloexec(), 0o444)
    recordCreated = true
    withDescriptor(bindingFd, () => {
      let offset = 0
      while (offset < bytes.length) {
        const count = effects.write(bindingFd, bytes, offset, bytes.length - offset)
        if (count <= 0) fail('protected binding record write was truncated')
        offset += count
      }
      effects.chmod(bindingFd, 0o444)
    })
    assertIssuedFile(retainedAnchorPath, 'issued anchor')
    assertIssuedFile(retainedRecordPath, 'issued binding record')
    issued = { anchorPath, bindingRecordPath, record }
  } catch (error) {
    originalError = error
    // Compensation is restricted to artifacts proven created by this call.
    if (recordCreated && retainedRecordPath) {
      try { effects.unlink(retainedRecordPath) } catch (cleanup) { cleanupErrors.push(cleanup) }
    }
    if (anchorCreated && retainedAnchorPath) {
      try { effects.unlink(retainedAnchorPath) } catch (cleanup) { cleanupErrors.push(cleanup) }
    }
  } finally {
    for (const fd of [...descriptors].reverse()) {
      try { release(fd) } catch (cleanup) { cleanupErrors.push(cleanup) }
    }
    if (originalError === undefined && cleanupErrors.length > 0) {
      if (recordCreated) {
        try { effects.unlink(bindingRecordPath) } catch (cleanup) { cleanupErrors.push(cleanup) }
      }
      if (anchorCreated) {
        try { effects.unlink(anchorPath) } catch (cleanup) { cleanupErrors.push(cleanup) }
      }
    }
  }
  const failures = [
    ...(originalError === undefined ? [] : [originalError]),
    ...cleanupErrors,
  ]
  if (failures.length === 1) throw failures[0]!
  if (failures.length > 1) {
    throw new AggregateError(failures, 'host canonical authority issuance and cleanup failed')
  }
  return issued!
}

function parseArgs(argv: string[]): { envelopePath: string } {
  if (argv.length !== 2 || argv[0] !== '--launch-envelope' || !argv[1]) {
    return fail('usage: issue-canonical-authority.ts --launch-envelope /absolute/envelope.json')
  }
  return { envelopePath: argv[1] }
}

if (import.meta.main) {
  const { envelopePath } = parseArgs(process.argv.slice(2))
  const issued = issueHostedCanonicalAuthority({ envelope: readBoundEnvelope(envelopePath) })
  process.stdout.write(`${JSON.stringify({
    registrationId: issued.record.registrationId,
    anchorPath: issued.anchorPath,
    bindingRecordPath: issued.bindingRecordPath,
  })}\n`)
}
