import { describe, expect, test } from 'bun:test'

import type { OpenCodeNormalizedPermission, OpenCodeSessionRecord } from '../opencode/types.js'
import { canonicalHostedApprovalDigest } from '../opencode/OpenCodeClientFactory.js'
import { OpenCodePermissionEffectNotAuthorizedError, type OpenCodePermissionEffectContext } from '../opencode/OpenCodeSessionBridge.js'
import type { HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import {
  fingerprintOpenCodeApprovalSessionRecord,
  ingressRecordForObservedPermission,
  liveEffectFingerprint,
  OpenCodeHostedApprovalRuntimeAdapter,
} from './OpenCodeHostedApprovalRuntimeAdapter.js'

const teamId = `team_${'1'.repeat(32)}`
const runId = `run_${'2'.repeat(32)}`
const laneId = 'secondary:opencode:worker'
const memberName = 'worker'
const openCodeArtifactDigest =
  'sha256:033c9c6f4f73e6d84a10c6edc3ab84e5aad078bf5c75f005721e1e94e85b8a02' as const
const record = {
  teamId, laneId, runId, memberName,
  providerId: 'opencode', toolApprovalMode: 'manual', opencodeSessionId: 'session_1', staleReason: null,
  hostKey: '/tmp/sandbox-project::profile-root::behavior-v1::config-v1',
  projectPath: '/tmp/sandbox-project', profileRootKey: 'profile-root', projectBehaviorFingerprint: 'behavior-v1',
  managedConfigFingerprint: 'config-v1', sourceAuthFingerprint: 'source-auth-v1',
  managedAuthFingerprint: 'managed-auth-v1', runtimePid: 1234,
  openCodeArtifactDigest,
  createdAt: '2026-08-13T09:00:00.000Z',
} as OpenCodeSessionRecord
const effectContext: OpenCodePermissionEffectContext = {
  record,
  profile: {
    projectPath: record.projectPath, profileRootKey: record.profileRootKey,
    profileRootPath: '/tmp/profile-root', projectBehaviorFingerprint: record.projectBehaviorFingerprint,
    behaviorSources: [], managedConfig: {}, managedConfigFingerprint: record.managedConfigFingerprint!,
    homePath: '/tmp/profile-root/home', tmpPath: '/tmp/profile-root/tmp',
    xdgConfigHome: '/tmp/profile-root/config', xdgDataHome: '/tmp/profile-root/data', xdgCacheHome: '/tmp/profile-root/cache',
    managedAuthPath: '/tmp/profile-root/auth.json', sourceAuthPath: '/tmp/source-auth.json',
    sourceAuthFingerprint: record.sourceAuthFingerprint, managedAuthFingerprint: record.managedAuthFingerprint,
    authState: 'ok', env: {},
  },
  host: {
    hostKey: record.hostKey, profileRootKey: record.profileRootKey, projectPath: record.projectPath,
    projectBehaviorFingerprint: record.projectBehaviorFingerprint, openCodeArtifactDigest,
    baseUrl: 'http://127.0.0.1:4096', port: 4096,
    pid: record.runtimePid!, processStartedAtMs: 1000,
    resolvedConfigFingerprint: 'resolved-fingerprint',
  },
}
const hostedCapability = {
  schemaVersion: 2 as const,
  protocol: 'agent-teams-hosted-approval-v2' as const,
  authentication: 'opencode-basic' as const,
  runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
  configGeneration: `config_generation_${'b'.repeat(32)}`,
}
const bindingProof = {
  context: effectContext,
  processIdentity: { pid: record.runtimePid!, startIdentity: `start_${'1'.repeat(64)}` },
  endpointIdentity: {
    address: '127.0.0.1' as const, port: 4096, pid: record.runtimePid!,
    startIdentity: `start_${'1'.repeat(64)}`,
  },
  executedArtifactDigest: openCodeArtifactDigest,
  resolvedConfigFingerprint: 'resolved-fingerprint',
  capability: hostedCapability,
}
const route: HostedApprovalRuntimeRoute = {
  routeId: 'route_1', memberName,
  authority: {
    deploymentId: 'deployment_test', teamId, runId, planGeneration: 2,
    laneId, providerId: 'opencode',
    credentialGeneration: 3, credentialId: 'credential_1', sessionId: 'session_1',
    runtimeInstanceId: hostedCapability.runtimeInstanceId, deliveryOwnerId: `member_${'4'.repeat(32)}`,
  },
  scope: {
    principalId: 'actor_owner', workspaceId: `workspace_${'3'.repeat(32)}`, teamId,
    authorityGeneration: 'generation_1', restoreGeneration: 1,
  },
  openCodeBinding: {
    toolApprovalMode: 'manual',
    planGeneration: 2, credentialGeneration: 3, credentialId: 'credential_1',
    runtimeInstanceId: hostedCapability.runtimeInstanceId, deliveryOwnerId: `member_${'4'.repeat(32)}`,
    openCodeArtifactDigest,
    sessionRecordFingerprint: fingerprintOpenCodeApprovalSessionRecord(record),
    liveEffectFingerprint: liveEffectFingerprint(bindingProof),
  },
}
const permission: OpenCodeNormalizedPermission = {
  requestId: 'permission_1', sessionId: 'session_1', tool: 'bash', title: 'Run tests', kind: 'tool',
  raw: { requestID: 'permission_1', sessionID: 'session_1', tool: 'bash', title: 'Run tests' },
}
const providerObservation = {
  capability: hostedCapability,
  permission: {
    requestId: permission.requestId,
    sessionId: permission.sessionId!,
    sessionIncarnation: `session_incarnation_${'d'.repeat(32)}`,
    requestIncarnation: `request_incarnation_${'c'.repeat(32)}`,
    permissionDigest: canonicalHostedApprovalDigest(permission.raw),
    rawPermission: permission.raw,
  },
  normalized: permission,
}
const observed = (value: OpenCodeNormalizedPermission = permission) => ({
  ...providerObservation,
  permission: {
    ...providerObservation.permission,
    requestId: value.requestId,
    sessionId: value.sessionId!,
    permissionDigest: canonicalHostedApprovalDigest(value.raw),
    rawPermission: value.raw,
  },
  normalized: value,
})
const expectedEffectRef = ingressRecordForObservedPermission({
  route, permission, providerObservation, observedAtIso: '2026-08-13T10:00:00.000Z',
}).effectRef
const matchingArtifacts = {
  prepareEffectToken: (expectedDigest: string) => expectedDigest === openCodeArtifactDigest
    ? { consume: () => true }
    : null,
}
function makeAdapter(
  store: ConstructorParameters<typeof OpenCodeHostedApprovalRuntimeAdapter>[0],
  bridge: ConstructorParameters<typeof OpenCodeHostedApprovalRuntimeAdapter>[1],
  now: () => number = Date.now,
  artifacts: ConstructorParameters<typeof OpenCodeHostedApprovalRuntimeAdapter>[3] = matchingArtifacts,
) {
  return new OpenCodeHostedApprovalRuntimeAdapter(store, {
    captureHostedApprovalBinding: async () => bindingProof,
    ...bridge,
  } as never, now, artifacts)
}
describe('OpenCodeHostedApprovalRuntimeAdapter R2', () => {
  test('keeps current upstream capability-false before raw permission observation or reply', async () => {
    let rawObservations = 0
    let replies = 0
    const adapter = makeAdapter(
      { get: async () => record } as never,
      {
        observeHostedApprovalPermissions: async () => {
          throw new Error('capability unavailable')
        },
        answerPermission: async () => { replies += 1 },
      } as never,
    )

    await expect(adapter.observe(route)).rejects.toThrow('capability unavailable')
    expect(await adapter.deliver({
      route,
      requestId: permission.requestId,
      expectedEffectRef,
      decision: 'allow',
      revalidate: async () => true,
    })).toBe('unavailable')
    expect({ rawObservations, replies }).toEqual({ rawObservations: 0, replies: 0 })
  })

  test('observes the exact admitted lane/session and never converts a permission probe failure to empty', async () => {
    const gets: unknown[][] = []
    const adapter = makeAdapter(
      { get: async (...args: unknown[]) => { gets.push(args); return record } } as never,
      { observeHostedApprovalPermissions: async () => [observed()], answerPermission: async () => undefined } as never,
      () => Date.parse('2026-08-13T10:00:00.000Z'),
    )
    expect(await adapter.observe(route)).toMatchObject([{ permission: { requestId: 'permission_1' } }])
    expect(gets).toEqual([[teamId, route.authority.laneId, route.memberName]])

    const unavailable = makeAdapter(
      { get: async () => record } as never,
      { observeHostedApprovalPermissions: async () => { throw new Error('network') }, answerPermission: async () => undefined } as never,
    )
    await expect(unavailable.observe(route)).rejects.toThrow('network')
  })

  test('performs zero provider observations when the installed artifact mismatches admission', async () => {
    let providerObservations = 0
    const adapter = makeAdapter(
      { get: async () => record } as never,
      {
        observeHostedApprovalPermissions: async (
          _record: OpenCodeSessionRecord,
          authorize?: (context: OpenCodePermissionEffectContext) => Promise<boolean>,
        ) => {
          if (authorize && !(await authorize(effectContext))) {
            throw new OpenCodePermissionEffectNotAuthorizedError()
          }
          providerObservations += 1
          return [observed()]
        },
        answerPermission: async () => undefined,
      } as never,
      Date.now,
      { prepareEffectToken: () => null },
    )

    await expect(adapter.observe(route)).rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
    expect(providerObservations).toBe(0)
  })

  test('performs zero reply observations and POSTs when the artifact rotates before reply', async () => {
    let artifactChecks = 0
    let replyObservations = 0
    let posts = 0
    const adapter = makeAdapter(
      { get: async () => record } as never,
      {
        observeHostedApprovalPermissions: async (
          _record: OpenCodeSessionRecord,
          authorize?: (context: OpenCodePermissionEffectContext) => Promise<boolean>,
        ) => {
          if (authorize && !(await authorize(effectContext))) {
            throw new OpenCodePermissionEffectNotAuthorizedError()
          }
          return [observed()]
        },
        answerPermission: async (_record: OpenCodeSessionRecord, params: {
          authorizeObservation?: (context: OpenCodePermissionEffectContext) => Promise<boolean>
        }) => {
          if (params.authorizeObservation && !(await params.authorizeObservation(effectContext))) {
            throw new OpenCodePermissionEffectNotAuthorizedError()
          }
          replyObservations += 1
          posts += 1
        },
      } as never,
      Date.now,
      {
        prepareEffectToken: () => ++artifactChecks === 1
          ? { consume: () => true }
          : null,
      },
    )

    expect(await adapter.deliver({
      route,
      requestId: permission.requestId,
      expectedEffectRef,
      decision: 'allow',
      revalidate: async () => true,
    })).toBe('not_started')
    expect({ artifactChecks, replyObservations, posts }).toEqual({
      artifactChecks: 2,
      replyObservations: 0,
      posts: 0,
    })
  })

  test('revalidates immediately before effect and distinguishes not-started from ambiguous', async () => {
    let answers = 0
    const make = (options: { permissions?: OpenCodeNormalizedPermission[][]; answerThrows?: boolean }) => {
      let probe = 0
      return makeAdapter(
        { get: async () => record } as never,
        {
          observeHostedApprovalPermissions: async () =>
            ((options.permissions ?? [[permission], []])[probe++] ?? []).map(observed),
          answerPermission: async (_record: OpenCodeSessionRecord, params: { authorizeEffect?: (context: OpenCodePermissionEffectContext) => Promise<boolean> }) => {
            if (params.authorizeEffect && !(await params.authorizeEffect(effectContext))) throw new OpenCodePermissionEffectNotAuthorizedError()
            answers += 1; if (options.answerThrows) throw new Error('uncertain')
          },
        } as never,
      )
    }
    expect(await make({}).deliver({ route, requestId: 'permission_1', expectedEffectRef, decision: 'allow', revalidate: async () => false })).toBe('not_started')
    expect(answers).toBe(0)
    expect(await make({ permissions: [[]] }).deliver({ route, requestId: 'permission_1', expectedEffectRef, decision: 'allow', revalidate: async () => true })).toBe('not_started')
    expect(await make({ answerThrows: true }).deliver({ route, requestId: 'permission_1', expectedEffectRef, decision: 'allow', revalidate: async () => true })).toBe('ambiguous')
    expect(await make({}).deliver({ route, requestId: 'permission_1', expectedEffectRef, decision: 'allow', revalidate: async () => true })).toBe('delivered')
  })

  test('fences after delayed host preparation and performs zero POSTs for rotated or replacement hosts', async () => {
    for (const rotate of [
      (context: OpenCodePermissionEffectContext) => ({ ...context, host: { ...context.host, pid: 4321 } }),
      (context: OpenCodePermissionEffectContext) => ({ ...context, host: { ...context.host, processStartedAtMs: 2000 } }),
      (context: OpenCodePermissionEffectContext) => ({ ...context, host: { ...context.host, hostKey: `${context.host.hostKey}::replacement` } }),
      (context: OpenCodePermissionEffectContext) => ({ ...context, profile: { ...context.profile, managedAuthFingerprint: 'managed-auth-v2' } }),
    ]) {
      let posts = 0
      let release!: () => void
      const delayedHost = new Promise<void>(resolve => { release = resolve })
      const adapter = makeAdapter(
        { get: async () => record } as never,
        {
          observeHostedApprovalPermissions: async () => [observed()],
          answerPermission: async (_record: OpenCodeSessionRecord, params: { authorizeEffect?: (context: OpenCodePermissionEffectContext) => Promise<boolean> }) => {
            await delayedHost
            if (params.authorizeEffect && !(await params.authorizeEffect(rotate(effectContext)))) {
              throw new OpenCodePermissionEffectNotAuthorizedError()
            }
            posts += 1
          },
        } as never,
      )
      const pending = adapter.deliver({ route, requestId: permission.requestId, expectedEffectRef, decision: 'allow', revalidate: async () => true })
      await Promise.resolve(); release()
      expect(await pending).toBe('not_started')
      expect(posts).toBe(0)
    }
  })

  test('fails a rotated live session closed and redacts unsafe provider summaries', async () => {
    let reads = 0; let answers = 0
    const adapter = makeAdapter(
      { get: async () => ++reads === 1 ? record : null } as never,
      { observeHostedApprovalPermissions: async () => [observed()], answerPermission: async () => { answers += 1 } } as never,
    )
    expect(await adapter.deliver({ route, requestId: 'permission_1', expectedEffectRef, decision: 'deny', revalidate: async () => true })).toBe('unavailable')
    expect(answers).toBe(0)
    const unsafe = ingressRecordForObservedPermission({
      route, observedAtIso: '2026-08-13T10:00:00.000Z',
      permission: { ...permission, title: 'Read /Users/alice/secret.txt' },
    })
    expect(JSON.parse(unsafe.payloadJson)).toMatchObject({ summary: 'OpenCode permission requested' })
  })

  test('binds canonical raw permission incarnation while ignoring object key order', () => {
    const first = ingressRecordForObservedPermission({ route, permission, observedAtIso: '2026-08-13T10:00:00.000Z' })
    const reordered = ingressRecordForObservedPermission({
      route, observedAtIso: '2026-08-13T10:00:01.000Z',
      permission: { ...permission, raw: { title: 'Run tests', tool: 'bash', sessionID: 'session_1', requestID: 'permission_1' } },
    })
    const replaced = ingressRecordForObservedPermission({
      route, observedAtIso: '2026-08-13T10:00:02.000Z',
      permission: { ...permission, raw: { ...permission.raw, metadata: { permission: 'write' } } },
    })
    expect(reordered).toMatchObject({ outboxId: first.outboxId, effectRef: first.effectRef, deliveryRef: first.deliveryRef })
    expect(replaced).not.toMatchObject({ outboxId: first.outboxId, effectRef: first.effectRef, deliveryRef: first.deliveryRef })
  })

  test('binds runtime restart, session recreation, and request incarnation with a reused raw digest', () => {
    const first = ingressRecordForObservedPermission({
      route, permission, providerObservation, observedAtIso: '2026-08-13T10:00:00.000Z',
    })
    const restarted = ingressRecordForObservedPermission({
      route, permission, observedAtIso: '2026-08-13T10:00:01.000Z',
      providerObservation: {
        ...providerObservation,
        capability: {
          ...providerObservation.capability,
          runtimeInstanceId: `runtime_instance_${'d'.repeat(32)}`,
        },
      },
    })
    const reusedRequest = ingressRecordForObservedPermission({
      route, permission, observedAtIso: '2026-08-13T10:00:02.000Z',
      providerObservation: {
        ...providerObservation,
        permission: {
          ...providerObservation.permission,
          requestIncarnation: `request_incarnation_${'e'.repeat(32)}`,
        },
      },
    })
    const recreatedSession = ingressRecordForObservedPermission({
      route, permission, observedAtIso: '2026-08-13T10:00:03.000Z',
      providerObservation: {
        ...providerObservation,
        permission: {
          ...providerObservation.permission,
          sessionIncarnation: `session_incarnation_${'f'.repeat(32)}`,
        },
      },
    })
    expect(restarted.effectRef).not.toBe(first.effectRef)
    expect(recreatedSession.effectRef).not.toBe(first.effectRef)
    expect(reusedRequest.effectRef).not.toBe(first.effectRef)
  })

  test('performs zero effects when the same run and session rotate live host or auth projection', async () => {
    for (const rotate of [
      (value: OpenCodeSessionRecord) => ({ ...value, hostKey: `${value.hostKey}::replacement` }),
      (value: OpenCodeSessionRecord) => ({ ...value, profileRootKey: 'profile-root-replacement' }),
      (value: OpenCodeSessionRecord) => ({ ...value, projectPath: '/tmp/other-sandbox-project' }),
      (value: OpenCodeSessionRecord) => ({ ...value, projectBehaviorFingerprint: 'behavior-v2' }),
      (value: OpenCodeSessionRecord) => ({ ...value, managedConfigFingerprint: 'config-v2' }),
      (value: OpenCodeSessionRecord) => ({ ...value, sourceAuthFingerprint: 'source-auth-v2' }),
      (value: OpenCodeSessionRecord) => ({ ...value, managedAuthFingerprint: 'managed-auth-v2' }),
      (value: OpenCodeSessionRecord) => ({ ...value, runtimePid: 4321 }),
      (value: OpenCodeSessionRecord) => ({ ...value, createdAt: '2026-08-13T09:00:01.000Z' }),
      (value: OpenCodeSessionRecord) => ({ ...value, toolApprovalMode: 'auto' as const }),
    ]) {
      let reads = 0; let answers = 0
      const adapter = makeAdapter(
        { get: async () => ++reads === 1 ? record : rotate(record) } as never,
        { observeHostedApprovalPermissions: async () => [observed()], answerPermission: async () => { answers += 1 } } as never,
      )
      expect(await adapter.deliver({ route, requestId: permission.requestId, expectedEffectRef, decision: 'allow', revalidate: async () => true })).toBe('unavailable')
      expect(answers).toBe(0)
    }
  })

  test('passes the exact persisted manual session image to the final token', async () => {
    let tokenRecord: OpenCodeSessionRecord | null = null
    let posts = 0
    const adapter = makeAdapter(
      {
        get: async () => record,
        prepareEffectToken: async (_teamId: string, _laneId: string, _memberName: string, expected: OpenCodeSessionRecord) => {
          tokenRecord = expected
          return { consume: () => true }
        },
      } as never,
      {
        observeHostedApprovalPermissions: async () => [observed()],
        answerPermission: async (received: OpenCodeSessionRecord, params: {
          validatePreparedEffect?: (context: OpenCodePermissionEffectContext) => Promise<boolean | { consume(): boolean }>
        }) => {
          const prepared = await params.validatePreparedEffect?.({ ...effectContext, record: received })
          if (!prepared || (typeof prepared !== 'boolean' && !prepared.consume())) {
            throw new OpenCodePermissionEffectNotAuthorizedError()
          }
          posts += 1
        },
      } as never,
    )
    expect(await adapter.deliver({
      route, requestId: permission.requestId, expectedEffectRef, decision: 'allow',
      revalidate: async () => true,
    })).toBe('delivered')
    expect(tokenRecord).toEqual(record)
    expect(posts).toBe(1)
  })
})
