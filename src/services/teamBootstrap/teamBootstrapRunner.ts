import * as fs from 'fs/promises'
import { getSessionId } from 'src/bootstrap/state.js'
import type { ToolUseContext } from 'src/Tool.js'
import { TeamCreateTool } from 'src/tools/TeamCreateTool/TeamCreateTool.js'
import type { DuplicateSkippedOutput } from 'src/tools/shared/spawnMultiAgent.js'
import { spawnTeammate } from 'src/tools/shared/spawnMultiAgent.js'
import { getCwd } from 'src/utils/cwd.js'
import { errorMessage } from 'src/utils/errors.js'
import { setLeaderTeamName } from 'src/utils/tasks.js'
import { assignTeammateColor } from 'src/utils/swarm/teammateLayoutManager.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
  sanitizeName,
  unregisterTeamForSessionCleanup,
  updateTeamFileAsync,
} from 'src/utils/swarm/teamHelpers.js'
import type { TeamBootstrapProgressSink } from './teamBootstrapEvents.js'
import { withBootstrapOwnershipLock } from './teamBootstrapLock.js'
import { TeamBootstrapStateStore } from './teamBootstrapStateStore.js'
import type {
  TeamBootstrapRequest,
  TeamBootstrapResult,
  TeamBootstrapSummary,
} from './teamBootstrapTypes.js'

export function shouldCreateTeamForBootstrap(params: {
  mode: TeamBootstrapRequest['mode']
  attachState: 'already_attached' | 'attached_existing' | 'missing'
  teamName: string
}): boolean {
  if (params.attachState !== 'missing') {
    return false
  }
  if (params.mode === 'launch') {
    throw new Error(
      `Deterministic bootstrap cannot launch team "${params.teamName}" because the team config does not exist.`,
    )
  }
  return true
}

export async function assertBootstrapRuntimeWorkspace(
  request: Pick<TeamBootstrapRequest, 'teamName' | 'cwd'>,
): Promise<void> {
  let runtimeCwd: string
  try {
    runtimeCwd = await fs.realpath(getCwd())
  } catch (error) {
    throw new Error(
      `Deterministic bootstrap cannot start team "${request.teamName}" because the lead runtime workspace is unavailable: ${errorMessage(error)}`,
    )
  }
  if (runtimeCwd !== request.cwd) {
    throw new Error(
      `Deterministic bootstrap cannot start team "${request.teamName}" because the runtime workspace "${runtimeCwd}" does not match the requested workspace "${request.cwd}".`,
    )
  }
}

export function deriveBootstrapTerminalStatus(params: {
  continueOnPartialFailure: boolean
  failedMembersCount: number
}): TeamBootstrapSummary['terminalStatus'] {
  if (params.failedMembersCount <= 0) {
    return 'completed'
  }
  return params.continueOnPartialFailure ? 'partial_success' : 'failed'
}

function buildStrictPartialFailureReason(params: {
  teamName: string
  failedMembers: Array<{ name: string; reason: string }>
}): string {
  const preview = params.failedMembers
    .slice(0, 3)
    .map(member => `${member.name}: ${member.reason}`)
    .join('; ')
  const suffix =
    params.failedMembers.length > 3
      ? ` (+${params.failedMembers.length - 3} more)`
      : ''
  return preview.length > 0
    ? `Deterministic bootstrap for "${params.teamName}" failed because teammate startup failed and continueOnPartialFailure=false. ${preview}${suffix}`
    : `Deterministic bootstrap for "${params.teamName}" failed because teammate startup failed and continueOnPartialFailure=false.`
}

async function ensureLeaderAttachedToTeam(
  request: TeamBootstrapRequest,
  context: ToolUseContext,
): Promise<'already_attached' | 'attached_existing' | 'missing'> {
  const currentTeamName = context.getAppState().teamContext?.teamName
  if (currentTeamName === request.teamName) {
    unregisterTeamForSessionCleanup(request.teamName)
    setLeaderTeamName(sanitizeName(request.teamName))
    return 'already_attached'
  }

  const existingTeam = await readTeamFileAsync(request.teamName)
  if (!existingTeam) {
    return 'missing'
  }

  await updateTeamFileAsync(request.teamName, teamFile => {
    const nextMembers = teamFile.members.map(member =>
      member.agentId === teamFile.leadAgentId
        ? {
            ...member,
            sessionId: getSessionId(),
            cwd: request.cwd,
          }
        : member,
    )
    const nextTeamFile = {
      ...teamFile,
      leadSessionId: getSessionId(),
      members: nextMembers,
    }
    const changed =
      nextTeamFile.leadSessionId !== teamFile.leadSessionId ||
      nextTeamFile.members.some(
        (member, index) =>
          member.sessionId !== teamFile.members[index]?.sessionId ||
          member.cwd !== teamFile.members[index]?.cwd,
      )
    return {
      changed,
      teamFile: changed ? nextTeamFile : teamFile,
    }
  })

  const refreshedTeam = (await readTeamFileAsync(request.teamName)) ?? existingTeam
  const teamFilePath = getTeamFilePath(request.teamName)
  setLeaderTeamName(sanitizeName(request.teamName))
  context.setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName: request.teamName,
      teamFilePath,
      leadAgentId: refreshedTeam.leadAgentId,
      teammates: Object.fromEntries(
        refreshedTeam.members.map(member => [
          member.agentId,
          {
            name: member.name,
            agentType: member.agentType,
            color: member.color ?? assignTeammateColor(member.agentId),
            tmuxSessionName: '',
            tmuxPaneId: member.tmuxPaneId ?? '',
            cwd: member.cwd || getCwd(),
            worktreePath: member.worktreePath,
            spawnedAt: member.joinedAt,
          },
        ]),
      ),
    },
  }))
  return 'attached_existing'
}

function buildSummary(params: {
  request: TeamBootstrapRequest
  reusedExistingTeam: boolean
  failedMembers: Array<{ name: string; reason: string }>
  registeredMembers: string[]
}): TeamBootstrapSummary {
  return {
    runId: params.request.runId,
    requestHash: params.request.requestHash,
    teamName: params.request.teamName,
    mode: params.request.mode,
    createdTeam: !params.reusedExistingTeam,
    reusedExistingTeam: params.reusedExistingTeam,
    expectedMembers: params.request.members.map(member => member.displayName),
    registeredMembers: params.registeredMembers,
    failedMembers: params.failedMembers,
    terminalStatus: deriveBootstrapTerminalStatus({
      continueOnPartialFailure: params.request.continueOnPartialFailure,
      failedMembersCount: params.failedMembers.length,
    }),
  }
}

export async function runTeamBootstrap(params: {
  request: TeamBootstrapRequest
  context: ToolUseContext
  emit: TeamBootstrapProgressSink
  onInitialized?: () => Promise<void> | void
  now?: () => number
}): Promise<TeamBootstrapResult> {
  const now = params.now ?? (() => Date.now())
  const stateStore = new TeamBootstrapStateStore(params.request, now)
  await stateStore.initialize()

  try {
    await params.onInitialized?.()
    await params.emit.started(
      params.request.members.map(member => member.displayName),
    )
    await params.emit.phaseChanged('validating_spec')
    await stateStore.transitionTo('loading_existing_state', now)
    await params.emit.phaseChanged('loading_existing_state')
    await assertBootstrapRuntimeWorkspace(params.request)
    await stateStore.transitionTo('acquiring_bootstrap_lock', now)
    await params.emit.phaseChanged('acquiring_bootstrap_lock')

    const summary = await withBootstrapOwnershipLock({
      teamName: params.request.teamName,
      runId: params.request.runId,
      requestHash: params.request.requestHash,
      ownerStartedAt: stateStore.getState().ownerStartedAt ?? now(),
      fn: async () => {
        const attachState = await ensureLeaderAttachedToTeam(
          params.request,
          params.context,
        )
        const shouldCreateTeam = shouldCreateTeamForBootstrap({
          mode: params.request.mode,
          attachState,
          teamName: params.request.teamName,
        })
        const reusedExistingTeam = !shouldCreateTeam
        if (shouldCreateTeam) {
          await stateStore.transitionTo('creating_team', now)
          await params.emit.phaseChanged('creating_team')
          await TeamCreateTool.call(
            {
              team_name: params.request.teamName,
              ...(params.request.description
                ? { description: params.request.description }
                : {}),
            },
            params.context,
          )
        }
        unregisterTeamForSessionCleanup(params.request.teamName)
        await params.emit.teamCreated(reusedExistingTeam)

        await stateStore.transitionTo('spawning_members', now)
        await params.emit.phaseChanged('spawning_members')
        const failedMembers: Array<{ name: string; reason: string }> = []

        for (const member of params.request.members) {
          await stateStore.markMemberSpawnStarted(member.displayName, now)
          await params.emit.memberSpawnStarted(member.displayName)
          try {
            const result = await spawnTeammate(
              {
                name: member.displayName,
                prompt: member.prompt,
                team_name: params.request.teamName,
                ...(member.cwd ? { cwd: member.cwd } : {}),
                ...(member.model ? { model: member.model } : {}),
                ...(member.provider ? { provider: member.provider } : {}),
                ...(member.effort ? { effort: member.effort as never } : {}),
                ...(member.agentType ? { agent_type: member.agentType } : {}),
                ...(member.description ? { description: member.description } : {}),
                ...(member.useSplitPane
                  ? { use_splitpane: member.useSplitPane }
                  : {}),
                ...(member.planModeRequired
                  ? { plan_mode_required: member.planModeRequired }
                  : {}),
              },
              params.context,
            )

            const duplicate = result.data as Partial<DuplicateSkippedOutput>
            if (duplicate.status === 'duplicate_skipped') {
              const duplicateOutcome =
                duplicate.reason === 'already_running'
                  ? 'already_running'
                  : 'duplicate_pending'
              await stateStore.markMemberResult(
                member.displayName,
                {
                  status: 'registered',
                  agentId: duplicate.agent_id,
                  failureReason: duplicate.reason,
                },
                now,
              )
              await params.emit.memberSpawnResult({
                memberName: member.displayName,
                outcome: duplicateOutcome,
                agentId: duplicate.agent_id,
                teammateId: duplicate.teammate_id,
                reason: duplicate.reason,
              })
              continue
            }

            await stateStore.markMemberResult(
              member.displayName,
              {
                status: 'registered',
                agentId: result.data.agent_id,
                backendType:
                  'backend_type' in result.data &&
                  typeof result.data.backend_type === 'string'
                    ? result.data.backend_type
                    : undefined,
              },
              now,
            )
            await params.emit.memberSpawnResult({
              memberName: member.displayName,
              outcome: 'spawned',
              agentId: result.data.agent_id,
              teammateId: result.data.teammate_id,
              backendType:
                'backend_type' in result.data &&
                typeof result.data.backend_type === 'string'
                  ? result.data.backend_type
                  : undefined,
            })
          } catch (error) {
            const reason = errorMessage(error)
            failedMembers.push({ name: member.displayName, reason })
            await stateStore.markMemberResult(
              member.displayName,
              {
                status: 'failed',
                failureReason: reason,
              },
              now,
            )
            await params.emit.memberSpawnResult({
              memberName: member.displayName,
              outcome: 'failed',
              reason,
            })
          }
        }

        await stateStore.transitionTo('auditing_truth', now)
        await params.emit.phaseChanged('auditing_truth')
        const teamFile = await readTeamFileAsync(params.request.teamName)
        const registeredMemberNames = new Set(
          (teamFile?.members ?? [])
            .map(member => member.name?.trim())
            .filter((name): name is string => Boolean(name) && name !== 'team-lead'),
        )
        for (const member of params.request.members) {
          if (registeredMemberNames.has(member.displayName)) {
            continue
          }
          const alreadyFailed = failedMembers.some(
            failed => failed.name === member.displayName,
          )
          if (alreadyFailed) {
            continue
          }
          const reason =
            'Teammate was not registered in config.json during deterministic bootstrap.'
          failedMembers.push({ name: member.displayName, reason })
          await stateStore.markMemberResult(
            member.displayName,
            {
              status: 'failed',
              failureReason: reason,
            },
            now,
          )
        }

        return buildSummary({
          request: params.request,
          reusedExistingTeam,
          failedMembers,
          registeredMembers: [...registeredMemberNames],
        })
      },
    })
    if (summary.terminalStatus === 'failed') {
      const reason = buildStrictPartialFailureReason({
        teamName: params.request.teamName,
        failedMembers: summary.failedMembers,
      })
      await stateStore.setTerminal(
        {
          status: 'failed',
          reason,
          finishedAt: now(),
        },
        now,
      )
      await params.emit.failed(reason)
      return {
        ok: false,
        fatal: true,
        error: reason,
        summary,
      }
    }

    await stateStore.setTerminal(
      {
        status: summary.terminalStatus,
        finishedAt: now(),
      },
      now,
    )
    await params.emit.completed({
      status: summary.terminalStatus,
      expectedMembers: summary.expectedMembers,
      registeredMembers: summary.registeredMembers,
      failedMembers: summary.failedMembers,
    })
    return {
      ok: true,
      fatal: false,
      summary,
    }
  } catch (error) {
    const reason = errorMessage(error)
    await stateStore.setTerminal(
      {
        status: 'failed',
        reason,
        finishedAt: now(),
      },
      now,
    )
    await params.emit.failed(reason)
    return {
      ok: false,
      fatal: true,
      error: reason,
    }
  }
}
