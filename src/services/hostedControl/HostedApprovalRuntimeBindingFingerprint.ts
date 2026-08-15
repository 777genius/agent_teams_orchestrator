import { createHash } from 'node:crypto'

export function fingerprintHostedApprovalSessionRecord(record: {
  teamId: string; laneId?: string; runId?: string | null; memberName: string; providerId: string
  opencodeSessionId: string; projectPath: string; hostKey: string
  openCodeArtifactDigest?: `sha256:${string}` | null; profileRootKey: string
  projectBehaviorFingerprint: string; managedConfigFingerprint?: string
  sourceAuthFingerprint: string | null; managedAuthFingerprint: string | null
  toolApprovalMode?: 'auto' | 'manual'; runtimePid?: number; createdAt: string
}): string {
  return digest({
    schemaVersion: 1, teamId: record.teamId, laneId: record.laneId ?? 'primary',
    runId: record.runId ?? null, memberName: record.memberName, providerId: record.providerId,
    opencodeSessionId: record.opencodeSessionId, projectPath: record.projectPath,
    hostKey: record.hostKey, openCodeArtifactDigest: record.openCodeArtifactDigest ?? null,
    profileRootKey: record.profileRootKey, projectBehaviorFingerprint: record.projectBehaviorFingerprint,
    managedConfigFingerprint: record.managedConfigFingerprint ?? null,
    sourceAuthFingerprint: record.sourceAuthFingerprint,
    managedAuthFingerprint: record.managedAuthFingerprint,
    toolApprovalMode: record.toolApprovalMode ?? null, runtimePid: record.runtimePid ?? null,
    createdAt: record.createdAt,
  })
}

export type HostedApprovalLiveEffectContext = {
  record: Parameters<typeof fingerprintHostedApprovalSessionRecord>[0]
  profile: {
    profileRootKey: string; projectPath: string; projectBehaviorFingerprint: string
    managedConfigFingerprint: string; sourceAuthFingerprint: string | null
    managedAuthFingerprint: string | null
  }
  host: {
    hostKey: string; profileRootKey: string; projectPath: string; projectBehaviorFingerprint: string
    openCodeArtifactDigest?: `sha256:${string}` | null; baseUrl?: string; port?: number; pid: number
    processStartedAtMs: number | null; resolvedConfigFingerprint: string | null
  }
}

export type HostedApprovalStrengthenedLiveEffect = {
  context: HostedApprovalLiveEffectContext
  processIdentity: { pid: number; startIdentity: string }
  endpointIdentity: { address: '127.0.0.1'; port: number; pid: number; startIdentity: string }
  executedArtifactDigest: `sha256:${string}`
  resolvedConfigFingerprint: string
  capability: {
    schemaVersion: 2
    protocol: 'agent-teams-hosted-approval-v2'
    authentication: 'opencode-basic'
    runtimeInstanceId: string
    configGeneration: string
  }
}

/**
 * The exact schema-v2 live-effect identity carried by authoritative bindings.
 * Both binding production and provider-edge consumption must call this helper;
 * the schema-v1 context digest is deliberately only an inner component.
 */
export function fingerprintHostedApprovalLiveEffect(
  input: HostedApprovalStrengthenedLiveEffect,
): string {
  return digest({
    schemaVersion: 2,
    priorLiveEffectFingerprint: fingerprintHostedApprovalLiveEffectContext(input.context),
    processIdentity: input.processIdentity,
    endpointIdentity: input.endpointIdentity,
    executedArtifactDigest: input.executedArtifactDigest,
    resolvedConfigFingerprint: input.resolvedConfigFingerprint,
    capability: input.capability,
  })
}

/** Inner schema-v1 projection; never compare this directly with a route. */
export function fingerprintHostedApprovalLiveEffectContext(
  context: HostedApprovalLiveEffectContext,
): string {
  return digest({
    schemaVersion: 1,
    sessionRecordFingerprint: fingerprintHostedApprovalSessionRecord(context.record),
    hostKey: context.host.hostKey, profileRootKey: context.host.profileRootKey,
    projectPath: context.host.projectPath,
    projectBehaviorFingerprint: context.host.projectBehaviorFingerprint,
    openCodeArtifactDigest: context.host.openCodeArtifactDigest ?? null,
    baseUrl: context.host.baseUrl ?? null, port: context.host.port ?? null, runtimePid: context.host.pid,
    processStartedAtMs: context.host.processStartedAtMs,
    resolvedConfigFingerprint: context.host.resolvedConfigFingerprint,
    preparedProfile: {
      profileRootKey: context.profile.profileRootKey, projectPath: context.profile.projectPath,
      projectBehaviorFingerprint: context.profile.projectBehaviorFingerprint,
      managedConfigFingerprint: context.profile.managedConfigFingerprint,
      sourceAuthFingerprint: context.profile.sourceAuthFingerprint,
      managedAuthFingerprint: context.profile.managedAuthFingerprint,
    },
  })
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}
