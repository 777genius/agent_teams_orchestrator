import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, test } from 'bun:test'

import {
  buildOpenCodeRuntimePromptMessageId,
  resetOpenCodeRuntimePromptMessageIdAllocatorForTest,
} from './OpenCodeMessageIds.js'
import {
  OpenCodePermissionEffectNotAuthorizedError,
  OpenCodePermissionEffectUnavailableError,
  OpenCodePermissionPostInvocationError,
  prepareOpenCodePermissionProfileToken,
  OpenCodeSessionBridge,
} from './OpenCodeSessionBridge.js'
import { canonicalHostedApprovalDigest } from './OpenCodeClientFactory.js'

import type {
  OpenCodeHostHandle,
  OpenCodePreparedProfile,
  OpenCodeSessionPreviewSummary,
  OpenCodeSessionRecord,
} from './types.js'

const profile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-v1',
  behaviorSources: ['AGENTS.md', 'opencode.json'],
  managedConfig: {
    default_agent: 'teammate',
    share: 'disabled',
    autoupdate: false,
    snapshot: true,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  tmpPath: '/tmp/profile-root/tmp',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: { OPENCODE_SERVER_PASSWORD: 'test-password' },
}

const host: OpenCodeHostHandle = {
  hostKey: 'host-key',
  profileRootKey: 'profile-root',
  projectPath: '/tmp/project',
  projectBehaviorFingerprint: 'behavior-v1',
  baseUrl: 'http://127.0.0.1:4096',
  port: 4096,
  pid: 123,
  version: '1.4.0',
  state: 'healthy',
  profile,
  resolvedConfigFingerprint: 'resolved-fingerprint',
  diagnostics: [],
}

function buildRecord(overrides: Partial<OpenCodeSessionRecord> = {}): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'alice',
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4-mini',
    projectPath: '/tmp/project',
    profileRootKey: 'profile-root',
    hostKey: 'host-key',
    resolvedBehaviorFingerprint: 'resolved-fingerprint',
    opencodeSessionId: 'session-1',
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: null,
    sourceAuthFingerprint: 'source-auth',
    managedAuthFingerprint: 'managed-auth',
    projectBehaviorFingerprint: 'behavior-v1',
    staleReason: null,
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    ...overrides,
  }
}

function buildPreviewSummary(
  overrides: Partial<OpenCodeSessionPreviewSummary> = {},
): OpenCodeSessionPreviewSummary {
  return {
    sessionId: 'session-1',
    previewOutcome: 'observed',
    staleReason: null,
    profileAuthState: null,
    streamEndpoint: '/event',
    streamConnected: true,
    observedEventCount: 3,
    matchedEventCount: 2,
    runtimeState: 'running',
    latestEventType: 'message.part.updated',
    latestAssistantMessageId: 'msg-assistant-1',
    latestAssistantPreview: 'pong',
    pendingPermissionRequestIds: [],
    diagnostics: [],
    ...overrides,
  }
}

describe('OpenCodeSessionBridge', () => {
  beforeEach(() => {
    resetOpenCodeRuntimePromptMessageIdAllocatorForTest()
  })

  test('reuses an existing clean session record', async () => {
    let createSessionCalls = 0
    let prepareProfileCalls = 0
    const retainedLeases: unknown[] = []
    const existing = buildRecord()
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => {
        prepareProfileCalls += 1
        return profile
      },
      sessionStore: {
        get: async () => existing,
        upsert: async () => 'unchanged',
        markStale: async () => existing,
      },
      hostManager: {
        ensureHost: async input => {
          expect(input?.preparedProfile).toBe(profile)
          if (input?.lease) retainedLeases.push(input.lease)
          return host
        },
        releaseHost: async () => {},
        retainHostLease: async (_hostKey, input) => {
          retainedLeases.push(input)
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            createSessionCalls += 1
            return { id: 'session-new' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const record = await bridge.ensureSession({
      teamId: 'team-a',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      runId: 'run-1',
    })

    expect(record).toEqual({ ...existing, runtimePid: 123 })
    expect(prepareProfileCalls).toBe(1)
    expect(createSessionCalls).toBe(0)
    expect(retainedLeases).toEqual([
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
        sessionId: 'session-1',
      },
    ])
  })

  test('authorizes permission only after prepareProfile and ensureHost, immediately before provider POST', async () => {
    const order: string[] = []
    let releaseHost!: () => void
    const delayedHost = new Promise<void>(resolve => { releaseHost = resolve })
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => { order.push('profile'); return profile },
      hostManager: {
        ensureHost: async () => { order.push('host-start'); await delayedHost; order.push('host-ready'); return { ...host, processStartedAtMs: 1000 } },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          answerPermission: async () => { order.push('post') },
        } as never),
      },
    })
    const pending = bridge.answerPermission(buildRecord({ runtimePid: host.pid }), {
      requestId: 'permission_1', decision: 'allow',
      authorizeEffect: async context => {
        order.push(`authorize:${context.host.pid}:${context.host.processStartedAtMs}`)
        return false
      },
    })
    await Promise.resolve(); expect(order).toContain('profile')
    releaseHost()
    await expect(pending).rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
    expect(order).toEqual(['profile', 'host-start', 'host-ready', 'authorize:123:1000'])
  })

  test('performs zero POSTs when final loopback endpoint ownership is substituted', async () => {
    let posts = 0
    let endpointProofs = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      captureProcessIdentity: async pid => ({ pid, startIdentity: `start_${'a'.repeat(64)}` }),
      captureLoopbackEndpointIdentity: async (pid, port) => ({
        address: '127.0.0.1', port, pid,
        startIdentity: `start_${(++endpointProofs === 1 ? 'a' : 'b').repeat(64)}`,
      }),
      hostManager: {
        ensureHost: async () => ({ ...host, processStartedAtMs: 1000 }),
        prepareEffectHostToken: async () => ({ consume: () => true }),
        releaseHost: async () => {}, retainHostLease: async () => {},
      },
      preparePermissionProfileToken: async () => ({ consume: () => true }),
      clientFactory: { create: () => ({
        getPermissions: async () => [{ requestID: 'permission_1', sessionID: 'session-1' }],
        answerPermission: async () => { posts += 1 },
      } as never) },
    })
    await expect(bridge.answerPermission(buildRecord({ toolApprovalMode: 'manual' }), {
      requestId: 'permission_1', decision: 'allow',
      expectedPermissionRaw: { requestID: 'permission_1', sessionID: 'session-1' },
    })).rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
    expect(endpointProofs).toBe(2)
    expect(posts).toBe(0)
  })

  test('freshly proves host, persisted effect, exact raw permission, and admission in POST-edge order', async () => {
    const order: string[] = []
    const raw = { requestID: 'permission_1', sessionID: 'session-1', title: 'Run test' }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => { order.push('profile'); return profile },
      captureProcessIdentity: async pid => ({ pid, startIdentity: `start_${'a'.repeat(64)}` }),
      captureLoopbackEndpointIdentity: async (pid, port) => ({
        address: '127.0.0.1', port, pid, startIdentity: `start_${'a'.repeat(64)}`,
      }),
      hostManager: {
        ensureHost: async () => { order.push('host'); return { ...host, processStartedAtMs: 1000 } },
        prepareEffectHostToken: async input => {
          order.push(`host-proof:${input.pid}:${input.processStartedAtMs}:${input.resolvedConfigFingerprint}`)
          return { consume: () => { order.push('host-token'); return true } }
        },
        releaseHost: async () => {}, retainHostLease: async () => {},
      },
      preparePermissionProfileToken: async () => ({
        consume: () => { order.push('auth-token'); return true },
      }),
      clientFactory: { create: () => ({
        getPermissions: async () => { order.push('permissions'); return [{ title: 'Run test', sessionID: 'session-1', requestID: 'permission_1' }] },
        answerPermission: async () => { order.push('post') },
      } as never) },
    })
    await bridge.answerPermission(buildRecord(), {
      requestId: 'permission_1', decision: 'allow', expectedPermissionRaw: raw,
      validatePreparedEffect: async () => {
        order.push('session-effect')
        return { consume: () => { order.push('session-token'); return true } }
      },
      authorizeEffect: async () => {
        order.push('admission')
        return { consume: () => { order.push('owner-token'); return true } }
      },
    })
    expect(order).toEqual([
      'profile', 'host', 'permissions', 'session-effect', 'admission',
      'host-proof:123:1000:resolved-fingerprint', 'session-token',
      'auth-token', 'owner-token', 'host-token', 'post',
    ])
  })

  test('fails closed before raw permission GET when atomic config reply is unsupported', async () => {
    let rawGets = 0
    let replies = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => ({ ...host, processStartedAtMs: 1000 }),
        releaseHost: async () => {},
      },
      clientFactory: { create: () => ({
        getHostedApprovalCapability: async () => {
          throw new Error('OpenCode request failed (404 Not Found)')
        },
        getPermissions: async () => { rawGets += 1; return [] },
        answerPermission: async () => { replies += 1 },
      } as never) },
    })

    await expect(bridge.answerPermission(buildRecord({ toolApprovalMode: 'manual' }), {
      requestId: 'permission_1',
      decision: 'allow',
      expectedPermissionRaw: { requestID: 'permission_1', sessionID: 'session-1' },
      requireAtomicConfigReply: true,
    })).rejects.toBeInstanceOf(OpenCodePermissionEffectUnavailableError)
    expect({ rawGets, replies }).toEqual({ rawGets: 0, replies: 0 })
  })

  test('proves capability before raw permissions on one pinned host and client acquisition', async () => {
    const order: string[] = []
    let acquisitions = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => ({ ...host, processStartedAtMs: 1000 }),
        releaseHost: async () => {},
      },
      clientFactory: { create: () => {
        acquisitions += 1
        return {
          getHostedApprovalCapability: async () => {
            order.push('capability')
            return {
              schemaVersion: 2,
              protocol: 'agent-teams-hosted-approval-v2',
              authentication: 'opencode-basic',
              runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
              configGeneration: `config_generation_${'2'.repeat(32)}`,
            }
          },
          observeHostedApprovalPermissions: async () => {
            order.push('permissions')
            const rawPermission = {
              id: 'per_1', sessionID: 'ses_1', permission: 'bash',
              patterns: ['ls'], metadata: { cwd: '/tmp' }, always: [],
            }
            return {
              schemaVersion: 2,
              protocol: 'agent-teams-hosted-approval-v2',
              runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
              configGeneration: `config_generation_${'2'.repeat(32)}`,
              sessionId: 'ses_1',
              permissions: [{
                requestId: 'per_1', sessionId: 'ses_1',
                requestIncarnation: `request_incarnation_${'3'.repeat(32)}`,
                permissionDigest: createHash('sha256')
                  .update('{"always":[],"id":"per_1","metadata":{"cwd":"/tmp"},"patterns":["ls"],"permission":"bash","sessionID":"ses_1"}')
                  .digest('hex'),
                rawPermission,
              }],
            }
          },
        } as never
      } },
    })

    await expect(bridge.observeHostedApprovalPermissions(buildRecord({
      toolApprovalMode: 'manual', opencodeSessionId: 'ses_1',
    })))
      .resolves.toMatchObject([{
        normalized: { requestId: 'per_1', sessionId: 'ses_1', tool: 'bash' },
        permission: { requestIncarnation: `request_incarnation_${'3'.repeat(32)}` },
      }])
    expect({ acquisitions, order }).toEqual({
      acquisitions: 1,
      order: ['capability', 'permissions'],
    })
  })

  test('preserves configured hosted Basic credentials without trimming', async () => {
    const auth: unknown[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => ({
        ...profile,
        env: {
          ...profile.env,
          OPENCODE_SERVER_USERNAME: ' user ',
          OPENCODE_SERVER_PASSWORD: ' pass ',
        },
      }),
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: (_baseUrl, _context, hostedApprovalAuth) => {
          auth.push(hostedApprovalAuth)
          return {
            getHostedApprovalCapability: async () => ({
              schemaVersion: 2,
              protocol: 'agent-teams-hosted-approval-v2',
              authentication: 'opencode-basic',
              runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
              configGeneration: `config_generation_${'2'.repeat(32)}`,
            }),
          } as never
        },
      },
    })
    await expect(bridge.probeHostedApprovalCapability(buildRecord({ toolApprovalMode: 'manual' })))
      .resolves.toBe(`config_generation_${'2'.repeat(32)}`)
    expect(auth).toEqual([{
      username: ' user ', password: ' pass ', directory: profile.projectPath,
    }])
  })

  test('projects valid hosted identifiers byte-for-byte without legacy trimming', async () => {
    const rawPermission = {
      id: 'per_1 ', sessionID: 'ses_1 ', permission: 'bash ',
      patterns: ['ls'], metadata: {}, always: [],
    }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getHostedApprovalCapability: async () => ({
            schemaVersion: 2,
            protocol: 'agent-teams-hosted-approval-v2',
            authentication: 'opencode-basic',
            runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
            configGeneration: `config_generation_${'2'.repeat(32)}`,
          }),
          observeHostedApprovalPermissions: async () => ({
            schemaVersion: 2,
            protocol: 'agent-teams-hosted-approval-v2',
            runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
            configGeneration: `config_generation_${'2'.repeat(32)}`,
            sessionId: rawPermission.sessionID,
            permissions: [{
              requestId: rawPermission.id,
              sessionId: rawPermission.sessionID,
              requestIncarnation: `request_incarnation_${'3'.repeat(32)}`,
              permissionDigest: canonicalHostedApprovalDigest(rawPermission),
              rawPermission,
            }],
          }),
        } as never),
      },
    })
    const observed = await bridge.observeHostedApprovalPermissions(buildRecord({
      toolApprovalMode: 'manual', opencodeSessionId: rawPermission.sessionID,
    }))
    expect(observed).toMatchObject([{
      normalized: {
        requestId: rawPermission.id,
        sessionId: rawPermission.sessionID,
        tool: rawPermission.permission,
      },
    }])
  })

  test('performs zero raw permission reads for a missing or malformed capability', async () => {
    for (const capability of [undefined, async () => ({ schemaVersion: 2, protocol: 'wrong', configGeneration: `config_generation_${'2'.repeat(32)}` })]) {
      let rawReads = 0
      const bridge = new OpenCodeSessionBridge({
        prepareProfile: async () => profile,
        hostManager: {
          ensureHost: async () => ({ ...host, processStartedAtMs: 1000 }),
          releaseHost: async () => {},
        },
        clientFactory: { create: () => ({
          ...(capability ? { getHostedApprovalCapability: capability } : {}),
          observeHostedApprovalPermissions: async () => { rawReads += 1; return [] },
        } as never) },
      })
      await expect(bridge.observeHostedApprovalPermissions(buildRecord({ toolApprovalMode: 'manual' })))
        .rejects.toThrow('capability unavailable')
      expect(rawReads).toBe(0)
    }
  })

  test('authorizes the OpenCode artifact before creating an observation or reply client', async () => {
    let clients = 0
    const artifactDigest = `sha256:${'d'.repeat(64)}` as const
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => ({ ...host, openCodeArtifactDigest: artifactDigest }),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => {
          clients += 1
          return {} as never
        },
      },
    })
    const record = buildRecord({ openCodeArtifactDigest: artifactDigest })
    const rejectArtifact = async () => false

    await expect(bridge.observeHostedApprovalPermissions(record, rejectArtifact))
      .rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
    await expect(bridge.answerPermission(record, {
      requestId: 'permission_1',
      decision: 'allow',
      authorizeObservation: rejectArtifact,
    })).rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
    expect(clients).toBe(0)
  })

  test('preserves provider success when host cleanup fails after POST', async () => {
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { throw new Error('cleanup failed') },
      },
      clientFactory: {
        create: () => ({
          answerPermission: async () => ({ ok: true }),
        } as never),
      },
    })
    await expect(bridge.answerPermission(buildRecord(), {
      requestId: 'permission_1', decision: 'allow',
    })).resolves.toEqual({ ok: true })
  })

  test('consumes exact session host and authority tokens synchronously before POST', async () => {
    const order: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      captureProcessIdentity: async pid => ({ pid, startIdentity: `start_${'a'.repeat(64)}` }),
      captureLoopbackEndpointIdentity: async (pid, port) => ({
        address: '127.0.0.1', port, pid, startIdentity: `start_${'a'.repeat(64)}`,
      }),
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
        prepareEffectHostToken: async () => ({ consume: () => { order.push('host-token'); return true } }),
      },
      preparePermissionProfileToken: async () => ({
        consume: () => { order.push('auth-token'); return true },
      }),
      clientFactory: {
        create: () => ({
          getPermissions: async () => [{ requestID: 'permission_1', sessionID: 'session-1' }],
          answerPermission: async () => { order.push('post') },
        } as never),
      },
    })
    await bridge.answerPermission(buildRecord({ toolApprovalMode: 'manual' }), {
      requestId: 'permission_1', decision: 'allow',
      expectedPermissionRaw: { requestID: 'permission_1', sessionID: 'session-1' },
      validatePreparedEffect: async () => ({ consume: () => { order.push('session-token'); return true } }),
      authorizeEffect: async () => ({ consume: () => { order.push('owner-token'); return false } }),
    }).catch(error => expect(error).toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError))
    expect(order).toEqual(['session-token', 'auth-token', 'owner-token', 'host-token'])
  })

  test('performs zero POSTs when live auth bytes rotate during final host proof', async () => {
    const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-approval-auth-')))
    try {
      const sourcePath = path.join(tempDir, 'source-auth.json')
      const managedPath = path.join(tempDir, 'managed-auth.json')
      const sourceBytes = '{"openai":{"type":"api","key":"source-v1"}}'
      const managedBytes = '{"openai":{"type":"api","key":"managed-v1"}}'
      await writeFile(sourcePath, sourceBytes, { mode: 0o600 })
      await writeFile(managedPath, managedBytes, { mode: 0o600 })
      const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
      const managedHash = createHash('sha256').update(managedBytes).digest('hex')
      const liveProfile: OpenCodePreparedProfile = {
        ...profile,
        sourceAuthPath: sourcePath,
        sourceAuthSources: [{ path: sourcePath, fingerprint: sourceHash }],
        sourceAuthFingerprint: createHash('sha256')
          .update(`${sourcePath}:${sourceHash}`)
          .digest('hex'),
        managedAuthPath: managedPath,
        managedAuthFingerprint: managedHash,
      }
      let posts = 0
      let hostProofs = 0
      const bridge = new OpenCodeSessionBridge({
        prepareProfile: async () => liveProfile,
        captureProcessIdentity: async pid => ({ pid, startIdentity: `start_${'a'.repeat(64)}` }),
        captureLoopbackEndpointIdentity: async (pid, port) => ({
          address: '127.0.0.1', port, pid, startIdentity: `start_${'a'.repeat(64)}`,
        }),
        hostManager: {
          ensureHost: async () => ({ ...host, profile: liveProfile, processStartedAtMs: 1000 }),
          releaseHost: async () => {},
          prepareEffectHostToken: async () => {
            hostProofs += 1
            await writeFile(managedPath, '{"openai":{"type":"api","key":"managed-v2"}}')
            return { consume: () => true }
          },
        },
        clientFactory: { create: () => ({
          getPermissions: async () => [{ requestID: 'permission_1', sessionID: 'session-1' }],
          answerPermission: async () => { posts += 1 },
        } as never) },
      })
      await expect(bridge.answerPermission(buildRecord({ toolApprovalMode: 'manual' }), {
        requestId: 'permission_1', decision: 'allow',
        expectedPermissionRaw: { requestID: 'permission_1', sessionID: 'session-1' },
      })).rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
      expect(hostProofs).toBe(1)
      expect(posts).toBe(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('pins absent auth sources and rejects their creation before consumption', async () => {
    const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-approval-auth-missing-')))
    try {
      const sourcePath = path.join(tempDir, 'missing-source.json')
      const managedPath = path.join(tempDir, 'missing-managed.json')
      const token = await prepareOpenCodePermissionProfileToken({
        ...profile,
        sourceAuthPath: null,
        sourceAuthSources: [{ path: sourcePath, fingerprint: null }],
        sourceAuthFingerprint: null,
        managedAuthPath: managedPath,
        managedAuthFingerprint: null,
      })
      expect(token).not.toBeNull()
      await writeFile(sourcePath, '{}', { mode: 0o600 })
      expect(token!.consume()).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects raw request-id reuse and classifies failures by POST invocation phase', async () => {
    const raw = { requestID: 'permission_1', sessionID: 'session-1', metadata: { scope: 'old' } }
    const make = (phase: 'host' | 'permission' | 'admission' | 'post') => {
      let posts = 0
      const bridge = new OpenCodeSessionBridge({
        prepareProfile: async () => profile,
        hostManager: {
          ensureHost: async () => ({ ...host, processStartedAtMs: 1000 }),
          prepareEffectHostToken: async () => phase === 'host' ? null : { consume: () => true },
          releaseHost: async () => {}, retainHostLease: async () => {},
        },
        preparePermissionProfileToken: async () => ({ consume: () => true }),
        clientFactory: { create: () => ({
          getPermissions: async () => {
            if (phase === 'permission') throw new Error('permission unavailable')
            return [{ requestID: 'permission_1', sessionID: 'session-1', metadata: { scope: 'replacement' } }]
          },
          answerPermission: async () => { posts += 1; throw new Error('socket closed') },
        } as never) },
      })
      return { bridge, posts: () => posts }
    }
    const hostFailure = make('host')
    await expect(hostFailure.bridge.answerPermission(buildRecord(), {
      requestId: 'permission_1', decision: 'allow', expectedPermissionRaw: raw,
    })).rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
    expect(hostFailure.posts()).toBe(0)

    const probeFailure = make('permission')
    await expect(probeFailure.bridge.answerPermission(buildRecord(), {
      requestId: 'permission_1', decision: 'allow', expectedPermissionRaw: raw,
    })).rejects.toBeInstanceOf(OpenCodePermissionEffectUnavailableError)
    expect(probeFailure.posts()).toBe(0)

    const rawReuse = make('admission')
    await expect(rawReuse.bridge.answerPermission(buildRecord(), {
      requestId: 'permission_1', decision: 'allow', expectedPermissionRaw: raw,
      authorizeEffect: async () => false,
    })).rejects.toBeInstanceOf(OpenCodePermissionEffectNotAuthorizedError)
    expect(rawReuse.posts()).toBe(0)

    const post = make('post')
    await expect(post.bridge.answerPermission(buildRecord(), {
      requestId: 'permission_1', decision: 'allow',
    })).rejects.toBeInstanceOf(OpenCodePermissionPostInvocationError)
    expect(post.posts()).toBe(1)
  })

  test('uses a caller-provided prepared profile without preparing it again', async () => {
    let prepareProfileCalls = 0
    let createSessionCalls = 0
    const existing = buildRecord()
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => {
        prepareProfileCalls += 1
        throw new Error('prepareProfile should not be called')
      },
      sessionStore: {
        get: async () => existing,
        upsert: async () => 'unchanged',
        markStale: async () => existing,
      },
      hostManager: {
        ensureHost: async input => {
          expect(input?.preparedProfile).toBe(profile)
          return host
        },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            createSessionCalls += 1
            return { id: 'session-new' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const record = await bridge.ensureSession({
      teamId: 'team-a',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      preparedProfile: profile,
    })

    expect(record).toEqual({ ...existing, runtimePid: 123 })
    expect(prepareProfileCalls).toBe(0)
    expect(createSessionCalls).toBe(0)
  })

  test('persists manual tool approval mode in fresh session records', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const admittedArtifactDigest = `sha256:${'d'.repeat(64)}` as const
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'created'
        },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async input => {
          expect(input?.preparedProfile).toBe(profile)
          return { ...host, openCodeArtifactDigest: admittedArtifactDigest }
        },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-manual' }),
          getSession: async () => ({ id: 'session-manual' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const record = await bridge.ensureSession({
      teamId: 'team-a',
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      fresh: true,
      toolApprovalMode: 'manual',
    })

    expect(record.toolApprovalMode).toBe('manual')
    expect(record.openCodeArtifactDigest).toBe(admittedArtifactDigest)
    expect(record.managedConfigFingerprint).toBe('managed-config-v1')
    expect(upserts[0]?.toolApprovalMode).toBe('manual')
    expect(upserts[0]?.openCodeArtifactDigest).toBe(admittedArtifactDigest)
    expect(upserts[0]?.managedConfigFingerprint).toBe('managed-config-v1')
  })

  test('infers manual tool approval mode from caller-provided prepared profile', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const manualProfile: OpenCodePreparedProfile = {
      ...profile,
      managedConfig: {
        agent: {
          teammate: {
            permission: {
              '*': 'ask',
            },
          },
        },
      },
      managedConfigFingerprint: 'manual-config-v1',
    }
    const manualHost: OpenCodeHostHandle = {
      ...host,
      hostKey: '/tmp/project::profile-root::behavior-v1::manual-config-v1',
      profile: manualProfile,
    }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => {
        throw new Error('preparedProfile should be used directly')
      },
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'created'
        },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async input => {
          expect(input?.preparedProfile).toBe(manualProfile)
          return manualHost
        },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-manual-profile' }),
          getSession: async () => ({ id: 'session-manual-profile' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const record = await bridge.ensureSession({
      teamId: 'team-a',
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      preparedProfile: manualProfile,
      fresh: true,
    })

    expect(record.toolApprovalMode).toBe('manual')
    expect(record.managedConfigFingerprint).toBe('manual-config-v1')
    expect(upserts[0]?.toolApprovalMode).toBe('manual')
  })

  test('reuses legacy manual session records by inferring approval mode from host config fingerprint', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const staleReasons: string[] = []
    const prepareProfileModes: Array<string | undefined> = []
    const ensuredProfileFingerprints: string[] = []
    let createSessionCalls = 0
    const manualProfile: OpenCodePreparedProfile = {
      ...profile,
      managedConfigFingerprint: 'manual-config-v1',
    }
    const autoProfile: OpenCodePreparedProfile = {
      ...profile,
      managedConfigFingerprint: 'auto-config-v1',
    }
    const manualHost: OpenCodeHostHandle = {
      ...host,
      hostKey: '/tmp/project::profile-root::behavior-v1::manual-config-v1',
      profile: manualProfile,
    }
    const legacyRecord = buildRecord({
      hostKey: manualHost.hostKey,
      managedConfigFingerprint: undefined,
      toolApprovalMode: undefined,
    })
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async (_projectPath, options) => {
        prepareProfileModes.push(options?.toolApprovalMode)
        return options?.toolApprovalMode === 'manual' ? manualProfile : autoProfile
      },
      sessionStore: {
        get: async () => legacyRecord,
        upsert: async record => {
          upserts.push(record)
          return 'updated'
        },
        markStale: async (_teamId, _laneId, _memberName, staleReason) => {
          staleReasons.push(staleReason)
          return { ...legacyRecord, staleReason }
        },
      },
      hostManager: {
        ensureHost: async input => {
          ensuredProfileFingerprints.push(input?.preparedProfile?.managedConfigFingerprint ?? 'missing')
          return manualHost
        },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            createSessionCalls += 1
            return { id: 'session-new' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const record = await bridge.ensureSession({
      teamId: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      runId: 'run-1',
    })

    expect(prepareProfileModes).toEqual(['auto', 'manual'])
    expect(ensuredProfileFingerprints).toEqual(['manual-config-v1'])
    expect(createSessionCalls).toBe(0)
    expect(staleReasons).toEqual([])
    expect(record.toolApprovalMode).toBe('manual')
    expect(record.managedConfigFingerprint).toBe('manual-config-v1')
    expect(upserts[0]?.toolApprovalMode).toBe('manual')
    expect(upserts[0]?.managedConfigFingerprint).toBe('manual-config-v1')
  })

  test('retries fresh session creation after a transient OpenCode socket close', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const retainedLeases: unknown[] = []
    let createSessionCalls = 0
    let releaseHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'created'
        },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {
          releaseHostCalls += 1
        },
        retainHostLease: async (_hostKey, input) => {
          retainedLeases.push(input)
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            createSessionCalls += 1
            if (createSessionCalls === 1) {
              throw new Error('The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()')
            }
            return { id: 'session-new' }
          },
          getSession: async () => ({ id: 'session-new' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const record = await bridge.ensureSession({
      teamId: 'team-a',
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      selectedModel: 'opencode/big-pickle',
      selectedVariant: 'max',
      projectPath: '/tmp/project',
      runId: 'run-1',
      fresh: true,
    })

    expect(createSessionCalls).toBe(2)
    expect(record.opencodeSessionId).toBe('session-new')
    expect(record.runId).toBe('run-1')
    expect(record.selectedVariant).toBe('max')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.selectedVariant).toBe('max')
    expect(releaseHostCalls).toBe(0)
    expect(retainedLeases).toEqual([{
      teamId: 'team-a',
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      runId: 'run-1',
      sessionId: 'session-new',
    }])
  })

  test('does not retry fresh session creation after a non-transient OpenCode error', async () => {
    let createSessionCalls = 0
    let releaseHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => null,
        upsert: async () => {
          throw new Error('upsert should not be called')
        },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {
          releaseHostCalls += 1
        },
        retainHostLease: async () => {
          throw new Error('retainHostLease should not be called')
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            createSessionCalls += 1
            throw new Error('OpenCode request failed (400 Bad Request): invalid session title')
          },
          getSession: async () => ({ id: 'session-new' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    await expect(bridge.ensureSession({
      teamId: 'team-a',
      memberName: 'tom',
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      fresh: true,
    })).rejects.toThrow('invalid session title')

    expect(createSessionCalls).toBe(1)
    expect(releaseHostCalls).toBe(1)
  })

  test('releaseSession drops the persistent host lease even after process restart', async () => {
    const releasedLeases: unknown[] = []
    let releaseHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {
          releaseHostCalls += 1
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeases.push(input)
        },
      },
    })

    await bridge.releaseSession(buildRecord())

    expect(releasedLeases).toEqual([
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        sessionId: 'session-1',
      },
    ])
    expect(releaseHostCalls).toBe(0)
  })

  test('ensureSessionAppMcpReady verifies app MCP on the session host', async () => {
    const ensureCalls: Array<{ baseUrl: string; attachIfMissing?: boolean }> = []
    let releaseHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async input => {
          expect(input).toEqual({
            projectPath: '/tmp/project',
            hostKey: 'host-key',
            preparedProfile: profile,
            lease: {
              teamId: 'team-a',
              laneId: 'primary',
              memberName: 'alice',
              sessionId: 'session-1',
            },
          })
          return host
        },
        releaseHost: async () => {
          releaseHostCalls += 1
        },
        retainHostLease: async () => {},
      },
      mcpManager: {
        ensureAppMcp: async input => {
          ensureCalls.push(input)
          return {
            mcp: {},
            summary: {
              serverName: 'agent-teams',
              matchedServerName: 'agent-teams',
              status: 'present',
              connected: true,
              launchSource: 'workspace-src',
              availableServerNames: ['agent-teams'],
              diagnostics: [],
            },
          }
        },
      },
    })

    const result = await bridge.ensureSessionAppMcpReady(buildRecord(), {
      attachIfMissing: true,
    })

    expect(result).toEqual({
      ok: true,
      runtimePid: 123,
      status: 'present',
      connected: true,
      diagnostics: [],
    })
    expect(ensureCalls).toEqual([{ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true }])
    expect(releaseHostCalls).toBe(1)
  })

  test('ensureSessionAppMcpReady returns blocking state when app MCP cannot attach', async () => {
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {},
          summary: {
            serverName: 'agent-teams',
            matchedServerName: null,
            status: 'attach_failed',
            connected: null,
            launchSource: 'workspace-src',
            availableServerNames: [],
            diagnostics: ['connect failed'],
          },
        }),
      },
    })

    const result = await bridge.ensureSessionAppMcpReady(buildRecord(), {
      attachIfMissing: true,
    })

    expect(result).toEqual({
      ok: false,
      runtimePid: 123,
      status: 'attach_failed',
      connected: null,
      diagnostics: ['connect failed'],
    })
  })

  test('ensureSessionAppMcpReady converts MCP probe exceptions into blocking state', async () => {
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      mcpManager: {
        ensureAppMcp: async () => {
          throw new Error('mcp endpoint unavailable')
        },
      },
    })

    const result = await bridge.ensureSessionAppMcpReady(buildRecord(), {
      attachIfMissing: true,
    })

    expect(result).toEqual({
      ok: false,
      runtimePid: 123,
      status: 'attach_failed',
      connected: null,
      diagnostics: ['OpenCode app MCP readiness check failed: mcp endpoint unavailable'],
    })
  })

  test('answers permissions on the stored manual session profile', async () => {
    const answerCalls: unknown[] = []
    const ensuredProfileFingerprints: string[] = []
    const manualProfile: OpenCodePreparedProfile = {
      ...profile,
      managedConfigFingerprint: 'manual-config-v1',
    }
    const manualHost: OpenCodeHostHandle = {
      ...host,
      profile: manualProfile,
    }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async (_projectPath, options) => {
        expect(options?.toolApprovalMode).toBe('manual')
        return manualProfile
      },
      hostManager: {
        ensureHost: async input => {
          ensuredProfileFingerprints.push(input?.preparedProfile?.managedConfigFingerprint ?? 'missing')
          return manualHost
        },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          answerPermission: async input => {
            answerCalls.push(input)
            return { ok: true }
          },
          abortSession: async () => true,
        }),
      },
    })

    await bridge.answerPermission(buildRecord({
      toolApprovalMode: 'manual',
      managedConfigFingerprint: 'manual-config-v1',
    }), {
      requestId: 'perm-1',
      decision: 'allow',
    })

    expect(ensuredProfileFingerprints).toEqual(['manual-config-v1'])
    expect(answerCalls).toEqual([{
      requestId: 'perm-1',
      sessionId: 'session-1',
      decision: 'allow',
    }])
  })

  test('marks stale and creates a new session when the model changes', async () => {
    const staleReasons: string[] = []
    const upserts: OpenCodeSessionRecord[] = []
    let prepareProfileCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => {
        prepareProfileCalls += 1
        return profile
      },
      sessionStore: {
        get: async () => buildRecord(),
        upsert: async record => {
          upserts.push(record)
          return 'created'
        },
        markStale: async (_teamId, _laneId, _memberName, staleReason) => {
          staleReasons.push(staleReason)
          return buildRecord({ staleReason })
        },
      },
      hostManager: {
        ensureHost: async input => {
          expect(input?.preparedProfile).toBe(profile)
          return host
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new', title: 'Team A - alice' }),
          getSession: async () => ({ id: 'session-new' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const record = await bridge.ensureSession({
      teamId: 'team-a',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4',
      projectPath: '/tmp/project',
    })

    expect(staleReasons).toEqual(['model_changed:openai/gpt-5.4-mini->openai/gpt-5.4'])
    expect(record.opencodeSessionId).toBe('session-new')
    expect(record.bootstrapMode).toBe('app_managed_context')
    expect(prepareProfileCalls).toBe(1)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.bootstrapMode).toBe('app_managed_context')
  })

  test('refreshes session environment fingerprints after OpenCode materializes project behavior files', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const refreshedProfile: OpenCodePreparedProfile = {
      ...profile,
      projectBehaviorFingerprint: 'behavior-v2',
      sourceAuthFingerprint: 'source-auth-v2',
      managedAuthFingerprint: 'managed-auth-v2',
    }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => refreshedProfile,
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'updated'
        },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
        refreshResolvedConfigFingerprint: async () => 'resolved-fingerprint-v2',
      },
    })

    const refreshed = await bridge.refreshSessionEnvironment(buildRecord())

    expect(refreshed.projectBehaviorFingerprint).toBe('behavior-v2')
    expect(refreshed.sourceAuthFingerprint).toBe('source-auth-v2')
    expect(refreshed.managedAuthFingerprint).toBe('managed-auth-v2')
    expect(refreshed.resolvedBehaviorFingerprint).toBe('resolved-fingerprint-v2')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.projectBehaviorFingerprint).toBe('behavior-v2')
  })

  test('releases a fresh host lease when session persistence fails', async () => {
    const retainedLeases: unknown[] = []
    const releasedLeases: unknown[] = []
    let releaseHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => null,
        upsert: async () => {
          throw new Error('disk write failed')
        },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async input => {
          if (input?.lease) retainedLeases.push(input.lease)
          return host
        },
        releaseHost: async () => {
          releaseHostCalls += 1
        },
        retainHostLease: async (_hostKey, input) => {
          retainedLeases.push(input)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeases.push(input)
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-new' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    await expect(
      bridge.ensureSession({
        teamId: 'team-a',
        memberName: 'alice',
        selectedModel: 'openai/gpt-5.4-mini',
        projectPath: '/tmp/project',
        runId: 'run-1',
      }),
    ).rejects.toThrow('disk write failed')

    expect(retainedLeases).toEqual([
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
      },
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
        sessionId: 'session-new',
      },
    ])
    expect(releasedLeases).toEqual([
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
      },
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
        sessionId: 'session-new',
      },
    ])
    expect(releaseHostCalls).toBe(1)
  })

  test('rolls back the promoted session lease when provisional lease release fails', async () => {
    const releasedLeases: Array<{ sessionId?: string }> = []
    let releaseHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => null,
        upsert: async () => 'updated',
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { releaseHostCalls += 1 },
        retainHostLease: async () => {},
        releaseHostLease: async (_hostKey, input) => {
          releasedLeases.push(input)
          if (!input.sessionId) throw new Error('provisional lease release failed')
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-promoted' }),
          getSession: async () => ({ id: 'session-promoted' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    await expect(bridge.ensureSession({
      teamId: 'team-a',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      runId: 'run-1',
    })).rejects.toThrow('provisional lease release failed')

    expect(releasedLeases.some(lease => lease.sessionId === 'session-promoted')).toBe(true)
    expect(releaseHostCalls).toBe(1)
  })

  test('sends provider-scoped model data when posting a message', async () => {
    const sentBodies: unknown[] = []
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'unchanged',
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async (_id, body) => {
            sentBodies.push(body)
            return { info: { id: 'message-1' }, parts: [{ type: 'text', text: 'pong' }] }
          },
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const message = await bridge.sendMessage(buildRecord(), {
      text: 'Reply with exactly: pong',
      agent: 'build',
    })

    expect(message.parts[0]?.text).toBe('pong')
    expect(sentBodies).toEqual([
      {
        agent: 'build',
        noReply: undefined,
        system: undefined,
        model: {
          providerID: 'openai',
          modelID: 'gpt-5.4-mini',
        },
        parts: [{ type: 'text', text: 'Reply with exactly: pong' }],
      },
    ])
  })

  test('fans out a rotated xAI OAuth credential after a runtime prompt', async () => {
    const fanOutInputs: Array<{ providerId: string; sourceAuthPath: string }> = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'message-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      fanOutOAuthCredential: async input => {
        fanOutInputs.push(input)
      },
    })

    await bridge.promptAsync(buildRecord({ selectedModel: 'xai/grok-4.3' }), {
      text: 'Reply with exactly: pong',
    })

    expect(fanOutInputs).toEqual([{
      providerId: 'xai',
      sourceAuthPath: profile.managedAuthPath,
    }])
  })

  test('refreshes expiring xAI OAuth before contacting the teammate host', async () => {
    const order: string[] = []
    let prepareProfileCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => {
        prepareProfileCalls += 1
        order.push(`prepare:${prepareProfileCalls}`)
        return profile
      },
      oauthRefreshCoordinator: {
        ensureFreshForPrompt: async input => {
          order.push('refresh')
          expect(input).toEqual({
            selectedModel: 'xai/grok-4.3',
            projectPath: '/tmp/project',
            profile,
          })
          return { checked: true, refreshed: true }
        },
      },
      hostManager: {
        ensureHost: async () => {
          order.push('host')
          return host
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'message-1' }, parts: [] }),
          promptSessionAsync: async () => {
            order.push('prompt')
          },
          abortSession: async () => true,
        }),
      },
      fanOutOAuthCredential: async () => {
        order.push('fanout')
      },
    })

    await bridge.promptAsync(buildRecord({ selectedModel: 'xai/grok-4.3' }), {
      text: 'Reply with exactly: pong',
    })

    expect(order).toEqual([
      'prepare:1',
      'refresh',
      'prepare:2',
      'host',
      'prompt',
      'fanout',
    ])
  })

  test('does not contact the teammate host when proactive xAI refresh fails', async () => {
    let ensureHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      oauthRefreshCoordinator: {
        ensureFreshForPrompt: async () => {
          throw new Error('SuperGrok OAuth refresh failed before prompt: invalid_grant')
        },
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
    })

    await expect(bridge.promptAsync(
      buildRecord({ selectedModel: 'xai/grok-4.3' }),
      { text: 'do not deliver' },
    )).rejects.toThrow('invalid_grant')
    expect(ensureHostCalls).toBe(0)
  })

  test('posts prompt_async with app-owned message id and waits for OpenCode turn-settled observation', async () => {
    const promptBodies: unknown[] = []
    const observationMarks: string[] = []
    const hookEvents: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      turnSettledObserver: {
        observe: input => {
          const runtimePromptMessageId = input.runtimePromptMessageId ?? ''
          expect(runtimePromptMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
          expect(input).toMatchObject({
            baseUrl: 'http://127.0.0.1:4096',
            sessionId: 'session-1',
            projectPath: '/tmp/project',
            runtimePromptMessageId,
            timeoutMs: 500,
            idleTimeoutMs: 100,
          })
          return {
            runtimePromptMessageId,
            turnId: runtimePromptMessageId,
            markPromptSubmitting: () => {
              observationMarks.push('submitting')
            },
            markPromptAcceptedByEndpoint: () => {
              observationMarks.push('accepted')
            },
            markPromptRejectedByEndpoint: error => {
              observationMarks.push(`rejected:${String(error)}`)
            },
            waitForSettled: async () => ({
              outcome: 'success',
              sessionId: 'session-1',
              runtimePromptMessageId,
              turnId: runtimePromptMessageId,
              endpoint: '/event',
              streamConnected: true,
              observedEventCount: 2,
              matchedEventCount: 2,
              assistantActivityCount: 1,
              promptPersisted: true,
              latestEventType: 'session.status',
              latestAssistantMessageId: 'msg-assistant-1',
              diagnostics: [],
            }),
            dispose: () => {
              observationMarks.push('disposed')
            },
          }
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async (_sessionId, body) => {
            promptBodies.push(body)
          },
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.promptAsyncWithTurnSettled(buildRecord({
      selectedModel: 'kimi-for-coding/k3',
      selectedVariant: 'max',
    }), {
      text: 'Continue task',
      agent: 'teammate',
      timeoutMs: 500,
      idleTimeoutMs: 100,
      onPromptSubmitting: async event => {
        hookEvents.push(`submitting:${event.sessionId}:${event.runtimePromptMessageId}`)
      },
      onPromptAccepted: async event => {
        hookEvents.push(`accepted:${event.sessionId}:${event.runtimePromptMessageId}`)
      },
      onTurnObserved: async event => {
        hookEvents.push(`turn:${event.sessionId}:${event.turnSettled.outcome}`)
      },
    })

    expect(result.runtimePromptMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(result.turnSettled.outcome).toBe('success')
    expect(result.hookDiagnostics).toEqual([])
    expect(promptBodies).toEqual([
      {
        messageID: result.runtimePromptMessageId,
        agent: 'teammate',
        noReply: undefined,
        system: undefined,
        variant: 'max',
        model: {
          providerID: 'kimi-for-coding',
          modelID: 'k3',
        },
        parts: [{ type: 'text', text: 'Continue task' }],
      },
    ])
    expect(observationMarks).toEqual(['submitting', 'accepted', 'disposed'])
    expect(hookEvents).toEqual([
      `submitting:session-1:${result.runtimePromptMessageId}`,
      `accepted:session-1:${result.runtimePromptMessageId}`,
      'turn:session-1:success',
    ])
  })

  test('keeps accepted prompt state when the accepted hook fails', async () => {
    const observationMarks: string[] = []
    let promptCalls = 0
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      turnSettledObserver: {
        observe: input => {
          const runtimePromptMessageId = input.runtimePromptMessageId ?? ''
          return {
            runtimePromptMessageId,
            turnId: runtimePromptMessageId,
            markPromptSubmitting: () => {
              observationMarks.push('submitting')
            },
            markPromptAcceptedByEndpoint: () => {
              observationMarks.push('accepted')
            },
            markPromptRejectedByEndpoint: error => {
              observationMarks.push(`rejected:${String(error)}`)
            },
            waitForSettled: async () => ({
              outcome: 'success',
              sessionId: 'session-1',
              runtimePromptMessageId,
              turnId: runtimePromptMessageId,
              endpoint: '/event',
              streamConnected: true,
              observedEventCount: 2,
              matchedEventCount: 2,
              assistantActivityCount: 1,
              promptPersisted: true,
              latestEventType: 'session.status',
              latestAssistantMessageId: 'msg-assistant-1',
              diagnostics: [],
            }),
            dispose: () => {
              observationMarks.push('disposed')
            },
          }
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {
            promptCalls += 1
          },
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.promptAsyncWithTurnSettled(buildRecord(), {
      text: 'Continue task',
      onPromptAccepted: async () => {
        throw new Error('store write failed after accept')
      },
    })

    expect(promptCalls).toBe(1)
    expect(result.hookDiagnostics).toEqual([
      'OpenCode prompt accepted hook failed - store write failed after accept',
    ])
    expect(observationMarks).toEqual(['submitting', 'accepted', 'disposed'])
  })

  test('posts prompt_async with app-owned message id without waiting for turn-settled in acceptance mode', async () => {
    const promptBodies: unknown[] = []
    const hookEvents: string[] = []
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      turnSettledObserver: {
        observe: () => {
          throw new Error('turn-settled observer must not be attached in acceptance-only mode')
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async (_sessionId, body) => {
            promptBodies.push(body)
          },
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.promptAsyncUntilAccepted(buildRecord(), {
      text: 'Accept fast',
      agent: 'teammate',
      onPromptSubmitting: async event => {
        hookEvents.push(`submitting:${event.sessionId}:${event.runtimePromptMessageId}`)
      },
      onPromptAccepted: async event => {
        hookEvents.push(`accepted:${event.sessionId}:${event.runtimePromptMessageId}`)
      },
    })

    expect(result.runtimePromptMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(result.hookDiagnostics).toEqual([])
    expect(promptBodies).toEqual([
      {
        messageID: result.runtimePromptMessageId,
        agent: 'teammate',
        noReply: false,
        system: undefined,
        model: {
          providerID: 'openai',
          modelID: 'gpt-5.4-mini',
        },
        parts: [{ type: 'text', text: 'Accept fast' }],
      },
    ])
    expect(hookEvents).toEqual([
      `submitting:session-1:${result.runtimePromptMessageId}`,
      `accepted:session-1:${result.runtimePromptMessageId}`,
    ])
  })

  test('allocates prompt_async message ids after latest canonical OpenCode message id', async () => {
    const latestAssistantMessageId = buildOpenCodeRuntimePromptMessageId({
      timestampMs: Date.now(),
      counter: 1,
      randomSuffix: 'AAAAAAAAAAAAAA',
    })
    const lowerLegacyMessageId = `msg_${latestAssistantMessageId.slice(4, 16)}${'0'.repeat(20)}`
    const promptBodies: Array<Record<string, unknown>> = []
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [
            {
              info: { id: latestAssistantMessageId, role: 'assistant' },
              parts: [],
            },
            {
              info: { id: lowerLegacyMessageId, role: 'user' },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async (_sessionId, body) => {
            promptBodies.push(body)
          },
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.promptAsyncUntilAccepted(buildRecord(), {
      text: 'Continue after assistant',
    })

    expect(result.runtimePromptMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(result.runtimePromptMessageId > latestAssistantMessageId).toBe(true)
    expect(promptBodies[0]?.messageID).toBe(result.runtimePromptMessageId)
    expect(result.hookDiagnostics).toEqual([])
  })

  test('continues prompt_async delivery when prompt id lower-bound fetch fails', async () => {
    const promptBodies: Array<Record<string, unknown>> = []
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => {
            throw new Error('temporary message list failure')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async (_sessionId, body) => {
            promptBodies.push(body)
          },
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.promptAsyncUntilAccepted(buildRecord(), {
      text: 'Accept despite list failure',
    })

    expect(result.runtimePromptMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(promptBodies[0]?.messageID).toBe(result.runtimePromptMessageId)
    expect(result.hookDiagnostics).toEqual([
      'OpenCode prompt id lower-bound check skipped - temporary message list failure',
    ])
  })

  test('fails before prompt_async when no safe prompt message id can be allocated', async () => {
    const futureAssistantMessageId = buildOpenCodeRuntimePromptMessageId({
      timestampMs: Date.now() + 60_000,
      counter: 1,
      randomSuffix: 'GGGGGGGGGGGGGG',
    })
    let promptCalls = 0
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [
            {
              info: { id: futureAssistantMessageId, role: 'assistant' },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {
            promptCalls += 1
          },
          abortSession: async () => true,
        }),
      },
    })

    await expect(bridge.promptAsyncUntilAccepted(buildRecord(), {
      text: 'Should not send with unsafe id',
    })).rejects.toThrow('OpenCode prompt id allocation failed')
    expect(promptCalls).toBe(0)
  })

  test('fails before prompt_async when a high legacy msg id would poison OpenCode ordering', async () => {
    let promptCalls = 0
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [
            {
              info: { id: 'msg_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', role: 'user' },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {
            promptCalls += 1
          },
          abortSession: async () => true,
        }),
      },
    })

    await expect(bridge.promptAsyncUntilAccepted(buildRecord(), {
      text: 'Should not send into poisoned ordering',
    })).rejects.toThrow('OpenCode prompt id allocation failed')
    expect(promptCalls).toBe(0)
  })

  test('rejects noReply prompt_async before attaching turn-settled observation', async () => {
    let hostEnsured = false
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => {
          hostEnsured = true
          return host
        },
        releaseHost: async () => {},
      },
      turnSettledObserver: {
        observe: () => {
          throw new Error('turn-settled observer must not be attached for noReply')
        },
      },
    })

    await expect(bridge.promptAsyncWithTurnSettled(buildRecord(), {
      text: 'fire and forget',
      noReply: true,
    })).rejects.toThrow('does not support noReply')
    expect(hostEnsured).toBe(false)
  })

  test('reconciles durable session history from messages and status', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'updated'
        },
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Reply with exactly: pong' }],
            },
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'pong' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const current = buildRecord()
    const result = await bridge.reconcileSession(current)

    expect(result.summary.reconcileOutcome).toBe('reconciled')
    expect(result.summary.durableState).toBe('idle')
    expect(result.summary.staleReason).toBeNull()
    expect(result.summary.profileAuthState).toBe('ok')
    expect(result.summary.pendingPermissionRequestIds).toEqual([])
    expect(result.summary.latestAssistantText).toBe('pong')
    expect(result.record.lastCanonicalCursor).toBe('msg-assistant-1')
    expect(result.record.lastKnownRawStatus).toBe('idle')
    expect(result.record.lastKnownDurableState).toBe('idle')
    expect(upserts).toHaveLength(1)
  })

  test('infers manual tool approval mode for legacy records from stored host config fingerprint', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const prepareProfileModes: Array<string | undefined> = []
    const ensuredProfileFingerprints: string[] = []
    const manualProfile: OpenCodePreparedProfile = {
      ...profile,
      managedConfigFingerprint: 'manual-config-v1',
    }
    const autoProfile: OpenCodePreparedProfile = {
      ...profile,
      managedConfigFingerprint: 'auto-config-v1',
    }
    const manualHost: OpenCodeHostHandle = {
      ...host,
      hostKey: '/tmp/project::profile-root::behavior-v1::manual-config-v1',
      profile: manualProfile,
      resolvedConfigFingerprint: null,
    }
    const legacyRecord = buildRecord({
      hostKey: manualHost.hostKey,
      resolvedBehaviorFingerprint: null,
      managedConfigFingerprint: undefined,
      toolApprovalMode: undefined,
    })
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async (_projectPath, options) => {
        prepareProfileModes.push(options?.toolApprovalMode)
        return options?.toolApprovalMode === 'manual' ? manualProfile : autoProfile
      },
      hostManager: {
        ensureHost: async input => {
          ensuredProfileFingerprints.push(input?.preparedProfile?.managedConfigFingerprint ?? 'missing')
          return manualHost
        },
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'updated'
        },
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'hello' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.reconcileSession(legacyRecord)

    expect(prepareProfileModes).toEqual(['auto', 'manual'])
    expect(ensuredProfileFingerprints).toEqual(['manual-config-v1'])
    expect(result.record.toolApprovalMode).toBe('manual')
    expect(result.record.managedConfigFingerprint).toBe('manual-config-v1')
    expect(upserts[0]?.toolApprovalMode).toBe('manual')
    expect(upserts[0]?.managedConfigFingerprint).toBe('manual-config-v1')
  })

  test('skips durable reconcile when stored project behavior has drifted', async () => {
    const staleMarks: Array<{ laneId: string; staleReason: string }> = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => ({
        ...profile,
        projectBehaviorFingerprint: 'behavior-v2',
      }),
      hostManager: {
        ensureHost: async () => {
          throw new Error('host should not be started for stale sessions')
        },
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'unchanged',
        markStale: async (_teamId, laneId, _memberName, staleReason) => {
          staleMarks.push({ laneId, staleReason })
          return buildRecord({ staleReason })
        },
      },
      clientFactory: {
        create: () => {
          throw new Error('client should not be created for stale sessions')
        },
      },
    })

    const result = await bridge.reconcileSession(buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
    }))

    expect(staleMarks).toEqual([{
      laneId: 'secondary:opencode:bob',
      staleReason: 'project_behavior_changed',
    }])
    expect(result.summary.reconcileOutcome).toBe('stale')
    expect(result.summary.staleReason).toBe('project_behavior_changed')
    expect(result.summary.messageCount).toBe(0)
  })

  test('marks session stale when resolved runtime behavior changes unexpectedly', async () => {
    const staleMarks: Array<{ laneId: string; staleReason: string }> = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => ({
          ...host,
          resolvedConfigFingerprint: 'resolved-fingerprint-next',
        }),
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'unchanged',
        markStale: async (_teamId, laneId, _memberName, staleReason) => {
          staleMarks.push({ laneId, staleReason })
          return buildRecord({ staleReason })
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.reconcileSession(buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
    }))

    expect(staleMarks).toEqual([{
      laneId: 'secondary:opencode:bob',
      staleReason: 'resolved_behavior_changed:resolved-fingerprint->resolved-fingerprint-next',
    }])
    expect(result.summary.reconcileOutcome).toBe('stale')
    expect(result.summary.staleReason).toBe(
      'resolved_behavior_changed:resolved-fingerprint->resolved-fingerprint-next',
    )
  })

  test('marks durable state blocked when the session has pending permission requests', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'updated'
        },
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-2',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 200 },
              },
              parts: [{ type: 'text', text: 'Can you run git status?' }],
            },
          ],
          getPermissions: async () => [
            {
              requestID: 'perm-1',
              sessionID: 'session-1',
              tool: 'bash',
              title: 'Run git status',
              kind: 'tool',
            },
          ],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.reconcileSession(buildRecord())

    expect(result.summary.durableState).toBe('blocked')
    expect(result.summary.pendingPermissionRequestIds).toEqual(['perm-1'])
    expect(result.summary.pendingPermissions).toMatchObject([
      {
        requestId: 'perm-1',
        sessionId: 'session-1',
        tool: 'bash',
        title: 'Run git status',
        kind: 'tool',
      },
    ])
    expect(
      result.summary.diagnostics.some(item => item.includes('pending permission request')),
    ).toBe(true)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.lastKnownDurableState).toBe('blocked')
  })

  test('keeps durable reconcile working when the permission probe fails', async () => {
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'updated',
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'pong' }],
            },
          ],
          getPermissions: async () => {
            throw new Error('permission endpoint timed out')
          },
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.reconcileSession(buildRecord())

    expect(result.summary.durableState).toBe('idle')
    expect(result.summary.pendingPermissionRequestIds).toEqual([])
    expect(
      result.summary.diagnostics.some(item => item.includes('Permission probe unavailable')),
    ).toBe(true)
  })

  test('rebuilds full durable history when the bounded message window no longer contains the stored cursor', async () => {
    const requestedLimits: Array<number | undefined> = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'updated',
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async (_id, limit) => {
            requestedLimits.push(limit)
            if (typeof limit === 'number') {
              return [
                {
                  info: {
                    id: 'msg-assistant-9',
                    role: 'assistant',
                    parentID: 'msg-user-9',
                    sessionID: 'session-1',
                    time: { created: 200, completed: 210 },
                  },
                  parts: [{ type: 'text', text: 'preview-pong' }],
                },
              ]
            }

            return [
              {
                info: {
                  id: 'msg-user-9',
                  role: 'user',
                  sessionID: 'session-1',
                  time: { created: 190 },
                },
                parts: [{ type: 'text', text: 'Reply with exactly: preview-pong' }],
              },
              {
                info: {
                  id: 'msg-assistant-9',
                  role: 'assistant',
                  parentID: 'msg-user-9',
                  sessionID: 'session-1',
                  time: { created: 200, completed: 210 },
                },
                parts: [{ type: 'text', text: 'preview-pong' }],
              },
            ]
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.reconcileSession(
      buildRecord({ lastCanonicalCursor: 'msg-user-9' }),
      { limit: 1 },
    )

    expect(requestedLimits).toEqual([1, undefined])
    expect(result.summary.latestAssistantText).toBe('preview-pong')
    expect(
      result.summary.diagnostics.some(item => item.includes('rebuilding full OpenCode session history')),
    ).toBe(true)
  })

  test('projects on-demand log messages from the durable reconcile summary', async () => {
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'updated',
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-log-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Run pwd' }],
            },
            {
              info: {
                id: 'msg-assistant-log-1',
                role: 'assistant',
                parentID: 'msg-user-log-1',
                providerID: 'opencode',
                modelID: 'big-pickle',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [
                { type: 'reasoning', text: 'Need bash first.' },
                {
                  type: 'tool',
                  tool: 'bash',
                  callID: 'call_pwd',
                  state: {
                    status: 'completed',
                    input: { command: 'pwd' },
                    output: '/tmp/project\n',
                    metadata: { output: '/tmp/project\n', exit: 0 },
                    time: { start: 102, end: 109 },
                  },
                },
                { type: 'text', text: '/tmp/project' },
              ],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await bridge.projectLogMessages(buildRecord())

    expect(result.summary.toolCallCount).toBe(1)
    expect(result.logProjection.projectedMessageCount).toBe(3)
    expect(result.logProjection.syntheticMessageCount).toBe(1)
    expect(result.logProjection.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: 'msg-assistant-log-1',
          type: 'assistant',
        }),
        expect.objectContaining({
          uuid: 'msg-assistant-log-1::tool_results',
          type: 'user',
          isMeta: true,
          sourceToolAssistantUUID: 'msg-assistant-log-1',
        }),
      ]),
    )
  })

  test('projects historical log messages for stale sessions without reusing durable state', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const staleMarks: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'updated'
        },
        markStale: async (_teamId, _laneId, _memberName, staleReason) => {
          staleMarks.push(staleReason)
          return buildRecord({ staleReason })
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-stale-log-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'What happened on task #1?' }],
            },
            {
              info: {
                id: 'msg-assistant-stale-log-1',
                role: 'assistant',
                parentID: 'msg-user-stale-log-1',
                providerID: 'opencode',
                modelID: 'big-pickle',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'Historical answer' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const staleReason = 'resolved_behavior_changed:old->new'
    const result = await bridge.projectLogMessages(buildRecord({ staleReason }))

    expect(result.summary.reconcileOutcome).toBe('stale')
    expect(result.summary.staleReason).toBe(staleReason)
    expect(result.summary.messageCount).toBe(2)
    expect(result.summary.latestAssistantText).toBe('Historical answer')
    expect(result.summary.diagnostics[0]).toContain(
      'reading historical messages for log projection only',
    )
    expect(result.logProjection.projectedMessageCount).toBe(2)
    expect(upserts).toEqual([])
    expect(staleMarks).toEqual([])
  })

  test('recovers stale session log projection from offline SQLite when live history read fails', async () => {
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'updated',
        markStale: async () => buildRecord({ staleReason: 'resolved_behavior_changed' }),
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => {
            throw new Error('live history unavailable')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      offlineReader: {
        readSession: async () => ({
          source: 'opencode-sqlite',
          dbPath: '/tmp/state.db',
          dbFingerprint: { dbMtimeMs: 1, dbSizeBytes: 1 },
          sessionIdentity: null,
          snapshotStepParts: [],
          patchParts: [],
          snapshotWindows: [],
          rawMessages: [],
          rawParts: [],
          messages: [
            {
              info: {
                id: 'msg-user-offline-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'offline prompt' }],
            },
            {
              info: {
                id: 'msg-assistant-offline-1',
                role: 'assistant',
                parentID: 'msg-user-offline-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'Offline recovered answer' }],
            },
          ],
          diagnostics: ['offline row cap ok'],
        }),
      },
    })

    const result = await bridge.projectLogMessages(
      buildRecord({ staleReason: 'resolved_behavior_changed' }),
    )

    expect(result.summary.reconcileOutcome).toBe('stale')
    expect(result.summary.messageCount).toBe(2)
    expect(result.summary.latestAssistantText).toBe('Offline recovered answer')
    expect(result.summary.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('recovered historical messages from local SQLite store'),
        expect.stringContaining('live history unavailable'),
        'offline row cap ok',
      ]),
    )
    expect(result.logProjection.projectedMessageCount).toBe(2)
  })

  test('observes preview without mutating durable session state', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async record => {
          upserts.push(record)
          return 'updated'
        },
        markStale: async () => null,
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-new' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      previewObserver: {
        observeSession: async () => buildPreviewSummary(),
      },
    })

    const result = await bridge.observePreview(buildRecord(), {
      timeoutMs: 200,
      idleTimeoutMs: 50,
    })

    expect(result.summary.previewOutcome).toBe('observed')
    expect(result.summary.profileAuthState).toBe('ok')
    expect(result.summary.latestAssistantPreview).toBe('pong')
    expect(upserts).toEqual([])
  })

  test('observes preview on the stored manual session profile', async () => {
    const prepareProfileModes: Array<string | undefined> = []
    const ensuredProfileFingerprints: string[] = []
    const observedSessions: string[] = []
    const manualProfile: OpenCodePreparedProfile = {
      ...profile,
      managedConfigFingerprint: 'manual-config-v1',
    }
    const manualHost: OpenCodeHostHandle = {
      ...host,
      profile: manualProfile,
    }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async (_projectPath, options) => {
        prepareProfileModes.push(options?.toolApprovalMode)
        return manualProfile
      },
      hostManager: {
        ensureHost: async input => {
          ensuredProfileFingerprints.push(input?.preparedProfile?.managedConfigFingerprint ?? 'missing')
          return manualHost
        },
        releaseHost: async () => {},
      },
      previewObserver: {
        observeSession: async input => {
          observedSessions.push(input.sessionId)
          return buildPreviewSummary()
        },
      },
    })

    const result = await bridge.observePreview(buildRecord({
      toolApprovalMode: 'manual',
      managedConfigFingerprint: 'manual-config-v1',
    }))

    expect(prepareProfileModes).toEqual(['manual'])
    expect(ensuredProfileFingerprints).toEqual(['manual-config-v1'])
    expect(observedSessions).toEqual(['session-1'])
    expect(result.summary.previewOutcome).toBe('observed')
  })

  test('skips preview observation when the stored session is stale', async () => {
    const staleMarks: Array<{ laneId: string; staleReason: string }> = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => ({
        ...profile,
        managedAuthFingerprint: 'managed-auth-v2',
      }),
      hostManager: {
        ensureHost: async () => {
          throw new Error('host should not be started for stale preview observation')
        },
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'unchanged',
        markStale: async (_teamId, laneId, _memberName, staleReason) => {
          staleMarks.push({ laneId, staleReason })
          return buildRecord({ staleReason })
        },
      },
      clientFactory: {
        create: () => {
          throw new Error('client should not be created for stale preview observation')
        },
      },
    })

    const result = await bridge.observePreview(buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
    }))

    expect(staleMarks).toEqual([{
      laneId: 'secondary:opencode:bob',
      staleReason: 'managed_auth_changed',
    }])
    expect(result.summary.previewOutcome).toBe('stale')
    expect(result.summary.staleReason).toBe('managed_auth_changed')
    expect(result.summary.streamConnected).toBe(false)
  })
})
