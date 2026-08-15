import { createHash } from 'node:crypto'

import {
  OpenCodePermissionEffectUnavailableError,
  OpenCodePermissionEffectNotAuthorizedError,
  openCodeSessionBridge,
  type OpenCodePermissionEffectContext,
  type OpenCodeSessionBridge,
} from '../opencode/OpenCodeSessionBridge.js'
import { openCodeSessionStore, type OpenCodeSessionStore } from '../opencode/OpenCodeSessionStore.js'
import type { OpenCodeNormalizedPermission } from '../opencode/types.js'
import type { OpenCodeHostedApprovalObservedPermission } from '../opencode/OpenCodeSessionBridge.js'
import { prepareOpenCodeArtifactDigestToken } from '../opencode/OpenCodeArtifactDigest.js'
import type { HostedApprovalIngressRecord } from './HostedApprovalWire.js'
import type { HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'

export type HostedApprovalObservedPermission = {
  route: HostedApprovalRuntimeRoute
  permission: OpenCodeNormalizedPermission
  providerObservation?: OpenCodeHostedApprovalObservedPermission
  observedAtIso: string
}

/** Dynamic pending-permission source and narrow provider decision effect. */
export class OpenCodeHostedApprovalRuntimeAdapter {
  readonly providerId = 'opencode' as const
  constructor(
    private readonly sessions: Pick<OpenCodeSessionStore, 'get'> &
      Partial<Pick<OpenCodeSessionStore, 'prepareEffectToken'>> = openCodeSessionStore,
    private readonly bridge: Pick<
      OpenCodeSessionBridge,
      'answerPermission' | 'observeHostedApprovalPermissions'
    > = openCodeSessionBridge,
    private readonly now: () => number = Date.now,
    private readonly artifacts: {
      prepareEffectToken(expectedDigest: string): { consume(): boolean } | null
    } = { prepareEffectToken: prepareOpenCodeArtifactDigestToken },
  ) {}

  async observe(route: HostedApprovalRuntimeRoute): Promise<readonly HostedApprovalObservedPermission[]> {
    const record = await this.#record(route)
    const permissions = await this.bridge.observeHostedApprovalPermissions(
      record,
      async context => this.#artifactMatches(route, context),
    )
    if (permissions.some(item => item.permission.sessionId !== route.authority.sessionId)) {
      throw new Error('Hosted approval OpenCode permission session mismatch')
    }
    const observedAtIso = new Date(this.now()).toISOString()
    return permissions.map(providerObservation => ({
      route,
      permission: providerObservation.normalized,
      providerObservation,
      observedAtIso,
    }))
  }

  async deliver(input: {
    route: HostedApprovalRuntimeRoute
    requestId: string
    expectedEffectRef: string
    decision: 'allow' | 'deny' | 'timeout'
    /** Revalidates the immutable admission generation/digest at the effect edge. */
    revalidate: () => Promise<boolean>
    /** Returns the exact owner/admission/WAL incarnation consumed at POST. */
    prepareEffectToken?: () => Promise<{ consume(): boolean } | null>
  }): Promise<'delivered' | 'not_started' | 'unavailable' | 'ambiguous'> {
    let before: readonly HostedApprovalObservedPermission[]
    try { before = await this.observe(input.route) } catch { return 'unavailable' }
    const expected = before.find(item => item.permission.requestId === input.requestId &&
      ingressRecordForObservedPermission(item).effectRef === input.expectedEffectRef)
    if (!expected?.providerObservation) return 'not_started'
    let record
    try {
      // Refetch the exact live lane/session/run immediately before the final
      // immutable admission fence. There is no async boundary between that fence
      // and invoking the provider effect.
      record = await this.#record(input.route)
      if (!(await input.revalidate())) return 'not_started'
    } catch { return 'unavailable' }
    // No catch after this line may convert uncertainty into not_started.
    try {
      await this.bridge.answerPermission(record, {
        requestId: input.requestId,
        decision: input.decision === 'allow' ? 'allow' : 'reject',
        expectedPermissionRaw: expected.permission.raw,
        expectedHostedPermission: expected.providerObservation,
        requireAtomicConfigReply: true,
        authorizeObservation: async context => this.#artifactMatches(input.route, context),
        validatePreparedEffect: async context => {
          const freshRecord = await this.#record(input.route)
          if (fingerprintOpenCodeApprovalSessionRecord(freshRecord) !==
            fingerprintOpenCodeApprovalSessionRecord(context.record) ||
            liveEffectFingerprint(context) !== input.route.openCodeBinding.liveEffectFingerprint) return false
          if (!this.sessions.prepareEffectToken) return true
          return await this.sessions.prepareEffectToken(
            input.route.authority.teamId,
            input.route.authority.laneId,
            input.route.memberName,
            context.record,
          ) ?? false
        },
        authorizeEffect: async context => {
          if (liveEffectFingerprint(context) !== input.route.openCodeBinding.liveEffectFingerprint ||
            !(await input.revalidate())) return false
          const artifactToken = this.artifacts.prepareEffectToken(
            input.route.openCodeBinding.openCodeArtifactDigest,
          )
          if (!artifactToken) return false
          const ownerToken = input.prepareEffectToken ? await input.prepareEffectToken() : null
          if (input.prepareEffectToken && !ownerToken) {
            artifactToken.consume()
            return false
          }
          return {
            consume: () => {
              const ownerCurrent = ownerToken?.consume() ?? true
              const artifactCurrent = artifactToken.consume()
              return artifactCurrent && ownerCurrent
            },
          }
        },
      })
    } catch (error) {
      if (error instanceof OpenCodePermissionEffectNotAuthorizedError) return 'not_started'
      return error instanceof OpenCodePermissionEffectUnavailableError ? 'unavailable' : 'ambiguous'
    }
    // The strict v2 success body is the provider transaction receipt. A second
    // observation would create a fresh race with host restart/config rotation
    // and must not weaken an already-proven applied result.
    return 'delivered'
  }

  async #record(route: HostedApprovalRuntimeRoute) {
    const record = await this.sessions.get(route.authority.teamId, route.authority.laneId, route.memberName)
    if (!record || record.providerId !== 'opencode' || record.toolApprovalMode !== 'manual' ||
      record.runId !== route.authority.runId ||
      record.opencodeSessionId !== route.authority.sessionId || record.staleReason !== null ||
      record.openCodeArtifactDigest !== route.openCodeBinding.openCodeArtifactDigest ||
      fingerprintOpenCodeApprovalSessionRecord(record) !== route.openCodeBinding.sessionRecordFingerprint) {
      throw new Error('Hosted approval OpenCode route changed')
    }
    return record
  }

  #artifactMatches(route: HostedApprovalRuntimeRoute, context: OpenCodePermissionEffectContext): boolean {
    if (context.record.openCodeArtifactDigest !== route.openCodeBinding.openCodeArtifactDigest ||
      context.host.openCodeArtifactDigest !== route.openCodeBinding.openCodeArtifactDigest) return false
    const token = this.artifacts.prepareEffectToken(route.openCodeBinding.openCodeArtifactDigest)
    return token?.consume() ?? false
  }
}

export function ingressRecordForObservedPermission(input: HostedApprovalObservedPermission): HostedApprovalIngressRecord {
  const requestId = input.permission.requestId
  const provider = input.providerObservation
  const effectDigest = createHash('sha256').update(canonicalJson({
    schemaVersion: 1,
    authority: input.route.authority,
    sessionRecordFingerprint: input.route.openCodeBinding.sessionRecordFingerprint,
    liveEffectFingerprint: input.route.openCodeBinding.liveEffectFingerprint,
    requestId,
    runtimeInstanceId: provider?.capability.runtimeInstanceId ?? null,
    configGeneration: provider?.capability.configGeneration ?? null,
    requestIncarnation: provider?.permission.requestIncarnation ?? null,
    permissionDigest: provider?.permission.permissionDigest ?? null,
    providerPermission: input.permission.raw,
  })).digest('hex')
  const deliveryRef = `delivery_ref_opencode-${effectDigest}`
  const summary = safeSummary(input.permission.title ?? `${input.permission.tool ?? 'tool'} permission requested`)
  const payloadJson = JSON.stringify({
    schemaVersion: 1, deliveryRef, category: category(input.permission),
    summary,
    expiresAtMs: null, preview: null,
  })
  return {
    outboxVersion: 1, outboxId: `runtime_permission:effect:${effectDigest}`,
    commandId: requestId, effectRef: `effect:${effectDigest}`, deliveryRef,
    authority: { ...input.route.authority }, payloadJson,
    observedAtIso: input.observedAtIso, acceptedAtIso: input.observedAtIso,
    lease: null, acknowledgedAtIso: null,
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Unsupported hosted approval canonical value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function fingerprintOpenCodeApprovalSessionRecord(record: {
  teamId: string
  laneId?: string
  runId?: string | null
  memberName: string
  providerId: string
  opencodeSessionId: string
  projectPath: string
  hostKey: string
  openCodeArtifactDigest?: `sha256:${string}` | null
  profileRootKey: string
  projectBehaviorFingerprint: string
  managedConfigFingerprint?: string
  sourceAuthFingerprint: string | null
  managedAuthFingerprint: string | null
  toolApprovalMode?: 'auto' | 'manual'
  runtimePid?: number
  createdAt: string
}): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 1,
    teamId: record.teamId,
    laneId: record.laneId ?? 'primary',
    runId: record.runId ?? null,
    memberName: record.memberName,
    providerId: record.providerId,
    opencodeSessionId: record.opencodeSessionId,
    projectPath: record.projectPath,
    hostKey: record.hostKey,
    openCodeArtifactDigest: record.openCodeArtifactDigest ?? null,
    profileRootKey: record.profileRootKey,
    projectBehaviorFingerprint: record.projectBehaviorFingerprint,
    managedConfigFingerprint: record.managedConfigFingerprint ?? null,
    sourceAuthFingerprint: record.sourceAuthFingerprint,
    managedAuthFingerprint: record.managedAuthFingerprint,
    toolApprovalMode: record.toolApprovalMode ?? null,
    runtimePid: record.runtimePid ?? null,
    createdAt: record.createdAt,
  })).digest('hex')
}

export function liveEffectFingerprint(context: OpenCodePermissionEffectContext): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 1,
    sessionRecordFingerprint: fingerprintOpenCodeApprovalSessionRecord(context.record),
    hostKey: context.host.hostKey,
    profileRootKey: context.host.profileRootKey,
    projectPath: context.host.projectPath,
    projectBehaviorFingerprint: context.host.projectBehaviorFingerprint,
    openCodeArtifactDigest: context.host.openCodeArtifactDigest ?? null,
    baseUrl: context.host.baseUrl ?? null,
    port: context.host.port ?? null,
    runtimePid: context.host.pid,
    processStartedAtMs: context.host.processStartedAtMs,
    resolvedConfigFingerprint: context.host.resolvedConfigFingerprint,
    preparedProfile: {
      profileRootKey: context.profile.profileRootKey,
      projectPath: context.profile.projectPath,
      projectBehaviorFingerprint: context.profile.projectBehaviorFingerprint,
      managedConfigFingerprint: context.profile.managedConfigFingerprint,
      sourceAuthFingerprint: context.profile.sourceAuthFingerprint,
      managedAuthFingerprint: context.profile.managedAuthFingerprint,
    },
  })).digest('hex')
}


const HOST_PATH = /(?:^|[\s"'`(])(?:~[\\/]|[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|etc|private|mnt|Volumes|opt)\/)/
function safeSummary(value: string): string {
  return value.length > 0 && Buffer.byteLength(value) <= 2048 && !/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !HOST_PATH.test(value)
    ? value : 'OpenCode permission requested'
}

function category(permission: OpenCodeNormalizedPermission): 'file_change' | 'command' | 'network' | 'other' {
  const value = `${permission.tool ?? ''} ${permission.kind ?? ''}`.toLowerCase()
  if (value.includes('bash') || value.includes('command') || value.includes('shell')) return 'command'
  if (value.includes('edit') || value.includes('write') || value.includes('file')) return 'file_change'
  if (value.includes('network') || value.includes('fetch') || value.includes('web')) return 'network'
  return 'other'
}
