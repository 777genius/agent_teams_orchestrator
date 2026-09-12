import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostedInputHandle, StructuredIO } from 'src/cli/structuredIO.js'
import type { Command } from 'src/commands.js'
import type { AppState } from 'src/state/AppState.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { Tools } from 'src/Tool.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { buildTeamBootstrapContext } from './teamBootstrapContext.js'
import {
  NoopTeamBootstrapProgressSink,
  TeamBootstrapProgressEmitter,
} from './teamBootstrapEvents.js'
import { assertDeterministicBootstrapNotDisabled } from './teamBootstrapFeatureGate.js'
import { runTeamBootstrap } from './teamBootstrapRunner.js'
import { readBoundRegularUtf8File } from './teamBootstrapBoundFileRead.js'
import { readTeamBootstrapSpec } from './teamBootstrapSpec.js'
import { TeamBootstrapStateStore } from './teamBootstrapStateStore.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import {
  assertHostedNativeRuntimeSelection,
  publishHostedNativeReady,
  readHostedNativeLaunchInputSnapshot,
  startHostedNativeLeadMailboxPump,
  type HostedNativeLaunchEnvelope,
} from './hostedNativeLaunch.js'
import { createHostedMailboxShutdownHandler } from './hostedMailboxShutdown.js'
import { admitHostedCanonicalAuthorityAtStartup } from './hostedCanonicalAuthorityStartup.js'

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

async function parseRetainedHostedBootstrapSpec(specText: string) {
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'hosted-bootstrap-spec-'))
  const snapshotPath = join(snapshotRoot, 'spec.json')
  try {
    await writeFile(snapshotPath, specText, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return await readTeamBootstrapSpec(snapshotPath)
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true })
  }
}

function assertBootstrapFeatureEnabled(): void {
  assertDeterministicBootstrapNotDisabled()
}

export async function resolveStartupTeamBootstrapInputs(params: {
  specPath: string
  userPromptFilePath?: string
  hostedNativeLaunchPath?: string
  hostedNativeLaunchIdentity?: string
  admitHostedAuthority?: typeof admitHostedCanonicalAuthorityAtStartup
}): Promise<{
  request: Awaited<ReturnType<typeof readTeamBootstrapSpec>>
  hostedNativeLaunch?: HostedNativeLaunchEnvelope
  retainedHostedPrompt?: string
}> {
  if (!params.hostedNativeLaunchPath) {
    return { request: await readTeamBootstrapSpec(params.specPath) }
  }
  const snapshot = await readHostedNativeLaunchInputSnapshot(
    params.hostedNativeLaunchPath,
  )
  const hostedNativeLaunch = snapshot.envelope
  if (params.specPath !== hostedNativeLaunch.bootstrapSpecPath) {
    throw new Error('Hosted native bootstrap spec selection does not match its envelope')
  }
  if (
    params.userPromptFilePath !== undefined &&
    params.userPromptFilePath !== hostedNativeLaunch.userPromptFilePath
  ) {
    throw new Error('Hosted native user prompt selection does not match its envelope')
  }
  if (
    hostedNativeLaunch.launchIdentityToken !== params.hostedNativeLaunchIdentity
  ) {
    throw new Error('Hosted native launch identity does not match its envelope')
  }
  await (params.admitHostedAuthority ?? admitHostedCanonicalAuthorityAtStartup)(
    hostedNativeLaunch,
  )
  return {
    request: await parseRetainedHostedBootstrapSpec(snapshot.bootstrapSpecText),
    hostedNativeLaunch,
    retainedHostedPrompt: snapshot.userPromptText,
  }
}

export async function runStartupTeamBootstrap(params: {
  specPath: string
  userPromptFilePath?: string
  hostedNativeLaunchPath?: string
  hostedNativeLaunchIdentity?: string
  hostedInput?: HostedInputHandle
  onHostedNativePumpFatal?: (error: Error) => void
  isHostedNativeStopping?: () => boolean
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
}): Promise<(() => Promise<void>) | undefined> {
  assertBootstrapFeatureEnabled()
  const assertHostedNativeStarting = () => {
    if (
      params.hostedNativeLaunchPath &&
      params.isHostedNativeStopping?.()
    ) {
      throw new Error('Hosted native startup stopped')
    }
  }
  assertHostedNativeStarting()
  if (
    params.hostedNativeLaunchPath &&
    (!params.hostedInput || !params.onHostedNativePumpFatal)
  ) {
    throw new Error('Hosted native launch requires retained runtime input custody')
  }
  // Hosted resolution retains and authenticates the exact consumed input
  // snapshot before any bootstrap context or state is constructed.
  const { request, hostedNativeLaunch, retainedHostedPrompt } =
    await resolveStartupTeamBootstrapInputs(params)
  assertHostedNativeStarting()
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
  const emitter = request.emitStructuredEvents
    ? new TeamBootstrapProgressEmitter(
        params.structuredIO,
        request.runId,
        request.teamName,
      )
    : NoopTeamBootstrapProgressSink
  const result = await runTeamBootstrap({
    request,
    context,
    emit: emitter,
    hostedNativeLaunch,
    onInitialized: async () => {
      await consumeBootstrapSpecFile(
        hostedNativeLaunch?.bootstrapSpecPath ?? params.specPath,
      )
    },
  })
  assertHostedNativeStarting()
  if (!result.ok && result.fatal) {
    throw new Error(result.error)
  }
  const effectivePromptPath = hostedNativeLaunch?.userPromptFilePath ?? params.userPromptFilePath
  if (effectivePromptPath) {
    const prompt = retainedHostedPrompt ?? await readBootstrapUserPromptFile(effectivePromptPath)
    assertHostedNativeStarting()
    if (prompt.trim().length > 0) {
      const markedUnknown =
        await TeamBootstrapStateStore.updateRealTaskSubmissionState({
          teamName: request.teamName,
          runId: request.runId,
          state: 'unknown',
          detail: 'runtime is preparing the first real user task',
        })
      assertHostedNativeStarting()
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
      assertHostedNativeStarting()
      if (!markedSubmitted) {
        throw new Error(
          'deterministic bootstrap could not persist first-task submission state',
        )
      }
    }
    await rm(effectivePromptPath, { force: true }).catch(() => {})
  }
  if (hostedNativeLaunch) {
    const isStopping = params.isHostedNativeStopping ?? (() => false)
    if (isStopping()) {
      throw new Error('Hosted native startup stopped before mailbox custody')
    }
    const provider = getAPIProvider()
    const normalizedProvider = provider === 'openai'
      ? 'codex'
      : provider === 'gemini'
        ? 'gemini'
        : 'anthropic'
    const appState = params.getAppState()
    assertHostedNativeRuntimeSelection({
      envelope: hostedNativeLaunch,
      provider: normalizedProvider,
      model: appState.mainLoopModel,
      permissionMode: appState.toolPermissionContext.mode,
    })
    const pump = await startHostedNativeLeadMailboxPump({
      envelope: hostedNativeLaunch,
      hostedInput: params.hostedInput!,
      onFatalError: params.onHostedNativePumpFatal!,
      isStopping,
      processProtocolMessage: createHostedMailboxShutdownHandler({
        teamName: request.teamName,
        getAppState: params.getAppState,
        setAppState: params.setAppState,
      }),
    })
    await publishHostedNativeReady({
      envelope: hostedNativeLaunch,
      pump,
      isStopping,
    })
    if (isStopping()) {
      const stoppedError = new Error('Hosted native startup stopped after readiness')
      const settlements = await Promise.allSettled([
        rm(hostedNativeLaunch.readyAckPath, { force: true }),
        pump.stop(),
      ])
      const failures = [
        stoppedError,
        ...settlements.flatMap(settlement =>
          settlement.status === 'rejected' ? [settlement.reason] : [],
        ),
      ]
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'Hosted native cancellation cleanup did not fully settle',
        )
      }
      throw stoppedError
    }
    return pump.stop
  }
  return undefined
}
