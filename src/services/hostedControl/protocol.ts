import { createHash } from 'node:crypto'

export const HOSTED_CONTROL_OPERATION = 'task_mutate' as const

export type HostedControlOwnerBinding = {
  ownerAuthority: string
  ownerGeneration: number
  ownerSessionId: string
  socketIdentity: { device: string; inode: string; uid: number; gid: number; mode: number }
}

export type HostedControlAuthority = {
  actorId: string
  deploymentId: string
  bootId: string
  restoreGeneration: number
  workspaceId: string
  mountBinding: { mountGeneration: number; declaredRootHash: string }
  teamId: string
}
export type HostedControlStableAuthority = Omit<HostedControlAuthority, 'actorId'>

type CommonCommand = {
  schemaVersion: 1
  commandId: string
  idempotencyKey: string
  teamId: string
  expectedSourceGeneration: string
  expectedRevision: string
}
type TaskStatus = 'pending' | 'in_progress' | 'completed'
type Column = 'todo' | 'in_progress' | 'review' | 'approved' | 'done'

export type HostedTaskMutationCommand =
  | (CommonCommand & { kind: 'create_task'; subject: string; description: string | null; status: TaskStatus; ownerId: string | null; column: Column; order: number })
  | (CommonCommand & { kind: 'update_details'; taskId: string; subject?: string; description?: string | null })
  | (CommonCommand & { kind: 'update_owner'; taskId: string; ownerId: string | null })
  | (CommonCommand & { kind: 'update_status'; taskId: string; status: TaskStatus })
  | (CommonCommand & { kind: 'move_task'; taskId: string; column: Column; order: number })
  | (CommonCommand & { kind: 'reorder_column'; column: Column; orderedTaskIds: string[] })

export type HostedControlPayload = { command: HostedTaskMutationCommand; payloadFingerprint: string }
export type HostedControlProof = string

export type HostedTaskMutationRequest = {
  schemaVersion: 2
  exchangeId: string
  operation: 'task_mutate'
  ownerBinding: HostedControlOwnerBinding
  authority: HostedControlAuthority
  payload: HostedControlPayload
  ownerProof: HostedControlProof
}

export type HostedTaskMutationReceipt = {
  schemaVersion: 1
  outcome: 'committed' | 'idempotent_replay'
  commandId: string
  teamId: string
  sourceGeneration: string
  revision: string
  affectedTaskIds: string[]
}

export type HostedTaskMutationCommittedResult = { kind: 'committed'; currentSourceGeneration: string; payloadFingerprint: string; receipt: HostedTaskMutationReceipt }
export type HostedTaskMutationReplayResult = { kind: 'idempotent_replay'; currentSourceGeneration: string; payloadFingerprint: string; receipt: HostedTaskMutationReceipt }
export type HostedTaskMutationTerminalResult =
  | HostedTaskMutationCommittedResult
  | HostedTaskMutationReplayResult
  | { kind: 'stale_generation'; currentSourceGeneration: string }
  | { kind: 'stale_revision'; currentSourceGeneration: string; currentRevision: string }
  | { kind: 'conflict'; reason: 'idempotency_mismatch'; currentSourceGeneration: string }
  | { kind: 'conflict'; reason: 'relationship_conflict'; currentSourceGeneration: string; currentRevision?: string }
  | { kind: 'conflict'; reason: 'state_conflict'; currentSourceGeneration: string; currentRevision: string }
  | { kind: 'not_found' }
  | { kind: 'unsafe_active' }
  | { kind: 'unavailable'; retryAfterMs?: number }

const ID = {
  team: /^team_[0-9a-f]{32}$/,
  member: /^member_[0-9a-f]{32}$/,
  task: /^task_[0-9a-f]{32}$/,
  command: /^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/,
  idempotency: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  generation: /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/,
  revision: /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/,
  hash: /^[0-9a-f]{64}$/,
  fingerprint: /^[A-Za-z0-9_-]{43}$/,
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${field}`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: string[], field: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${field} keys`)
}
function string(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern ? !pattern.test(value) : value.length === 0)) throw new Error(`Invalid ${field}`)
  return value
}
function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${field}`)
  return value as number
}
function nullableString(value: unknown, field: string, max: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${field}`)
  return value
}
function description(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Invalid description')
  return value
}
function subject(value: unknown): string {
  const parsed = nullableString(value, 'subject', 200)
  if (parsed === null || parsed.length === 0 || parsed.trim() !== parsed) throw new Error('Invalid subject')
  return parsed
}
function status(value: unknown): TaskStatus {
  if (value !== 'pending' && value !== 'in_progress' && value !== 'completed') throw new Error('Invalid status')
  return value
}
function column(value: unknown): Column {
  if (!['todo', 'in_progress', 'review', 'approved', 'done'].includes(value as string)) throw new Error('Invalid column')
  return value as Column
}

export function decodeHostedControlAuthority(value: unknown): HostedControlAuthority {
  const v = record(value, 'authority'); exact(v, ['actorId', 'deploymentId', 'bootId', 'restoreGeneration', 'workspaceId', 'mountBinding', 'teamId'], 'authority')
  const mount = record(v.mountBinding, 'mountBinding'); exact(mount, ['mountGeneration', 'declaredRootHash'], 'mountBinding')
  return { actorId: string(v.actorId, 'actorId'), deploymentId: string(v.deploymentId, 'deploymentId'), bootId: string(v.bootId, 'bootId'), restoreGeneration: integer(v.restoreGeneration, 'restoreGeneration'), workspaceId: string(v.workspaceId, 'workspaceId'), mountBinding: { mountGeneration: integer(mount.mountGeneration, 'mountGeneration', 1), declaredRootHash: string(mount.declaredRootHash, 'declaredRootHash', ID.hash) }, teamId: string(v.teamId, 'teamId', ID.team) }
}

export function decodeHostedTaskMutationCommand(value: unknown): HostedTaskMutationCommand {
  const v = record(value, 'command')
  const common = ['schemaVersion', 'kind', 'commandId', 'idempotencyKey', 'teamId', 'expectedSourceGeneration', 'expectedRevision']
  if (v.schemaVersion !== 1) throw new Error('Invalid command.schemaVersion')
  const base = { schemaVersion: 1 as const, commandId: string(v.commandId, 'commandId', ID.command), idempotencyKey: string(v.idempotencyKey, 'idempotencyKey', ID.idempotency), teamId: string(v.teamId, 'teamId', ID.team), expectedSourceGeneration: string(v.expectedSourceGeneration, 'expectedSourceGeneration', ID.generation), expectedRevision: string(v.expectedRevision, 'expectedRevision', ID.revision) }
  switch (v.kind) {
    case 'create_task': exact(v, [...common, 'subject', 'description', 'status', 'ownerId', 'column', 'order'], 'create_task'); return { ...base, kind: 'create_task', subject: subject(v.subject), description: description(v.description), status: status(v.status), ownerId: v.ownerId === null ? null : string(v.ownerId, 'ownerId', ID.member), column: column(v.column), order: integer(v.order, 'order', 0, 1_000_000) }
    case 'update_details': {
      const hasSubject = Object.hasOwn(v, 'subject'); const hasDescription = Object.hasOwn(v, 'description')
      exact(v, [...common, 'taskId', ...(hasSubject ? ['subject'] : []), ...(hasDescription ? ['description'] : [])], 'update_details')
      if (!hasSubject && !hasDescription) throw new Error('update_details requires a field')
      return { ...base, kind: 'update_details', taskId: string(v.taskId, 'taskId', ID.task), ...(hasSubject ? { subject: subject(v.subject) } : {}), ...(hasDescription ? { description: description(v.description) } : {}) }
    }
    case 'update_owner': exact(v, [...common, 'taskId', 'ownerId'], 'update_owner'); return { ...base, kind: 'update_owner', taskId: string(v.taskId, 'taskId', ID.task), ownerId: v.ownerId === null ? null : string(v.ownerId, 'ownerId', ID.member) }
    case 'update_status': exact(v, [...common, 'taskId', 'status'], 'update_status'); return { ...base, kind: 'update_status', taskId: string(v.taskId, 'taskId', ID.task), status: status(v.status) }
    case 'move_task': exact(v, [...common, 'taskId', 'column', 'order'], 'move_task'); return { ...base, kind: 'move_task', taskId: string(v.taskId, 'taskId', ID.task), column: column(v.column), order: integer(v.order, 'order', 0, 1_000_000) }
    case 'reorder_column': {
      exact(v, [...common, 'column', 'orderedTaskIds'], 'reorder_column')
      if (!Array.isArray(v.orderedTaskIds) || v.orderedTaskIds.length === 0 || v.orderedTaskIds.length > 100) throw new Error('Invalid orderedTaskIds')
      const ids = v.orderedTaskIds.map(id => string(id, 'orderedTaskId', ID.task)); if (new Set(ids).size !== ids.length) throw new Error('Duplicate orderedTaskIds')
      return { ...base, kind: 'reorder_column', column: column(v.column), orderedTaskIds: ids }
    }
    default: throw new Error('Invalid command.kind')
  }
}

function decodeReceipt(value: unknown, outcome: HostedTaskMutationReceipt['outcome']): HostedTaskMutationReceipt {
  const v = record(value, 'receipt')
  exact(v, ['schemaVersion', 'outcome', 'commandId', 'teamId', 'sourceGeneration', 'revision', 'affectedTaskIds'], 'receipt')
  if (v.schemaVersion !== 1 || v.outcome !== outcome || !Array.isArray(v.affectedTaskIds)) throw new Error('Invalid receipt')
  const affectedTaskIds = v.affectedTaskIds.map(id => string(id, 'affectedTaskId', ID.task))
  if (affectedTaskIds.length > 100 || new Set(affectedTaskIds).size !== affectedTaskIds.length || affectedTaskIds.some((id, index) => index > 0 && affectedTaskIds[index - 1]! > id)) throw new Error('Invalid affectedTaskIds')
  return {
    schemaVersion: 1,
    outcome,
    commandId: string(v.commandId, 'receipt.commandId', ID.command),
    teamId: string(v.teamId, 'receipt.teamId', ID.team),
    sourceGeneration: string(v.sourceGeneration, 'receipt.sourceGeneration', ID.generation),
    revision: string(v.revision, 'receipt.revision', ID.revision),
    affectedTaskIds,
  }
}

export function decodeHostedTaskMutationTerminalResult(value: unknown): HostedTaskMutationTerminalResult {
  const v = record(value, 'mutation result')
  switch (v.kind) {
    case 'committed':
    case 'idempotent_replay': {
      exact(v, ['kind', 'currentSourceGeneration', 'payloadFingerprint', 'receipt'], v.kind)
      const receipt = decodeReceipt(v.receipt, v.kind)
      const currentSourceGeneration = string(v.currentSourceGeneration, 'currentSourceGeneration', ID.generation)
      if (receipt.sourceGeneration !== currentSourceGeneration) throw new Error('Invalid result generation binding')
      return { kind: v.kind, currentSourceGeneration, payloadFingerprint: string(v.payloadFingerprint, 'payloadFingerprint', ID.fingerprint), receipt }
    }
    case 'stale_generation':
      exact(v, ['kind', 'currentSourceGeneration'], 'stale_generation')
      return { kind: 'stale_generation', currentSourceGeneration: string(v.currentSourceGeneration, 'currentSourceGeneration', ID.generation) }
    case 'stale_revision':
      exact(v, ['kind', 'currentSourceGeneration', 'currentRevision'], 'stale_revision')
      return { kind: 'stale_revision', currentSourceGeneration: string(v.currentSourceGeneration, 'currentSourceGeneration', ID.generation), currentRevision: string(v.currentRevision, 'currentRevision', ID.revision) }
    case 'conflict': {
      if (v.reason === 'idempotency_mismatch') {
        exact(v, ['kind', 'reason', 'currentSourceGeneration'], 'idempotency conflict')
        return { kind: 'conflict', reason: 'idempotency_mismatch', currentSourceGeneration: string(v.currentSourceGeneration, 'currentSourceGeneration', ID.generation) }
      }
      if (v.reason === 'state_conflict') {
        exact(v, ['kind', 'reason', 'currentSourceGeneration', 'currentRevision'], 'state conflict')
        return { kind: 'conflict', reason: 'state_conflict', currentSourceGeneration: string(v.currentSourceGeneration, 'currentSourceGeneration', ID.generation), currentRevision: string(v.currentRevision, 'currentRevision', ID.revision) }
      }
      if (v.reason === 'relationship_conflict') {
        const hasRevision = Object.hasOwn(v, 'currentRevision')
        exact(v, ['kind', 'reason', 'currentSourceGeneration', ...(hasRevision ? ['currentRevision'] : [])], 'relationship conflict')
        return { kind: 'conflict', reason: 'relationship_conflict', currentSourceGeneration: string(v.currentSourceGeneration, 'currentSourceGeneration', ID.generation), ...(hasRevision ? { currentRevision: string(v.currentRevision, 'currentRevision', ID.revision) } : {}) }
      }
      throw new Error('Invalid conflict reason')
    }
    case 'not_found': exact(v, ['kind'], 'not_found'); return { kind: 'not_found' }
    case 'unsafe_active': exact(v, ['kind'], 'unsafe_active'); return { kind: 'unsafe_active' }
    case 'unavailable': {
      const hasRetry = Object.hasOwn(v, 'retryAfterMs')
      exact(v, ['kind', ...(hasRetry ? ['retryAfterMs'] : [])], 'unavailable')
      return { kind: 'unavailable', ...(hasRetry ? { retryAfterMs: integer(v.retryAfterMs, 'retryAfterMs', 1, 3_600_000) } : {}) }
    }
    default: throw new Error('Invalid mutation result kind')
  }
}

export function fingerprintHostedTaskCommand(command: HostedTaskMutationCommand): string {
  const values: unknown[] = [command.schemaVersion, command.commandId, command.idempotencyKey, command.teamId, command.expectedSourceGeneration, command.expectedRevision, command.kind]
  switch (command.kind) {
    case 'create_task': values.push(command.subject, command.description, command.status, command.ownerId, command.column, command.order); break
    case 'update_details': values.push(command.taskId, Object.hasOwn(command, 'subject'), command.subject ?? null, Object.hasOwn(command, 'description'), command.description ?? null); break
    case 'update_owner': values.push(command.taskId, command.ownerId); break
    case 'update_status': values.push(command.taskId, command.status); break
    case 'move_task': values.push(command.taskId, command.column, command.order); break
    case 'reorder_column': values.push(command.column, command.orderedTaskIds); break
  }
  return createHash('sha256').update(JSON.stringify(values)).digest('base64url')
}

export function hostedMutationDedupeKey(command: HostedTaskMutationCommand): string {
  // Ephemeral adapter/cache key only. Durable ledger keys are domain-separated
  // SHA-256 hashes and are produced by HostedTaskMutationService.
  return `${command.teamId}\0${command.expectedSourceGeneration}\0${command.idempotencyKey}`
}

export function hostedControlGoldenRequestFixture(): Omit<HostedTaskMutationRequest, 'ownerProof'> {
  const command: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'create_task', commandId: 'command_golden-1', idempotencyKey: 'golden:create:1', teamId: `team_${'1'.repeat(32)}`, expectedSourceGeneration: 'generation_golden-1', expectedRevision: 'revision_golden-1', subject: 'Golden task', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }
  return { schemaVersion: 2, exchangeId: `task-request_${'2'.repeat(32)}`, operation: 'task_mutate', ownerBinding: { ownerAuthority: 'owner-authority_golden-1', ownerGeneration: 1, ownerSessionId: `owner-session_${'3'.repeat(32)}`, socketIdentity: { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o600 } }, authority: { actorId: 'actor-1', deploymentId: 'deployment-1', bootId: 'boot-1', restoreGeneration: 1, workspaceId: 'workspace-1', mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) }, teamId: command.teamId }, payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) } }
}
