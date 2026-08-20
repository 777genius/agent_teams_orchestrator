import { createHash } from 'node:crypto'

import type {
  OpenCodeLaunchAttemptRequest,
  OpenCodeOpaqueIdentity,
} from './OpenCodeBridgeContractV2.js'
import {
  OpenCodeLaunchAttempt,
  type OpenCodeLaunchAttemptPorts,
  type OpenCodeLaunchAttemptInput,
  type OpenCodeLaunchAttemptResult,
} from './OpenCodeLaunchAttempt.js'
import type { OpenCodeLaunchAttemptStore } from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'
import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'

export type OpenCodeLaunchBridgeMember = {
  name: string
  memberIdentity: OpenCodeOpaqueIdentity
  prompt?: string
  effort?: string
}

/**
 * The deliberately small boundary between the command handler and the S3
 * launch runtime. Implementations own the launch-attempt store and all runtime
 * ports; the handler never reaches profile, host, proof, session, or journal
 * services on the S3 path.
 *
 * Before starting `execute`, an implementation must read its durable command
 * ledger for the exact attempt/payload pair. An unknown outcome is
 * reconciliation-only and must not result in a new OpenCode mutation.
 */
export type OpenCodeLaunchAttemptBridgePort = {
  execute(input: {
    request: OpenCodeLaunchAttemptRequest
    members: readonly OpenCodeLaunchBridgeMember[]
    runId: string
    laneId: string
    teamId: string
    projectPath: string
    selectedModel: string
    toolApprovalMode: 'auto' | 'manual'
    continuation: boolean
    requestedBudgetMs: number
    signal?: AbortSignal
    /** Remaining time on the already-running outer command deadline. */
    outerRemainingBudgetMs?: number
    /** S1-authored immutable plan identity, added only by production composition. */
    effectiveProfilePlanDigest?: string
  }): Promise<{
    snapshot: OpenCodeProvisioningSnapshot
    /** Existing bridge response projection, produced only from durable S3 outcomes. */
    data: unknown
  }>
}

export type OpenCodeBridgeCommandHandlerPorts = {
  launchAttempt: OpenCodeLaunchAttemptBridgePort
}

let installedProductionPorts: OpenCodeBridgeCommandHandlerPorts | undefined

/** Install once during production startup; tests should pass ports directly to the handler. */
function installOpenCodeLaunchAttemptPorts(
  ports: OpenCodeBridgeCommandHandlerPorts,
): void {
  if (installedProductionPorts && installedProductionPorts !== ports) {
    throw new Error('OpenCode launch-attempt production ports are already installed')
  }
  installedProductionPorts = ports
}

export function installOpenCodeLaunchAttemptPortsForTests(
  ports: OpenCodeBridgeCommandHandlerPorts,
): void {
  installOpenCodeLaunchAttemptPorts(ports)
}

export function installOpenCodeLaunchAttemptPortsForProduction(
  ports: OpenCodeBridgeCommandHandlerPorts,
): void {
  installOpenCodeLaunchAttemptPorts(ports)
}

export function getOpenCodeLaunchAttemptProductionPorts():
OpenCodeBridgeCommandHandlerPorts | undefined {
  return installedProductionPorts
}

export function resetOpenCodeLaunchAttemptProductionPortsForTests(): void {
  installedProductionPorts = undefined
}

export type OpenCodeLaunchCommandLedgerOutcome =
  | { status: 'absent' }
  | {
      status: 'completed' | 'unknown'
      snapshot: OpenCodeProvisioningSnapshot
      data: unknown
    }

export type OpenCodeLaunchAttemptBridgeDependencies = {
  /** The accepted S3 core, normally constructed with the durable store and production ports. */
  attempt: { run(input: OpenCodeLaunchAttemptInput): Promise<OpenCodeLaunchAttemptResult> }
  commandLedger: {
    read(input: {
      attemptId: string
      payloadHash: string
      generation: number
      inputDigest: string
    }): Promise<OpenCodeLaunchCommandLedgerOutcome>
  }
  projection: {
    fromDurableResult(input: {
      result: OpenCodeLaunchAttemptResult
      command: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0]
    }): Promise<{ snapshot: OpenCodeProvisioningSnapshot; data: unknown }>
  }
}

export type OpenCodeLaunchAttemptProductionComposition = Omit<
  OpenCodeLaunchAttemptBridgeDependencies,
  'attempt'
> & {
  store: OpenCodeLaunchAttemptStore
  runtimePorts: OpenCodeLaunchAttemptPorts
}

/**
 * Production startup entrypoint. This is the only supported path for binding
 * the durable core to the command handler; callers cannot install a different
 * handler after this succeeds.
 */
export function installOpenCodeLaunchAttemptProductionComposition(
  composition: OpenCodeLaunchAttemptProductionComposition,
): OpenCodeLaunchAttemptBridge {
  const bridge = OpenCodeLaunchAttemptBridge.production(composition)
  installOpenCodeLaunchAttemptPorts({ launchAttempt: bridge })
  return bridge
}

/** Production composition for the thin command-handler port. */
export class OpenCodeLaunchAttemptBridge implements OpenCodeLaunchAttemptBridgePort {
  constructor(private readonly dependencies: OpenCodeLaunchAttemptBridgeDependencies) {}

  /** Binds the accepted core to the real adapter set without exposing it to the handler. */
  static production(
    composition: OpenCodeLaunchAttemptProductionComposition,
  ): OpenCodeLaunchAttemptBridge {
    return new OpenCodeLaunchAttemptBridge({
      attempt: new OpenCodeLaunchAttempt(composition.store, composition.runtimePorts),
      commandLedger: composition.commandLedger,
      projection: composition.projection,
    })
  }

  async execute(
    input: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0],
  ): ReturnType<OpenCodeLaunchAttemptBridgePort['execute']> {
    const attempt = input.request.launchAttempt
    const inputDigest = computeOpenCodeLaunchCommandInputDigest(input)
    // This read is intentionally before construction of any profile/host/session side effect.
    const prior = await this.dependencies.commandLedger.read({
      attemptId: attempt.attemptId,
      payloadHash: attempt.payloadHash,
      generation: attempt.generation,
      inputDigest,
    })
    if (prior.status !== 'absent') {
      // Both completed and unknown are replayed from durable evidence. Unknown is never resent.
      return { snapshot: prior.snapshot, data: prior.data }
    }

    const result = await this.dependencies.attempt.run({
      request: input.request,
      members: input.members.map(member => member.memberIdentity),
      continuation: input.continuation,
      signal: input.signal,
      commandInputDigest: inputDigest,
      commandImmutableDigest: computeOpenCodeLaunchCommandImmutableDigest(input),
      requestedBudgetMs: input.outerRemainingBudgetMs ?? input.requestedBudgetMs,
    })
    return this.dependencies.projection.fromDurableResult({ result, command: input })
  }
}

/** Canonical local digest; callers cannot substitute payloadHash as authority. */
export function computeOpenCodeLaunchCommandInputDigest(
  input: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0],
): string {
  const attempt = input.request.launchAttempt
  return createHash('sha256').update(JSON.stringify({
    contractVersion: input.request.launchContractVersion,
    attemptId: attempt.attemptId,
    payloadHash: attempt.payloadHash,
    generation: attempt.generation,
    parent: attempt.parent,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    requiredMcpTools: [...attempt.requiredMcpTools],
    requireFreshRetainedHostProof: attempt.requireFreshRetainedHostProof,
    continuationToken: attempt.continuationToken ?? null,
    runId: input.runId,
    teamId: input.teamId,
    laneId: input.laneId,
    projectIdentity: normalizeOpenCodeProjectIdentity(input.projectPath),
    selectedModel: input.selectedModel,
    toolApprovalMode: input.toolApprovalMode,
    continuation: input.continuation,
    requestedBudgetMs: input.requestedBudgetMs,
    effectiveProfilePlanDigest: input.effectiveProfilePlanDigest ?? null,
    members: input.members.map(member => ({
      memberIdentity: member.memberIdentity,
      name: member.name,
      prompt: member.prompt ?? null,
      effort: member.effort ?? null,
    })),
  })).digest('hex')
}

export function computeOpenCodeLaunchCommandImmutableDigest(
  input: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0],
): string {
  const attempt = input.request.launchAttempt
  return createHash('sha256').update(JSON.stringify({
    contractVersion: input.request.launchContractVersion,
    attemptId: attempt.attemptId,
    payloadHash: attempt.payloadHash,
    parent: attempt.parent,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    requiredMcpTools: [...attempt.requiredMcpTools],
    requireFreshRetainedHostProof: attempt.requireFreshRetainedHostProof,
    runId: input.runId,
    teamId: input.teamId,
    laneId: input.laneId,
    projectIdentity: normalizeOpenCodeProjectIdentity(input.projectPath),
    selectedModel: input.selectedModel,
    toolApprovalMode: input.toolApprovalMode,
    requestedBudgetMs: input.requestedBudgetMs,
    effectiveProfilePlanDigest: input.effectiveProfilePlanDigest ?? null,
    members: input.members.map(member => ({
      memberIdentity: member.memberIdentity,
      name: member.name,
      prompt: member.prompt ?? null,
      effort: member.effort ?? null,
    })),
  })).digest('hex')
}
