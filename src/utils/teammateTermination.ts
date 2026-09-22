import type { AppState } from '../state/AppState.js'
import type { BackendType } from './swarm/backends/types.js'
import { ensureBackendsRegistered, getBackendByType } from './swarm/backends/registry.js'
import { isPaneBackend } from './swarm/backends/types.js'
import { killProcessBackendRuntime } from './swarm/processBackend.js'
import {
  getTeamsDir,
} from './envUtils.js'
import { readdir } from 'node:fs/promises'
import {
  readTeamFileAsync,
  removeTeammateFromTeamFileIfIdentityMatches,
  updateTeamFileAsync,
  upsertTeamMember,
} from './swarm/teamHelpers.js'

export type TeammateTerminationRetry = {
  teammateName: string
  requestId?: string
  paneId?: string
  processStartedAtMs?: number
  processOsIdentity?: string
  processOwnerToken?: string
  processRunId?: string
  spawnClaimToken?: string
  spawnClaimRunId?: string
  detail?: string
}

export async function persistTeammateTerminationRecovery(
  teamName: string,
  agentId: string,
  retry: TeammateTerminationRetry,
): Promise<void> {
  await updateTeamFileAsync(teamName, teamFile => {
    const member = teamFile.members.find(candidate => candidate.agentId === agentId)
    if (!member) return { changed: false, teamFile }
    return upsertTeamMember(teamFile, {
      ...member,
      terminationRecovery: {
        requestId: retry.requestId,
        agentId: member.agentId,
        backendType: member.backendType,
        paneId: retry.paneId ?? member.tmuxPaneId,
        processStartedAtMs: retry.processStartedAtMs ?? member.processStartedAtMs,
        processOsIdentity: retry.processOsIdentity ?? member.processOsIdentity,
        processOwnerToken: retry.processOwnerToken ?? member.processOwnerToken,
        processRunId: retry.processRunId ?? member.processRunId,
        spawnClaimToken: member.spawnClaimToken,
        spawnClaimRunId: member.spawnClaimRunId,
        detail: retry.detail,
        recordedAt: new Date().toISOString(),
      },
    })
  })
}

/** Retry a persisted failed termination without trusting volatile UI state. */
export async function retryPersistedTeammateTermination(
  teamName: string,
  agentId: string,
  options: { outsideTmux?: boolean } = {},
): Promise<boolean> {
  const member = (await readTeamFileAsync(teamName))?.members.find(
    candidate => candidate.agentId === agentId,
  )
  const recovery = member?.terminationRecovery
  if (!member || !recovery) return false
  if (
    recovery.agentId !== member.agentId ||
    recovery.paneId !== member.tmuxPaneId ||
    recovery.processStartedAtMs !== member.processStartedAtMs ||
    recovery.processOsIdentity !== member.processOsIdentity ||
    recovery.processOwnerToken !== member.processOwnerToken ||
    recovery.processRunId !== member.processRunId ||
    recovery.spawnClaimToken !== member.spawnClaimToken ||
    recovery.spawnClaimRunId !== member.spawnClaimRunId
  ) {
    return false
  }
  const paneId = recovery.paneId
  if (!paneId) return false
  const backendType = recovery.backendType as BackendType | undefined
  let terminated = false
  if (backendType === 'process' || paneId.startsWith('process:')) {
    terminated = await killProcessBackendRuntime(paneId, {
      expectedAgentId: agentId,
      teamName,
      expectedStartedAtMs: recovery.processStartedAtMs,
      expectedOwnerToken: recovery.processOwnerToken,
      expectedRunId: recovery.processRunId,
      expectedOsIdentity: recovery.processOsIdentity,
    }).catch(() => false)
  } else if (backendType && isPaneBackend(backendType)) {
    await ensureBackendsRegistered()
    terminated = Boolean(await getBackendByType(backendType).killPane(
      paneId,
      options.outsideTmux ?? true,
    ).catch(() => false))
  } else if (backendType === 'in-process' || paneId === 'in-process') {
    // A crashed prior CLI cannot own an in-memory task in this process. The
    // persisted roster generation is therefore terminal and can be removed by
    // the same identity CAS below.
    terminated = true
  }
  if (!terminated) return false
  return removeTeammateFromTeamFileIfIdentityMatches(teamName, {
    agentId,
    paneId: recovery.paneId,
    processStartedAtMs: recovery.processStartedAtMs,
    processOsIdentity: recovery.processOsIdentity,
    processOwnerToken: recovery.processOwnerToken,
    processRunId: recovery.processRunId,
    spawnClaimToken: recovery.spawnClaimToken,
    spawnClaimRunId: recovery.spawnClaimRunId,
  })
}

/** Reconcile durable termination retries left by a crashed prior session. */
export async function reconcilePersistedTeammateTerminations(): Promise<{
  attempted: number
  completed: number
}> {
  const entries = await readdir(getTeamsDir(), { withFileTypes: true }).catch(() => [])
  let attempted = 0
  let completed = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const teamName = entry.name
    const teamFile = await readTeamFileAsync(teamName)
    if (!teamFile) continue
    for (const member of teamFile.members) {
      if (!member.terminationRecovery) continue
      attempted += 1
      if (await retryPersistedTeammateTermination(teamName, member.agentId).catch(() => false)) {
        completed += 1
      }
    }
  }
  return { attempted, completed }
}

export async function readTeammateTerminationRecovery(
  teamName: string,
  agentId: string,
) {
  const { readTeamFileAsync } = await import('./swarm/teamHelpers.js')
  return (await readTeamFileAsync(teamName))?.members.find(
    member => member.agentId === agentId,
  )?.terminationRecovery ?? null
}

export async function clearPersistedTeammateTerminationRecovery(
  teamName: string,
  agentId: string,
  expectedOwnerToken?: string,
): Promise<boolean> {
  let cleared = false
  await updateTeamFileAsync(teamName, teamFile => {
    const member = teamFile.members.find(candidate => candidate.agentId === agentId)
    if (!member?.terminationRecovery) return { changed: false, teamFile }
    if (
      expectedOwnerToken !== undefined &&
      member.terminationRecovery.processOwnerToken !== expectedOwnerToken
    ) return { changed: false, teamFile }
    cleared = true
    return upsertTeamMember(teamFile, { ...member, terminationRecovery: undefined })
  })
  return cleared
}

/** Add a retry diagnostic without mutating the preserved teammate record. */
export function preserveTeammateAfterTerminationFailure(
  prev: AppState,
  retry: TeammateTerminationRetry,
): AppState {
  return {
    ...prev,
    teammateTerminationRecovery: {
      ...prev.teammateTerminationRecovery,
      [retry.teammateName]: {
        ...retry,
        recordedAt: new Date().toISOString(),
      },
    },
  }
}

export function clearTeammateTerminationRecovery(
  prev: AppState,
  teammateName: string,
): AppState {
  if (!(teammateName in prev.teammateTerminationRecovery)) return prev
  const { [teammateName]: _, ...remaining } = prev.teammateTerminationRecovery
  return { ...prev, teammateTerminationRecovery: remaining }
}
