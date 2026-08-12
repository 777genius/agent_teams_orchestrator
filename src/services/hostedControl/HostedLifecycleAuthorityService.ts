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
  HostedLifecycleAuthorityWal,
  type HostedLifecycleDurableAuthorization,
  type HostedLifecycleDurableBinding,
  type HostedLifecycleDurableCommand,
  type HostedLifecycleWalState,
} from './HostedLifecycleAuthorityWal.js'
import {
  HostedLifecycleProviderRegistry,
  type HostedLifecycleOwnerResolution,
} from './HostedLifecycleProviderRegistry.js'
import { createHostedLifecycleSnapshot } from './HostedLifecycleSnapshot.js'

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

export type HostedLifecycleAuthorityServiceOptions = {
  workspaceId: string
  teamId: string
  deploymentId: string
  bootId: string
  restoreGeneration: number
  requiredScope?: string
  wal: HostedLifecycleAuthorityWal
  providers: HostedLifecycleProviderRegistry
  createId?: () => string
}

/**
 * Sole hosted lifecycle authority. Every decision and provider effect is serialized by the
 * durable team lock; provider adapters cannot be selected by callers.
 */
export class HostedLifecycleAuthorityService implements HostedLifecycleAuthorityEffectPort {
  readonly #requiredScope: string
  readonly #createId: () => string

  constructor(private readonly options: HostedLifecycleAuthorityServiceOptions) {
    this.#requiredScope = options.requiredScope ?? 'scope_team-lifecycle.write'
    this.#createId = options.createId ?? (() => randomUUID().replaceAll('-', ''))
  }

  async getControlState(input: {
    request: { schemaVersion: 1; workspaceId: string; teamId: string }
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<Record<string, unknown>> {
    if (!this.#bindingCurrent(input.context, input.authority)) return unavailablePublic()
    return (await this.#locked(async state => {
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
    })) ?? unavailablePublic()
  }

  async authorize(input: {
    command: LifecycleCommand
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleAuthorizationDecision> {
    if (!this.#bindingCurrent(input.context, input.authority)) return unavailableDecision()
    const fingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
    return (await this.#locked(async state => {
      await this.#retireStaleGrants(state)
      const prior = state.commands.get(input.command.idempotencyKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint) return conflict('idempotency_conflict', input.command.expectedRevision)
        if (prior.kind === 'started') return unavailableDecision()
        return { kind: 'authorized', authorization: prior.authorization }
      }
      const priorGrant = [...state.grants.values()].find(grant =>
        grant.command.idempotencyKey === input.command.idempotencyKey)
      if (priorGrant) {
        if (priorGrant.fingerprint !== fingerprint) {
          return conflict('idempotency_conflict', input.command.expectedRevision)
        }
        return { kind: 'authorized', authorization: priorGrant.authorization }
      }
      const existingGrant = [...state.grants.values()].find(grant =>
        !state.released.has(grant.authorization.grantId) &&
        state.commands.get(grant.command.idempotencyKey)?.kind !== 'completed')
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
    if (!this.#bindingCurrent(input.context, input.authority)) return unavailableDecision()
    const fingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
    return (await this.#locked(async state => {
      const grant = state.grants.get(input.authorization.grantId)
      const completed = state.commands.get(input.command.idempotencyKey)?.kind === 'completed'
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
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleExecutionDecision> {
    if (!this.#bindingCurrent(input.context, input.authority)) return unavailableDecision()
    const fingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
    return (await this.#locked(async state => {
      const grant = state.grants.get(input.authorization.grantId)
      if (!grant || grant.fingerprint !== fingerprint || !isDeepStrictEqual(grant.authorization, input.authorization)) {
        return unavailableDecision()
      }
      const prior = state.commands.get(input.command.idempotencyKey)
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.kind === 'started') return unavailableDecision()
        return {
          kind: 'result',
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
      await this.options.wal.append({
        schemaVersion: 1, kind: 'started', fingerprint, command: input.command,
        authorization: input.authorization,
      })
      let effect
      try {
        effect = await owner.adapter.execute({
          scope: this.#scope(),
          action: input.command.action,
          commandId: input.command.commandId,
          runId: input.command.runId ?? null,
          expectedProviderGeneration: before.providerGeneration,
        })
      } catch { return unavailableDecision() }
      if (effect.kind !== 'applied' || effect.snapshot.providerId !== owner.adapter.providerId) {
        // A started record intentionally remains ambiguous. Recovery requires an operator decision.
        return unavailableDecision()
      }
      const observedOwner = await this.options.providers.resolve(this.#scope())
      if (observedOwner.kind !== 'owned' || observedOwner.adapter.providerId !== owner.adapter.providerId ||
        !isDeepStrictEqual(observedOwner.snapshot, effect.snapshot)) return unavailableDecision()
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
        authorization: input.authorization, result,
      })
      return { kind: 'result', authorization: input.authorization, result }
    })) ?? unavailableDecision()
  }

  async release(input: {
    command: LifecycleCommand
    authorization: LifecycleAuthorization
    context: LifecycleContext
    authority: HostedLifecycleAuthority
  }): Promise<HostedLifecycleReleaseDecision> {
    if (!this.#bindingCurrent(input.context, input.authority)) return unavailableDecision()
    const decision = await this.#locked(async state => {
      const grant = state.grants.get(input.authorization.grantId)
      const fingerprint = fingerprintCommand(input.command, this.#binding(input.context, input.authority))
      if (!grant || grant.fingerprint !== fingerprint || !isDeepStrictEqual(grant.authorization, input.authorization)) {
        return unavailableDecision()
      }
      if (!state.released.has(input.authorization.grantId)) {
        await this.options.wal.append({ schemaVersion: 1, kind: 'released', grantId: input.authorization.grantId })
      }
      return { kind: 'released' as const }
    })
    return decision ?? unavailableDecision()
  }

  async #locked<T>(operation: (state: HostedLifecycleWalState) => Promise<T>): Promise<T | undefined> {
    try { return await this.options.wal.withLock(async () => operation(await this.options.wal.load())) } catch {
      return undefined
    }
  }
  async #retireStaleGrants(state: HostedLifecycleWalState): Promise<void> {
    for (const grant of state.grants.values()) {
      const authorization = grant.authorization
      if (state.released.has(authorization.grantId) ||
        authorization.deploymentId === this.options.deploymentId &&
        authorization.bootId === this.options.bootId &&
        authorization.restoreGeneration === this.options.restoreGeneration) continue
      // A grant without started evidence has no external effect to replay. Retire it
      // durably so an authorize-before-execute crash from an old incarnation cannot
      // deadlock the current owner. Started records remain operator-required ambiguity.
      if (!state.commands.has(grant.command.idempotencyKey)) {
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
    }
  }
  #bindingCurrent(context: LifecycleContext, authority: HostedLifecycleAuthority): boolean {
    return authority.workspaceId === this.options.workspaceId && authority.teamId === this.options.teamId &&
      authority.deploymentId === this.options.deploymentId && authority.bootId === this.options.bootId &&
      authority.restoreGeneration === this.options.restoreGeneration && context.actorId === authority.actorId &&
      context.deploymentId === authority.deploymentId && context.bootId === authority.bootId &&
      context.authorizedScope === this.#requiredScope
  }
}

function fingerprintCommand(command: LifecycleCommand, binding: HostedLifecycleDurableBinding): string {
  return createHash('sha256').update(JSON.stringify({ command, binding })).digest('hex')
}
function conflict(
  reason: 'authorization_changed' | 'command_in_progress' | 'grant_revoked' |
    'idempotency_conflict' | 'stale_revision' | 'stale_run',
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
