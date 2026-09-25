import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'
import type {
  HostedLifecycleAuthorityEffectPort,
  HostedLifecycleAuthorizationDecision,
  HostedLifecycleExecutionDecision,
  HostedLifecycleReleaseDecision,
  HostedLifecycleRevalidationDecision,
} from './HostedLifecycleCommandService.js'
import {
  createHostedLifecycleGrantFingerprint,
  HostedLifecycleAuthorityWal,
  type HostedLifecycleDurableAuthorization,
  type HostedLifecycleDurableBinding,
  type HostedLifecycleDurableCommand,
  type HostedLifecycleWireDurableCommand,
  type HostedLifecycleWalState,
} from './HostedLifecycleAuthorityWal.js'
import {
  HostedLifecycleProviderRegistry,
  type HostedLifecycleOwnerResolution,
} from './HostedLifecycleProviderRegistry.js'
import { createHostedLifecycleSnapshot } from './HostedLifecycleSnapshot.js'
import type { HostedLifecycleRunReservation } from './HostedLifecycleRunReservation.js'

type LifecycleContext = {
  actorId: string
  sessionId: string
  deploymentId: string
  bootId: string
  requestId: string
  authorizedScope: string
  deadlineAtMs: number
}
type LifecycleCommand = HostedLifecycleDurableCommand
type LifecycleAuthorization = HostedLifecycleDurableAuthorization
const QUERY_SCOPE = 'scope_hosted-lifecycle-control-state'
const COMMAND_SCOPE = 'scope_hosted-lifecycle-command'

export type HostedLifecycleAuthorityServiceOptions = {
  workspaceId: string
  teamId: string
  deploymentId: string
  bootId: string
  restoreGeneration: number
  requiredScope?: typeof COMMAND_SCOPE
  wal: HostedLifecycleAuthorityWal
  providers: HostedLifecycleProviderRegistry
  createId?: () => string
  /** Production composition rejects missing Product pre-reservation before WAL starts an effect. */
  requireRunReservation?: boolean
}

/**
 * Sole hosted lifecycle authority. Every decision and provider effect is serialized by the
 * durable team lock; provider adapters cannot be selected by callers.
 */
export class HostedLifecycleAuthorityService implements HostedLifecycleAuthorityEffectPort {
  readonly #createId: () => string

  constructor(private readonly options: HostedLifecycleAuthorityServiceOptions) {
    if (options.requiredScope !== undefined && options.requiredScope !== COMMAND_SCOPE) {
      throw new TypeError('Invalid hosted lifecycle command scope')
    }
    this.#createId = options.createId ?? (() => randomUUID().replaceAll('-', ''))
  }

  async getControlState(input: {
    request: { schemaVersion: 1; workspaceId: string; teamId: string }
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<Record<string, unknown>> {
    if (!this.#bindingCurrent(input.context, input.authority, QUERY_SCOPE)) return unavailablePublic()
    return (await this.#locked(state => this.getControlStateUnlocked(state))) ?? unavailablePublic()
  }

  async prepareProvisioning(input: {
    request: { schemaVersion: 1; workspaceId: string; teamId: string }
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<Record<string, unknown>> {
    const control = await this.getControlState(input)
    if (control.kind !== 'control_state') return control
    return {
      ...control,
      kind: 'prepared',
      lanes: [{ laneKey: `owner:${this.options.teamId}`, backend: 'opencode', status: 'ready' }],
    }
  }

  async getProvisioningStatus(input: {
    request: { schemaVersion: 1; workspaceId: string; teamId: string }
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<Record<string, unknown>> {
    if (!this.#bindingCurrent(input.context, input.authority, QUERY_SCOPE)) return unavailablePublic()
    return (await this.#locked(async state => {
      const owner = await this.options.providers.resolve(this.#scope())
      if (owner.kind === 'not_found') return { schemaVersion: 1, kind: 'not_found' }
      if (owner.kind === 'unavailable') return unavailablePublic()
      const snapshot = this.#snapshot(owner)
      const seenCommandIds = new Set<string>()
      const recentCommands = [...state.commands.values()].reverse().filter(entry => {
        if (entry.authorization.deploymentId !== input.authority.deploymentId ||
          entry.authorization.actorId !== input.authority.actorId || seenCommandIds.has(entry.command.commandId)) return false
        seenCommandIds.add(entry.command.commandId)
        return true
      }).slice(0, 16).map(entry => ({
        action: entry.command.action,
        commandId: entry.command.commandId,
        result: entry.kind === 'completed' ? entry.result : {
          schemaVersion: 1,
          kind: 'operator_required',
          action: entry.command.action,
          commandId: entry.command.commandId,
          workspaceId: entry.command.workspaceId,
          teamId: entry.command.teamId,
        },
      }))
      return {
        schemaVersion: 1,
        kind: 'provisioning_status',
        workspaceId: snapshot.workspaceId,
        teamId: snapshot.teamId,
        deploymentId: snapshot.deploymentId,
        bootId: snapshot.bootId,
        runId: snapshot.runId,
        resourceRevision: snapshot.resourceRevision,
        availableActions: hasAmbiguousCommand(state) ? [] : snapshot.availableActions,
        recentCommands,
      }
    })) ?? unavailablePublic()
  }

  async authorize(input: {
    command: LifecycleCommand
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleAuthorizationDecision> {
    if (!this.#bindingCurrent(input.context, input.authority, COMMAND_SCOPE)) return unavailableDecision()
    const fingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
    return (await this.#locked(async state => {
      await this.#retireStaleGrants(state, input.authority)
      const key = commandStateKey(input.command, input.authority)
      const prior = state.commands.get(key)
      if (prior) {
        if (!isDeepStrictEqual(prior.command, input.command) ||
          prior.authorization.actorId !== input.authority.actorId ||
          prior.authorization.deploymentId !== input.authority.deploymentId ||
          prior.authorization.bootId !== input.authority.bootId ||
          prior.authorization.restoreGeneration !== input.authority.restoreGeneration ||
          prior.authorization.mountGeneration !== input.authority.mountGeneration ||
          !isDeepStrictEqual(prior.authorization.ownerEffectFence, input.authority.ownerEffectFence)) {
          return conflict('idempotency_mismatch', input.command.expectedRevision)
        }
        if (prior.kind === 'started') return unavailableDecision()
        return { kind: 'authorized', authorization: prior.authorization }
      }
      const priorGrant = [...state.grants.values()].find(grant =>
        commandStateKey(grant.command, grant.authorization) === key)
      if (priorGrant) {
        if (priorGrant.fingerprint !== fingerprint) {
          return conflict('idempotency_mismatch', input.command.expectedRevision)
        }
        if (state.released.has(priorGrant.authorization.grantId)) {
          return conflict('grant_revoked', input.command.expectedRevision)
        }
        return { kind: 'authorized', authorization: priorGrant.authorization }
      }
      const existingGrant = [...state.grants.values()].find(grant =>
        !state.released.has(grant.authorization.grantId) &&
        state.commands.get(commandStateKey(grant.command, grant.authorization))?.kind !== 'completed')
      if (existingGrant) return conflict('command_in_progress', input.command.expectedRevision)
      const owner = await this.options.providers.resolve(this.#scope())
      const snapshotResult = this.#snapshotDecision(owner)
      if (snapshotResult.kind !== 'snapshot') return snapshotResult.decision
      const snapshot = snapshotResult.snapshot
      if (snapshot.resourceRevision !== input.command.expectedRevision || input.authority.resourceRevision !== input.command.expectedRevision) {
        return conflict('stale_revision', snapshot.resourceRevision)
      }
      if (input.command.action !== 'launch' && snapshot.runId !== input.command.runId) {
        return conflict('stale_run', snapshot.resourceRevision)
      }
      if (!snapshot.availableActions.includes(input.command.action)) {
        return conflict('command_in_progress', snapshot.resourceRevision)
      }
      const token = this.#createId()
      const authorization: LifecycleAuthorization = {
        grantId: `grant_${token}`,
        authorizationGeneration: `authorization-generation_${token}`,
        deploymentId: this.options.deploymentId,
        bootId: this.options.bootId,
        resourceRevision: snapshot.resourceRevision,
        actorId: input.authority.actorId,
        workspaceId: this.options.workspaceId,
        teamId: this.options.teamId,
        restoreGeneration: this.options.restoreGeneration,
        mountGeneration: input.authority.mountGeneration,
        ownerEffectFence: input.authority.ownerEffectFence,
      }
      await this.options.wal.append({
        schemaVersion: 1,
        kind: 'grant',
        fingerprint,
        command: input.command,
        binding: this.#binding(input.context, input.authority),
        authorization,
      })
      return { kind: 'authorized', authorization }
    })) ?? unavailableDecision()
  }

  async revalidate(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleRevalidationDecision> {
    if (!this.#bindingCurrent(input.context, input.authority, COMMAND_SCOPE)) return unavailableDecision()
    const fingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
    return (await this.#locked(async state => {
      const grant = state.grants.get(input.authorization.grantId)
      const completed = state.commands.get(commandStateKey(input.command, input.authorization))?.kind === 'completed'
      if (!grant || grant.fingerprint !== fingerprint || !isDeepStrictEqual(grant.authorization, input.authorization)) {
        return conflict('authorization_changed', input.command.expectedRevision)
      }
      if (state.released.has(input.authorization.grantId) && !completed) {
        return conflict('grant_revoked', input.command.expectedRevision)
      }
      if (completed) return { kind: 'valid', authorization: input.authorization }
      const owner = await this.options.providers.resolve(this.#scope())
      const snapshotResult = this.#snapshotDecision(owner)
      if (snapshotResult.kind !== 'snapshot') return snapshotResult.decision
      if (snapshotResult.snapshot.resourceRevision !== input.command.expectedRevision) {
        return conflict('stale_revision', snapshotResult.snapshot.resourceRevision)
      }
      if (input.command.action !== 'launch' && snapshotResult.snapshot.runId !== input.command.runId) {
        return conflict('stale_run', snapshotResult.snapshot.resourceRevision)
      }
      return { kind: 'valid', authorization: input.authorization }
    })) ?? unavailableDecision()
  }

  async execute(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    durableCommand: HostedLifecycleWireDurableCommand
    runReservation?: HostedLifecycleRunReservation
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleExecutionDecision> {
    if (!this.#bindingCurrent(input.context, input.authority, COMMAND_SCOPE)) return unavailableDecision()
    const fingerprint = durableFingerprint(input.durableCommand, input.command, input.authorization)
    const grantFingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
    return (await this.#locked(async state => {
      const grant = state.grants.get(input.authorization.grantId)
      if (!grant || grant.fingerprint !== grantFingerprint || !isDeepStrictEqual(grant.authorization, input.authorization)) {
        return unavailableDecision()
      }
      const prior = state.commands.get(commandStateKey(input.command, input.authorization))
      if (prior) {
        if (prior.fingerprint !== fingerprint) return { kind: 'idempotency_mismatch', durableCommand: input.durableCommand }
        if (prior.kind === 'started') return { kind: 'started', durableCommand: prior.durableCommand }
        return {
          kind: 'settled',
          durableCommand: prior.durableCommand,
          authorization: input.authorization,
          result: { ...prior.result, kind: 'idempotent_replay' },
        }
      }
      if (state.released.has(input.authorization.grantId)) return unavailableDecision()
      const owner = await this.options.providers.resolve(this.#scope())
      if (owner.kind !== 'owned') return unavailableDecision()
      const before = this.#snapshot(owner)
      // This is the final revision/run fence, under the same lock as the effect and WAL.
      if (before.resourceRevision !== input.command.expectedRevision ||
        (input.command.action !== 'launch' && before.runId !== input.command.runId) ||
        !before.availableActions.includes(input.command.action)) return unavailableDecision()
      if (input.command.action === 'launch' && this.options.requireRunReservation && !input.runReservation) {
        return unavailableDecision()
      }
      if (input.runReservation &&
        (input.command.action !== 'launch' ||
          (input.durableCommand.resource as { runId?: unknown })?.runId !== input.runReservation.runId)) {
        return unavailableDecision()
      }
      await this.options.wal.append({
        schemaVersion: 1, kind: 'started', fingerprint, command: input.command,
        durableCommand: input.durableCommand,
        authorization: input.authorization,
      })
      let effect
      try {
        effect = await owner.adapter.execute({
          scope: this.#scope(),
          action: input.command.action,
          commandId: input.command.commandId,
          idempotencyKey: input.command.idempotencyKey,
          runId: input.command.runId ?? null,
          expectedProviderGeneration: before.providerGeneration,
          runReservation: input.runReservation,
          deadlineAtMs: input.context.deadlineAtMs,
        })
      } catch { return unavailableDecision() }
      if (effect.kind !== 'applied' || effect.snapshot.providerId !== owner.adapter.providerId) {
        // A started record intentionally remains ambiguous. Recovery requires an operator decision.
        return unavailableDecision()
      }
      const observedOwner = await this.options.providers.resolve(this.#scope())
      if (observedOwner.kind !== 'owned' || observedOwner.adapter.providerId !== owner.adapter.providerId ||
        state.grants.get(input.authorization.grantId) !== grant ||
        !this.#bindingCurrent(input.context, input.authority, COMMAND_SCOPE) ||
        input.runReservation && (effect.snapshot.runId !== input.runReservation.runId ||
          observedOwner.snapshot.runId !== input.runReservation.runId) ||
        !effectConfirmedByObservation(input.command.action, before.providerGeneration,
          effect.snapshot, observedOwner.snapshot)) return unavailableDecision()
      let after
      try { after = createHostedLifecycleSnapshot({ ...this.#incarnation(), provider: observedOwner.snapshot }) } catch {
        return unavailableDecision()
      }
      if (after.resourceRevision === before.resourceRevision) return unavailableDecision()
      const resultRunId = input.command.action === 'launch' ? after.runId : input.command.runId
      if (!resultRunId) return unavailableDecision()
      const result = {
        schemaVersion: 1,
        kind: 'accepted',
        action: input.command.action,
        commandId: input.command.commandId,
        workspaceId: this.options.workspaceId,
        teamId: this.options.teamId,
        runId: resultRunId,
        // The receipt identifies the revision admitted by the final authorization fence.
        // A later control_state request exposes the post-effect provider revision.
        resourceRevision: input.authorization.resourceRevision,
      }
      await this.options.wal.append({
        schemaVersion: 1, kind: 'completed', fingerprint, command: input.command,
        durableCommand: input.durableCommand,
        authorization: input.authorization, result,
      })
      return { kind: 'settled', durableCommand: input.durableCommand, authorization: input.authorization, result }
    })) ?? unavailableDecision()
  }

  async replayLookup(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    durableCommand: HostedLifecycleWireDurableCommand
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleExecutionDecision> {
    if (!this.#bindingCurrent(input.context, input.authority, COMMAND_SCOPE)) return unavailableDecision()
    const fingerprint = durableFingerprint(input.durableCommand, input.command, input.authorization)
    return (await this.#locked(async state => {
      const entry = state.commands.get(commandStateKey(input.command, input.authorization))
      if (!entry) return { kind: 'not_started', durableCommand: input.durableCommand }
      if (entry.fingerprint !== fingerprint) return { kind: 'idempotency_mismatch', durableCommand: input.durableCommand }
      if (entry.kind === 'started') return { kind: 'started', durableCommand: entry.durableCommand }
      return {
        kind: 'settled', durableCommand: entry.durableCommand,
        authorization: entry.authorization,
        result: { ...entry.result, kind: 'idempotent_replay' },
      }
    })) ?? unavailableDecision()
  }

  async release(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleReleaseDecision> {
    if (!this.#bindingCurrent(input.context, input.authority, COMMAND_SCOPE)) return unavailableDecision()
    const decision = await this.#locked(async state => {
      const grant = state.grants.get(input.authorization.grantId)
      const fingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
      if (!grant || grant.fingerprint !== fingerprint || !isDeepStrictEqual(grant.authorization, input.authorization)) {
        return unavailableDecision()
      }
      if (state.commands.get(commandStateKey(input.command, input.authorization))?.kind === 'started') {
        return { kind: 'operator_required' as const, authorization: input.authorization }
      }
      if (!state.released.has(input.authorization.grantId)) {
        await this.options.wal.append({ schemaVersion: 1, kind: 'released', grantId: input.authorization.grantId })
      }
      return { kind: state.released.has(input.authorization.grantId) ? 'already_released' as const : 'released' as const, authorization: input.authorization }
    })
    return decision ?? unavailableDecision()
  }

  async #locked<T>(operation: (state: HostedLifecycleWalState) => Promise<T>): Promise<T | undefined> {
    try { return await this.options.wal.withLock(async () => operation(await this.options.wal.load())) } catch {
      return undefined
    }
  }
  private async getControlStateUnlocked(state: HostedLifecycleWalState): Promise<Record<string, unknown>> {
    if (hasAmbiguousCommand(state)) return unavailablePublic()
    const owner = await this.options.providers.resolve(this.#scope())
    if (owner.kind === 'not_found') return { schemaVersion: 1, kind: 'not_found' }
    if (owner.kind === 'unavailable') return unavailablePublic()
    const snapshot = this.#snapshot(owner)
    return {
      schemaVersion: 1,
      kind: 'control_state',
      workspaceId: snapshot.workspaceId,
      teamId: snapshot.teamId,
      deploymentId: snapshot.deploymentId,
      bootId: snapshot.bootId,
      runId: snapshot.runId,
      resourceRevision: snapshot.resourceRevision,
      availableActions: snapshot.availableActions,
    }
  }
  async #retireStaleGrants(state: HostedLifecycleWalState, current: HostedLifecycleAuthority): Promise<void> {
    for (const grant of state.grants.values()) {
      const authorization = grant.authorization
      if (state.released.has(authorization.grantId) ||
        authorization.deploymentId === current.deploymentId &&
        authorization.bootId === current.bootId &&
        authorization.restoreGeneration === current.restoreGeneration &&
        authorization.mountGeneration === current.mountGeneration &&
        isDeepStrictEqual(authorization.ownerEffectFence, current.ownerEffectFence)) continue
      // A grant without started evidence has no external effect to replay. Retire it
      // durably so an authorize-before-execute crash from an old incarnation cannot
      // deadlock the current owner. Started records remain operator-required ambiguity.
      if (!state.commands.has(commandStateKey(grant.command, grant.authorization))) {
        await this.options.wal.append({ schemaVersion: 1, kind: 'released', grantId: authorization.grantId })
        state.released.add(authorization.grantId)
      }
    }
  }
  #scope() { return { workspaceId: this.options.workspaceId, teamId: this.options.teamId } }
  #incarnation() {
    return {
      ...this.#scope(), deploymentId: this.options.deploymentId, bootId: this.options.bootId,
      restoreGeneration: this.options.restoreGeneration,
    }
  }
  #snapshot(owner: Extract<HostedLifecycleOwnerResolution, { kind: 'owned' }>) {
    return createHostedLifecycleSnapshot({ ...this.#incarnation(), provider: owner.snapshot })
  }
  #snapshotDecision(owner: HostedLifecycleOwnerResolution):
    | { kind: 'snapshot'; snapshot: ReturnType<typeof createHostedLifecycleSnapshot> }
    | { kind: 'decision'; decision: Exclude<HostedLifecycleAuthorizationDecision, { kind: 'authorized' }> } {
    if (owner.kind === 'not_found') return { kind: 'decision', decision: { kind: 'not_found' } }
    if (owner.kind === 'unavailable') return { kind: 'decision', decision: unavailableDecision() }
    return { kind: 'snapshot', snapshot: this.#snapshot(owner) }
  }
  #binding(context: LifecycleContext, authority: HostedLifecycleAuthority): HostedLifecycleDurableBinding {
    return {
      actorId: authority.actorId, sessionId: context.sessionId, deploymentId: authority.deploymentId,
      bootId: authority.bootId, authorizedScope: context.authorizedScope,
      restoreGeneration: authority.restoreGeneration,
      mountGeneration: authority.mountGeneration,
      ownerEffectFence: authority.ownerEffectFence,
    }
  }
  #bindingCurrent(context: LifecycleContext, authority: HostedLifecycleAuthority, requiredScope: typeof QUERY_SCOPE | typeof COMMAND_SCOPE): boolean {
    return authority.workspaceId === this.options.workspaceId && authority.teamId === this.options.teamId &&
      authority.deploymentId === this.options.deploymentId && authority.bootId === this.options.bootId &&
      authority.restoreGeneration === this.options.restoreGeneration && context.actorId === authority.actorId &&
      authority.mountGeneration >= 1 &&
      context.deploymentId === authority.deploymentId && context.bootId === authority.bootId &&
      context.authorizedScope === requiredScope
  }
}

function effectConfirmedByObservation(
  action: LifecycleCommand['action'],
  beforeGeneration: string,
  applied: HostedLifecycleProviderSnapshot,
  observed: HostedLifecycleProviderSnapshot,
): boolean {
  if (observed.providerId !== applied.providerId ||
    applied.providerGeneration === beforeGeneration || observed.providerGeneration === beforeGeneration) return false
  if (isDeepStrictEqual(observed, applied)) return true
  // A launch may complete between the adapter receipt and authority re-inspection.
  // Only the same canonical run advancing from launching to a confirmed successor is safe.
  return action === 'launch' && applied.phase === 'launching' && !applied.recoverable &&
    applied.runId !== null && observed.runId === applied.runId &&
    observed.providerGeneration !== applied.providerGeneration &&
    (observed.phase === 'running' && !observed.recoverable ||
      observed.phase === 'failed' && observed.recoverable)
}

function fingerprintCommand(command: LifecycleCommand, binding: HostedLifecycleDurableBinding): string {
  return createHostedLifecycleGrantFingerprint(command, binding)
}
function durableFingerprint(
  value: HostedLifecycleWireDurableCommand,
  command: LifecycleCommand,
  authorization: LifecycleAuthorization,
): string {
  const durable = strictObject(value, ['schemaVersion', 'commandFingerprint', 'idempotency', 'resource'])
  if (durable.schemaVersion !== 1) throw new TypeError('Invalid lifecycle durable command')
  const fingerprint = strictObject(durable.commandFingerprint, ['algorithm', 'version', 'digest'])
  const digest = fingerprint.digest
  if (fingerprint.algorithm !== 'sha256' || fingerprint.version !== 1 ||
    typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError('Invalid lifecycle durable command fingerprint')
  }
  const idempotency = strictObject(durable.idempotency,
    ['deploymentId', 'actorId', 'action', 'idempotencyKey'])
  const resource = strictObject(durable.resource, [
    'bootId', 'workspaceId', 'teamId', 'runId', 'expectedRevision', 'restoreGeneration',
    'mountGeneration', 'ownerEffectFence',
  ])
  if (idempotency.deploymentId !== authorization.deploymentId ||
    idempotency.actorId !== authorization.actorId || idempotency.action !== command.action ||
    idempotency.idempotencyKey !== command.idempotencyKey || resource.bootId !== authorization.bootId ||
    resource.workspaceId !== command.workspaceId || resource.teamId !== command.teamId ||
    (command.action === 'launch'
      ? !(resource.runId === null || typeof resource.runId === 'string' && /^run_[0-9a-f]{32}$/.test(resource.runId))
      : resource.runId !== command.runId) ||
    resource.expectedRevision !== command.expectedRevision ||
    resource.restoreGeneration !== authorization.restoreGeneration ||
    resource.mountGeneration !== authorization.mountGeneration ||
    !isDeepStrictEqual(resource.ownerEffectFence, authorization.ownerEffectFence)) {
    throw new TypeError('Invalid lifecycle durable command scope')
  }
  const expected = createHash('sha256').update(JSON.stringify([
    'agent-teams.hosted-lifecycle-command/v1', command.schemaVersion, command.action,
    command.commandId, command.idempotencyKey, command.workspaceId, command.teamId,
    command.expectedRevision, resource.runId,
    authorization.ownerEffectFence.grantRevision, authorization.ownerEffectFence.identityChecksum,
  ])).digest('hex')
  if (digest !== expected) throw new TypeError('Invalid lifecycle durable command fingerprint')
  return digest
}
function strictObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid lifecycle durable command')
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError('Invalid lifecycle durable command keys')
  }
  return record
}
function conflict(
  reason: 'authorization_changed' | 'command_in_progress' | 'grant_revoked' |
    'idempotency_mismatch' | 'stale_revision' | 'stale_run',
  currentRevision: string | null,
): Extract<HostedLifecycleAuthorizationDecision, { kind: 'conflict' }> {
  return { kind: 'conflict', reason, currentRevision }
}
function unavailableDecision(): { kind: 'unavailable'; retryAfterMs: null } {
  return { kind: 'unavailable', retryAfterMs: null }
}
function unavailablePublic(): Record<string, unknown> {
  return { schemaVersion: 1, kind: 'unavailable', retryAfterMs: null }
}
function hasAmbiguousCommand(state: HostedLifecycleWalState): boolean {
  return [...state.commands.values()].some(entry => entry.kind === 'started')
}
function commandStateKey(
  command: LifecycleCommand,
  scope: Pick<LifecycleAuthorization, 'deploymentId' | 'actorId'>,
): string {
  return `${scope.deploymentId}\0${scope.actorId}\0${command.action}\0${command.idempotencyKey}`
}
