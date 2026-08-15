import { describe, expect, test } from 'bun:test'

import type { OpenCodePermissionEffectContext } from '../opencode/OpenCodeSessionBridge.js'
import type { OpenCodePreparedProfile, OpenCodeSessionRecord } from '../opencode/types.js'
import { HostedApprovalRuntimeBindingFence } from './HostedApprovalRuntimeBindingFence.js'
import type { HostedApprovalRuntimeAdmission, HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import {
  fingerprintOpenCodeApprovalSessionRecord,
  liveEffectFingerprint,
} from './OpenCodeHostedApprovalRuntimeAdapter.js'
import { OpenCodeHostedApprovalRuntimeBindingSource } from './OpenCodeHostedApprovalRuntimeBindingSource.js'

const teamId = `team_${'1'.repeat(32)}`
const runId = `run_${'2'.repeat(32)}`
const memberId = `member_${'3'.repeat(32)}`
const runtimeInstanceId = `runtime_instance_${'4'.repeat(32)}`
const configGeneration = `config_generation_${'5'.repeat(32)}`
const artifact = `sha256:${'6'.repeat(64)}` as const

function fixture() {
  const profile: OpenCodePreparedProfile = {
    projectPath: '/tmp/project', profileRootKey: 'profile', profileRootPath: '/tmp/profile',
    projectBehaviorFingerprint: 'behavior', behaviorSources: [], managedConfig: {},
    managedConfigFingerprint: 'managed-config', homePath: '/tmp/profile/home',
    tmpPath: '/tmp/profile/tmp', xdgConfigHome: '/tmp/profile/config',
    xdgDataHome: '/tmp/profile/data', xdgCacheHome: '/tmp/profile/cache',
    managedAuthPath: '/tmp/profile/auth.json', sourceAuthPath: null,
    sourceAuthFingerprint: null, managedAuthFingerprint: 'managed-auth', authState: 'ok', env: {},
  }
  const record: OpenCodeSessionRecord = {
    teamId, laneId: 'primary', runId, memberName: 'lead', providerId: 'opencode',
    selectedModel: 'openai/test', projectPath: profile.projectPath,
    profileRootKey: profile.profileRootKey, hostKey: 'host', openCodeArtifactDigest: artifact,
    toolApprovalMode: 'manual', runtimePid: 88, resolvedBehaviorFingerprint: null,
    opencodeSessionId: 'session_test', lastCanonicalCursor: null, lastKnownRawStatus: null,
    lastKnownDurableState: null, sourceAuthFingerprint: null,
    managedAuthFingerprint: profile.managedAuthFingerprint,
    projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
    managedConfigFingerprint: profile.managedConfigFingerprint, staleReason: null,
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  }
  const context: OpenCodePermissionEffectContext = {
    record, profile, host: {
      hostKey: record.hostKey, profileRootKey: profile.profileRootKey,
      projectPath: profile.projectPath, projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      openCodeArtifactDigest: artifact, pid: 88, processStartedAtMs: 123,
      resolvedConfigFingerprint: 'resolved',
    },
  }
  const route: HostedApprovalRuntimeRoute = {
    routeId: 'route_test',
    authority: {
      deploymentId: 'deployment_test', teamId, runId, planGeneration: 7,
      laneId: 'primary', providerId: 'opencode', credentialGeneration: 8,
      credentialId: 'credential_test', sessionId: record.opencodeSessionId,
      runtimeInstanceId, deliveryOwnerId: memberId,
    },
    scope: {
      principalId: 'actor_owner', workspaceId: 'workspace_test', teamId,
      authorityGeneration: 'generation_test', restoreGeneration: 2,
    },
    memberName: 'lead',
    openCodeBinding: {
      toolApprovalMode: 'manual', planGeneration: 7, credentialGeneration: 8,
      credentialId: 'credential_test', runtimeInstanceId, deliveryOwnerId: memberId,
      openCodeArtifactDigest: artifact,
      sessionRecordFingerprint: fingerprintOpenCodeApprovalSessionRecord(record),
      liveEffectFingerprint: liveEffectFingerprint(context),
    },
  }
  let current = true
  const admission: HostedApprovalRuntimeAdmission = {
    schemaVersion: 1, admissionGeneration: 'approval-admission-generation_test',
    outerAuthority: {
      deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
      teamId, restoreGeneration: 2,
      mountBinding: { mountGeneration: 3, declaredRootHash: '7'.repeat(64) },
    },
    routes: [route], actorMembers: { actor_owner: memberId }, digest: '8'.repeat(64),
    isCurrent: async () => current,
    prepareEffectToken: async () => null,
  }
  const fence = new HostedApprovalRuntimeBindingFence()
  const source = new OpenCodeHostedApprovalRuntimeBindingSource({
    admission, fence,
    owner: {
      socketPath: '/run/agent-teams/owner.sock',
      processId: 77,
      getOwnerBinding: () => ({
        ownerAuthority: 'owner-authority_binding-test', ownerGeneration: 9,
        ownerSessionId: 'owner-session_binding-test',
        socketIdentity: { device: '10', inode: '11', uid: 1000, gid: 1000, mode: 0o600 },
      }),
      isCurrent: async () => current,
    },
    approvalOwner: { isAdmissionRecoveredCurrent: async () => current },
    sessions: { get: async () => record },
    bridge: { captureHostedApprovalBinding: async () => ({
      capability: {
        schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2',
        authentication: 'opencode-basic', runtimeInstanceId, configGeneration,
      },
      processIdentity: { pid: 88, startIdentity: `start_${'9'.repeat(64)}` }, context,
    }) },
    captureProcessIdentity: async pid => ({
      pid, startIdentity: `start_${'a'.repeat(64)}`,
    }),
  })
  return { source, route, fence, setCurrent: (value: boolean) => { current = value } }
}

describe('OpenCodeHostedApprovalRuntimeBindingSource', () => {
  test('captures the exact closed authoritative binding without a decision effect', async () => {
    const { source, route } = fixture()
    const binding = await source.capture()
    expect(binding).toEqual({
      outerAuthority: {
        deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
        teamId, restoreGeneration: 2,
        mountBinding: { mountGeneration: 3, declaredRootHash: '7'.repeat(64) },
      },
      routes: [route], memberIdsByName: { lead: memberId },
      actorMembers: { actor_owner: memberId },
      owner: {
        teamId, ownerAuthority: 'owner-authority_binding-test', ownerGeneration: 9,
        ownerSessionId: 'owner-session_binding-test', socketPath: '/run/agent-teams/owner.sock',
        socketIdentity: { device: '10', inode: '11', uid: 1000, gid: 1000, mode: 0o600 },
        processIdentity: { pid: 77, startIdentity: `start_${'a'.repeat(64)}` },
      },
      capability: {
        schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2',
        authentication: 'opencode-basic', runtimeInstanceId, configGeneration,
      },
    })
    expect(Object.keys(binding)).toEqual([
      'outerAuthority', 'routes', 'memberIdsByName', 'actorMembers', 'owner', 'capability',
    ])
    expect(Object.keys(binding.outerAuthority)).toEqual([
      'deploymentId', 'bootId', 'workspaceId', 'teamId', 'restoreGeneration', 'mountBinding',
    ])
    expect(Object.keys(binding.routes[0]!.authority)).toEqual([
      'deploymentId', 'teamId', 'runId', 'planGeneration', 'laneId', 'providerId',
      'credentialGeneration', 'credentialId', 'sessionId', 'runtimeInstanceId', 'deliveryOwnerId',
    ])
    expect(Object.keys(binding.owner)).toEqual([
      'teamId', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'socketPath',
      'socketIdentity', 'processIdentity',
    ])
    expect(Object.keys(binding.capability)).toEqual([
      'schemaVersion', 'protocol', 'authentication', 'runtimeInstanceId', 'configGeneration',
    ])
  })

  test('fails closed when recovered admission is no longer current', async () => {
    const { source, setCurrent } = fixture()
    setCurrent(false)
    await expect(source.capture()).rejects.toThrow('unavailable')
  })

  test('freshly rereads through the held transition pin while writes remain fenced', async () => {
    const { source, fence } = fixture()
    const pin = fence.tryAcquireBindingPin()
    if (!pin) throw new Error('expected binding pin')
    const capture = source.capture(pin)
    await expect(capture).resolves.toMatchObject({ routes: [{ routeId: 'route_test' }] })
    let mutated = false
    const mutation = fence.withBindingMutation(async () => { mutated = true })
    await Promise.resolve()
    expect(mutated).toBe(false)
    pin.release()
    await mutation
    expect(mutated).toBe(true)
  })
})
