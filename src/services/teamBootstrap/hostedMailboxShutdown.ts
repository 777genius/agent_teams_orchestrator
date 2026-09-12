import type { AppState } from 'src/state/AppState.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isShutdownApproved } from 'src/utils/teammateMailbox.js'
import { getTeamDir, readTeamFileAtCanonicalRoot, updateTeamFileAtCanonicalRoot, withTeamFileLockAtCanonicalRoot, type TeamFile, type TeamMember } from 'src/utils/swarm/teamHelpers.js'
import { killProcessBackendRuntime } from 'src/utils/swarm/processBackend.js'
import { ensureBackendsRegistered, getBackendByType } from 'src/utils/swarm/backends/registry.js'
import { isInsideTmux } from 'src/utils/swarm/backends/detection.js'
import { isPaneBackend } from 'src/utils/swarm/backends/types.js'
import { preserveTeammateAfterTerminationFailure } from 'src/utils/teammateTermination.js'
import { captureTrustedTeammateTaskIdentity, unassignTeammateTasksWithTrustedIdentity } from 'src/utils/tasks.js'
import type { HostedNativeMailboxProtocolHandler } from './hostedNativeLaunch.js'
import { readHostedMailboxShutdownCleanupState, sameHostedMailboxShutdownIdentity, writeHostedMailboxShutdownCleanupState, type HostedMailboxShutdownCleanupState, type HostedMailboxShutdownIdentity } from './hostedMailboxShutdownCleanup.js'

function memberIdentity(member: TeamMember): HostedMailboxShutdownIdentity {
  return {
    agentId: member.agentId, joinedAt: member.joinedAt, paneId: member.tmuxPaneId,
    processStartedAtMs: member.processStartedAtMs, processOsIdentity: member.processOsIdentity,
    processOwnerToken: member.processOwnerToken, processRunId: member.processRunId,
    spawnClaimToken: member.spawnClaimToken, spawnClaimRunId: member.spawnClaimRunId,
  }
}

function advance(previous: HostedMailboxShutdownCleanupState, phase: HostedMailboxShutdownCleanupState['phase']): HostedMailboxShutdownCleanupState {
  return { ...previous, phase, updatedAt: new Date().toISOString() }
}

function recoveryPersisted(teamFile: TeamFile, agentId: string, requestId: string, expected: HostedMailboxShutdownIdentity): boolean {
  const recovery = teamFile.members.find(candidate => candidate.agentId === agentId)?.terminationRecovery
  return Boolean(recovery && recovery.requestId === requestId && recovery.agentId === expected.agentId &&
    recovery.paneId === expected.paneId && recovery.processStartedAtMs === expected.processStartedAtMs &&
    recovery.processOsIdentity === expected.processOsIdentity && recovery.processOwnerToken === expected.processOwnerToken &&
    recovery.processRunId === expected.processRunId && recovery.spawnClaimToken === expected.spawnClaimToken &&
    recovery.spawnClaimRunId === expected.spawnClaimRunId)
}

/** Handles hosted shutdown under mailbox custody; true means durable settlement. */
export function createHostedMailboxShutdownHandler(params: {
  teamName: string
  getAppState: () => AppState
  setAppState: (update: (previous: AppState) => AppState) => void
}): HostedNativeMailboxProtocolHandler {
  return async message => {
    const approval = isShutdownApproved(message.text)
    if (!approval) return false
    if (approval.from !== message.from) {
      logForDebugging(`[hosted mailbox] Ignoring shutdown approval whose claimed sender ${approval.from} does not match mailbox sender ${message.from}`)
      return true
    }
    if (params.getAppState().teamContext?.teamName !== params.teamName) return true

    const canonicalTeamRoot = getTeamDir(params.teamName)
    let state = await readHostedMailboxShutdownCleanupState({
      canonicalTeamRoot, teamName: params.teamName,
      requestId: approval.requestId, teammateName: approval.from,
    })
    if (state?.phase === 'complete') return true

    if (!state) {
      const captured = await withTeamFileLockAtCanonicalRoot(canonicalTeamRoot, params.teamName, async () => {
        const teamFile = await readTeamFileAtCanonicalRoot(canonicalTeamRoot, params.teamName)
        if (!teamFile) return null
        const candidates = teamFile.members.filter(member => member.name === message.from && member.outstandingShutdownRequestId === approval.requestId)
        if (candidates.length === 0) return null
        if (candidates.length !== 1) throw new Error('Hosted shutdown approval identity is ambiguous')
        const teammate = candidates[0]!
        const taskIdentity = await captureTrustedTeammateTaskIdentity(params.teamName, teammate.agentId, teammate.name)
        return { teammate, taskIdentity }
      })
      if (!captured) return true
      const { teammate, taskIdentity } = captured
      const persistedPaneId = teammate.tmuxPaneId?.trim()
      const messagePaneId = approval.paneId?.trim()
      if (messagePaneId !== persistedPaneId || approval.backendType !== teammate.backendType) {
        logForDebugging(`[hosted mailbox] Ignoring shutdown approval with substituted runtime binding for ${approval.from}`)
        return true
      }

      const processRuntime = approval.backendType === 'process' || Boolean(persistedPaneId?.startsWith('process:')) || Boolean(messagePaneId?.startsWith('process:'))
      let terminated = false
      let recoveryDetail: string | undefined
      if (processRuntime) {
        const identityMatches = Boolean(persistedPaneId) && messagePaneId === persistedPaneId &&
          approval.processStartedAtMs === teammate.processStartedAtMs && approval.processOsIdentity === teammate.processOsIdentity &&
          approval.processOwnerToken === teammate.processOwnerToken && approval.processRunId === teammate.processRunId
        terminated = identityMatches ? await killProcessBackendRuntime(persistedPaneId!, {
          expectedAgentId: teammate.agentId, teamName: params.teamName,
          expectedStartedAtMs: approval.processStartedAtMs, expectedOsIdentity: approval.processOsIdentity,
          expectedOwnerToken: approval.processOwnerToken, expectedRunId: approval.processRunId,
        }).catch(() => false) : false
        recoveryDetail = 'Noninteractive shutdown could not prove exact runtime termination.'
      } else if (persistedPaneId && teammate.backendType && isPaneBackend(teammate.backendType)) {
        await ensureBackendsRegistered()
        terminated = Boolean(await getBackendByType(teammate.backendType).killPane(persistedPaneId, !(await isInsideTmux())).catch(() => false))
        recoveryDetail = 'Noninteractive pane termination was not confirmed.'
      } else {
        recoveryDetail = 'Noninteractive runtime type is unavailable; termination cannot be confirmed.'
      }

      const identity = memberIdentity(teammate)
      if (!terminated) {
        const recovery = {
          teammateName: approval.from, requestId: approval.requestId, paneId: identity.paneId,
          processStartedAtMs: identity.processStartedAtMs, processOsIdentity: identity.processOsIdentity,
          processOwnerToken: identity.processOwnerToken, processRunId: identity.processRunId, detail: recoveryDetail,
        }
        const persisted = await updateTeamFileAtCanonicalRoot(canonicalTeamRoot, params.teamName, teamFile => {
          const current = teamFile.members.find(candidate => candidate.agentId === teammate.agentId)
          if (!current || !sameHostedMailboxShutdownIdentity(memberIdentity(current), identity)) {
            throw new Error('Hosted shutdown identity changed before recovery persistence')
          }
          const terminationRecovery = {
            requestId: approval.requestId, agentId: current.agentId, backendType: current.backendType,
            paneId: identity.paneId, processStartedAtMs: identity.processStartedAtMs,
            processOsIdentity: identity.processOsIdentity, processOwnerToken: identity.processOwnerToken,
            processRunId: identity.processRunId, spawnClaimToken: identity.spawnClaimToken,
            spawnClaimRunId: identity.spawnClaimRunId, detail: recoveryDetail,
            recordedAt: new Date().toISOString(),
          }
          return {
            changed: true,
            teamFile: {
              ...teamFile,
              members: teamFile.members.map(member => member === current ? { ...current, terminationRecovery } : member),
            },
          }
        })
        if (persisted.status !== 'updated') throw new Error('Hosted shutdown termination recovery update was not persisted')
        const verified = await readTeamFileAtCanonicalRoot(canonicalTeamRoot, params.teamName)
        if (!verified || !recoveryPersisted(verified, teammate.agentId, approval.requestId, identity)) {
          throw new Error('Hosted shutdown termination recovery was not durably persisted')
        }
        params.setAppState(previous => preserveTeammateAfterTerminationFailure(previous, recovery))
        return true
      }

      state = { version: 1, requestId: approval.requestId, teammateName: approval.from, identity, taskIdentity, phase: 'prepared', updatedAt: new Date().toISOString() }
      await writeHostedMailboxShutdownCleanupState({ canonicalTeamRoot, teamName: params.teamName, state })
    }

    if (state.phase === 'prepared') {
      const result = await updateTeamFileAtCanonicalRoot(canonicalTeamRoot, params.teamName, teamFile => {
        const member = teamFile.members.find(candidate => candidate.agentId === state!.identity.agentId || candidate.name === state!.teammateName)
        if (!member) return { changed: false, teamFile }
        if (!sameHostedMailboxShutdownIdentity(memberIdentity(member), state!.identity)) throw new Error('Hosted shutdown roster identity was replaced')
        return { changed: true, teamFile: { ...teamFile, members: teamFile.members.filter(candidate => candidate !== member) } }
      })
      if (result.status === 'missing') throw new Error('Hosted shutdown team config disappeared during cleanup')
      state = advance(state, 'roster_removed')
      await writeHostedMailboxShutdownCleanupState({ canonicalTeamRoot, teamName: params.teamName, state })
    }

    if (state.phase === 'roster_removed') {
      await withTeamFileLockAtCanonicalRoot(canonicalTeamRoot, params.teamName, async () => {
        const teamFile = await readTeamFileAtCanonicalRoot(canonicalTeamRoot, params.teamName)
        if (!teamFile) throw new Error('Hosted shutdown team config is unavailable during task cleanup')
        if (teamFile.members.some(member => member.agentId === state!.identity.agentId || member.name === state!.teammateName)) {
          throw new Error('Hosted shutdown task identity was replaced before cleanup')
        }
        await unassignTeammateTasksWithTrustedIdentity(params.teamName, state!.taskIdentity, 'shutdown')
      })
      state = advance(state, 'tasks_cleaned')
      await writeHostedMailboxShutdownCleanupState({ canonicalTeamRoot, teamName: params.teamName, state })
    }

    if (state.phase === 'tasks_cleaned') {
      params.setAppState(previous => {
        const teammates = previous.teamContext?.teammates
        const current = teammates?.[state!.identity.agentId]
        if (!teammates || !current) return previous
        const rosterJoinedAt = current.rosterJoinedAt
        if (typeof rosterJoinedAt !== 'number' || !Number.isSafeInteger(rosterJoinedAt) || rosterJoinedAt < 0) {
          throw new Error('Hosted shutdown AppState roster incarnation is unavailable')
        }
        if (!sameHostedMailboxShutdownIdentity({
          agentId: state!.identity.agentId, joinedAt: rosterJoinedAt, paneId: current.tmuxPaneId,
          processStartedAtMs: current.processStartedAtMs, processOsIdentity: current.processOsIdentity,
          processOwnerToken: current.processOwnerToken, processRunId: current.processRunId,
          spawnClaimToken: current.spawnClaimToken, spawnClaimRunId: current.spawnClaimRunId,
        }, state!.identity)) return previous
        const { [state!.identity.agentId]: _removed, ...remainingTeammates } = teammates
        return { ...previous, teamContext: { ...previous.teamContext!, teammates: remainingTeammates } }
      })
      state = advance(state, 'complete')
      await writeHostedMailboxShutdownCleanupState({ canonicalTeamRoot, teamName: params.teamName, state })
    }
    return true
  }
}
