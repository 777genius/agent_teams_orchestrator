import { isBoundGroupChatControl } from '../../utils/groupChatControlClient.js'
import { hasGroupChatTools } from '../../utils/groupMailbox.js'
import { createHash } from 'node:crypto'
import type { OpenCodeProvisioningSnapshot, OpenCodeSessionRecord } from './types.js'

export type OpenCodeGroupChatRunProof = {
  teamName: string
  memberName: string
  runId: string
  runKey: string
  laneId: string | null
  runtimePid: number
  runtimeSessionId: string
  processorReady: true
  groupReactionProtocolVersion?: 1
}

export type OpenCodeGroupControlBinding = {
  controlUrl: string
  context: string
}

/** The selected xAI endpoint is host-less in observations. For local MCP, read
 * the bound config that OpenCode actually loaded. For desktop HTTP MCP, verify
 * the current app-scoped URL AND the live HTTP server's root/transport identity;
 * a bridge environment alone does not attest another MCP process. */
export async function readOwnedOAuthGroupControlBinding(
  config: { type: 'local' | 'remote'; environment?: Record<string, string>; url?: string },
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<OpenCodeGroupControlBinding | null> {
  const appControlUrl = environment.AGENT_TEAMS_BOUND_CONTROL_URL
  const appContext = environment.AGENT_TEAMS_BOUND_CONTEXT_JSON
  if (!isBoundGroupChatControl(appControlUrl, appContext)) return null

  if (config.type === 'local') {
    const controlUrl = config.environment?.AGENT_TEAMS_BOUND_CONTROL_URL
    const context = config.environment?.AGENT_TEAMS_BOUND_CONTEXT_JSON
    return controlUrl === appControlUrl && context === appContext
      ? { controlUrl: controlUrl!, context: context! }
      : null
  }
  if (config.type !== 'remote' || !config.url) return null

  try {
    const url = new URL(config.url)
    const appInstance = environment.CLAUDE_TEAM_APP_INSTANCE_ID
    const appProfile = environment.CLAUDE_TEAM_APP_PROFILE_SCOPE
    const root = environment.AGENT_TEAMS_MCP_CLAUDE_DIR
    const context = JSON.parse(appContext!) as Record<string, unknown>
    const markers = new URLSearchParams(url.hash.slice(1))
    // This is the app-owned HTTP transport, not an arbitrary remote MCP.
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        !url.port || url.pathname !== '/mcp' || url.search || url.username || url.password ||
        !appInstance || !/^[a-f0-9]{64}$/.test(appProfile ?? '') || !root ||
        context.appInstanceId !== appInstance ||
        markers.get('agent-teams-app-instance') !== appInstance ||
        markers.get('agent-teams-app-profile') !== appProfile ||
        environment.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH !==
          createHash('sha256').update(url.origin + url.pathname).digest('hex')) return null

    const response = await fetch(url.origin + '/health', {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_500)]) : AbortSignal.timeout(1_500),
    })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 8192) return null
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 8192) {
          void reader.cancel().catch(() => undefined)
          return null
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const health = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks))) as Record<string, unknown>
    if (health.schemaVersion !== 1 || health.service !== 'agent-teams-mcp-http' ||
        health.transport !== 'httpStream' || health.host !== '127.0.0.1' ||
        health.port !== Number(url.port) || health.endpoint !== '/mcp' ||
        health.claudeDirHash !== createHash('sha256').update(root).digest('hex') ||
        typeof health.ownerInstanceId !== 'string' || !health.ownerInstanceId.trim() ||
        typeof health.launchSpecHash !== 'string' || !/^[a-f0-9]{64}$/.test(health.launchSpecHash)) return null

    return { controlUrl: appControlUrl!, context: appContext! }
  } catch {
    if (signal?.aborted) throw signal.reason
    return null
  }
}

// A retained host or exact owned OAuth endpoint, a matching run/session, and
// fresh tools/list are required. Cached proofs and labels cannot attest a run.
export function buildOpenCodeGroupChatRunProof(
  snapshot: OpenCodeProvisioningSnapshot | null,
  record: OpenCodeSessionRecord,
  observedTools: readonly string[],
  ownedHost?: { hostKey: string; pid: number; controlUrl: string; controlContext: string },
): OpenCodeGroupChatRunProof | undefined {
  const host = snapshot?.host
  const config = host?.profile.managedConfig.mcp?.['agent-teams']
  const binding = host
    ? { ...host.profile.env, ...config?.environment }
    : { AGENT_TEAMS_BOUND_CONTROL_URL: ownedHost?.controlUrl, AGENT_TEAMS_BOUND_CONTEXT_JSON: ownedHost?.controlContext }
  const pid = record.runtimePid
  const hostMatches = host
    ? host.state === 'healthy' && snapshot?.hostHealthy && host.pid === pid && host.hostKey === record.hostKey
    : !!ownedHost && record.profileScope?.purpose === 'launch_runtime'
      && record.profileScope.providerId === 'xai'
      && ownedHost.pid === pid && ownedHost.hostKey === record.hostKey
  if (!hostMatches || !Number.isSafeInteger(pid) || pid <= 0 ||
      !record.runId || record.stoppedAt || record.staleReason || !record.appManagedBootstrap ||
      record.appManagedBootstrap.schemaVersion !== 1 || !record.appManagedBootstrap.injectionVerifiedAt ||
      !record.opencodeSessionId || snapshot?.mcp?.['agent-teams']?.status !== 'connected' ||
      !isBoundGroupChatControl(binding.AGENT_TEAMS_BOUND_CONTROL_URL, binding.AGENT_TEAMS_BOUND_CONTEXT_JSON) ||
      !hasGroupChatTools(observedTools.map(name => ({ name })))) return undefined
  try { process.kill(pid, 0) } catch { return undefined }
  return {
    teamName: record.teamId, memberName: record.memberName,
    runId: record.runId, runKey: record.runId, laneId: record.laneId ?? null,
    runtimePid: pid, runtimeSessionId: record.opencodeSessionId, processorReady: true, groupReactionProtocolVersion: 1,
  }
}
