import { isDeepStrictEqual } from 'node:util'

import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'
import type { HostedControlOwnerBinding } from './protocol.js'

export type HostedLifecycleRunReservation = Readonly<{
  schemaVersion: 1
  workspaceId: string
  runtimeWorkspaceId: string
  teamId: string
  actorId: string
  deploymentId: string
  bootId: string
  commandId: string
  idempotencyKey: string
  expectedRevision: string
  expectedPlanGeneration: string
  ownerAuthority: string
  ownerGeneration: number
  ownerSessionId: string
  restoreGeneration: number
  mountGeneration: number
  ownerEffectFence: { grantRevision: string; identityChecksum: string }
  authorityEvidence: { userId: string; sessionId: string; grantGeneration: number }
  runId: string
  promotionOperationId: string
  planSha256: string
  rosterBindingSha256: string
  createdAtMs: number
}>

/** The request is authenticated by the existing lifecycle socket proof before this check. */
export function decodeHostedLifecycleRunReservation(
  value: unknown,
  command: Record<string, unknown>,
  authority: HostedLifecycleAuthority,
  owner: HostedControlOwnerBinding,
): HostedLifecycleRunReservation {
  const raw = exactObject(value, [
    'schemaVersion', 'workspaceId', 'runtimeWorkspaceId', 'teamId', 'actorId',
    'deploymentId', 'bootId', 'commandId', 'idempotencyKey', 'expectedRevision',
    'expectedPlanGeneration', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId',
    'restoreGeneration', 'mountGeneration', 'ownerEffectFence', 'authorityEvidence',
    'runId', 'promotionOperationId', 'planSha256', 'rosterBindingSha256', 'createdAtMs',
  ])
  const fence = exactObject(raw.ownerEffectFence, ['grantRevision', 'identityChecksum'])
  const evidence = exactObject(raw.authorityEvidence, ['userId', 'sessionId', 'grantGeneration'])
  const sha = /^[0-9a-f]{64}$/
  if (raw.schemaVersion !== 1 ||
    raw.workspaceId !== authority.workspaceId || raw.teamId !== authority.teamId ||
    raw.actorId !== authority.actorId || raw.deploymentId !== authority.deploymentId ||
    raw.bootId !== authority.bootId || raw.commandId !== command.commandId ||
    raw.idempotencyKey !== command.idempotencyKey || raw.expectedRevision !== command.expectedRevision ||
    raw.ownerAuthority !== owner.ownerAuthority || raw.ownerGeneration !== owner.ownerGeneration ||
    raw.ownerSessionId !== owner.ownerSessionId ||
    raw.restoreGeneration !== authority.restoreGeneration || raw.mountGeneration !== authority.mountGeneration ||
    !isDeepStrictEqual(fence, authority.ownerEffectFence) ||
    typeof raw.runtimeWorkspaceId !== 'string' || !/^workspace_[0-9a-f]{32}$/.test(raw.runtimeWorkspaceId) ||
    typeof raw.runId !== 'string' || !/^run_[0-9a-f]{32}$/.test(raw.runId) ||
    typeof raw.promotionOperationId !== 'string' || !/^promotion_[0-9a-f]{32}$/.test(raw.promotionOperationId) ||
    typeof raw.planSha256 !== 'string' || !sha.test(raw.planSha256) ||
    typeof raw.rosterBindingSha256 !== 'string' || !sha.test(raw.rosterBindingSha256) ||
    raw.expectedPlanGeneration !== `plan-generation_${raw.planSha256}` ||
    !Number.isSafeInteger(raw.createdAtMs) || (raw.createdAtMs as number) < 0 ||
    !Number.isSafeInteger(raw.ownerGeneration) || (raw.ownerGeneration as number) < 1 ||
    typeof evidence.userId !== 'string' || !/^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(evidence.userId) ||
    typeof evidence.sessionId !== 'string' || !/^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(evidence.sessionId) ||
    !Number.isSafeInteger(evidence.grantGeneration) || evidence.grantGeneration !== authority.restoreGeneration ||
    typeof fence.grantRevision !== 'string' || !sha.test(fence.grantRevision) ||
    typeof fence.identityChecksum !== 'string' || !sha.test(fence.identityChecksum)) {
    throw new Error('Invalid hosted lifecycle run reservation')
  }
  return raw as HostedLifecycleRunReservation
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Invalid hosted lifecycle run reservation shape')
  }
  return value as Record<string, unknown>
}
