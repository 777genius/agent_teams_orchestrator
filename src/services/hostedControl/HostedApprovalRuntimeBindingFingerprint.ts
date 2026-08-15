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

export function fingerprintHostedApprovalLiveEffect(context: {
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
}): string {
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
