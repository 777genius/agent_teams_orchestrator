import { z } from 'zod/v4'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  buildProcessBackendPaneId,
  getProcessBackendRuntimeState,
  parseProcessBackendPid,
} from '../../utils/swarm/processBackend.js'
import {
  cleanupTeamDirectories,
  readTeamFile,
  unregisterTeamForSessionCleanup,
} from '../../utils/swarm/teamHelpers.js'
import { clearTeammateColors } from '../../utils/swarm/teammateLayoutManager.js'
import { clearLeaderTeamName } from '../../utils/tasks.js'
import { TEAM_DELETE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  success: boolean
  message: string
  team_name?: string
}

export type Input = z.infer<InputSchema>

export const TeamDeleteTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_DELETE_TOOL_NAME,
  searchHint: 'disband a swarm team and clean up',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return ''
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return isAgentSwarmsEnabled()
  },

  async description() {
    return 'Clean up team and task directories when the swarm is complete'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  async call(_input, context) {
    const { setAppState, getAppState } = context
    const appState = getAppState()
    const teamName = appState.teamContext?.teamName

    if (teamName) {
      // Read team config to check for active members
      const teamFile = readTeamFile(teamName)
      if (teamFile) {
        // Filter out the team lead - only count non-lead members
        const nonLeadMembers = teamFile.members.filter(
          m => m.name !== TEAM_LEAD_NAME,
        )

        // A roster entry is the durable recovery handle for every runtime kind.
        // Team deletion must never erase it merely because UI activity is idle:
        // shutdown first has to confirm termination and remove the exact member.
        if (nonLeadMembers.length > 0) {
          const memberNames = nonLeadMembers.map(m => m.name).join(', ')
          return {
            data: {
              success: false,
              message: `Cannot cleanup team with ${nonLeadMembers.length} registered member(s): ${memberNames}. Use requestShutdown and wait for confirmed roster removal first.`,
              team_name: teamName,
            },
          }
        }

        // Separate truly active members from idle/dead ones
        // Members with isActive === false are idle (finished their turn or crashed)
        const activeMembers = nonLeadMembers.filter(m => m.isActive !== false)

        if (activeMembers.length > 0) {
          const memberNames = activeMembers.map(m => m.name).join(', ')
          return {
            data: {
              success: false,
              message: `Cannot cleanup team with ${activeMembers.length} active member(s): ${memberNames}. Use requestShutdown to gracefully terminate teammates first.`,
              team_name: teamName,
            },
          }
        }

        const processMembers = nonLeadMembers.filter(
          member =>
            member.backendType === 'process' ||
            member.tmuxPaneId?.trim().startsWith('process:') ||
            (typeof member.runtimePid === 'number' && member.runtimePid > 0),
        )
        for (const member of processMembers) {
          const paneId =
            member.tmuxPaneId?.trim() ||
            (member.runtimePid
              ? buildProcessBackendPaneId(member.runtimePid)
              : undefined)
          const pid = parseProcessBackendPid(paneId)
          if (!pid) {
            return {
              data: {
                success: false,
                message: `Cannot cleanup team while ${member.name}'s process identity is incomplete. Retry shutdown or inspect the preserved team record.`,
                team_name: teamName,
              },
            }
          }
          const runtimeState = await getProcessBackendRuntimeState(
            pid,
            member.agentId,
            teamName,
            {
              expectedStartedAtMs: member.processStartedAtMs,
              expectedOsIdentity: member.processOsIdentity,
              expectedOwnerToken: member.processOwnerToken,
              expectedRunId: member.processRunId,
            },
          )
          if (runtimeState === 'confirmed' || runtimeState === 'legacy_unverifiable') {
            return {
              data: {
                success: false,
                message: `Cannot cleanup team while ${member.name}'s exact process termination is unconfirmed. Retry shutdown or inspect the preserved team record.`,
                team_name: teamName,
              },
            }
          }
        }
        const uncertainMembers = nonLeadMembers.filter(member =>
          !processMembers.includes(member) &&
          !(member.tmuxPaneId && member.backendType && isPaneBackend(member.backendType)),
        )
        if (uncertainMembers.length > 0) {
          return {
            data: {
              success: false,
              message: `Cannot cleanup team while runtime termination is unconfirmed for: ${uncertainMembers.map(member => member.name).join(', ')}.`,
              team_name: teamName,
            },
          }
        }
      }

      await cleanupTeamDirectories(teamName)
      // Already cleaned — don't try again on gracefulShutdown.
      unregisterTeamForSessionCleanup(teamName)

      // Clear color assignments so new teams start fresh
      clearTeammateColors()

      // Clear leader team name so getTaskListId() falls back to session ID
      clearLeaderTeamName()

      logEvent('tengu_team_deleted', {
        team_name:
          teamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    // Clear team context and inbox from app state
    setAppState(prev => ({
      ...prev,
      teamContext: undefined,
      inbox: {
        messages: [], // Clear any queued messages
      },
    }))

    return {
      data: {
        success: true,
        message: teamName
          ? `Cleaned up directories and worktrees for team "${teamName}"`
          : 'No team name found, nothing to clean up',
        team_name: teamName,
      },
    }
  },

  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
