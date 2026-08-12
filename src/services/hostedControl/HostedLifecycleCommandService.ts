import { isDeepStrictEqual } from 'node:util'
import type {
  HostedLifecycleAuthority,
  HostedLifecycleCommandPort,
  HostedLifecycleOwnerEffectFence,
  HostedLifecycleOperation,
} from './HostedControlDispatcher.js'

const ACTIONS = ['launch', 'cancel', 'stop', 'recover'] as const
const CONFLICT_REASONS = [
  'authorization_changed',
  'boot_changed',
  'command_in_progress',
  'grant_revoked',
  'idempotency_conflict',
  'idempotency_mismatch',
  'stale_revision',
  'stale_run',
] as const

type LifecycleAction = (typeof ACTIONS)[number]
type ConflictReason = (typeof CONFLICT_REASONS)[number]
type LifecycleContext = {
  actorId: string
  sessionId: string
  deploymentId: string
  bootId: string
  requestId: string
  authorizedScope: string
  deadlineAtMs: number
}
type LifecycleCommand = {
  schemaVersion: 1
  action: LifecycleAction
  commandId: string
  idempotencyKey: string
  workspaceId: string
  teamId: string
  expectedRevision: string
  runId?: string
}
type LifecycleAuthorization = {
  grantId: string
  authorizationGeneration: string
  deploymentId: string
  bootId: string
  resourceRevision: string
  actorId: string
  workspaceId: string
  teamId: string
  restoreGeneration: number
  mountGeneration: number
  ownerEffectFence: HostedLifecycleOwnerEffectFence
}

export type HostedLifecycleAuthorizationDecision =
  | { kind: 'authorized'; authorization: LifecycleAuthorization }
  | { kind: 'conflict'; reason: ConflictReason; currentRevision: string | null }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; retryAfterMs: number | null }

export type HostedLifecycleRevalidationDecision =
  | { kind: 'valid'; authorization: LifecycleAuthorization }
  | Exclude<HostedLifecycleAuthorizationDecision, { kind: 'authorized' }>

export type HostedLifecycleExecutionDecision =
  | {
      kind: 'result'
      authorization: LifecycleAuthorization
      result: Record<string, unknown>
    }
  | { kind: 'unavailable'; retryAfterMs: number | null }
  | { kind: 'not_started' | 'started' | 'operator_required' | 'idempotency_mismatch'; durableCommand: Record<string, unknown> }
  | { kind: 'settled'; durableCommand: Record<string, unknown>; result: Record<string, unknown>; authorization: LifecycleAuthorization }

export type HostedLifecycleReleaseDecision =
  | { kind: 'released' | 'already_released' | 'operator_required'; authorization?: LifecycleAuthorization }
  | { kind: 'unavailable'; retryAfterMs: number | null }

/**
 * The process owner must implement this port. In particular, execute must perform its revision
 * comparison and external lifecycle effect as one authority-owned compare-and-commit operation.
 */
export interface HostedLifecycleAuthorityEffectPort {
  getControlState(input: {
    request: { schemaVersion: 1; workspaceId: string; teamId: string }
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<Record<string, unknown>>
  prepareProvisioning?(input: {
    request: { schemaVersion: 1; workspaceId: string; teamId: string }
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<Record<string, unknown>>
  getProvisioningStatus?(input: {
    request: { schemaVersion: 1; workspaceId: string; teamId: string }
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<Record<string, unknown>>
  authorize(input: {
    command: LifecycleCommand
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleAuthorizationDecision>
  revalidate(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleRevalidationDecision>
  execute(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    durableCommand: Record<string, unknown>
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleExecutionDecision>
  replayLookup?(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    durableCommand: Record<string, unknown>
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleExecutionDecision>
  release(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleReleaseDecision>
}

export interface HostedLifecycleAuthorityGuard {
  isCurrent(authority: HostedLifecycleAuthority): boolean | Promise<boolean>
}

/** Strict hosted-wire adapter. It deliberately cannot construct a desktop lifecycle owner. */
export class HostedLifecycleCommandService implements HostedLifecycleCommandPort {
  constructor(
    private readonly effects: HostedLifecycleAuthorityEffectPort,
    private readonly guard: HostedLifecycleAuthorityGuard,
    private readonly now: () => number = Date.now,
  ) {
    for (const method of ['getControlState', 'authorize', 'revalidate', 'execute', 'release'] as const) {
      if (typeof effects[method] !== 'function') {
        throw new TypeError(`Hosted lifecycle authority effect ${method} is not installed`)
      }
    }
  }

  async dispatch(input: {
    operation: HostedLifecycleOperation
    payload: Record<string, unknown>
    authority: HostedLifecycleAuthority
  }): Promise<{ payload: Record<string, unknown>; resourceRevision: string | null }> {
    const context = lifecycleContext(input.payload.context)
    if (!(await this.#requestCurrent(context, input.authority))) {
      return unavailable(input.operation)
    }
    if (isQueryOperation(input.operation)) {
      const request = controlStateRequest(input.payload.request, input.authority)
      const method = input.operation === 'control_state' ? this.effects.getControlState :
        input.operation === 'prepare' || input.operation === 'prepare_provisioning' ? this.effects.prepareProvisioning :
          this.effects.getProvisioningStatus
      let payload = method ? await method.call(this.effects, { request, context, authority: input.authority }) :
        { schemaVersion: 1, kind: 'unavailable', retryAfterMs: null }
      if (input.operation === 'get_status' && payload.kind === 'provisioning_status') {
        payload = { ...payload, kind: 'status' }
      }
      if (!(await this.#requestCurrent(context, input.authority))) return unavailable(input.operation)
      return { payload, resourceRevision: revisionFrom(payload) }
    }

    const command = lifecycleCommand(input.payload.command, input.authority)
    if (input.operation === 'authorize') {
      const decision = await this.effects.authorize({ command, context, authority: input.authority })
      if (!(await this.#requestCurrent(context, input.authority))) return unavailable(input.operation)
      return decisionResult(decision)
    }

    const authorization = lifecycleAuthorization(input.payload.authorization, command, input.authority)
    if (input.operation === 'revalidate') {
      const decision = await this.effects.revalidate({ command, authorization, context, authority: input.authority })
      if (!(await this.#requestCurrent(context, input.authority))) return unavailable(input.operation)
      return decisionResult(decision)
    }
    if (input.operation === 'release') {
      const decision = await this.effects.release({ command, authorization, context, authority: input.authority })
      if ((decision.kind !== 'released' && decision.kind !== 'already_released' &&
        decision.kind !== 'operator_required') || !(await this.#requestCurrent(context, input.authority))) {
        return unavailable(input.operation)
      }
      return decisionResult({ ...decision, authorization })
    }

    const durableCommand = exactRecord(input.payload.durableCommand,
      ['schemaVersion', 'commandFingerprint', 'idempotency', 'resource'], 'durable command')
    if (input.operation === 'replay_lookup') {
      const lookup = this.effects.replayLookup
      const decision = lookup ? await lookup.call(this.effects, {
        command, authorization, durableCommand, context, authority: input.authority,
      }) : { kind: 'not_started' as const, durableCommand }
      if (!(await this.#requestCurrent(context, input.authority))) return unavailable(input.operation)
      return decisionResult(decision)
    }

    // The explicit wire revalidate is useful to the caller, but execution gets a fresh fence too.
    const fresh = await this.effects.revalidate({ command, authorization, context, authority: input.authority })
    if (fresh.kind !== 'valid' || !isDeepStrictEqual(fresh.authorization, authorization) ||
      !(await this.#requestCurrent(context, input.authority))) {
      return unavailable(input.operation)
    }
    const decision = await this.effects.execute({ command, authorization, durableCommand, context, authority: input.authority })
    if (!(await this.#requestCurrent(context, input.authority))) return unavailable(input.operation)
    // Older owner adapters returned `result`; preserve that in-process port while
    // emitting only the canonical durable `settled` wire shape.
    return decisionResult(decision.kind === 'result'
      ? { ...decision, kind: 'settled', durableCommand }
      : decision)
  }

  async #requestCurrent(context: LifecycleContext, authority: HostedLifecycleAuthority): Promise<boolean> {
    return context.deadlineAtMs > this.now() && await this.guard.isCurrent(authority)
  }
}

function unavailable(operation: HostedLifecycleOperation): { payload: Record<string, unknown>; resourceRevision: null } {
  return {
    payload: { schemaVersion: isQueryOperation(operation) ? 1 : 2, kind: 'unavailable', retryAfterMs: null },
    resourceRevision: null,
  }
}

function isQueryOperation(operation: HostedLifecycleOperation): boolean {
  return operation === 'control_state' || operation === 'prepare' || operation === 'get_status' ||
    operation === 'prepare_provisioning' || operation === 'get_provisioning_status'
}

function decisionResult(
  decision: HostedLifecycleAuthorizationDecision | HostedLifecycleRevalidationDecision |
    HostedLifecycleExecutionDecision | HostedLifecycleReleaseDecision | Record<string, unknown>,
): { payload: Record<string, unknown>; resourceRevision: string | null } {
  const payload = { schemaVersion: 2, ...decision } as Record<string, unknown>
  const authorization = 'authorization' in decision ? decision.authorization : null
  const resourceRevision = authorization && typeof authorization === 'object' && 'resourceRevision' in authorization ?
    authorization.resourceRevision as string :
    ('currentRevision' in decision &&
      (typeof decision.currentRevision === 'string' || decision.currentRevision === null)
      ? decision.currentRevision : durableDecisionRevision(decision))
  return { payload, resourceRevision }
}

function durableDecisionRevision(decision: Record<string, unknown>): string | null {
  if (!('durableCommand' in decision)) return null
  const durableCommand = objectRecord(decision.durableCommand, 'durable command')
  const resource = objectRecord(durableCommand.resource, 'durable resource')
  return pattern(resource.expectedRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'expectedRevision')
}

function lifecycleContext(value: unknown): LifecycleContext {
  const record = exactRecord(value, [
    'actorId', 'sessionId', 'deploymentId', 'bootId', 'requestId', 'authorizedScope', 'deadlineAtMs',
  ], 'context')
  return {
    actorId: nonEmpty(record.actorId, 'actorId'),
    sessionId: nonEmpty(record.sessionId, 'sessionId'),
    deploymentId: nonEmpty(record.deploymentId, 'deploymentId'),
    bootId: nonEmpty(record.bootId, 'bootId'),
    requestId: nonEmpty(record.requestId, 'requestId'),
    authorizedScope: nonEmpty(record.authorizedScope, 'authorizedScope'),
    deadlineAtMs: nonNegativeInteger(record.deadlineAtMs, 'deadlineAtMs'),
  }
}

function controlStateRequest(value: unknown, authority: HostedLifecycleAuthority) {
  const record = exactRecord(value, ['schemaVersion', 'workspaceId', 'teamId'], 'control state request')
  if (record.schemaVersion !== 1 || record.workspaceId !== authority.workspaceId || record.teamId !== authority.teamId) {
    throw new TypeError('Invalid hosted lifecycle control state scope')
  }
  return { schemaVersion: 1 as const, workspaceId: authority.workspaceId, teamId: authority.teamId }
}

function lifecycleCommand(value: unknown, authority: HostedLifecycleAuthority): LifecycleCommand {
  const record = objectRecord(value, 'command')
  const action = record.action
  if (!ACTIONS.includes(action as LifecycleAction)) throw new TypeError('Invalid hosted lifecycle action')
  const keys = action === 'launch'
    ? ['schemaVersion', 'action', 'commandId', 'idempotencyKey', 'workspaceId', 'teamId', 'expectedRevision']
    : ['schemaVersion', 'action', 'commandId', 'idempotencyKey', 'workspaceId', 'teamId', 'expectedRevision', 'runId']
  exactKeys(record, keys, 'command')
  if (record.schemaVersion !== 1 || record.workspaceId !== authority.workspaceId || record.teamId !== authority.teamId) {
    throw new TypeError('Invalid hosted lifecycle command scope')
  }
  const command: LifecycleCommand = {
    schemaVersion: 1,
    action: action as LifecycleAction,
    commandId: pattern(record.commandId, /^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'commandId'),
    idempotencyKey: pattern(record.idempotencyKey, /^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'idempotencyKey'),
    workspaceId: authority.workspaceId,
    teamId: authority.teamId,
    expectedRevision: pattern(record.expectedRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'expectedRevision'),
  }
  if (action !== 'launch') command.runId = pattern(record.runId, /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/, 'runId')
  return command
}

function lifecycleAuthorization(
  value: unknown,
  command: LifecycleCommand,
  authority: HostedLifecycleAuthority,
): LifecycleAuthorization {
  const record = exactRecord(value, [
    'grantId', 'authorizationGeneration', 'deploymentId', 'bootId', 'resourceRevision',
    'actorId', 'workspaceId', 'teamId', 'restoreGeneration', 'mountGeneration', 'ownerEffectFence',
  ], 'authorization')
  const parsed = {
    grantId: pattern(record.grantId, /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'grantId'),
    authorizationGeneration: pattern(record.authorizationGeneration, /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'authorizationGeneration'),
    deploymentId: nonEmpty(record.deploymentId, 'deploymentId'),
    bootId: nonEmpty(record.bootId, 'bootId'),
    resourceRevision: pattern(record.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'resourceRevision'),
    actorId: nonEmpty(record.actorId, 'actorId'),
    workspaceId: nonEmpty(record.workspaceId, 'workspaceId'),
    teamId: nonEmpty(record.teamId, 'teamId'),
    restoreGeneration: nonNegativeInteger(record.restoreGeneration, 'restoreGeneration'),
    mountGeneration: positiveInteger(record.mountGeneration, 'mountGeneration'),
    ownerEffectFence: ownerEffectFence(record.ownerEffectFence),
  }
  if (parsed.actorId !== authority.actorId || parsed.workspaceId !== command.workspaceId ||
    parsed.teamId !== command.teamId || parsed.deploymentId !== authority.deploymentId ||
    parsed.bootId !== authority.bootId || parsed.restoreGeneration !== authority.restoreGeneration ||
    parsed.mountGeneration !== authority.mountGeneration ||
    !isDeepStrictEqual(parsed.ownerEffectFence, authority.ownerEffectFence) ||
    parsed.resourceRevision !== command.expectedRevision) {
    throw new TypeError('Invalid hosted lifecycle authorization scope')
  }
  return parsed
}

function revisionFrom(payload: Record<string, unknown>): string | null {
  if (payload.kind === 'not_found' || payload.kind === 'unavailable') return null
  return pattern(payload.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'resourceRevision')
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${field}`)
  return value as Record<string, unknown>
}
function exactRecord(value: unknown, keys: string[], field: string): Record<string, unknown> {
  const record = objectRecord(value, field)
  exactKeys(record, keys, field)
  return record
}
function exactKeys(record: Record<string, unknown>, keys: string[], field: string): void {
  const actual = Reflect.ownKeys(record)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError(`Invalid hosted lifecycle ${field} keys`)
  }
}
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Invalid ${field}`)
  return value
}
function pattern(value: unknown, regex: RegExp, field: string): string {
  const parsed = nonEmpty(value, field)
  if (!regex.test(parsed)) throw new TypeError(`Invalid ${field}`)
  return parsed
}
function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`Invalid ${field}`)
  return value as number
}
function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field)
  if (parsed < 1) throw new TypeError(`Invalid ${field}`)
  return parsed
}
function ownerEffectFence(value: unknown): HostedLifecycleOwnerEffectFence {
  const record = exactRecord(value, ['grantRevision', 'identityChecksum'], 'owner effect fence')
  return {
    grantRevision: pattern(record.grantRevision, /^[0-9a-f]{64}$/, 'grantRevision'),
    identityChecksum: pattern(record.identityChecksum, /^[0-9a-f]{64}$/, 'identityChecksum'),
  }
}
