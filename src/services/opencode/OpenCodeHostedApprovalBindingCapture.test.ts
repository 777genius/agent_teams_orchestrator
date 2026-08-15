import { describe, expect, test } from 'bun:test'

import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeSessionRecord } from './types.js'

const artifact = `sha256:${'a'.repeat(64)}` as const
const runtimeInstanceId = `runtime_instance_${'1'.repeat(32)}`
const configGeneration = `config_generation_${'2'.repeat(32)}`

describe('OpenCodeSessionBridge.captureHostedApprovalBinding', () => {
  test('captures one read-only capability against a stable process/profile/host', async () => {
    const calls: string[] = []
    const profile: OpenCodePreparedProfile = {
      projectPath: '/tmp/project', profileRootKey: 'profile', profileRootPath: '/tmp/profile',
      projectBehaviorFingerprint: 'behavior', behaviorSources: [], managedConfig: {},
      managedConfigFingerprint: 'managed-config', homePath: '/tmp/profile/home',
      tmpPath: '/tmp/profile/tmp', xdgConfigHome: '/tmp/profile/config',
      xdgDataHome: '/tmp/profile/data', xdgCacheHome: '/tmp/profile/cache',
      managedAuthPath: '/tmp/profile/auth.json', sourceAuthPath: null,
      sourceAuthFingerprint: null, managedAuthFingerprint: 'managed-auth', authState: 'ok',
      env: { OPENCODE_SERVER_PASSWORD: 'secret' },
    }
    const host: OpenCodeHostHandle = {
      hostKey: 'host', profileRootKey: profile.profileRootKey, projectPath: profile.projectPath,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      openCodeArtifactDigest: artifact, baseUrl: 'http://127.0.0.1:1', port: 1, pid: 99,
      processStartedAtMs: 10, version: '1', state: 'healthy', profile,
      resolvedConfigFingerprint: 'resolved', diagnostics: [],
    }
    const record: OpenCodeSessionRecord = {
      teamId: `team_${'3'.repeat(32)}`, laneId: 'primary', runId: `run_${'4'.repeat(32)}`,
      memberName: 'lead', providerId: 'opencode', selectedModel: 'openai/test',
      projectPath: profile.projectPath, profileRootKey: profile.profileRootKey, hostKey: host.hostKey,
      openCodeArtifactDigest: artifact, toolApprovalMode: 'manual', runtimePid: host.pid,
      resolvedBehaviorFingerprint: null, opencodeSessionId: 'session_test', lastCanonicalCursor: null,
      lastKnownRawStatus: null, lastKnownDurableState: null, sourceAuthFingerprint: null,
      managedAuthFingerprint: 'managed-auth', projectBehaviorFingerprint: 'behavior',
      managedConfigFingerprint: 'managed-config', staleReason: null,
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => { calls.push('host'); return host },
        releaseHost: async () => { calls.push('release') },
      },
      clientFactory: { create: () => ({
        getHostedApprovalCapability: async () => {
          calls.push('capability')
          return { schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2',
            authentication: 'opencode-basic', runtimeInstanceId, configGeneration }
        },
      }) as never },
      captureProcessIdentity: async pid => {
        calls.push('process')
        return { pid, startIdentity: `start_${'5'.repeat(64)}` }
      },
    })
    const capture = await bridge.captureHostedApprovalBinding(record)
    expect(capture.capability).toMatchObject({ runtimeInstanceId, configGeneration })
    expect(capture.context).toEqual({ record, profile, host: {
      hostKey: host.hostKey, profileRootKey: host.profileRootKey, projectPath: host.projectPath,
      projectBehaviorFingerprint: host.projectBehaviorFingerprint,
      openCodeArtifactDigest: artifact, pid: host.pid, processStartedAtMs: 10,
      resolvedConfigFingerprint: 'resolved',
    } })
    expect(calls).toEqual(['host', 'process', 'capability', 'process', 'release'])
  })
})
