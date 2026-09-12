import { createHash, randomUUID } from 'node:crypto'
import { closeSync } from 'node:fs'
import { jsonParse, jsonStringify } from 'src/utils/slowOperations.js'
import { CanonicalTeamDirectory } from 'src/utils/swarm/canonicalTeamDirectory.js'
import {
  resolveCanonicalTeamLockAuthority,
  withCanonicalTeamLock,
  withValidatedCanonicalTeamRoot,
} from 'src/utils/swarm/canonicalTeamLockAuthority.js'
import type { TrustedTeammateTaskIdentity } from 'src/utils/tasks.js'

const MAX_CLEANUP_STATE_BYTES = 64 * 1024

export type HostedMailboxShutdownIdentity = {
  agentId: string
  joinedAt: number
  paneId?: string
  processStartedAtMs?: number
  processOsIdentity?: string
  processOwnerToken?: string
  processRunId?: string
  spawnClaimToken?: string
  spawnClaimRunId?: string
}

export type HostedMailboxShutdownCleanupState = {
  version: 1
  requestId: string
  teammateName: string
  identity: HostedMailboxShutdownIdentity
  taskIdentity: TrustedTeammateTaskIdentity
  phase: 'prepared' | 'roster_removed' | 'tasks_cleaned' | 'complete'
  updatedAt: string
}

function cleanupStateName(requestId: string, teammateName: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify({ requestId, teammateName }))
    .digest('hex')
  return `hosted-shutdown-cleanup.${key}.json`
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function parseCleanupState(text: string): HostedMailboxShutdownCleanupState {
  if (Buffer.byteLength(text) > MAX_CLEANUP_STATE_BYTES) {
    throw new Error('Hosted shutdown cleanup state is too large')
  }
  const value = jsonParse(text) as Partial<HostedMailboxShutdownCleanupState>
  const identity = value.identity as Partial<HostedMailboxShutdownIdentity> | undefined
  const taskIdentity = value.taskIdentity as Partial<TrustedTeammateTaskIdentity> | undefined
  if (
    value.version !== 1 ||
    typeof value.requestId !== 'string' || !value.requestId ||
    typeof value.teammateName !== 'string' || !value.teammateName ||
    !['prepared', 'roster_removed', 'tasks_cleaned', 'complete'].includes(value.phase ?? '') ||
    typeof value.updatedAt !== 'string' ||
    !identity || typeof identity.agentId !== 'string' || !identity.agentId ||
    !Number.isSafeInteger(identity.joinedAt) || (identity.joinedAt as number) < 0 ||
    !isOptionalString(identity.paneId) ||
    (identity.processStartedAtMs !== undefined && !Number.isFinite(identity.processStartedAtMs)) ||
    !isOptionalString(identity.processOsIdentity) ||
    !isOptionalString(identity.processOwnerToken) ||
    !isOptionalString(identity.processRunId) ||
    !isOptionalString(identity.spawnClaimToken) ||
    !isOptionalString(identity.spawnClaimRunId) ||
    !taskIdentity || taskIdentity.teammateId !== identity.agentId ||
    taskIdentity.teammateName !== value.teammateName ||
    (taskIdentity.hostedOwnerId !== undefined &&
      (typeof taskIdentity.hostedOwnerId !== 'string' || !/^member_[0-9a-f]{32}$/.test(taskIdentity.hostedOwnerId)))
  ) throw new Error('Hosted shutdown cleanup state is invalid')
  return value as HostedMailboxShutdownCleanupState
}

export async function readHostedMailboxShutdownCleanupState(params: {
  canonicalTeamRoot: string
  teamName: string
  requestId: string
  teammateName: string
}): Promise<HostedMailboxShutdownCleanupState | null> {
  const authority = resolveCanonicalTeamLockAuthority(params.canonicalTeamRoot, params.teamName)
  return withValidatedCanonicalTeamRoot(authority, async rootFd => {
    const directory = await CanonicalTeamDirectory.fromRootFd(rootFd)
    const file = directory.readFile(cleanupStateName(params.requestId, params.teammateName))
    if (!file) return null
    const state = parseCleanupState(file.text)
    if (state.requestId !== params.requestId || state.teammateName !== params.teammateName) {
      throw new Error('Hosted shutdown cleanup state key does not match its contents')
    }
    return state
  })
}

export async function writeHostedMailboxShutdownCleanupState(params: {
  canonicalTeamRoot: string
  teamName: string
  state: HostedMailboxShutdownCleanupState
}): Promise<void> {
  const authority = resolveCanonicalTeamLockAuthority(params.canonicalTeamRoot, params.teamName)
  await withCanonicalTeamLock(
    authority,
    { deadlineMs: Date.now() + 30_000 },
    async rootFd => {
      const directory = await CanonicalTeamDirectory.fromRootFd(rootFd)
      const finalName = cleanupStateName(params.state.requestId, params.state.teammateName)
      const temporaryName = `${finalName}.tmp.${process.pid}.${randomUUID()}`
      const owned = directory.createFile(
        temporaryName,
        jsonStringify(params.state, null, 2),
      )
      try {
        if (!directory.namedFileIs(temporaryName, owned)) {
          throw new Error('Hosted shutdown cleanup staging file was replaced')
        }
        directory.rename(temporaryName, finalName)
      } finally {
        if (owned.fd !== undefined) closeSync(owned.fd)
      }
    },
  )
}

export function sameHostedMailboxShutdownIdentity(
  member: HostedMailboxShutdownIdentity,
  expected: HostedMailboxShutdownIdentity,
): boolean {
  return member.agentId === expected.agentId &&
    member.joinedAt === expected.joinedAt &&
    member.paneId === expected.paneId &&
    member.processStartedAtMs === expected.processStartedAtMs &&
    member.processOsIdentity === expected.processOsIdentity &&
    member.processOwnerToken === expected.processOwnerToken &&
    member.processRunId === expected.processRunId &&
    member.spawnClaimToken === expected.spawnClaimToken &&
    member.spawnClaimRunId === expected.spawnClaimRunId
}
