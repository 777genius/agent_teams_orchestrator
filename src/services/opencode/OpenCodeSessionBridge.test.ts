import { describe, expect, test } from 'bun:test'

import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'

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
    snapshot: false,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: {},
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
  test('reuses an existing clean session record', async () => {
    let createSessionCalls = 0
    const retainedLeases: unknown[] = []
    const existing = buildRecord()
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => existing,
        upsert: async () => 'unchanged',
        markStale: async () => existing,
      },
      hostManager: {
        ensureHost: async () => host,
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
      },
    ])
    expect(releaseHostCalls).toBe(0)
  })

  test('marks stale and creates a new session when the model changes', async () => {
    const staleReasons: string[] = []
    const upserts: OpenCodeSessionRecord[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
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
    expect(upserts).toHaveLength(1)
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
        ensureHost: async () => host,
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
        sessionId: 'session-new',
      },
    ])
    expect(releasedLeases).toEqual([
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
      },
    ])
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
