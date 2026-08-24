import { createHash } from 'node:crypto'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('unsupported fixture fingerprint value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const input = value as Record<string, unknown>
  return `{${Object.keys(input).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`
}

export function fingerprintFixtureSession(record: Record<string, any>): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 1, teamId: record.teamId, laneId: record.laneId ?? 'primary',
    runId: record.runId ?? null, memberName: record.memberName, providerId: record.providerId,
    opencodeSessionId: record.opencodeSessionId, projectPath: record.projectPath,
    hostKey: record.hostKey, openCodeArtifactDigest: record.openCodeArtifactDigest ?? null,
    profileRootKey: record.profileRootKey, projectBehaviorFingerprint: record.projectBehaviorFingerprint,
    managedConfigFingerprint: record.managedConfigFingerprint ?? null,
    sourceAuthFingerprint: record.sourceAuthFingerprint, managedAuthFingerprint: record.managedAuthFingerprint,
    toolApprovalMode: record.toolApprovalMode ?? null, runtimePid: record.runtimePid ?? null,
    createdAt: record.createdAt,
  })).digest('hex')
}

export function fingerprintFixtureEffect(effect: Record<string, any>, proof: {
  processStartIdentity: string
  capability: Record<string, unknown>
}): string {
  const priorLiveEffectFingerprint = createHash('sha256').update(canonicalJson({
    schemaVersion: 1, sessionRecordFingerprint: fingerprintFixtureSession(effect.record),
    hostKey: effect.host.hostKey, profileRootKey: effect.host.profileRootKey,
    projectPath: effect.host.projectPath,
    projectBehaviorFingerprint: effect.host.projectBehaviorFingerprint,
    openCodeArtifactDigest: effect.host.openCodeArtifactDigest ?? null,
    baseUrl: effect.host.baseUrl ?? null, port: effect.host.port ?? null,
    runtimePid: effect.host.pid, processStartedAtMs: effect.host.processStartedAtMs,
    resolvedConfigFingerprint: effect.host.resolvedConfigFingerprint,
    preparedProfile: { profileRootKey: effect.profile.profileRootKey,
      projectPath: effect.profile.projectPath,
      projectBehaviorFingerprint: effect.profile.projectBehaviorFingerprint,
      managedConfigFingerprint: effect.profile.managedConfigFingerprint,
      sourceAuthFingerprint: effect.profile.sourceAuthFingerprint,
      managedAuthFingerprint: effect.profile.managedAuthFingerprint },
  })).digest('hex')
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 2, priorLiveEffectFingerprint,
    processIdentity: { pid: effect.host.pid, startIdentity: proof.processStartIdentity },
    endpointIdentity: { address: '127.0.0.1', port: effect.host.port,
      pid: effect.host.pid, startIdentity: proof.processStartIdentity },
    executedArtifactDigest: effect.host.openCodeArtifactDigest,
    resolvedConfigFingerprint: effect.host.resolvedConfigFingerprint,
    capability: proof.capability,
  })).digest('hex')
}
