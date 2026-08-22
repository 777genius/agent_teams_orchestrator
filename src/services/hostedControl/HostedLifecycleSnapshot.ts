import { createHash } from 'node:crypto'

export const HOSTED_LIFECYCLE_ACTIONS = ['launch', 'cancel', 'stop', 'recover'] as const
export type HostedLifecycleAction = (typeof HOSTED_LIFECYCLE_ACTIONS)[number]
export type HostedLifecyclePhase = 'idle' | 'launching' | 'running' | 'stopping' | 'failed'

export type HostedLifecycleProviderSnapshot = {
  providerId: string
  providerGeneration: string
  phase: HostedLifecyclePhase
  runId: string | null
  recoverable: boolean
}

export type HostedLifecycleSnapshot = HostedLifecycleProviderSnapshot & {
  workspaceId: string
  teamId: string
  deploymentId: string
  bootId: string
  resourceRevision: string
  availableActions: HostedLifecycleAction[]
}

export function createHostedLifecycleSnapshot(input: {
  workspaceId: string
  teamId: string
  deploymentId: string
  bootId: string
  restoreGeneration: number
  provider: HostedLifecycleProviderSnapshot
}): HostedLifecycleSnapshot {
  assertProviderSnapshot(input.provider)
  const canonical = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    deploymentId: input.deploymentId,
    bootId: input.bootId,
    restoreGeneration: input.restoreGeneration,
    providerId: input.provider.providerId,
    providerGeneration: input.provider.providerGeneration,
    phase: input.provider.phase,
    runId: input.provider.runId,
    recoverable: input.provider.recoverable,
  }
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  return {
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    deploymentId: input.deploymentId,
    bootId: input.bootId,
    ...input.provider,
    resourceRevision: `revision_${digest}`,
    availableActions: availableActions(input.provider),
  }
}

function availableActions(snapshot: HostedLifecycleProviderSnapshot): HostedLifecycleAction[] {
  switch (snapshot.phase) {
    case 'idle': return ['launch']
    case 'launching': return ['cancel']
    case 'running': return ['stop']
    case 'stopping': return []
    case 'failed': return snapshot.recoverable ? ['recover'] : []
  }
}

function assertProviderSnapshot(value: HostedLifecycleProviderSnapshot): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.providerId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value.providerGeneration) ||
    !['idle', 'launching', 'running', 'stopping', 'failed'].includes(value.phase) ||
    (value.runId !== null && !/^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(value.runId)) ||
    typeof value.recoverable !== 'boolean') {
    throw new TypeError('Invalid hosted lifecycle provider snapshot')
  }
  if ((value.phase === 'running' || value.phase === 'stopping') && value.runId === null) {
    throw new TypeError('Active hosted lifecycle snapshot requires runId')
  }
}
