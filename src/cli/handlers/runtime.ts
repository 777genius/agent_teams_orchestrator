/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  getUnifiedRuntimeStatusPayload,
} from '../../services/runtimeBackends/registry.js'
import { openCodeExecutionProbe } from '../../services/opencode/OpenCodeExecutionProbe.js'
import { openCodeProvisioningProbe } from '../../services/opencode/OpenCodeProvisioningProbe.js'
import { openCodeSessionBridge } from '../../services/opencode/OpenCodeSessionBridge.js'
import { openCodeSessionStore } from '../../services/opencode/OpenCodeSessionStore.js'
import type {
  RuntimeProviderId,
  RuntimeProviderStatus,
} from '../../services/runtimeBackends/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'

type RuntimeProviderTarget = RuntimeProviderId | 'all'

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
}): Promise<void> {
  const providerFilter =
    opts.provider && opts.provider !== 'all' ? opts.provider : undefined
  const payload = await getUnifiedRuntimeStatusPayload(providerFilter)

  if (opts.text) {
    const providerOrder: RuntimeProviderId[] = ['anthropic', 'codex', 'gemini', 'opencode']
    for (const providerId of providerOrder) {
      const provider = payload.providers[providerId]
      if (!provider) continue
      printProviderStatus(provider)
    }
  } else {
    process.stdout.write(jsonStringify(payload, null, 2) + '\n')
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

export async function runtimeReconcile(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
  team: string
  member: string
  limit?: number
}): Promise<void> {
  const provider = opts.provider ?? 'all'
  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime reconcile is currently only implemented for OpenCode, received "${provider}"`)
  }

  const record = await openCodeSessionStore.get(opts.team, opts.member)
  if (!record) {
    throw new Error(`No stored OpenCode session record for ${opts.team}/${opts.member}`)
  }

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
  timeout?: number
  idleTimeout?: number
}): Promise<void> {
  const provider = opts.provider ?? 'all'
  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime preview is currently only implemented for OpenCode, received "${provider}"`)
  }

  const record = await openCodeSessionStore.get(opts.team, opts.member)
  if (!record) {
    throw new Error(`No stored OpenCode session record for ${opts.team}/${opts.member}`)
  }

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
  limit?: number
}): Promise<void> {
  const provider = opts.provider ?? 'all'
  if (provider !== 'opencode' && provider !== 'all') {
    throw new Error(`runtime transcript is currently only implemented for OpenCode, received "${provider}"`)
  }

  const record = await openCodeSessionStore.get(opts.team, opts.member)
  if (!record) {
    throw new Error(`No stored OpenCode session record for ${opts.team}/${opts.member}`)
  }

  const result = await openCodeSessionBridge.projectLogMessages(record, {
    limit: typeof opts.limit === 'number' ? opts.limit : undefined,
  })

  if (opts.text) {
    printOpenCodeSessionTranscript(result)
    process.stdout.write(
      `  projected log messages: ${String(result.logProjection.projectedMessageCount)} (${String(result.logProjection.syntheticMessageCount)} synthetic)\n`,
    )
  } else {
    process.stdout.write(jsonStringify({
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
        messages: result.summary.messages,
        diagnostics: result.summary.diagnostics,
        logProjection: result.logProjection,
      },
    }, null, 2) + '\n')
  }

  process.exit(0)
}
