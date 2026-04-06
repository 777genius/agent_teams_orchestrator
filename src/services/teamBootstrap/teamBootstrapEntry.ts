import { rm } from 'fs/promises'
import type { StructuredIO } from 'src/cli/structuredIO.js'
import type { Command } from 'src/commands.js'
import type { AppState } from 'src/state/AppState.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { Tools } from 'src/Tool.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { buildTeamBootstrapContext } from './teamBootstrapContext.js'
import { TeamBootstrapProgressEmitter } from './teamBootstrapEvents.js'
import { assertDeterministicBootstrapNotDisabled } from './teamBootstrapFeatureGate.js'
import { runTeamBootstrap } from './teamBootstrapRunner.js'
import { readBoundRegularUtf8File } from './teamBootstrapBoundFileRead.js'
import { readTeamBootstrapSpec } from './teamBootstrapSpec.js'
import { TeamBootstrapStateStore } from './teamBootstrapStateStore.js'

const MAX_BOOTSTRAP_USER_PROMPT_BYTES = 256 * 1024

async function consumeBootstrapSpecFile(specPath: string): Promise<void> {
  try {
    await rm(specPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return
    }
    throw new Error(
      `deterministic bootstrap could not consume the bootstrap spec file: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function readBootstrapUserPromptFile(promptFilePath: string): Promise<string> {
  return readBoundRegularUtf8File({
    filePath: promptFilePath,
    maxBytes: MAX_BOOTSTRAP_USER_PROMPT_BYTES,
    messages: {
      notRegular:
        'team bootstrap user prompt file must be a regular file and must not be a symlink',
      oversized: 'team bootstrap user prompt file is too large',
      invalid:
        'team bootstrap user prompt file changed while being validated or could not be read safely',
    },
  })
}

function assertBootstrapFeatureEnabled(): void {
  assertDeterministicBootstrapNotDisabled()
  if (process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP !== '1') {
    throw new Error(
      'deterministic team bootstrap requires CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1',
    )
  }
}

export async function runStartupTeamBootstrap(params: {
  specPath: string
  userPromptFilePath?: string
  structuredIO: StructuredIO
  commands: Command[]
  tools: Tools
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt?: string
  appendSystemPrompt?: string
  thinkingConfig?: ThinkingConfig
}): Promise<void> {
  assertBootstrapFeatureEnabled()
  const request = await readTeamBootstrapSpec(params.specPath)
  const context = buildTeamBootstrapContext({
    commands: params.commands,
    tools: params.tools,
    mcpClients: params.mcpClients,
    agents: params.agents,
    getAppState: params.getAppState,
    setAppState: params.setAppState,
    customSystemPrompt: params.customSystemPrompt,
    appendSystemPrompt: params.appendSystemPrompt,
    thinkingConfig: params.thinkingConfig,
    structuredIO: params.structuredIO,
  })
  const emitter = new TeamBootstrapProgressEmitter(
    params.structuredIO,
    request.runId,
    request.teamName,
  )
  const result = await runTeamBootstrap({
    request,
    context,
    emit: emitter,
    onInitialized: async () => {
      await consumeBootstrapSpecFile(params.specPath)
    },
  })
  if (!result.ok && result.fatal) {
    throw new Error(result.error)
  }
  if (params.userPromptFilePath) {
    const prompt = await readBootstrapUserPromptFile(params.userPromptFilePath)
    if (prompt.trim().length > 0) {
      const markedUnknown =
        await TeamBootstrapStateStore.updateRealTaskSubmissionState({
          teamName: request.teamName,
          runId: request.runId,
          state: 'unknown',
          detail: 'runtime is preparing the first real user task',
        })
      if (!markedUnknown) {
        throw new Error(
          'deterministic bootstrap could not persist pre-submission state for the first real task',
        )
      }
      params.structuredIO.prependUserMessage(prompt)
      const markedSubmitted =
        await TeamBootstrapStateStore.updateRealTaskSubmissionState({
          teamName: request.teamName,
          runId: request.runId,
          state: 'submitted',
          detail: 'runtime queued the first real user task',
        })
      if (!markedSubmitted) {
        throw new Error(
          'deterministic bootstrap could not persist first-task submission state',
        )
      }
    }
    await rm(params.userPromptFilePath, { force: true }).catch(() => {})
  }
}
