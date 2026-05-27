/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  getUnifiedRuntimeStatusPayload,
} from '../../services/runtimeBackends/registry.js'
import { openCodeExecutionProbe } from '../../services/opencode/OpenCodeExecutionProbe.js'
import { openCodeHostManager } from '../../services/opencode/OpenCodeHostManager.js'
import { openCodeProvisioningProbe } from '../../services/opencode/OpenCodeProvisioningProbe.js'
import { openCodeSessionBridge } from '../../services/opencode/OpenCodeSessionBridge.js'
import { openCodeSessionStore } from '../../services/opencode/OpenCodeSessionStore.js'
import { executeOpenCodeBridgeCommandEnvelope } from '../../services/opencode/OpenCodeBridgeCommandHandler.js'
import { openCodeLedgerBridgeService } from '../../services/opencode/OpenCodeLedgerBridgeService.js'
import {
  connectProviderWithApiKey,
  connectProvider,
  forgetManagedProvider,
  loadProviderDirectory,
  loadProviderModels,
  loadProviderManagementView,
  loadProviderSetupForm,
  openCodeProviderManagementAdapter,
  setProviderDefaultModel,
  testProviderModel,
  type ConnectProviderInput,
  type ProviderConnection,
  type ProviderDirectoryFilter,
  type ProviderDirectoryView,
  type ProviderManagementError,
  type ProviderManagementResult,
  type ProviderManagementRuntimeId,
  type ProviderManagementView,
  type ProviderModelTestResult,
  type ProviderSetupForm,
  type RuntimeProviderModelsView,
} from '../../features/runtimeProviderManagement/index.js'
import type {
  RuntimeProviderId,
  RuntimeProviderStatus,
} from '../../services/runtimeBackends/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { readFile, writeFile } from 'node:fs/promises'

const STDOUT_DRAIN_FALLBACK_TIMEOUT_MS = 2_000
const STDOUT_EXIT_SETTLE_TIMEOUT_MS = 50

type RuntimeProviderTarget = RuntimeProviderId | 'all'
type RuntimeProviderManagementTarget = ProviderManagementRuntimeId
type RuntimeStdoutWrite = typeof process.stdout.write

function shouldDeferRuntimeStdoutExit(): boolean {
  return process.platform === 'win32'
}

function exitRuntimeCommand(exitCode: number): void {
  if (shouldDeferRuntimeStdoutExit()) {
    process.exitCode = exitCode
    return
  }

  process.exit(exitCode)
}

async function withRuntimeJsonStdoutGuardedResponse<T>(
  operation: () => Promise<T>,
  writeResponse: (result: T, stdoutWrite: RuntimeStdoutWrite) => Promise<number>,
  recoverOperationError?: (error: unknown) => T,
): Promise<void> {
  const originalWrite = process.stdout.write
  let stdoutRestored = false
  const restoreStdout = () => {
    if (stdoutRestored) {
      return
    }
    process.stdout.write = originalWrite
    stdoutRestored = true
  }
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) =>
    process.stderr.write(...args)) as typeof process.stdout.write
  try {
    let result: T
    try {
      result = await operation()
    } catch (error) {
      if (!recoverOperationError) {
        throw error
      }
      result = recoverOperationError(error)
    }
    const exitCode = await writeResponse(result, originalWrite)
    await new Promise(resolve => setTimeout(resolve, STDOUT_EXIT_SETTLE_TIMEOUT_MS))
    exitRuntimeCommand(exitCode)
  } finally {
    restoreStdout()
  }
}

async function withRuntimeJsonStdoutGuardedExit(
  writeResponse: (stdoutWrite: RuntimeStdoutWrite) => Promise<number>,
): Promise<void> {
  await withRuntimeJsonStdoutGuardedResponse(
    async () => undefined,
    async (_result, stdoutWrite) => writeResponse(stdoutWrite),
  )
}

function recoverProviderManagementError<T>(
  secretToRedact?: string | null,
): (error: unknown) => ProviderManagementResult<T> {
  return error => ({
    ok: false,
    error: runtimeProviderCommandExceptionError(error, secretToRedact),
  })
}

function runtimeProviderCommandExceptionError(
  error: unknown,
  secretToRedact?: string | null,
): ProviderManagementError {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = redactRuntimeProviderSecretPatterns(
    redactRuntimeSecret(rawMessage, secretToRedact),
  )
  return {
    code: 'runtime-unhealthy',
    message: `Runtime provider management command failed unexpectedly: ${message}`,
    recoverable: true,
  }
}

function redactRuntimeSecret(message: string, secretToRedact?: string | null): string {
  const secret = secretToRedact?.trim()
  if (!secret) {
    return message
  }
  return message.split(secret).join('[redacted]')
}

function redactRuntimeProviderSecretPatterns(message: string): string {
  return message
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, 'sk-...redacted')
    .replace(/\b(or-[A-Za-z0-9_-]{12,})\b/g, 'or-...redacted')
    .replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, 'AIza...redacted')
    .replace(
      /\b([a-z0-9_.-]*(?:api[-_]?key|(?:access|auth)[-_]?token|token|secret|password|[-_]key)["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi,
      '$1...redacted',
    )
    .replace(/\b(key["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted')
    .replace(/\b(bearer\s+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted')
}

const PROVIDER_DIRECTORY_FILTERS = new Set<string>([
  'all',
  'connected',
  'configured',
  'connectable',
  'manual',
  'has-models',
])

function formatValue(value: string | null | undefined, fallback = 'none'): string {
  return value && value.length > 0 ? value : fallback
}

function truncateForText(value: string | null | undefined, limit = 120): string {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'none'
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`
}

function isSensitiveFieldKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    normalized === 'key'
    || normalized.endsWith('apikey')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized === 'authorization'
    || normalized === 'cookie'
    || normalized.endsWith('clientsecret')
  )
}

function sanitizeOpenCodeVerifyValue(
  value: unknown,
  keyHint?: string,
): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeOpenCodeVerifyValue(item))
  }

  if (typeof value !== 'object') {
    return value
  }

  if (keyHint === 'env') {
    const entries = Object.entries(value as Record<string, unknown>)
    return {
      redacted: true,
      count: entries.length,
      keys: entries.map(([key]) => key).sort(),
    }
  }

  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, entryValue] of Object.entries(source)) {
    if (isSensitiveFieldKey(key)) {
      result[key] = '[redacted]'
      continue
    }
    result[key] = sanitizeOpenCodeVerifyValue(entryValue, key)
  }
  return result
}

function printProviderStatus(provider: RuntimeProviderStatus): void {
  process.stdout.write(`${provider.displayName}:\n`)
  process.stdout.write(`  authenticated: ${provider.authenticated ? 'yes' : 'no'}\n`)
  process.stdout.write(`  auth method: ${formatValue(provider.authMethod)}\n`)
  process.stdout.write(`  verification: ${provider.verificationState}\n`)
  process.stdout.write(`  selected backend: ${formatValue(provider.selectedBackendId)}\n`)
  process.stdout.write(`  resolved backend: ${formatValue(provider.resolvedBackendId)}\n`)
  process.stdout.write(`  status: ${formatValue(provider.statusMessage)}\n`)
  if (provider.detailMessage) {
    process.stdout.write(`  detail: ${provider.detailMessage}\n`)
  }
  if (provider.backend) {
    process.stdout.write(`  runtime: ${provider.backend.label}\n`)
    if (provider.backend.endpointLabel) {
      process.stdout.write(`  endpoint: ${provider.backend.endpointLabel}\n`)
    }
    if (provider.backend.projectId) {
      process.stdout.write(`  project: ${provider.backend.projectId}\n`)
    }
  }
  if (provider.availableBackends.length > 0) {
    process.stdout.write('  backends:\n')
    for (const backend of provider.availableBackends) {
      process.stdout.write(
        `    - ${backend.id}: ${backend.available ? 'ready' : 'unavailable'}${backend.recommended ? ' [recommended]' : ''}\n`,
      )
    }
  }
  if (provider.externalRuntimeDiagnostics.length > 0) {
    process.stdout.write('  diagnostics:\n')
    for (const diagnostic of provider.externalRuntimeDiagnostics) {
      process.stdout.write(
        `    - ${diagnostic.label}: ${diagnostic.detected ? 'detected' : 'missing'}\n`,
      )
    }
  }
  if (provider.models.length > 0) {
    process.stdout.write(`  models: ${provider.models.join(', ')}\n`)
  }
}

export async function runtimeStatus(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
  summary?: boolean
}): Promise<void> {
  const providerFilter =
    opts.provider && opts.provider !== 'all' ? opts.provider : undefined
  const loadPayload = () =>
    getUnifiedRuntimeStatusPayload(providerFilter, {}, {
      detailLevel: opts.summary ? 'summary' : 'full',
    })

  if (opts.text) {
    const payload = await loadPayload()
    const providerOrder: RuntimeProviderId[] = ['anthropic', 'codex', 'gemini', 'opencode']
    for (const providerId of providerOrder) {
      const provider = payload.providers[providerId]
      if (!provider) continue
      printProviderStatus(provider)
    }
  } else {
    await withRuntimeJsonStdoutGuardedResponse(
      loadPayload,
      async (payload, stdoutWrite) => {
        await writeStdoutAndDrain(jsonStringify(payload, null, 2) + '\n', stdoutWrite)
        return 0
      },
    )
    return
  }

  process.exit(0)
}

function printOpenCodeVerification(snapshot: Awaited<ReturnType<typeof openCodeProvisioningProbe.probe>>): void {
  process.stdout.write('OpenCode live verification:\n')
  process.stdout.write(`  detected: ${snapshot.detected ? 'yes' : 'no'}\n`)
  process.stdout.write(`  host healthy: ${snapshot.hostHealthy ? 'yes' : 'no'}\n`)
  process.stdout.write(`  project: ${snapshot.projectPath}\n`)
  if (snapshot.host) {
    process.stdout.write(`  host key: ${snapshot.host.hostKey}\n`)
    process.stdout.write(`  version: ${formatValue(snapshot.host.version)}\n`)
    process.stdout.write(
      `  resolved config: ${formatValue(snapshot.host.resolvedConfigFingerprint)}\n`,
    )
  }
  if (snapshot.profile) {
    process.stdout.write(`  profile root: ${snapshot.profile.profileRootKey}\n`)
    process.stdout.write(
      `  behavior fingerprint: ${snapshot.profile.projectBehaviorFingerprint}\n`,
    )
    process.stdout.write(
      `  managed config: ${snapshot.profile.managedConfigFingerprint}\n`,
    )
    process.stdout.write(
      `  behavior sources: ${snapshot.profile.behaviorSources.join(', ') || 'none'}\n`,
    )
  }
  if (snapshot.config) {
    process.stdout.write(
      `  default agent: ${formatValue(snapshot.config.default_agent)}\n`,
    )
    process.stdout.write(
      `  share mode: ${formatValue(snapshot.config.share)}\n`,
    )
    process.stdout.write(
      `  snapshot: ${String(snapshot.config.snapshot ?? 'unknown')}\n`,
    )
    process.stdout.write(
      `  autoupdate: ${String(snapshot.config.autoupdate ?? 'unknown')}\n`,
    )
  }
  process.stdout.write(
    `  connected providers: ${(snapshot.providers?.connected ?? []).join(', ') || 'none'}\n`,
  )
  process.stdout.write(
    `  config providers: ${(snapshot.configProviders?.providers ?? []).map(provider => provider.id).filter(Boolean).join(', ') || 'none'}\n`,
  )
  process.stdout.write(
    `  agents: ${snapshot.agents.map(agent => agent.name).filter(Boolean).join(', ') || 'none'}\n`,
  )
  process.stdout.write(
    `  mcp: ${Object.keys(snapshot.mcp ?? {}).join(', ') || 'none'}\n`,
  )
  if (snapshot.appMcp) {
    process.stdout.write(`  app mcp status: ${snapshot.appMcp.status}\n`)
    process.stdout.write(`  app mcp server: ${snapshot.appMcp.serverName}\n`)
    process.stdout.write(
      `  app mcp matched: ${formatValue(snapshot.appMcp.matchedServerName)}\n`,
    )
    process.stdout.write(
      `  app mcp connected: ${snapshot.appMcp.connected === null ? 'unknown' : snapshot.appMcp.connected ? 'yes' : 'no'}\n`,
    )
    process.stdout.write(
      `  app mcp source: ${formatValue(snapshot.appMcp.launchSource)}\n`,
    )
  }
  if (snapshot.host?.diagnostics.length) {
    process.stdout.write('  host diagnostics:\n')
    for (const diagnostic of snapshot.host.diagnostics) {
      process.stdout.write(`    - ${diagnostic}\n`)
    }
  }
  process.stdout.write(`  probe error: ${formatValue(snapshot.probeError)}\n`)
  if (snapshot.diagnostics.length > 0) {
    process.stdout.write('  diagnostics:\n')
    for (const diagnostic of snapshot.diagnostics) {
      process.stdout.write(`    - ${diagnostic}\n`)
    }
  }
}

function printOpenCodeModelProbe(
  result: Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>>,
): void {
  process.stdout.write('OpenCode model execution probe:\n')
  process.stdout.write(`  model: ${result.modelId}\n`)
  process.stdout.write(`  outcome: ${result.outcome}\n`)
  process.stdout.write(`  durable state: ${result.durableState}\n`)
  process.stdout.write(`  raw status: ${formatValue(result.rawStatus)}\n`)
  process.stdout.write(`  latest assistant: ${formatValue(result.latestAssistantPreview)}\n`)
  process.stdout.write(`  tool calls: ${String(result.toolCallCount)}\n`)
  process.stdout.write(`  errors: ${String(result.errorCount)}\n`)
  process.stdout.write(`  duration: ${String(result.durationMs)}ms\n`)
  process.stdout.write(`  reason: ${formatValue(result.reason)}\n`)
  if (result.diagnostics.length > 0) {
    process.stdout.write('  diagnostics:\n')
    for (const diagnostic of result.diagnostics) {
      process.stdout.write(`    - ${diagnostic}\n`)
    }
  }
}

export async function runtimeVerify(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
}): Promise<void> {
  const provider = opts.provider ?? 'all'

  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime verify is currently only implemented for OpenCode, received "${provider}"`)
  }

  const snapshot = await openCodeProvisioningProbe.probe()
  if (opts.text) {
    printOpenCodeVerification(snapshot)
  } else {
    process.stdout.write(jsonStringify({
      schemaVersion: 1,
      providerId: 'opencode',
      snapshot: sanitizeOpenCodeVerifyValue(snapshot),
    }, null, 2) + '\n')
  }

  process.exit(0)
}

export async function runtimeVerifyModel(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
  model: string
}): Promise<void> {
  const provider = opts.provider ?? 'all'

  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime verify-model is currently only implemented for OpenCode, received "${provider}"`)
  }

  const result = await openCodeExecutionProbe.probeModel({
    selectedModel: opts.model,
  })

  if (opts.text) {
    printOpenCodeModelProbe(result)
  } else {
    process.stdout.write(jsonStringify({
      schemaVersion: 1,
      providerId: 'opencode',
      result,
    }, null, 2) + '\n')
  }

  process.exit(0)
}

function printOpenCodeSessionReconcile(result: Awaited<ReturnType<typeof openCodeSessionBridge.reconcileSession>>): void {
  process.stdout.write('OpenCode session reconcile:\n')
  process.stdout.write(`  session: ${result.record.opencodeSessionId}\n`)
  process.stdout.write(`  model: ${result.record.selectedModel}\n`)
  process.stdout.write(`  outcome: ${result.summary.reconcileOutcome}\n`)
  process.stdout.write(`  raw status: ${formatValue(result.summary.rawStatus)}\n`)
  process.stdout.write(`  durable state: ${result.summary.durableState}\n`)
  process.stdout.write(`  stale reason: ${formatValue(result.summary.staleReason)}\n`)
  process.stdout.write(`  auth state: ${formatValue(result.summary.profileAuthState)}\n`)
  process.stdout.write(
    `  pending permissions: ${result.summary.pendingPermissionRequestIds.join(', ') || 'none'}\n`,
  )
  process.stdout.write(`  message count: ${result.summary.messageCount}\n`)
  process.stdout.write(`  tool calls: ${result.summary.toolCallCount}\n`)
  process.stdout.write(`  errors: ${result.summary.errorCount}\n`)
  process.stdout.write(
    `  last cursor: ${formatValue(result.record.lastCanonicalCursor)}\n`,
  )
  process.stdout.write(
    `  latest assistant: ${formatValue(result.summary.latestAssistantPreview)}\n`,
  )
  process.stdout.write(
    `  reply pending since: ${formatValue(result.summary.replyPendingSinceMessageId)}\n`,
  )
  if (result.summary.diagnostics.length > 0) {
    process.stdout.write('  diagnostics:\n')
    for (const diagnostic of result.summary.diagnostics) {
      process.stdout.write(`    - ${diagnostic}\n`)
    }
  }
}

function printOpenCodeSessionTranscript(result: Awaited<ReturnType<typeof openCodeSessionBridge.reconcileSession>>): void {
  process.stdout.write('OpenCode session transcript:\n')
  process.stdout.write(`  session: ${result.record.opencodeSessionId}\n`)
  process.stdout.write(`  model: ${result.record.selectedModel}\n`)
  process.stdout.write(`  durable state: ${result.summary.durableState}\n`)
  process.stdout.write(`  message count: ${result.summary.messageCount}\n`)
  process.stdout.write(`  tool calls: ${result.summary.toolCallCount}\n`)
  process.stdout.write(`  errors: ${result.summary.errorCount}\n`)
  process.stdout.write('\n')

  for (const message of result.summary.messages) {
    process.stdout.write(
      `[${message.role}] ${formatValue(message.id)} ${message.createdAt ? new Date(message.createdAt).toISOString() : 'unknown-time'}\n`,
    )
    if (message.reasoningText) {
      process.stdout.write(`  reasoning: ${truncateForText(message.reasoningText)}\n`)
    }
    if (message.text) {
      process.stdout.write(`  text: ${truncateForText(message.text)}\n`)
    }
    if (message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        process.stdout.write(
          `  tool: ${formatValue(toolCall.toolName)} ${toolCall.status}${toolCall.title ? ` - ${toolCall.title}` : ''}\n`,
        )
        if (toolCall.outputPreview) {
          process.stdout.write(`    result: ${truncateForText(toolCall.outputPreview)}\n`)
        }
      }
    }
    if (message.hasError) {
      process.stdout.write(
        `  error: ${formatValue(message.errorName)} - ${truncateForText(message.errorMessage)}\n`,
      )
    }
    process.stdout.write('\n')
  }

  if (result.summary.diagnostics.length > 0) {
    process.stdout.write('  diagnostics:\n')
    for (const diagnostic of result.summary.diagnostics) {
      process.stdout.write(`    - ${diagnostic}\n`)
    }
  }
}

function printOpenCodeSessionPreview(result: Awaited<ReturnType<typeof openCodeSessionBridge.observePreview>>): void {
  process.stdout.write('OpenCode session preview:\n')
  process.stdout.write(`  session: ${result.record.opencodeSessionId}\n`)
  process.stdout.write(`  model: ${result.record.selectedModel}\n`)
  process.stdout.write(`  outcome: ${result.summary.previewOutcome}\n`)
  process.stdout.write(`  runtime state: ${result.summary.runtimeState}\n`)
  process.stdout.write(`  stale reason: ${formatValue(result.summary.staleReason)}\n`)
  process.stdout.write(`  auth state: ${formatValue(result.summary.profileAuthState)}\n`)
  process.stdout.write(`  endpoint: ${formatValue(result.summary.streamEndpoint)}\n`)
  process.stdout.write(`  stream connected: ${result.summary.streamConnected ? 'yes' : 'no'}\n`)
  process.stdout.write(`  observed events: ${String(result.summary.observedEventCount)}\n`)
  process.stdout.write(`  matched events: ${String(result.summary.matchedEventCount)}\n`)
  process.stdout.write(`  latest event: ${formatValue(result.summary.latestEventType)}\n`)
  process.stdout.write(
    `  latest assistant preview: ${formatValue(result.summary.latestAssistantPreview)}\n`,
  )
  process.stdout.write(
    `  pending permissions: ${result.summary.pendingPermissionRequestIds.join(', ') || 'none'}\n`,
  )
  if (result.summary.diagnostics.length > 0) {
    process.stdout.write('  diagnostics:\n')
    for (const diagnostic of result.summary.diagnostics) {
      process.stdout.write(`    - ${diagnostic}\n`)
    }
  }
}

async function resolveOpenCodeSessionRecordForCli(opts: {
  team: string
  member: string
  lane?: string
  sessionId?: string
}) {
  const laneId = opts.lane?.trim()
  const sessionId = opts.sessionId?.trim()
  const matchesSession = (record: { opencodeSessionId: string }): boolean =>
    !sessionId || record.opencodeSessionId === sessionId

  if (laneId) {
    const record = await openCodeSessionStore.get(opts.team, laneId, opts.member)
    if (!record) {
      throw new Error(`No stored OpenCode session record for ${opts.team}/${laneId}/${opts.member}`)
    }
    if (!matchesSession(record)) {
      throw new Error(
        `Stored OpenCode session record for ${opts.team}/${laneId}/${opts.member} does not match --session-id ${sessionId}`,
      )
    }
    return record
  }

  const records = (await openCodeSessionStore.list()).filter(record => {
    return record.teamId === opts.team && record.memberName === opts.member && matchesSession(record)
  })

  if (sessionId && records.length === 0) {
    throw new Error(`No stored OpenCode session record for ${opts.team}/${opts.member} with session ${sessionId}`)
  }

  if (records.length > 1) {
    throw new Error(
      `Multiple OpenCode session records exist for ${opts.team}/${opts.member}; pass --lane to select one`,
    )
  }

  const record = records[0]
  if (!record) {
    throw new Error(`No stored OpenCode session record for ${opts.team}/${opts.member}`)
  }

  return record
}

export async function runtimeReconcile(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
  team: string
  member: string
  lane?: string
  limit?: number
}): Promise<void> {
  const provider = opts.provider ?? 'all'
  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime reconcile is currently only implemented for OpenCode, received "${provider}"`)
  }

  const record = await resolveOpenCodeSessionRecordForCli(opts)

  const result = await openCodeSessionBridge.reconcileSession(record, {
    limit: typeof opts.limit === 'number' ? opts.limit : undefined,
  })

  if (opts.text) {
    printOpenCodeSessionReconcile(result)
  } else {
    process.stdout.write(jsonStringify({
      schemaVersion: 1,
      providerId: 'opencode',
      result,
    }, null, 2) + '\n')
  }

  process.exit(0)
}

export async function runtimePreview(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
  team: string
  member: string
  lane?: string
  timeout?: number
  idleTimeout?: number
}): Promise<void> {
  const provider = opts.provider ?? 'all'
  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime preview is currently only implemented for OpenCode, received "${provider}"`)
  }

  const record = await resolveOpenCodeSessionRecordForCli(opts)

  const result = await openCodeSessionBridge.observePreview(record, {
    timeoutMs: typeof opts.timeout === 'number' ? opts.timeout : undefined,
    idleTimeoutMs: typeof opts.idleTimeout === 'number' ? opts.idleTimeout : undefined,
  })

  if (opts.text) {
    printOpenCodeSessionPreview(result)
  } else {
    process.stdout.write(jsonStringify({
      schemaVersion: 1,
      providerId: 'opencode',
      result,
    }, null, 2) + '\n')
  }

  process.exit(0)
}

export async function runtimeTranscript(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
  team: string
  member: string
  lane?: string
  limit?: number
  sessionId?: string
  projectionOnly?: boolean
  output?: string
}): Promise<void> {
  const provider = opts.provider ?? 'all'
  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime transcript is currently only implemented for OpenCode, received "${provider}"`)
  }

  const record = await resolveOpenCodeSessionRecordForCli(opts)

  const result = await openCodeSessionBridge.projectLogMessages(record, {
    limit: typeof opts.limit === 'number' ? opts.limit : undefined,
  })

  if (opts.text) {
    printOpenCodeSessionTranscript(result)
    process.stdout.write(
      `  projected log messages: ${String(result.logProjection.projectedMessageCount)} (${String(result.logProjection.syntheticMessageCount)} synthetic)\n`,
    )
  } else {
    const payload = jsonStringify({
      schemaVersion: 1,
      providerId: 'opencode',
      transcript: {
        sessionId: result.record.opencodeSessionId,
        durableState: result.summary.durableState,
        staleReason: result.summary.staleReason,
        messageCount: result.summary.messageCount,
        toolCallCount: result.summary.toolCallCount,
        errorCount: result.summary.errorCount,
        latestAssistantText: result.summary.latestAssistantText,
        latestAssistantPreview: result.summary.latestAssistantPreview,
        messages: opts.projectionOnly ? [] : result.summary.messages,
        diagnostics: result.summary.diagnostics,
        logProjection: result.logProjection,
      },
    }, null, 2) + '\n'
    if (opts.output?.trim()) {
      await writeFile(opts.output.trim(), payload, 'utf8')
    } else {
      process.stdout.write(payload)
    }
  }

  process.exit(0)
}

export async function runtimeOpenCodeCommand(opts: {
  input: string
  json?: boolean
  output?: string
}): Promise<void> {
  let signalCleanupPromise: Promise<void> | null = null
  const cleanupUnregisteredHostsAndExit = (exitCode: number): void => {
    if (signalCleanupPromise) {
      return
    }
    const watchdog = setTimeout(() => process.exit(exitCode), 5_000)
    watchdog.unref?.()
    signalCleanupPromise = openCodeHostManager.disposeUnregisteredOwnedHosts()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(watchdog)
        process.exit(exitCode)
      })
  }
  const onSigterm = () => cleanupUnregisteredHostsAndExit(143)
  const onSigint = () => cleanupUnregisteredHostsAndExit(130)
  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)

  try {
    logOpenCodeCommandDebug('read-input:start')
    const raw = await readFile(opts.input, 'utf8')
    logOpenCodeCommandDebug('execute:start')
    const envelope = JSON.parse(raw) as unknown
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
    logOpenCodeCommandDebug('execute:done')
    if (signalCleanupPromise) {
      await signalCleanupPromise
      return
    }
    const payload = jsonStringify(result) + '\n'
    if (opts.output?.trim()) {
      logOpenCodeCommandDebug('write-output:start')
      await writeFile(opts.output.trim(), payload, 'utf8')
      logOpenCodeCommandDebug('write-output:done')
    } else {
      logOpenCodeCommandDebug('write-stdout:start')
      await writeStdoutAndDrain(payload)
      logOpenCodeCommandDebug('write-stdout:done')
    }
  } finally {
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }
  exitRuntimeCommand(0)
}

function logOpenCodeCommandDebug(stage: string): void {
  if (process.env.CLAUDE_MULTIMODEL_DEBUG_OPENCODE_COMMAND !== '1') {
    return
  }
  process.stderr.write(`[opencode-command] ${stage}\n`)
}

export async function runtimeOpenCodeLedgerBackfill(opts: {
  json?: boolean
  team: string
  task?: string
  taskDisplayId?: string
  member?: string
  lane?: string
  projectDir?: string
  workspaceRoot?: string
  deliveryContext?: string
  deliveryContextHash?: string
  attributionMode?: string
  dryRun?: boolean
  output?: string
}): Promise<void> {
  const result = await openCodeLedgerBridgeService.backfill({
    teamName: opts.team,
    taskId: opts.task,
    taskDisplayId: opts.taskDisplayId,
    memberName: opts.member,
    laneId: opts.lane,
    projectDir: opts.projectDir,
    workspaceRoot: opts.workspaceRoot,
    deliveryContextPath: opts.deliveryContext,
    deliveryContextHash: opts.deliveryContextHash,
    attributionMode: opts.attributionMode === 'strict-delivery' ? 'strict-delivery' : 'compatible',
    dryRun: opts.dryRun === true,
  })
  const payload = jsonStringify({
    schemaVersion: 1,
    providerId: 'opencode',
    result,
  }, null, 2) + '\n'
  if (opts.output?.trim()) {
    await writeFile(opts.output.trim(), payload, 'utf8')
  } else {
    process.stdout.write(payload)
  }
  process.exit(0)
}

function writeStdoutAndDrain(
  payload: string,
  stdoutWrite: RuntimeStdoutWrite = process.stdout.write,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      process.stdout.off('drain', onDrain)
    }
    const finish = (error?: Error | null) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const onDrain = () => finish()
    timer = setTimeout(() => finish(), STDOUT_DRAIN_FALLBACK_TIMEOUT_MS)
    timer.unref?.()
    const shouldWaitForDrain = !stdoutWrite.call(process.stdout, payload, error => {
      finish(error)
    })
    if (shouldWaitForDrain && !settled) {
      process.stdout.once('drain', onDrain)
    }
  })
}

function normalizeProviderManagementRuntime(
  runtime: string | null | undefined,
): RuntimeProviderManagementTarget {
  const normalized = runtime?.trim() || 'opencode'
  if (normalized !== 'opencode') {
    throw new Error(`runtime providers is currently only implemented for OpenCode, received "${normalized}"`)
  }
  return normalized
}

function normalizeProviderDirectoryFilter(
  filter: string | null | undefined,
): ProviderDirectoryFilter | null {
  const normalized = filter?.trim()
  return normalized && PROVIDER_DIRECTORY_FILTERS.has(normalized)
    ? normalized as ProviderDirectoryFilter
    : null
}

async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function readStdinJsonObject(): Promise<Record<string, unknown> | null> {
  const raw = await readStdinSecret()
  if (!raw) {
    return null
  }
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}

async function writeProviderManagementViewResponse(
  runtimeId: RuntimeProviderManagementTarget,
  view: ProviderManagementView | null,
  error: ProviderManagementError | null,
  stdoutWrite?: RuntimeStdoutWrite,
): Promise<void> {
  await writeStdoutAndDrain(jsonStringify({
    schemaVersion: 1,
    runtimeId,
    ...(view ? { view } : {}),
    ...(error ? { error } : {}),
  }, null, 2) + '\n', stdoutWrite)
}

async function writeProviderManagementDirectoryResponse(
  runtimeId: RuntimeProviderManagementTarget,
  directory: ProviderDirectoryView | null,
  error: ProviderManagementError | null,
  stdoutWrite?: RuntimeStdoutWrite,
): Promise<void> {
  await writeStdoutAndDrain(jsonStringify({
    schemaVersion: 1,
    runtimeId,
    ...(directory ? { directory } : {}),
    ...(error ? { error } : {}),
  }, null, 2) + '\n', stdoutWrite)
}

async function writeProviderManagementProviderResponse(
  runtimeId: RuntimeProviderManagementTarget,
  provider: ProviderConnection | null,
  error: ProviderManagementError | null,
  stdoutWrite?: RuntimeStdoutWrite,
): Promise<void> {
  await writeStdoutAndDrain(jsonStringify({
    schemaVersion: 1,
    runtimeId,
    ...(provider ? { provider } : {}),
    ...(error ? { error } : {}),
  }, null, 2) + '\n', stdoutWrite)
}

async function writeProviderManagementSetupFormResponse(
  runtimeId: RuntimeProviderManagementTarget,
  setupForm: ProviderSetupForm | null,
  error: ProviderManagementError | null,
  stdoutWrite?: RuntimeStdoutWrite,
): Promise<void> {
  await writeStdoutAndDrain(jsonStringify({
    schemaVersion: 1,
    runtimeId,
    ...(setupForm ? { setupForm } : {}),
    ...(error ? { error } : {}),
  }, null, 2) + '\n', stdoutWrite)
}

async function writeProviderManagementModelsResponse(
  runtimeId: RuntimeProviderManagementTarget,
  models: RuntimeProviderModelsView | null,
  error: ProviderManagementError | null,
  stdoutWrite?: RuntimeStdoutWrite,
): Promise<void> {
  await writeStdoutAndDrain(jsonStringify({
    schemaVersion: 1,
    runtimeId,
    ...(models ? { models } : {}),
    ...(error ? { error } : {}),
  }, null, 2) + '\n', stdoutWrite)
}

async function writeProviderManagementModelTestResponse(
  runtimeId: RuntimeProviderManagementTarget,
  result: ProviderModelTestResult | null,
  error: ProviderManagementError | null,
  stdoutWrite?: RuntimeStdoutWrite,
): Promise<void> {
  await writeStdoutAndDrain(jsonStringify({
    schemaVersion: 1,
    runtimeId,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  }, null, 2) + '\n', stdoutWrite)
}

function authRequiredError(message: string): ProviderManagementError {
  return {
    code: 'auth-required',
    message,
    recoverable: true,
  }
}

async function exitWithProviderManagementProviderResponse(input: {
  runtimeId: RuntimeProviderManagementTarget
  provider: ProviderConnection | null
  error: ProviderManagementError | null
  exitCode: number
}): Promise<void> {
  await withRuntimeJsonStdoutGuardedExit(async stdoutWrite => {
    await writeProviderManagementProviderResponse(
      input.runtimeId,
      input.provider,
      input.error,
      stdoutWrite,
    )
    return input.exitCode
  })
}

function compactProviderManagementView(view: ProviderManagementView): ProviderManagementView {
  return {
    ...view,
    providers: view.providers.filter(provider => {
      if (provider.state === 'connected' || provider.recommended) {
        return true
      }

      return provider.actions.some(action =>
        action.enabled && (action.id === 'connect' || action.id === 'forget')
      )
    }),
  }
}

export async function runtimeProvidersView(opts: {
  runtime?: string
  projectPath?: string
  json?: boolean
  compact?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  await withRuntimeJsonStdoutGuardedResponse(
    () => loadProviderManagementView(openCodeProviderManagementAdapter, {
      runtimeId,
      projectPath: opts.projectPath?.trim() || null,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementViewResponse(
          runtimeId,
          opts.compact ? compactProviderManagementView(result.value) : result.value,
          null,
          stdoutWrite,
        )
        return 0
      }

      await writeProviderManagementViewResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(),
  )
}

export async function runtimeProvidersDirectory(opts: {
  runtime?: string
  projectPath?: string
  query?: string
  filter?: string
  limit?: number
  cursor?: string
  refresh?: boolean
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  await withRuntimeJsonStdoutGuardedResponse(
    () => loadProviderDirectory(openCodeProviderManagementAdapter, {
      runtimeId,
      projectPath: opts.projectPath?.trim() || null,
      query: opts.query?.trim() || null,
      filter: normalizeProviderDirectoryFilter(opts.filter),
      limit: opts.limit ?? null,
      cursor: opts.cursor?.trim() || null,
      refresh: opts.refresh === true,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementDirectoryResponse(runtimeId, result.value, null, stdoutWrite)
        return 0
      }

      await writeProviderManagementDirectoryResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(),
  )
}

export async function runtimeProvidersSetupForm(opts: {
  runtime?: string
  provider: string
  projectPath?: string
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  await withRuntimeJsonStdoutGuardedResponse(
    () => loadProviderSetupForm(openCodeProviderManagementAdapter, {
      runtimeId,
      providerId: opts.provider?.trim(),
      projectPath: opts.projectPath?.trim() || null,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementSetupFormResponse(runtimeId, result.value, null, stdoutWrite)
        return 0
      }

      await writeProviderManagementSetupFormResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(),
  )
}

function normalizeConnectProviderPayload(input: {
  runtimeId: RuntimeProviderManagementTarget
  providerId: string
  projectPath?: string | null
  payload: Record<string, unknown>
}): ConnectProviderInput {
  const method = typeof input.payload.method === 'string'
    ? input.payload.method.trim()
    : 'api'
  if (method !== 'api' && method !== 'oauth' && method !== 'manual') {
    throw new Error(`Unsupported provider setup method: ${method || '(empty)'}`)
  }
  const apiKey = typeof input.payload.apiKey === 'string'
    ? input.payload.apiKey
    : typeof input.payload.key === 'string'
      ? input.payload.key
      : null
  const metadata: Record<string, string> = {}
  const rawMetadata = input.payload.metadata
  if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
    for (const [key, value] of Object.entries(rawMetadata)) {
      if (typeof value === 'string') {
        metadata[key] = value
      }
    }
  }

  return {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    method,
    apiKey,
    metadata,
    projectPath: input.projectPath,
  }
}

export async function runtimeProvidersConnect(opts: {
  runtime?: string
  provider: string
  projectPath?: string
  stdinJson?: boolean
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  const providerId = opts.provider?.trim()

  if (!opts.stdinJson) {
    await exitWithProviderManagementProviderResponse({
      runtimeId,
      provider: null,
      error: authRequiredError('Provider setup payload must be supplied through --stdin-json'),
      exitCode: 1,
    })
    return
  }

  let payload: Record<string, unknown> | null = null
  try {
    payload = await readStdinJsonObject()
  } catch {
    await exitWithProviderManagementProviderResponse({
      runtimeId,
      provider: null,
      error: authRequiredError('Provider setup payload from stdin is not valid JSON'),
      exitCode: 1,
    })
    return
  }
  if (!payload) {
    await exitWithProviderManagementProviderResponse({
      runtimeId,
      provider: null,
      error: authRequiredError('Provider setup payload from stdin is empty'),
      exitCode: 1,
    })
    return
  }

  let connectInput: ConnectProviderInput
  try {
    connectInput = normalizeConnectProviderPayload({
      runtimeId,
      providerId,
      projectPath: opts.projectPath?.trim() || null,
      payload,
    })
  } catch (error) {
    await exitWithProviderManagementProviderResponse({
      runtimeId,
      provider: null,
      error: {
        code: 'unsupported-auth-method',
        message: error instanceof Error ? error.message : 'Unsupported provider setup method',
        recoverable: true,
      },
      exitCode: 1,
    })
    return
  }

  await withRuntimeJsonStdoutGuardedResponse(
    () => connectProvider(openCodeProviderManagementAdapter, connectInput),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementProviderResponse(runtimeId, result.value, null, stdoutWrite)
        return 0
      }

      await writeProviderManagementProviderResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(connectInput.apiKey),
  )
}

export async function runtimeProvidersConnectApiKey(opts: {
  runtime?: string
  provider: string
  projectPath?: string
  stdinKey?: boolean
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  const providerId = opts.provider?.trim()

  if (!opts.stdinKey) {
    await exitWithProviderManagementProviderResponse({
      runtimeId,
      provider: null,
      error: authRequiredError('API key must be supplied through --stdin-key'),
      exitCode: 1,
    })
    return
  }

  let apiKey: string
  try {
    apiKey = await readStdinSecret()
  } catch {
    await exitWithProviderManagementProviderResponse({
      runtimeId,
      provider: null,
      error: authRequiredError('API key from stdin could not be read'),
      exitCode: 1,
    })
    return
  }
  if (!apiKey) {
    await exitWithProviderManagementProviderResponse({
      runtimeId,
      provider: null,
      error: authRequiredError('API key from stdin is empty'),
      exitCode: 1,
    })
    return
  }

  await withRuntimeJsonStdoutGuardedResponse(
    () => connectProviderWithApiKey(openCodeProviderManagementAdapter, {
      runtimeId,
      providerId,
      apiKey,
      projectPath: opts.projectPath?.trim() || null,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementProviderResponse(runtimeId, result.value, null, stdoutWrite)
        return 0
      }

      await writeProviderManagementProviderResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(apiKey),
  )
}

export async function runtimeProvidersForget(opts: {
  runtime?: string
  provider: string
  projectPath?: string
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  await withRuntimeJsonStdoutGuardedResponse(
    () => forgetManagedProvider(openCodeProviderManagementAdapter, {
      runtimeId,
      providerId: opts.provider?.trim(),
      projectPath: opts.projectPath?.trim() || null,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementProviderResponse(runtimeId, result.value, null, stdoutWrite)
        return 0
      }

      await writeProviderManagementProviderResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(),
  )
}

export async function runtimeProvidersModels(opts: {
  runtime?: string
  provider: string
  projectPath?: string
  query?: string
  limit?: number
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  await withRuntimeJsonStdoutGuardedResponse(
    () => loadProviderModels(openCodeProviderManagementAdapter, {
      runtimeId,
      providerId: opts.provider?.trim(),
      projectPath: opts.projectPath?.trim() || null,
      query: opts.query?.trim() || null,
      limit: opts.limit ?? null,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementModelsResponse(runtimeId, result.value, null, stdoutWrite)
        return 0
      }

      await writeProviderManagementModelsResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(),
  )
}

export async function runtimeProvidersTestModel(opts: {
  runtime?: string
  provider: string
  model: string
  projectPath?: string
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  await withRuntimeJsonStdoutGuardedResponse(
    () => testProviderModel(openCodeProviderManagementAdapter, {
      runtimeId,
      providerId: opts.provider?.trim(),
      modelId: opts.model?.trim(),
      projectPath: opts.projectPath?.trim() || null,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementModelTestResponse(runtimeId, result.value, null, stdoutWrite)
        return 0
      }

      await writeProviderManagementModelTestResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(),
  )
}

export async function runtimeProvidersSetDefault(opts: {
  runtime?: string
  provider: string
  model: string
  projectPath?: string
  scope?: 'project' | 'all-projects'
  probe?: boolean
  compact?: boolean
  json?: boolean
}): Promise<void> {
  const runtimeId = normalizeProviderManagementRuntime(opts.runtime)
  await withRuntimeJsonStdoutGuardedResponse(
    () => setProviderDefaultModel(openCodeProviderManagementAdapter, {
      runtimeId,
      providerId: opts.provider?.trim(),
      modelId: opts.model?.trim(),
      projectPath: opts.projectPath?.trim() || null,
      scope: opts.scope === 'all-projects' ? 'all_projects' : 'project',
      probe: opts.probe === true,
    }),
    async (result, stdoutWrite) => {
      if (!('error' in result)) {
        await writeProviderManagementViewResponse(
          runtimeId,
          opts.compact ? compactProviderManagementView(result.value) : result.value,
          null,
          stdoutWrite,
        )
        return 0
      }

      await writeProviderManagementViewResponse(runtimeId, null, result.error, stdoutWrite)
      return 1
    },
    recoverProviderManagementError(),
  )
}
