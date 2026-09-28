import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import { isAbsolute } from 'node:path'

import type {
  HostedApprovalActivationEffectToken,
  HostedApprovalActivationGuard,
} from './HostedApprovalActivatablePort.js'
import type {
  VerifiedHostedApprovalActivation,
} from './HostedApprovalRuntimeActivation.js'
import type {
  HostedApprovalRuntimeAdmission,
  HostedApprovalRuntimeRoute,
} from './HostedApprovalRuntimeAdmission.js'

const MAX_RAW_ADMISSION_BYTES = 256 * 1024
const SHA256 = /^sha256:([0-9a-f]{64})$/

export type HostedApprovalActivationSocketEffectToken = {
  consume(): boolean
}

/**
 * Currentness capability for the exact connection retained as the activation
 * lease. The server-side implementation owns the descriptor and socket
 * identity; this adapter only combines its synchronous fence with the
 * activation epoch and raw admission fence.
 */
export type HostedApprovalRetainedActivationSocket = {
  isCurrent(): boolean
  prepareEffectToken(): HostedApprovalActivationSocketEffectToken | null
}

export type HostedApprovalActivatedAdmissionOptions = {
  activation: VerifiedHostedApprovalActivation
  rawAdmissionPath: string
  activationGuard: HostedApprovalActivationGuard
  activationSocket: HostedApprovalRetainedActivationSocket
}

type RawAdmissionIdentity = Readonly<{
  dev: number | bigint
  ino: number | bigint
  size: number
  bytes: Buffer
}>

/**
 * Adapts an already-authenticated C1 global admission into the existing local
 * runtime admission. Loading performs only private-file observations; it does
 * not install a delegate, inspect provider state, or authorize an effect.
 */
export function loadHostedApprovalActivatedAdmission(
  options: HostedApprovalActivatedAdmissionOptions,
): HostedApprovalRuntimeAdmission {
  const { activation, rawAdmissionPath, activationGuard, activationSocket } = options
  if (!isAbsolute(rawAdmissionPath) || rawAdmissionPath.includes('\0')) {
    throw new TypeError('Invalid hosted approval activated admission path')
  }
  if (!activationGuard.isCurrent()) {
    throw new Error('Hosted approval activation attempt is not current')
  }
  if (!activationSocket.isCurrent()) {
    throw new Error('Hosted approval activation socket is not current')
  }

  const canonicalBytes = canonicalAdmissionBytes(activation)
  const identity = loadExactPrivateAdmission(rawAdmissionPath, canonicalBytes)
  const routes = localRoutes(activation)
  const actorMembers = localActors(activation, routes)
  const digest = bareGlobalDigest(activation, canonicalBytes)
  const epoch = activationGuard.epoch

  const synchronouslyCurrent = (): boolean => {
    try {
      return activationGuard.epoch === epoch &&
        activationGuard.isCurrent() &&
        activationSocket.isCurrent() &&
        rawAdmissionCurrent(rawAdmissionPath, identity)
    } catch {
      return false
    }
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    admissionGeneration: activation.requestedTeam.admissionGeneration,
    outerAuthority: Object.freeze({
      deploymentId: activation.binding.deploymentId,
      bootId: activation.binding.bootId,
      workspaceId: activation.binding.workspaceId,
      teamId: activation.requestedTeam.teamId,
      restoreGeneration: activation.binding.restoreGeneration,
      mountBinding: Object.freeze({ ...activation.binding.mountBinding }),
    }),
    routes,
    actorMembers,
    // The WAL is globally fenced even though routes are projected locally.
    digest,
    isCurrent: () => Promise.resolve(synchronouslyCurrent()),
    prepareEffectToken: () => Promise.resolve(prepareCombinedEffectToken(
      synchronouslyCurrent,
      activationGuard,
      activationSocket,
      rawAdmissionPath,
      identity,
    )),
  })
}

function canonicalAdmissionBytes(activation: VerifiedHostedApprovalActivation): Buffer {
  const source = activation.canonicalAdmissionDocument
  if (
    typeof source !== 'string' ||
    !source.endsWith('\n') ||
    source.slice(0, -1).includes('\n') ||
    source.includes('\r')
  ) {
    throw new Error('Hosted approval canonical admission must end in exactly one LF')
  }
  const bytes = Buffer.from(source, 'utf8')
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_RAW_ADMISSION_BYTES) {
    throw new Error('Hosted approval canonical admission exceeds the 256 KiB limit')
  }
  return bytes
}

function bareGlobalDigest(
  activation: VerifiedHostedApprovalActivation,
  canonicalBytes: Buffer,
): string {
  const match = SHA256.exec(activation.admissionDocumentDigest)
  if (
    !match ||
    activation.binding.admissionDocumentDigest !== activation.admissionDocumentDigest ||
    activation.requestedTeam.globalAdmissionDigest !== activation.admissionDocumentDigest ||
    createHash('sha256').update(canonicalBytes).digest('hex') !== match[1]
  ) {
    throw new Error('Hosted approval global admission digest mismatch')
  }
  return match[1]
}

function localRoutes(
  activation: VerifiedHostedApprovalActivation,
): readonly HostedApprovalRuntimeRoute[] {
  const teamId = activation.requestedTeam.teamId
  if (teamId !== activation.binding.teamId) {
    throw new Error('Hosted approval requested team mismatch')
  }
  const routes = [...activation.requestedTeam.routes]
  if (
    routes.length === 0 ||
    routes.some(route => route.authority.teamId !== teamId || route.scope.teamId !== teamId)
  ) {
    throw new Error('Hosted approval requested-team route mismatch')
  }
  return Object.freeze(routes)
}

function localActors(
  activation: VerifiedHostedApprovalActivation,
  routes: readonly HostedApprovalRuntimeRoute[],
): Readonly<Record<string, string>> {
  const actors: Record<string, string> = {}
  for (const route of routes) {
    const actor = route.scope.principalId
    const member = activation.requestedTeam.actorMembers[actor]
    if (member !== route.authority.deliveryOwnerId) {
      throw new Error('Hosted approval requested-team actor cross-binding mismatch')
    }
    const prior = actors[actor]
    if (prior !== undefined && prior !== member) {
      throw new Error('Hosted approval requested-team actor is ambiguous')
    }
    actors[actor] = member
  }
  return Object.freeze(actors)
}

function loadExactPrivateAdmission(path: string, expected: Buffer): RawAdmissionIdentity {
  let fd = -1
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const linked = lstatSync(path)
    if (!safePrivateIdentity(opened, linked) || opened.size !== expected.byteLength) {
      throw new Error('Hosted approval raw admission is not an exact private file')
    }
    const bytes = readExact(fd, opened.size)
    const after = fstatSync(fd)
    const current = lstatSync(path)
    if (
      !safePrivateIdentity(after, current) ||
      after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || !bytes.equals(expected)
    ) {
      throw new Error('Hosted approval raw admission bytes do not match verified activation')
    }
    return Object.freeze({
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      bytes: Buffer.from(bytes),
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Hosted approval')) throw error
    throw new Error('Hosted approval raw admission is unavailable', { cause: error })
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

function rawAdmissionCurrent(path: string, expected: RawAdmissionIdentity): boolean {
  let fd = -1
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const linked = lstatSync(path)
    if (
      !safePrivateIdentity(opened, linked) ||
      opened.dev !== expected.dev || opened.ino !== expected.ino ||
      opened.size !== expected.size
    ) return false
    const bytes = readExact(fd, opened.size)
    const after = fstatSync(fd)
    const current = lstatSync(path)
    return safePrivateIdentity(after, current) &&
      after.dev === expected.dev && after.ino === expected.ino &&
      after.size === expected.size && bytes.equals(expected.bytes)
  } catch {
    return false
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

function prepareCombinedEffectToken(
  synchronouslyCurrent: () => boolean,
  activationGuard: HostedApprovalActivationGuard,
  activationSocket: HostedApprovalRetainedActivationSocket,
  rawAdmissionPath: string,
  identity: RawAdmissionIdentity,
): { consume(): boolean } | null {
  if (!synchronouslyCurrent()) return null
  const activationToken = activationGuard.prepareEffectToken()
  const socketToken = activationSocket.prepareEffectToken()
  if (!activationToken || !socketToken) {
    consumePreparedToken(activationToken)
    consumePreparedToken(socketToken)
    return null
  }

  let consumed = false
  return Object.freeze({
    consume: () => {
      if (consumed) return false
      consumed = true
      // Evaluate every constituent fence even after one fails so no prepared
      // single-use capability remains live after this combined attempt.
      const rawCurrent = rawAdmissionCurrent(rawAdmissionPath, identity)
      const socketCurrent = consumePreparedToken(socketToken)
      const epochCurrent = consumePreparedToken(activationToken)
      return rawCurrent && socketCurrent && epochCurrent
    },
  })
}

function consumePreparedToken(
  token: HostedApprovalActivationEffectToken | HostedApprovalActivationSocketEffectToken | null,
): boolean {
  if (!token) return false
  try { return token.consume() } catch { return false }
}

function readExact(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset)
    if (read === 0) throw new Error('Hosted approval raw admission was truncated')
    offset += read
  }
  return bytes
}

function safePrivateIdentity(
  opened: {
    dev: number | bigint
    ino: number | bigint
    mode: number
    uid: number
    isFile(): boolean
  },
  linked: {
    dev: number | bigint
    ino: number | bigint
    isFile(): boolean
    isSymbolicLink(): boolean
  },
): boolean {
  const ownerUid = process.geteuid?.() ?? process.getuid?.()
  return opened.isFile() && linked.isFile() && !linked.isSymbolicLink() &&
    opened.dev === linked.dev && opened.ino === linked.ino &&
    (opened.mode & 0o7777) === 0o600 &&
    (ownerUid === undefined || opened.uid === ownerUid)
}
