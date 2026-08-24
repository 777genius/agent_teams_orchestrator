import { createHash, createHmac } from 'node:crypto'

import { describe, expect, test } from 'bun:test'
import { fingerprintFixtureEffect } from '../../../scripts/e2e/hosted-actual-owner/fingerprint-fixture.js'

import {
  OpenCodePermissionEffectNotAuthorizedError,
  type OpenCodeHostedApprovalObservedPermission,
  type OpenCodePermissionEffectContext,
} from '../opencode/OpenCodeSessionBridge.js'
import type { OpenCodeNormalizedPermission, OpenCodeSessionRecord } from '../opencode/types.js'
import type { HostedControlProcessIdentity } from './HostedControlProcessIdentity.js'
import { HostedApprovalRuntimeBindingFence } from './HostedApprovalRuntimeBindingFence.js'
import {
  ingressRecordForObservedPermission,
  OpenCodeHostedApprovalRuntimeAdapter,
} from './OpenCodeHostedApprovalRuntimeAdapter.js'
import {
  assertHostedApprovalRuntimeBinding,
  canonicalHostedApprovalRuntimeBinding,
  digestHostedApprovalRuntimeBinding,
  HOSTED_APPROVAL_BINDING_GOLDEN_DIGEST,
  HOSTED_APPROVAL_TRANSITION_CONTRACT_SHA256,
  liveHostedApprovalEffectFingerprint,
  OpenCodeHostedApprovalRuntimeBindingSource,
} from './OpenCodeHostedApprovalRuntimeBindingSource.js'
import {
  HOSTED_APPROVAL_TRANSITION_BINDING_VECTORS,
  HOSTED_APPROVAL_TRANSITION_TEST_KEY_HEX,
} from './HostedApprovalTransitionBindingContract.js'

const teamId = `team_${'1'.repeat(32)}`
const memberId = `member_${'2'.repeat(32)}`
const runtimeInstanceId = `runtime_instance_${'3'.repeat(32)}`
const configGeneration = `config_generation_${'4'.repeat(32)}`
const artifact = `sha256:${'a'.repeat(64)}` as const
const hostProcess: HostedControlProcessIdentity = { pid: 88, startIdentity: `start_${'9'.repeat(64)}` }

function fixture(memberName = 'lead') {
  const record: OpenCodeSessionRecord = {
    teamId, laneId: 'primary', runId: `run_${'5'.repeat(32)}`, memberName,
    providerId: 'opencode', selectedModel: 'openai/test', projectPath: '/tmp/project',
    profileRootKey: 'profile', hostKey: 'host', openCodeArtifactDigest: artifact,
    toolApprovalMode: 'manual', runtimePid: hostProcess.pid, resolvedBehaviorFingerprint: null,
    opencodeSessionId: 'session_test', lastCanonicalCursor: null, lastKnownRawStatus: null,
    lastKnownDurableState: null, sourceAuthFingerprint: null, managedAuthFingerprint: 'managed-auth',
    projectBehaviorFingerprint: 'behavior', managedConfigFingerprint: 'managed-config', staleReason: null,
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  }
  const context: OpenCodePermissionEffectContext = {
    record,
    profile: {
      projectPath: '/tmp/project', profileRootKey: 'profile', profileRootPath: '/tmp/profile',
      projectBehaviorFingerprint: 'behavior', behaviorSources: [], managedConfig: {},
      managedConfigFingerprint: 'managed-config', homePath: '/tmp/profile/home', tmpPath: '/tmp/profile/tmp',
      xdgConfigHome: '/tmp/profile/config', xdgDataHome: '/tmp/profile/data',
      xdgCacheHome: '/tmp/profile/cache', managedAuthPath: '/tmp/profile/auth.json',
      sourceAuthPath: null, sourceAuthFingerprint: null, managedAuthFingerprint: 'managed-auth',
      authState: 'ok', env: {},
    },
    host: {
      hostKey: 'host', profileRootKey: 'profile', projectPath: '/tmp/project',
      projectBehaviorFingerprint: 'behavior', openCodeArtifactDigest: artifact,
      baseUrl: 'http://127.0.0.1:4096', port: 4096, pid: hostProcess.pid,
      processStartedAtMs: 10, resolvedConfigFingerprint: 'resolved-config',
    },
  }
  const host = {
    context,
    processIdentity: hostProcess,
    endpointIdentity: { address: '127.0.0.1' as const, port: 4096, ...hostProcess },
    executedArtifactDigest: artifact,
    resolvedConfigFingerprint: 'resolved-config',
  }
  let current = true
  let currentHost = host
  const capability = {
    schemaVersion: 2 as const, protocol: 'agent-teams-hosted-approval-v2' as const,
    authentication: 'opencode-basic' as const, runtimeInstanceId, configGeneration,
  }
  const fence = new HostedApprovalRuntimeBindingFence()
  const source = new OpenCodeHostedApprovalRuntimeBindingSource({
    fence,
    lifecycle: { read: async () => ({
      outerAuthority: {
        deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
        teamId, restoreGeneration: 2,
        mountBinding: { mountGeneration: 3, declaredRootHash: '7'.repeat(64) },
      },
      routes: [{ routeId: 'route_test', runId: record.runId!, planGeneration: 7,
        laneId: 'primary', authorityGeneration: 'generation_test' }],
    }) },
    membership: { read: async () => ({ members: [{
      routeId: 'route_test', memberName, principalId: 'actor_owner', deliveryOwnerId: memberId,
    }] }) },
    credentials: { read: async () => [{
      routeId: 'route_test', credentialGeneration: 8, credentialId: 'credential_test',
    }] },
    sessions: { get: async () => record },
    hosts: { read: async () => currentHost },
    capability: { read: async () => capability },
    owner: {
      socketPath: '/run/agent-teams/owner.sock', processId: 77,
      getOwnerBinding: () => ({
        ownerAuthority: 'owner-authority_binding-test', ownerGeneration: 9,
        ownerSessionId: 'owner-session_binding-test',
        socketIdentity: { device: '10', inode: '11', uid: 1000, gid: 1000, mode: 0o600 },
      }),
      isCurrent: async () => current,
    },
    captureProcessIdentity: async pid => ({
      pid,
      startIdentity: `start_${'b'.repeat(64)}` as `start_${string}`,
    }),
  })
  return {
    source, fence, host, record, capability,
    setCurrent: (value: boolean) => { current = value },
    setHost: (value: typeof host) => { currentHost = value },
  }
}

describe('OpenCodeHostedApprovalRuntimeBindingSource', () => {
  test('captures during initial provisioning from independent orchestrator ports', async () => {
    const { source, host } = fixture()
    const binding = await source.capture()
    expect(binding.routes[0]).toMatchObject({
      routeId: 'route_test',
      authority: { sessionId: 'session_test', runtimeInstanceId, deliveryOwnerId: memberId },
      openCodeBinding: {
        openCodeArtifactDigest: artifact,
        liveEffectFingerprint: liveHostedApprovalEffectFingerprint(host, {
          schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', authentication: 'opencode-basic',
          runtimeInstanceId, configGeneration,
        }),
      },
    })
    expect(binding.memberIdsByName).toEqual({ lead: memberId })
    expect(binding.actorMembers).toEqual({ actor_owner: memberId })
    expect(HOSTED_APPROVAL_TRANSITION_CONTRACT_SHA256).toBe(
      'c4304b8eb1ed77145141390294575f403c9f041c6ff6ad5b6f9f21f8b1b9d39e',
    )
    expect(() => assertHostedApprovalRuntimeBinding(binding)).not.toThrow()
  })

  test('rejects PID/start-identity endpoint substitution', async () => {
    const { source, host, setHost } = fixture()
    setHost({
      ...host,
      endpointIdentity: {
        ...host.endpointIdentity,
        startIdentity: `start_${'8'.repeat(64)}` as `start_${string}`,
      },
    })
    await expect(source.capture()).rejects.toThrow('unavailable')
  })

  test('keeps the independent acceptance fixture fingerprint byte-identical to runtime', () => {
    const { host, capability } = fixture()
    expect(fingerprintFixtureEffect(host.context, {
      processStartIdentity: host.processIdentity.startIdentity,
      capability,
    })).toBe(liveHostedApprovalEffectFingerprint(host, capability))
  })

  test('takes a source-produced route to one POST and rejects live proof substitutions before POST', async () => {
    type Proof = ReturnType<typeof fixture>['host'] & {
      capability: ReturnType<typeof fixture>['capability']
    }
    type Substitution = {
      proof?: (value: Proof) => Proof
      context?: (value: OpenCodePermissionEffectContext) => OpenCodePermissionEffectContext
      ownerToken?: boolean
    }
    const execute = async (substitution: Substitution = {}) => {
      const { source, host, record, capability } = fixture()
      const binding = await source.capture()
      const route = binding.routes[0]!
      const rawPermission = {
        id: 'permission_source_binding', sessionID: record.opencodeSessionId,
        permission: 'bash', patterns: [], metadata: {}, always: [],
      }
      const permission: OpenCodeNormalizedPermission = {
        requestId: 'permission_source_binding', sessionId: record.opencodeSessionId,
        tool: 'bash', title: 'Run provider effect', kind: 'tool',
        raw: rawPermission,
      }
      const providerObservation: OpenCodeHostedApprovalObservedPermission = {
        capability,
        permission: {
          requestId: permission.requestId, sessionId: record.opencodeSessionId,
          requestIncarnation: `request_incarnation_${'c'.repeat(32)}`,
          permissionDigest: 'd'.repeat(64), rawPermission,
        },
        normalized: permission,
      }
      const expectedEffectRef = ingressRecordForObservedPermission({
        route, permission, providerObservation, observedAtIso: '2026-08-15T00:00:00.000Z',
      }).effectRef
      let posts = 0
      const bridge = {
        observeHostedApprovalPermissions: async () => [providerObservation],
        captureHostedApprovalBinding: async () => {
          const proof = { ...host, capability }
          return substitution.proof ? substitution.proof(proof) : proof
        },
        answerPermission: async (_record: OpenCodeSessionRecord, parameters: {
          validatePreparedEffect?: (context: OpenCodePermissionEffectContext) => Promise<boolean | { consume(): boolean }>
          authorizeEffect?: (context: OpenCodePermissionEffectContext) => Promise<boolean | { consume(): boolean }>
        }) => {
          const context = substitution.context ? substitution.context(host.context) : host.context
          const prepared = await parameters.validatePreparedEffect?.(context)
          if (!prepared || (typeof prepared !== 'boolean' && !prepared.consume())) {
            throw new OpenCodePermissionEffectNotAuthorizedError()
          }
          const authorized = await parameters.authorizeEffect?.(context)
          if (!authorized || (typeof authorized !== 'boolean' && !authorized.consume())) {
            throw new OpenCodePermissionEffectNotAuthorizedError()
          }
          posts += 1
        },
      }
      const adapter = new OpenCodeHostedApprovalRuntimeAdapter(
        { get: async () => record, prepareEffectToken: async () => ({ consume: () => true }) },
        bridge as never,
        Date.now,
        { prepareEffectToken: () => ({ consume: () => true }) },
      )
      const result = await adapter.deliver({
        route, requestId: permission.requestId, expectedEffectRef, decision: 'allow',
        revalidate: async () => true,
        prepareEffectToken: async () => substitution.ownerToken === false
          ? null : { consume: () => true },
      })
      return { result, posts }
    }

    expect(await execute()).toEqual({ result: 'delivered', posts: 1 })
    for (const substitution of [
      { proof: (proof: Proof) => ({ ...proof, processIdentity: { ...proof.processIdentity,
        startIdentity: `start_${'1'.repeat(64)}` } }) },
      { proof: (proof: Proof) => ({ ...proof, endpointIdentity: { ...proof.endpointIdentity,
        startIdentity: `start_${'2'.repeat(64)}` } }) },
      { context: (context: OpenCodePermissionEffectContext) => ({ ...context, profile: {
        ...context.profile, managedAuthFingerprint: 'substituted-profile',
      } }) },
      { context: (context: OpenCodePermissionEffectContext) => ({ ...context, host: {
        ...context.host, hostKey: 'substituted-host',
      } }) },
      { proof: (proof: Proof) => ({ ...proof, capability: { ...proof.capability,
        configGeneration: `config_generation_${'f'.repeat(32)}`,
      } }) },
      { ownerToken: false },
    ] satisfies Substitution[]) {
      expect(await execute(substitution)).toEqual({ result: 'not_started', posts: 0 })
    }
  })

  test('fails closed when an independent source is no longer current', async () => {
    const { source, setCurrent } = fixture()
    setCurrent(false)
    await expect(source.capture()).rejects.toThrow('unavailable')
  })

  test('holds the shared transition pin across fresh rereads', async () => {
    const { source, fence } = fixture()
    const pin = fence.tryAcquireBindingPin()
    if (!pin) throw new Error('expected binding pin')
    await expect(source.capture(pin)).resolves.toMatchObject({ routes: [{ routeId: 'route_test' }] })
    let mutated = false
    const mutation = fence.withBindingMutation(async () => { mutated = true })
    await Promise.resolve()
    expect(mutated).toBe(false)
    pin.release()
    await mutation
    expect(mutated).toBe(true)
  })

  test('closed schema rejects extra and reordered fields', async () => {
    const binding = await fixture().source.capture()
    const first = binding.routes[0]!
    const extraFields = [
      { extra: true, ...binding },
      { ...binding, outerAuthority: { ...binding.outerAuthority, extra: true } },
      { ...binding, outerAuthority: { ...binding.outerAuthority,
        mountBinding: { ...binding.outerAuthority.mountBinding, extra: true } } },
      { ...binding, routes: [{ ...first, extra: true }] },
      { ...binding, routes: [{ ...first, authority: { ...first.authority, extra: true } }] },
      { ...binding, routes: [{ ...first, scope: { ...first.scope, extra: true } }] },
      { ...binding, routes: [{ ...first,
        openCodeBinding: { ...first.openCodeBinding, extra: true } }] },
      { ...binding, owner: { ...binding.owner, extra: true } },
      { ...binding, owner: { ...binding.owner,
        socketIdentity: { ...binding.owner.socketIdentity, extra: true } } },
      { ...binding, owner: { ...binding.owner,
        processIdentity: { ...binding.owner.processIdentity, extra: true } } },
      { ...binding, capability: { ...binding.capability, extra: true } },
    ]
    for (const value of extraFields) {
      expect(() => assertHostedApprovalRuntimeBinding(value as never)).toThrow('schema')
    }
    const reordered = { routes: binding.routes, outerAuthority: binding.outerAuthority,
      memberIdsByName: binding.memberIdsByName, actorMembers: binding.actorMembers,
      owner: binding.owner, capability: binding.capability }
    expect(() => assertHostedApprovalRuntimeBinding(reordered as never)).toThrow('schema')
  })

  test('rejects coercive, wrong-shape, and over-limit frozen binding values', async () => {
    const binding = await fixture().source.capture()
    const first = binding.routes[0]!
    const coercive = {
      ...binding,
      outerAuthority: { ...binding.outerAuthority, bootId: 123, workspaceId: 456 },
      routes: [{
        ...first, routeId: 101, memberName: 10,
        authority: { ...first.authority, laneId: 789, credentialId: 202, sessionId: 303 },
        scope: { ...first.scope, workspaceId: 456 },
        openCodeBinding: { ...first.openCodeBinding, credentialId: 202 },
      }],
    }
    const wrongShapes = [
      null,
      { ...binding, routes: {} },
      { ...binding, routes: [null] },
      { ...binding, memberIdsByName: [] },
      { ...binding, actorMembers: null },
      { ...binding, outerAuthority: { ...binding.outerAuthority, mountBinding: null } },
      { ...binding, owner: null },
      { ...binding, owner: { ...binding.owner, socketIdentity: [] } },
      { ...binding, capability: [] },
    ]
    expect(() => assertHostedApprovalRuntimeBinding(coercive as never)).toThrow('schema')
    for (const value of wrongShapes) {
      expect(() => assertHostedApprovalRuntimeBinding(value as never)).toThrow('schema')
    }

    const memberIdsByName = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
      `name_${String(index).padStart(3, '0')}`,
      `member_${index.toString(16).padStart(32, '0')}`,
    ]))
    const actorMembers = Object.fromEntries(Object.values(memberIdsByName).map((memberId, index) => [
      `actor_x${String(index).padStart(3, '0')}`, memberId,
    ]))
    expect(() => assertHostedApprovalRuntimeBinding({
      ...binding, memberIdsByName, actorMembers,
    } as never)).toThrow('schema')

    const sparseRoutes = new Array(1) as typeof binding.routes
    expect(() => assertHostedApprovalRuntimeBinding({ ...binding, routes: sparseRoutes }))
      .toThrow('schema')
    const deletedRoutes = [...binding.routes]
    Reflect.deleteProperty(deletedRoutes, '0')
    expect(() => canonicalHostedApprovalRuntimeBinding({ ...binding, routes: deletedRoutes }))
      .toThrow('schema')
  })

  test('reproduces the frozen canonical binding digest golden', () => {
    const binding = {
      outerAuthority: {
        deploymentId: 'deployment_wire-test', bootId: 'boot_wire-test',
        workspaceId: 'workspace_44444444444444444444444444444444',
        teamId: `team_${'1'.repeat(32)}`, restoreGeneration: 2,
        mountBinding: { mountGeneration: 3, declaredRootHash: 'e'.repeat(64) },
      },
      routes: [{
        routeId: 'route_wire-test',
        authority: {
          deploymentId: 'deployment_wire-test', teamId: `team_${'1'.repeat(32)}`,
          runId: `run_${'5'.repeat(32)}`, planGeneration: 7, laneId: 'primary', providerId: 'opencode' as const,
          credentialGeneration: 5, credentialId: 'credential_wire-test', sessionId: 'session_wire-test',
          runtimeInstanceId: `runtime_instance_${'3'.repeat(32)}`, deliveryOwnerId: `member_${'2'.repeat(32)}`,
        },
        scope: {
          principalId: 'actor_owner', workspaceId: 'workspace_44444444444444444444444444444444',
          teamId: `team_${'1'.repeat(32)}`, authorityGeneration: 'generation_wire-test', restoreGeneration: 2,
        },
        memberName: 'lead',
        openCodeBinding: {
          toolApprovalMode: 'manual' as const, planGeneration: 7, credentialGeneration: 5,
          credentialId: 'credential_wire-test', runtimeInstanceId: `runtime_instance_${'3'.repeat(32)}`,
          deliveryOwnerId: `member_${'2'.repeat(32)}`, openCodeArtifactDigest: `sha256:${'a'.repeat(64)}` as const,
          sessionRecordFingerprint: '7'.repeat(64), liveEffectFingerprint: '8'.repeat(64),
        },
      }],
      memberIdsByName: { lead: `member_${'2'.repeat(32)}` },
      actorMembers: { actor_owner: `member_${'2'.repeat(32)}` },
      owner: {
        teamId: `team_${'1'.repeat(32)}`, ownerAuthority: 'owner-authority_wire-test', ownerGeneration: 7,
        ownerSessionId: 'owner-session_wire-test', socketPath: '/run/agent-teams/owner.sock',
        socketIdentity: { device: '10', inode: '20', uid: 1000, gid: 1000, mode: 384 },
        processIdentity: {
          pid: 2345,
          startIdentity: `start_${'c'.repeat(64)}` as `start_${string}`,
        },
      },
      capability: {
        schemaVersion: 2 as const, protocol: 'agent-teams-hosted-approval-v2' as const,
        authentication: 'opencode-basic' as const, runtimeInstanceId: `runtime_instance_${'3'.repeat(32)}`,
        configGeneration: `config_generation_${'6'.repeat(32)}`,
      },
    }
    expect(digestHostedApprovalRuntimeBinding(binding)).toBe(HOSTED_APPROVAL_BINDING_GOLDEN_DIGEST)
  })

  test('rejects negative zero in every zero-admitting binding integer before digest', async () => {
    const binding = await fixture().source.capture()
    const invalidBindings = [
      { ...binding, outerAuthority: { ...binding.outerAuthority, restoreGeneration: -0 } },
      { ...binding, outerAuthority: {
        ...binding.outerAuthority,
        mountBinding: { ...binding.outerAuthority.mountBinding, mountGeneration: -0 },
      } },
      { ...binding, routes: binding.routes.map(route => ({
        ...route,
        scope: { ...route.scope, restoreGeneration: -0 },
      })) },
      { ...binding, routes: binding.routes.map(route => ({
        ...route,
        authority: { ...route.authority, planGeneration: -0 },
        openCodeBinding: { ...route.openCodeBinding, planGeneration: -0 },
      })) },
      { ...binding, routes: binding.routes.map(route => ({
        ...route,
        authority: { ...route.authority, credentialGeneration: -0 },
        openCodeBinding: { ...route.openCodeBinding, credentialGeneration: -0 },
      })) },
      { ...binding, owner: { ...binding.owner, ownerGeneration: -0 } },
      { ...binding, owner: {
        ...binding.owner,
        socketIdentity: { ...binding.owner.socketIdentity, uid: -0 },
      } },
      { ...binding, owner: {
        ...binding.owner,
        socketIdentity: { ...binding.owner.socketIdentity, gid: -0 },
      } },
      { ...binding, owner: {
        ...binding.owner,
        processIdentity: { ...binding.owner.processIdentity, pid: -0 },
      } },
    ]
    for (const invalidBinding of invalidBindings) {
      expect(() => digestHostedApprovalRuntimeBinding(invalidBinding)).toThrow('schema')
    }
  })

  test('resolves a contract-valid numeric member name', async () => {
    const binding = await fixture('10').source.capture()
    expect(binding.routes[0]?.memberName).toBe('10')
    expect(binding.memberIdsByName['10']).toBe(memberId)
    expect(() => canonicalHostedApprovalRuntimeBinding(binding)).not.toThrow()
  })

  test('canonicalizes numeric member names by UTF-16 order for roundtrip and digest', async () => {
    const captured = await fixture().source.capture()
    const first = captured.routes[0]!
    const secondMemberId = `member_${'3'.repeat(32)}`
    const binding = {
      ...captured,
      routes: [{
        ...first,
        routeId: 'route_10',
        memberName: '10',
      }, {
        ...first,
        routeId: 'route_2',
        authority: {
          ...first.authority,
          sessionId: 'session_test_2',
          deliveryOwnerId: secondMemberId,
        },
        scope: { ...first.scope, principalId: 'actor_2' },
        memberName: '2',
        openCodeBinding: { ...first.openCodeBinding, deliveryOwnerId: secondMemberId },
      }],
      memberIdsByName: { '10': memberId, '2': secondMemberId },
      actorMembers: { actor_2: secondMemberId, actor_owner: memberId },
    }
    const canonical = canonicalHostedApprovalRuntimeBinding(binding)
    expect(canonical).toContain(`"memberIdsByName":{"10":"${memberId}","2":"${secondMemberId}"}`)
    expect(JSON.parse(canonical)).toEqual(binding)
    expect(canonicalHostedApprovalRuntimeBinding(JSON.parse(canonical))).toBe(canonical)
    expect(digestHostedApprovalRuntimeBinding(binding)).toBe(
      '40a72fa011a7f0df1d73e3757b9a7aa83f4ebfcbab4ab95cc35705db9ff73ba1',
    )
  })

  test('reproduces frozen binding-carrying wire vectors without product imports', () => {
    for (const vector of HOSTED_APPROVAL_TRANSITION_BINDING_VECTORS) {
      expect(createHash('sha256').update(vector.canonicalUnsigned).digest('hex')).toBe(vector.unsignedSha256)
      expect(createHmac('sha256', Buffer.from(HOSTED_APPROVAL_TRANSITION_TEST_KEY_HEX, 'hex'))
        .update('agent-teams.hosted-approval-transition.owner-proof/v1')
        .update('\0')
        .update(vector.direction)
        .update('\0')
        .update(vector.canonicalUnsigned)
        .digest('hex')).toBe(vector.expectedHmacSha256)
    }
  })
})
