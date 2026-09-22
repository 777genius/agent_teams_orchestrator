import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import { createAbortController } from 'src/utils/abortController.js'
import type { StructuredIO } from 'src/cli/structuredIO.js'
import type { Command } from 'src/commands.js'
import type { AppState } from 'src/state/AppState.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import type { ToolUseContext, Tools } from 'src/Tool.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'

export function buildTeamBootstrapContext(params: {
  commands: Command[]
  tools: Tools
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt?: string
  appendSystemPrompt?: string
  thinkingConfig?: ThinkingConfig
  structuredIO: StructuredIO
}): ToolUseContext {
  return {
    options: {
      commands: params.commands,
      debug: false,
      mainLoopModel:
        params.getAppState().mainLoopModelForSession ??
        params.getAppState().mainLoopModel,
      tools: params.tools,
      verbose: false,
      thinkingConfig:
        params.thinkingConfig ?? {
          type: 'adaptive',
        },
      mcpClients: params.mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: params.agents,
        allAgents: params.agents,
      },
      customSystemPrompt: params.customSystemPrompt,
      appendSystemPrompt: params.appendSystemPrompt,
      refreshTools: () => params.tools,
    },
    abortController: createAbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    getAppState: params.getAppState,
    setAppState: params.setAppState,
    setAppStateForTasks: params.setAppState,
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
}
