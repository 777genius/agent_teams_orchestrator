import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { TextDecoder } from 'node:util'

import type { HostedApprovalAuthorityScope, HostedApprovalIngressAuthority } from './HostedApprovalWire.js'
import { assertNoDuplicateJsonObjectKeys } from './ownerProof.js'
import type { HostedControlStableAuthority } from './protocol.js'

export type HostedApprovalRuntimeRoute = {
  routeId: string
  authority: HostedApprovalIngressAuthority
  scope: HostedApprovalAuthorityScope
  memberName: string
  /** Provisioning-captured identity of the exact live OpenCode session record. */
  openCodeBinding: {
    toolApprovalMode: 'manual'
    planGeneration: number
    credentialGeneration: number
    credentialId: string
    runtimeInstanceId: string
    deliveryOwnerId: string
    /** SHA-256 of the exact OpenCode executable admitted for this route. */
    openCodeArtifactDigest: `sha256:${string}`
    /** SHA-256 of the exact, stable live OpenCode session projection. */
    sessionRecordFingerprint: string
    /** SHA-256 of prepareProfile + ensured host/process identity at POST edge. */
    liveEffectFingerprint: string
  }
}

export type HostedApprovalRuntimeAdmission = {
  schemaVersion: 1
  admissionGeneration: string
  outerAuthority: {
    deploymentId: string
    bootId: string
    workspaceId: string
    teamId: string
    restoreGeneration: number
    mountBinding: {
      mountGeneration: number
      declaredRootHash: string
    }
  }
  routes: readonly HostedApprovalRuntimeRoute[]
  actorMembers: Readonly<Record<string, string>>
  digest: string
  isCurrent(): Promise<boolean>
  prepareEffectToken(): Promise<{ consume(): boolean } | null>
}

const MAX_BYTES = 16 * 1024 * 1024
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const MEMBER_ID = /^member_[0-9a-f]{32}$/

/** Provisioning-owned immutable routing authority; raw bytes are the generation fence. */
export class PrivateFileHostedApprovalRuntimeAdmissionStore {
  constructor(readonly path: string) {
    if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('Invalid hosted approval admission path')
  }

  async load(authority: HostedControlStableAuthority): Promise<HostedApprovalRuntimeAdmission> {
    const raw = await this.#read()
    const source = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    assertNoDuplicateJsonObjectKeys(source)
    const decoded = decodeSnapshot(JSON.parse(source), authority)
    const digest = createHash('sha256').update(raw).digest('hex')
    return {
      ...decoded,
      digest,
      isCurrent: async () => {
        try {
          return (
            createHash('sha256')
              .update(await this.#read())
              .digest('hex') === digest
          )
        } catch {
          return false
        }
      },
      prepareEffectToken: async () => {
        let fd = -1
        try {
          fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          const opened = fstatSync(fd); const linked = lstatSync(this.path)
          if (!safeAdmissionIdentity(opened, linked) || opened.size < 2 || opened.size > MAX_BYTES ||
            digestAdmissionFd(fd, opened.size) !== digest) {
            closeSync(fd); return null
          }
          const expected = { dev: opened.dev, ino: opened.ino }
          const ownedFd = fd; fd = -1; let consumed = false
          return {
            consume: () => {
              if (consumed) return false
              consumed = true
              try {
                const current = fstatSync(ownedFd); const currentLinked = lstatSync(this.path)
                return current.dev === expected.dev && current.ino === expected.ino &&
                  safeAdmissionIdentity(current, currentLinked) && current.size === opened.size &&
                  digestAdmissionFd(ownedFd, current.size) === digest
              } catch { return false } finally { closeSync(ownedFd) }
            },
          }
        } catch {
          if (fd >= 0) closeSync(fd)
          return null
        }
      },
    }
  }

  async #read(): Promise<Buffer> {
    const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const [stat, current, canonical] = await Promise.all([handle.stat(), lstat(this.path), realpath(this.path)])
      if (
        !stat.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        stat.dev !== current.dev ||
        stat.ino !== current.ino ||
        canonical !== this.path ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size < 2 ||
        stat.size > MAX_BYTES ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())
      ) {
        throw new Error('Hosted approval admission is not a canonical private file')
      }
      const raw = await handle.readFile()
      if (raw.byteLength < 2 || raw.byteLength > MAX_BYTES) throw new Error('Hosted approval admission size changed')
      return raw
    } finally {
      await handle.close()
    }
  }
}

function digestAdmissionFd(fd: number, size: number): string | null {
  const raw = Buffer.alloc(size)
  return readSync(fd, raw, 0, size, 0) === size
    ? createHash('sha256').update(raw).digest('hex')
    : null
}

function safeAdmissionIdentity(
  opened: { dev: number | bigint; ino: number | bigint; mode: number; uid: number; isFile(): boolean },
  linked: { dev: number | bigint; ino: number | bigint; isFile(): boolean; isSymbolicLink(): boolean },
): boolean {
  return opened.isFile() && linked.isFile() && !linked.isSymbolicLink() &&
    opened.dev === linked.dev && opened.ino === linked.ino && (opened.mode & 0o777) === 0o600 &&
    (process.getuid?.() === undefined || opened.uid === process.getuid())
}

function decodeSnapshot(
  value: unknown,
  expected: HostedControlStableAuthority,
): Omit<HostedApprovalRuntimeAdmission, 'digest' | 'isCurrent' | 'prepareEffectToken'> {
  const input = object(value, 'snapshot')
  exact(input, ['schemaVersion', 'admissionGeneration', 'outerAuthority', 'routes', 'actorMembers'], 'snapshot')
  if (
    input.schemaVersion !== 1 ||
    typeof input.admissionGeneration !== 'string' ||
    !/^approval-admission-generation_[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(input.admissionGeneration)
  ) {
    throw new Error('Invalid hosted approval admission generation')
  }
  const outer = object(input.outerAuthority, 'outer authority')
  exact(
    outer,
    ['deploymentId', 'bootId', 'workspaceId', 'teamId', 'restoreGeneration', 'mountBinding'],
    'outer authority',
  )
  const mountBinding = object(outer.mountBinding, 'outer mount binding')
  exact(mountBinding, ['mountGeneration', 'declaredRootHash'], 'outer mount binding')
  if (
    outer.deploymentId !== expected.deploymentId ||
    outer.bootId !== expected.bootId ||
    outer.workspaceId !== expected.workspaceId ||
    outer.teamId !== expected.teamId ||
    outer.restoreGeneration !== expected.restoreGeneration ||
    mountBinding.mountGeneration !== expected.mountBinding.mountGeneration ||
    mountBinding.declaredRootHash !== expected.mountBinding.declaredRootHash
  ) {
    throw new Error('Hosted approval admission outer authority mismatch')
  }
  const actors = object(input.actorMembers, 'actor mappings')
  for (const [actorId, memberId] of Object.entries(actors)) {
    if (
      !/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(actorId) ||
      typeof memberId !== 'string' ||
      !MEMBER_ID.test(memberId)
    ) {
      throw new Error('Invalid hosted approval actor mapping')
    }
  }
  if (!Array.isArray(input.routes) || input.routes.length > 256) throw new Error('Invalid hosted approval routes')
  const routes = input.routes.map((route, index) => decodeRoute(route, index, expected, actors))
  if (
    new Set(routes.map(route => route.routeId)).size !== routes.length ||
    new Set(routes.map(route => route.authority.sessionId)).size !== routes.length
  ) {
    throw new Error('Duplicate hosted approval route')
  }
  return {
    schemaVersion: 1,
    admissionGeneration: input.admissionGeneration,
    outerAuthority: {
      deploymentId: expected.deploymentId,
      bootId: expected.bootId,
      workspaceId: expected.workspaceId,
      teamId: expected.teamId,
      restoreGeneration: expected.restoreGeneration,
      mountBinding: { ...expected.mountBinding },
    },
    routes,
    actorMembers: actors as Record<string, string>,
  }
}

function decodeRoute(
  value: unknown,
  index: number,
  expected: HostedControlStableAuthority,
  actors: Record<string, unknown>,
): HostedApprovalRuntimeRoute {
  const route = object(value, `route ${index}`)
  exact(route, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding'], `route ${index}`)
  const authority = decodeAuthority(route.authority)
  const scope = decodeScope(route.scope)
  const openCodeBinding = decodeOpenCodeBinding(route.openCodeBinding)
  if (
    typeof route.routeId !== 'string' ||
    !IDENTIFIER.test(route.routeId) ||
    typeof route.memberName !== 'string' ||
    !IDENTIFIER.test(route.memberName) ||
    authority.deploymentId !== expected.deploymentId ||
    authority.teamId !== expected.teamId ||
    scope.workspaceId !== expected.workspaceId ||
    scope.teamId !== expected.teamId ||
    scope.restoreGeneration !== expected.restoreGeneration ||
    actors[scope.principalId] !== authority.deliveryOwnerId ||
    openCodeBinding.planGeneration !== authority.planGeneration ||
    openCodeBinding.credentialGeneration !== authority.credentialGeneration ||
    openCodeBinding.credentialId !== authority.credentialId ||
    openCodeBinding.runtimeInstanceId !== authority.runtimeInstanceId ||
    openCodeBinding.deliveryOwnerId !== authority.deliveryOwnerId ||
    authority.providerId !== 'opencode'
  ) {
    throw new Error(`Hosted approval route ${index} cross-binding mismatch`)
  }
  return {
    routeId: route.routeId,
    authority,
    scope,
    memberName: route.memberName,
    openCodeBinding,
  }
}

function decodeOpenCodeBinding(value: unknown): HostedApprovalRuntimeRoute['openCodeBinding'] {
  const input = object(value, 'OpenCode binding')
  exact(
    input,
    [
      'toolApprovalMode',
      'planGeneration',
      'credentialGeneration',
      'credentialId',
      'runtimeInstanceId',
      'deliveryOwnerId',
      'openCodeArtifactDigest',
      'sessionRecordFingerprint',
      'liveEffectFingerprint',
    ],
    'OpenCode binding',
  )
  if (
    input.toolApprovalMode !== 'manual' ||
    !positive(input.planGeneration) ||
    !positive(input.credentialGeneration) ||
    typeof input.credentialId !== 'string' ||
    !IDENTIFIER.test(input.credentialId) ||
    typeof input.runtimeInstanceId !== 'string' ||
    !IDENTIFIER.test(input.runtimeInstanceId) ||
    typeof input.deliveryOwnerId !== 'string' ||
    !MEMBER_ID.test(input.deliveryOwnerId) ||
    typeof input.openCodeArtifactDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(input.openCodeArtifactDigest) ||
    typeof input.sessionRecordFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.sessionRecordFingerprint) ||
    typeof input.liveEffectFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.liveEffectFingerprint)
  )
    throw new Error('Invalid hosted approval OpenCode binding')
  return input as HostedApprovalRuntimeRoute['openCodeBinding']
}

function decodeAuthority(value: unknown): HostedApprovalIngressAuthority {
  const input = object(value, 'route authority')
  exact(
    input,
    [
      'deploymentId',
      'teamId',
      'runId',
      'planGeneration',
      'laneId',
      'providerId',
      'credentialGeneration',
      'credentialId',
      'sessionId',
      'runtimeInstanceId',
      'deliveryOwnerId',
    ],
    'route authority',
  )
  if (
    typeof input.deploymentId !== 'string' ||
    !IDENTIFIER.test(input.deploymentId) ||
    typeof input.teamId !== 'string' ||
    !/^team_[0-9a-f]{32}$/.test(input.teamId) ||
    typeof input.runId !== 'string' ||
    !/^run_[0-9a-f]{32}$/.test(input.runId) ||
    !positive(input.planGeneration) ||
    typeof input.laneId !== 'string' ||
    !IDENTIFIER.test(input.laneId) ||
    input.providerId !== 'opencode' ||
    !positive(input.credentialGeneration) ||
    typeof input.credentialId !== 'string' ||
    !IDENTIFIER.test(input.credentialId) ||
    typeof input.sessionId !== 'string' ||
    !IDENTIFIER.test(input.sessionId) ||
    typeof input.runtimeInstanceId !== 'string' ||
    !IDENTIFIER.test(input.runtimeInstanceId) ||
    typeof input.deliveryOwnerId !== 'string' ||
    !MEMBER_ID.test(input.deliveryOwnerId)
  ) {
    throw new Error('Invalid hosted approval route authority')
  }
  return input as HostedApprovalIngressAuthority
}

function decodeScope(value: unknown): HostedApprovalAuthorityScope {
  const input = object(value, 'route scope')
  exact(input, ['principalId', 'workspaceId', 'teamId', 'authorityGeneration', 'restoreGeneration'], 'route scope')
  if (
    typeof input.principalId !== 'string' ||
    !/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(input.principalId) ||
    typeof input.workspaceId !== 'string' ||
    !IDENTIFIER.test(input.workspaceId) ||
    typeof input.teamId !== 'string' ||
    !/^team_[0-9a-f]{32}$/.test(input.teamId) ||
    typeof input.authorityGeneration !== 'string' ||
    !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(input.authorityGeneration) ||
    !Number.isSafeInteger(input.restoreGeneration) ||
    (input.restoreGeneration as number) < 0
  ) {
    throw new Error('Invalid hosted approval route scope')
  }
  return input as HostedApprovalAuthorityScope
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid hosted approval ${field}`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid hosted approval ${field} keys`)
  }
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
