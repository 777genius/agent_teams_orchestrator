import { constants, closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import { getTasksDir } from 'src/utils/tasks.js'
import { getTeamDir } from 'src/utils/swarm/teamHelpers.js'
import {
  admitCanonicalTeamLockAuthority,
  type CanonicalTeamLockAuthority,
  type HostIssuedCanonicalTeamLockBinding,
  type RetainedHostCanonicalTeamLockRegistration,
} from 'src/utils/swarm/canonicalTeamLockAuthority.js'

const PROTOCOL_VERSION = 1 as const
const MAX_RECORD_BYTES = 64 * 1024

export type HostedCanonicalAuthorityRegistrationReference = {
  version: typeof PROTOCOL_VERSION
  registrationId: string
  storageGeneration: string
  admittedWriterImage: string
  registryRoot: string
  anchorName: string
  bindingRecordName: string
}

export type HostedCanonicalAuthorityLaunch = {
  version: number
  role: string
  publicTeamId: string
  legacyKey: string
  canonicalDataRoot: string
  canonicalTeamRoot: string
  canonicalTasksRoot: string
  canonicalCwd: string
  dataRootIdentity: string
  teamRootIdentity: string
  tasksRootIdentity: string
  runId: string
  primary: { displayName: string; agentId: string; provider: string; model: string; effort?: string }
  primaryAlias: string
  launchIdentityToken: string
  materialDigest: string
  profileDigest: string
  settingsDigest: string
  mcpDigest: string
  settingsPath: string
  mcpConfigPath: string
  bootstrapSpecPath: string
  bootstrapSpecDigest: string
  userPromptFilePath: string
  userPromptDigest: string
  permissionMode: string
  readyAckPath: string
  mailboxPollMs?: number
  envelopeDigest: string
  canonicalAuthority: HostedCanonicalAuthorityRegistrationReference
}

export type HostedCanonicalAuthorityProtectedRecord = HostIssuedCanonicalTeamLockBinding & {
  recordVersion: typeof PROTOCOL_VERSION
  registration: HostedCanonicalAuthorityRegistrationReference
  launch: {
    version: number
    role: string
    publicTeamId: string
    legacyKey: string
    canonicalDataRoot: string
    canonicalTeamRoot: string
    canonicalTasksRoot: string
    canonicalCwd: string
    dataRootIdentity: string
    teamRootIdentity: string
    tasksRootIdentity: string
    runId: string
    primary: HostedCanonicalAuthorityLaunch['primary']
    primaryAlias: string
    launchIdentityToken: string
    materialDigest: string
    profileDigest: string
    settingsDigest: string
    mcpDigest: string
    settingsPath: string
    mcpConfigPath: string
    bootstrapSpecPath: string
    bootstrapSpecDigest: string
    userPromptFilePath: string
    userPromptDigest: string
    permissionMode: string
    readyAckPath: string
    mailboxPollMs?: number
    envelopeDigest: string
  }
}

type AdmissionEffects = {
  admit(input: RetainedHostCanonicalTeamLockRegistration): Promise<CanonicalTeamLockAuthority>
}

const defaultEffects: AdmissionEffects = { admit: admitCanonicalTeamLockAuthority }
const retainedProcessAuthorities = new Map<string, CanonicalTeamLockAuthority>()

function cloexec(): number {
  if (typeof constants.O_CLOEXEC === 'number' && constants.O_CLOEXEC !== 0) return constants.O_CLOEXEC
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) return 0o2000000
  throw new Error('Hosted canonical authority requires Linux O_CLOEXEC')
}

function safeComponent(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Hosted canonical authority ${label} is invalid`)
  }
}

function exactJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => exactJson(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && exactJson(leftRecord[key], rightRecord[key]))
}

function readRecord(fd: number): HostedCanonicalAuthorityProtectedRecord {
  const stats = fstatSync(fd)
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_RECORD_BYTES) {
    throw new Error('Hosted canonical authority protected record is not a bounded regular file')
  }
  const bytes = Buffer.alloc(stats.size)
  let offset = 0
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
    if (count <= 0) throw new Error('Hosted canonical authority protected record was truncated')
    offset += count
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as HostedCanonicalAuthorityProtectedRecord
  } catch (error) {
    throw new Error('Hosted canonical authority protected record is malformed', { cause: error })
  }
}

function mountId(fd: number): number {
  const match = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
  if (!match) throw new Error('Hosted canonical authority mount identity is unavailable')
  return Number(match[1])
}

function identity(fd: number): { dev: number; ino: number; mountId: number } {
  const stats = fstatSync(fd)
  return { dev: stats.dev, ino: stats.ino, mountId: mountId(fd) }
}

function expectedLaunch(envelope: HostedCanonicalAuthorityLaunch): HostedCanonicalAuthorityProtectedRecord['launch'] {
  return {
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
  }
}

/**
 * Opens the host's protected registration entries itself and admits their exact
 * retained descriptors before any team bootstrap state is touched. The
 * authority deliberately remains retained for process lifetime: print teardown
 * currently joins pump and consumer branches in parallel, so revoking from the
 * pump branch would race admitted consumer work. Process exit closes the fds.
 */
export async function admitHostedCanonicalAuthorityAtStartup(
  envelope: HostedCanonicalAuthorityLaunch,
  effects: AdmissionEffects = defaultEffects,
): Promise<CanonicalTeamLockAuthority> {
  const reference = envelope.canonicalAuthority
  if (!reference || reference.version !== PROTOCOL_VERSION || !isAbsolute(reference.registryRoot)) {
    throw new Error('Hosted native launch lacks a valid host canonical authority reference')
  }
  safeComponent(reference.registrationId, 'registration identity')
  safeComponent(reference.anchorName, 'anchor name')
  safeComponent(reference.bindingRecordName, 'binding record name')
  if (reference.anchorName === reference.bindingRecordName || !reference.storageGeneration ||
    !reference.admittedWriterImage) {
    throw new Error('Hosted canonical authority registration fields are invalid')
  }
  if (getClaudeConfigHomeDir() !== envelope.canonicalDataRoot ||
    getTeamDir(envelope.legacyKey) !== envelope.canonicalTeamRoot ||
    getTasksDir(envelope.legacyKey) !== envelope.canonicalTasksRoot ||
    dirname(envelope.canonicalTeamRoot) !== join(envelope.canonicalDataRoot, 'teams')) {
    throw new Error('Hosted canonical authority does not match conventional team/tasks derivation')
  }
  if (retainedProcessAuthorities.has(reference.registrationId)) {
    throw new Error('Hosted canonical authority registration is already retained by this process')
  }

  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0) | cloexec()
  const fileFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0) | cloexec()
  const descriptors: number[] = []
  const opened = (path: string, flags: number): number => {
    const fd = openSync(path, flags)
    descriptors.push(fd)
    return fd
  }
  try {
    const rootParentFd = opened(dirname(envelope.canonicalTeamRoot), directoryFlags)
    const rootFd = opened(envelope.canonicalTeamRoot, directoryFlags)
    const anchorParentFd = opened(reference.registryRoot, directoryFlags)
    const anchorFd = opened(join(reference.registryRoot, reference.anchorName), fileFlags)
    const bindingRecordFd = opened(join(reference.registryRoot, reference.bindingRecordName), fileFlags)
    const protectedRecord = readRecord(bindingRecordFd)
    const expectedBinding: HostIssuedCanonicalTeamLockBinding = {
      protocolVersion: PROTOCOL_VERSION,
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
    }
    if (protectedRecord.recordVersion !== PROTOCOL_VERSION ||
      !exactJson(protectedRecord.registration, reference) ||
      !exactJson(protectedRecord.launch, expectedLaunch(envelope)) ||
      !Object.entries(expectedBinding).every(([key, value]) =>
        exactJson(protectedRecord[key as keyof HostIssuedCanonicalTeamLockBinding], value))) {
      throw new Error('Protected host registration does not exactly bind this launch and retained authority')
    }
    const authority = await effects.admit({
      binding: {
        protocolVersion: PROTOCOL_VERSION,
        registrationId: reference.registrationId,
        publicTeamId: envelope.publicTeamId,
        legacyKey: envelope.legacyKey,
        storageGeneration: reference.storageGeneration,
        admittedWriterImage: reference.admittedWriterImage,
        canonicalTeamRoot: envelope.canonicalTeamRoot,
      },
      rootFd,
      rootParentFd,
      rootName: basename(envelope.canonicalTeamRoot),
      anchorFd,
      anchorParentFd,
      anchorName: reference.anchorName,
      bindingRecordFd,
      bindingRecordName: reference.bindingRecordName,
    })
    retainedProcessAuthorities.set(reference.registrationId, authority)
    return authority
  } catch (error) {
    for (const fd of descriptors.reverse()) {
      try { closeSync(fd) } catch {}
    }
    throw error
  }
}
