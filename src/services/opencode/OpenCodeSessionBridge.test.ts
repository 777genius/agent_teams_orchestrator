import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  buildOpenCodeRuntimePromptMessageId,
  resetOpenCodeRuntimePromptMessageIdAllocatorForTest,
} from './OpenCodeMessageIds.js'
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
    version: 2,
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'alice',
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4-mini',
    projectIdentity: overrides.projectIdentity ?? overrides.projectPath ?? '/tmp/project',
    projectPath: '/tmp/project',
    runId: null,
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

  test.each([
    ['accepts exact returned and persisted ownership',
      { id: 'msg-bootstrap', sessionID: 'session-1' }, { id: 'msg-bootstrap', sessionID: 'session-1' }, true],
    ['rejects a missing returned message id',
      { sessionID: 'session-1' }, { id: 'msg-bootstrap', sessionID: 'session-1' }, false],
    ['rejects a mismatched returned message id',
      { id: 'msg-other', sessionID: 'session-1' }, { id: 'msg-bootstrap', sessionID: 'session-1' }, false],
    ['rejects a missing returned session id',
      { id: 'msg-bootstrap' }, { id: 'msg-bootstrap', sessionID: 'session-1' }, false],
    ['rejects a mismatched returned session id',
      { id: 'msg-bootstrap', sessionID: 'session-other' },
      { id: 'msg-bootstrap', sessionID: 'session-1' }, false],
    ['rejects a missing persisted message id',
      { id: 'msg-bootstrap', sessionID: 'session-1' }, { sessionID: 'session-1' }, false],
    ['rejects a mismatched persisted message id',
      { id: 'msg-bootstrap', sessionID: 'session-1' }, { id: 'msg-other', sessionID: 'session-1' }, false],
    ['rejects a missing persisted session id',
      { id: 'msg-bootstrap', sessionID: 'session-1' }, { id: 'msg-bootstrap' }, false],
    ['rejects a mismatched persisted session id',
      { id: 'msg-bootstrap', sessionID: 'session-1' },
      { id: 'msg-bootstrap', sessionID: 'session-other' }, false],
  ] as const)('app-managed bootstrap %s', async (_name, returnedInfo, persistedInfo, valid) => {
    const text = '<exact-bootstrap>'
    const messageID = 'msg-bootstrap'
    const exactMessage = { info: persistedInfo,
      parts: [{ type: 'text', text }] }
    let exactReads = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      oauthRefreshCoordinator: { ensureFreshForPrompt: async () => ({ checked: true, refreshed: false }) },
      hostManager: { ensureHost: async () => host, releaseHost: async () => {} },
      clientFactory: { create: () => ({
        getSessionMessage: async () => ++exactReads === 1 ? null : exactMessage,
        getSessionMessages: async () => [],
        sendSessionMessage: async () => ({ info: returnedInfo, parts: [{ type: 'text', text }] }),
      } as never) },
    })
    const operation = bridge.injectAppManagedBootstrapContext(buildRecord(), {
      messageID, text, agent: 'teammate-bootstrap',
      contextHash: createHash('sha256').update(text).digest('hex'), briefingHash: 'b'.repeat(64),
    })
    if (valid) {
      await expect(operation).resolves.toMatchObject({
        messageID, runtimeSessionId: 'session-1', alreadyPresent: false,
      })
    } else {
      await expect(operation).rejects.toThrow(/bootstrap context (id|session) mismatch after (send|read-after-send)/)
    }
  })

  test('reuses an existing clean session record', async () => {
    let createSessionCalls = 0
    let prepareProfileCalls = 0
    const retainedLeases: unknown[] = []
    const existing = buildRecord({ runId: 'run-1' })
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

  test('reuses only the project-qualified session when two projects share a logical member', async () => {
    const projectA = buildRecord({ projectPath: '/tmp/project-a', opencodeSessionId: 'session-a' })
    const projectB = buildRecord({ projectPath: '/tmp/project-b', opencodeSessionId: 'session-b', runId: 'run-b' })
    const projectBProfile = { ...profile, projectPath: projectB.projectPath }
    const lookups: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => projectBProfile,
      sessionStore: {
        get: async () => projectA,
        getByLogicalMember: async logical => {
          lookups.push(logical.projectIdentity)
          return logical.projectIdentity === projectB.projectPath ? projectB : projectA
        },
        upsert: async () => 'unchanged',
        markStale: async () => projectA,
      },
      hostManager: {
        ensureHost: async () => ({ ...host, projectPath: projectB.projectPath, profile: projectBProfile }),
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
    })

    const record = await bridge.ensureSession({
      teamId: projectB.teamId, laneId: projectB.laneId, memberName: projectB.memberName,
      selectedModel: projectB.selectedModel, projectPath: projectB.projectPath, runId: 'run-b',
    })

    expect(lookups).toEqual(['/tmp/project-b'])
    expect(record.opencodeSessionId).toBe('session-b')
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
    expect(record.managedConfigFingerprint).toBe('managed-config-v1')
    expect(upserts[0]?.toolApprovalMode).toBe('manual')
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
      runId: 'run-1',
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
          return 'applied' as const
        },
      },
    })

    await bridge.releaseSession(buildRecord({ runId: 'run-restarted' }))

    expect(releasedLeases).toEqual([
      {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-restarted',
        sessionId: 'session-1',
      },
    ])
    expect(releaseHostCalls).toBe(0)
  })

  test('ensureSessionAppMcpReady verifies app MCP on the session host', async () => {
    const ensureCalls: Array<{ baseUrl: string; attachIfMissing?: boolean }> = []
    const retainedLeases: unknown[] = []
    let releaseHostCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async input => {
          expect(input).toEqual({ projectPath: '/tmp/project', hostKey: 'host-key', preparedProfile: profile })
          return host
        },
        releaseHost: async () => {
          releaseHostCalls += 1
        },
        retainHostLease: async (_hostKey, owner) => { retainedLeases.push(owner) },
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
    expect(retainedLeases).toEqual([{
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      runId: null, sessionId: 'session-1',
    }])
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
    const publications: Array<{ successor: OpenCodeSessionRecord; oldSessionId: string; oldRunId: string | null }> = []
    let prepareProfileCalls = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => {
        prepareProfileCalls += 1
        return profile
      },
      sessionStore: {
        get: async () => buildRecord(),
        publishSuccessorIfExact: async (successor, oldSessionId, oldRunId) => {
          publications.push({ successor, oldSessionId, oldRunId })
          return { status: 'replaced' as const, record: successor }
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
          deleteSession: async () => true,
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

    expect(record.opencodeSessionId).toBe('session-new')
    expect(record.bootstrapMode).toBe('app_managed_context')
    expect(prepareProfileCalls).toBe(1)
    expect(publications).toHaveLength(1)
    expect(publications[0]).toMatchObject({ oldSessionId: 'session-1', oldRunId: null })
    expect(publications[0]?.successor.bootstrapMode).toBe('app_managed_context')
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

  test('releases only the fresh host when publication fails before lease retention', async () => {
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
          return 'applied' as const
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
          deleteSession: async () => true,
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

    expect(retainedLeases).toEqual([])
    expect(releasedLeases).toEqual([])
    expect(releaseHostCalls).toBe(1)
  })

  test('sends provider-scoped model data when posting a message', async () => {
    const sentBodies: unknown[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
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

  test('cleans up a created successor when exact publication observes a replacement owner', async () => {
    const original = buildRecord({ runId: 'run-old' })
    const replacement = buildRecord({
      runId: 'run-new', opencodeSessionId: 'session-replacement',
    })
    let releaseCalls = 0
    let createCalls = 0
    const deleted: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => original,
        publishSuccessorIfExact: async () => ({
          status: 'conflict', record: replacement,
        }),
        upsertIfSessionMatches: async () => ({ status: 'foreign', record: replacement }),
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { releaseCalls += 1 },
        refreshResolvedConfigFingerprint: async () => 'replacement-fingerprint',
      },
      clientFactory: { create: () => ({
        createSession: async () => { createCalls += 1; return { id: 'session-new' } },
        deleteSession: async id => { deleted.push(id); return true },
      } as never) },
    })

    await expect(bridge.ensureSession({
      teamId: original.teamId, laneId: original.laneId, memberName: original.memberName,
      selectedModel: 'openai/gpt-5.4', projectPath: original.projectPath,
      runId: original.runId,
    })).rejects.toThrow('ownership changed')
    expect({ releaseCalls, createCalls, deleted }).toEqual({
      releaseCalls: 1, createCalls: 1, deleted: ['session-new'],
    })
    await expect(bridge.refreshSessionEnvironment(original)).rejects.toThrow('ownership changed')
  })

  test('keeps successor ownership observable when remote cleanup cannot be confirmed', async () => {
    const old = buildRecord({ runId: 'run-old' })
    const retained: unknown[] = []
    let releasedLease = 0
    let releasedHost = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => old,
        publishSuccessorIfExact: async () => ({
          status: 'conflict' as const,
          record: buildRecord({ opencodeSessionId: 'session-foreign', runId: 'run-foreign' }),
        }),
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { releasedHost += 1 },
        retainHostLease: async (_key, owner) => { retained.push(owner) },
        releaseHostLease: async () => { releasedLease += 1; return 'applied' as const },
      },
      clientFactory: { create: () => ({
        createSession: async () => ({ id: 'session-new' }),
        deleteSession: async () => { throw new Error('transport outcome unknown') },
      } as never) },
    })

    await expect(bridge.ensureSession({
      teamId: old.teamId, laneId: old.laneId, memberName: old.memberName,
      selectedModel: old.selectedModel, projectPath: old.projectPath,
      runId: 'run-new', fresh: true,
    })).rejects.toThrow(/cleanup remains required for session-new on host-key.*outcome unknown/)
    expect(retained).toHaveLength(0)
    expect({ releasedLease, releasedHost }).toEqual({ releasedLease: 0, releasedHost: 0 })
  })

  test('retries uncertain cleanup through the original client before creating again', async () => {
    const old = buildRecord({ runId: 'run-old' })
    let createCalls = 0
    let deleteCalls = 0
    let releasedHosts = 0
    const firstClient = {
      createSession: async () => ({ id: `session-new-${++createCalls}` }),
      deleteSession: async () => {
        deleteCalls += 1
        if (deleteCalls === 1) throw new Error('cleanup outcome unknown')
        return true
      },
    }
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => old,
        publishSuccessorIfExact: async () => ({ status: 'absent' }),
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { releasedHosts += 1 },
      },
      clientFactory: { create: () => firstClient as never },
    })
    const input = {
      teamId: old.teamId, laneId: old.laneId, memberName: old.memberName,
      selectedModel: old.selectedModel, projectPath: old.projectPath, runId: 'run-new',
    }

    await expect(bridge.ensureSession(input)).rejects.toThrow('cleanup remains required')
    expect({ createCalls, deleteCalls, releasedHosts }).toEqual({
      createCalls: 1, deleteCalls: 1, releasedHosts: 0,
    })
    await expect(bridge.ensureSession(input)).rejects.toThrow('ownership changed')
    expect({ createCalls, deleteCalls, releasedHosts }).toEqual({
      createCalls: 2, deleteCalls: 3, releasedHosts: 2,
    })
  })

  test('preserves the predecessor for conflict, reservation conflict, absence, and thrown publication', async () => {
    const old = buildRecord({ runId: 'run-old' })
    const outcomes = [
      { status: 'conflict' as const, record: buildRecord({
        opencodeSessionId: 'session-foreign', runId: 'run-foreign',
      }) },
      { status: 'conflict' as const, reservation: {
        version: 1 as const,
        logicalMemberKey: 'logical',
        reservationIdentity: 'reservation',
        expectedOpencodeSessionId: 'reserved-session',
        createdAt: old.createdAt,
        teamId: old.teamId,
        laneId: old.laneId,
        projectIdentity: old.projectIdentity,
        memberName: old.memberName,
      } },
      { status: 'absent' as const },
      new Error('publication write failed'),
    ]

    for (const outcome of outcomes) {
      const deleted: string[] = []
      let releasedHost = 0
      let retainedLease = 0
      let releasedLease = 0
      const bridge = new OpenCodeSessionBridge({
        prepareProfile: async () => profile,
        sessionStore: {
          get: async () => old,
          publishSuccessorIfExact: async () => {
            if (outcome instanceof Error) throw outcome
            return outcome
          },
        },
        hostManager: {
          ensureHost: async () => host,
          releaseHost: async () => { releasedHost += 1 },
          retainHostLease: async () => { retainedLease += 1 },
          releaseHostLease: async () => { releasedLease += 1; return 'applied' as const },
        },
        clientFactory: { create: () => ({
          createSession: async () => ({ id: 'session-new' }),
          deleteSession: async id => { deleted.push(id); return true },
        } as never) },
      })

      await expect(bridge.ensureSession({
        teamId: old.teamId, laneId: old.laneId, memberName: old.memberName,
        selectedModel: old.selectedModel, projectPath: old.projectPath,
        runId: 'run-new',
      })).rejects.toThrow(outcome instanceof Error ? outcome.message : 'ownership changed')
      expect({ deleted, releasedHost, retainedLease, releasedLease }).toEqual({
        deleted: ['session-new'], releasedHost: 1, retainedLease: 0, releasedLease: 0,
      })
      expect(old).toMatchObject({ opencodeSessionId: 'session-1', runId: 'run-old' })
    }
  })

  test('never deletes a protected deterministic session id owned by another run', async () => {
    const old = buildRecord({ runId: 'run-old' })
    let deletes = 0
    let releasedHost = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => old,
        publishSuccessorIfExact: async () => ({
          status: 'conflict',
          record: buildRecord({ opencodeSessionId: old.opencodeSessionId, runId: 'run-foreign' }),
        }),
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { releasedHost += 1 },
      },
      clientFactory: { create: () => ({
        createSession: async () => ({ id: old.opencodeSessionId }),
        deleteSession: async () => { deletes += 1; return true },
      } as never) },
    })

    await expect(bridge.ensureSession({
      teamId: old.teamId, laneId: old.laneId, memberName: old.memberName,
      selectedModel: old.selectedModel, projectPath: old.projectPath, runId: 'run-new',
    })).rejects.toThrow('ownership changed')
    expect({ deletes, releasedHost }).toEqual({ deletes: 0, releasedHost: 1 })
  })

  test('retries a published successor lease before releasing the predecessor lease', async () => {
    let current = buildRecord({ runId: 'run-old' })
    let creates = 0
    let deletes = 0
    let retainAttempts = 0
    const events: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => current,
        publishSuccessorIfExact: async successor => {
          events.push('publish-successor')
          current = successor
          return { status: 'replaced', record: successor }
        },
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { events.push('release-host') },
        retainHostLease: async () => {
          retainAttempts += 1
          events.push(retainAttempts === 1 ? 'retain-failed' : 'retain-successor')
          if (retainAttempts === 1) throw new Error('lease store unavailable')
        },
        releaseHostLease: async (_key, owner) => {
          events.push(`release-old:${owner.sessionId}`)
          return 'foreign'
        },
      },
      clientFactory: { create: () => ({
        createSession: async () => ({ id: `session-new-${++creates}` }),
        deleteSession: async () => { deletes += 1; return true },
      } as never) },
    })
    const input = {
      teamId: current.teamId, laneId: current.laneId, memberName: current.memberName,
      selectedModel: current.selectedModel, projectPath: current.projectPath,
      runId: 'run-new', fresh: true,
    }

    await expect(bridge.ensureSession(input)).rejects.toThrow(
      /published but successor host lease retention failed.*lease store unavailable/,
    )
    expect(current).toMatchObject({ opencodeSessionId: 'session-new-1', runId: 'run-new' })
    expect(events).toEqual(['publish-successor', 'retain-failed'])
    expect({ creates, deletes }).toEqual({ creates: 1, deletes: 0 })

    const retried = await bridge.ensureSession(input)
    expect(retried).toMatchObject({ opencodeSessionId: 'session-new-1', runId: 'run-new' })
    expect(events).toEqual([
      'publish-successor', 'retain-failed', 'retain-successor', 'release-old:session-1',
    ])
    expect({ creates, deletes }).toEqual({ creates: 1, deletes: 0 })
  })

  test('a restarted bridge reuses the durable successor after lease retention failure', async () => {
    let current = buildRecord({ runId: 'run-old' })
    let creates = 0
    const store = {
      get: async () => current,
      publishSuccessorIfExact: async (successor: OpenCodeSessionRecord) => {
        current = successor
        return { status: 'replaced' as const, record: successor }
      },
    }
    const clientFactory = { create: () => ({
      createSession: async () => ({ id: `session-new-${++creates}` }),
      deleteSession: async () => true,
    } as never) }
    const first = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: store,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
        retainHostLease: async () => { throw new Error('lease write failed') },
        releaseHostLease: async () => 'applied',
      },
      clientFactory,
    })
    const input = {
      teamId: current.teamId, laneId: current.laneId, memberName: current.memberName,
      selectedModel: current.selectedModel, projectPath: current.projectPath, runId: 'run-new',
    }
    await expect(first.ensureSession(input)).rejects.toThrow('lease retention failed')

    const restarted = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: store,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
        retainHostLease: async () => {},
        releaseHostLease: async () => 'foreign',
      },
      clientFactory,
    })
    const recovered = await restarted.ensureSession(input)
    expect(recovered).toMatchObject({ opencodeSessionId: 'session-new-1', runId: 'run-new' })
    expect(creates).toBe(1)
  })

  test('successor CAS distinguishes the same deterministic session id under a different run', async () => {
    const old = buildRecord({ runId: 'run-old' })
    const expected: unknown[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => old,
        publishSuccessorIfExact: async (successor, sessionId, runId) => {
          expected.push({ successorRunId: successor.runId, sessionId, runId })
          return { status: 'replaced' as const, record: successor }
        },
      },
      hostManager: {
        ensureHost: async () => host, releaseHost: async () => {},
        retainHostLease: async () => {}, releaseHostLease: async () => 'foreign',
      },
      clientFactory: { create: () => ({
        createSession: async () => ({ id: old.opencodeSessionId }),
        deleteSession: async () => { throw new Error('must not delete the shared deterministic session') },
      } as never) },
    })

    const successor = await bridge.ensureSession({
      teamId: old.teamId, laneId: old.laneId, memberName: old.memberName,
      selectedModel: old.selectedModel, projectPath: old.projectPath, runId: 'run-new',
    })
    expect(successor).toMatchObject({ opencodeSessionId: 'session-1', runId: 'run-new' })
    expect(expected).toEqual([{
      successorRunId: 'run-new', sessionId: 'session-1', runId: 'run-old',
    }])
  })

  test('idempotent refresh retry reuses an already-published exact successor', async () => {
    let current = buildRecord({ runId: 'run-old' })
    let creates = 0
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => current,
        publishSuccessorIfExact: async successor => {
          current = successor
          return { status: 'exact' as const, record: successor }
        },
      },
      hostManager: {
        ensureHost: async () => host, releaseHost: async () => {},
        retainHostLease: async () => {}, releaseHostLease: async () => 'foreign',
      },
      clientFactory: { create: () => ({
        createSession: async () => ({ id: `session-successor-${++creates}` }),
        deleteSession: async () => true,
      } as never) },
    })
    const input = {
      teamId: current.teamId, laneId: current.laneId, memberName: current.memberName,
      selectedModel: current.selectedModel, projectPath: current.projectPath,
      runId: 'run-new', fresh: true,
    }
    const first = await bridge.ensureSession(input)
    const retry = await bridge.ensureSession(input)
    expect(retry.opencodeSessionId).toBe(first.opencodeSessionId)
    expect(creates).toBe(1)
  })

  test('foreign lease CAS preserves the exact retained project run session owner', async () => {
    let releaseHostCalls = 0
    const created = buildRecord({ runId: 'run-new' })
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: {
        get: async () => null,
        publishIfAbsentOrExact: async record => ({ status: 'inserted', record }),
      },
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => { releaseHostCalls += 1 },
        retainHostLease: async () => {},
        releaseHostLease: async () => 'foreign',
      },
      clientFactory: { create: () => ({
        createSession: async () => ({ id: created.opencodeSessionId }),
      } as never) },
    })
    const retained = await bridge.ensureSession({
      teamId: created.teamId, laneId: created.laneId, memberName: created.memberName,
      selectedModel: created.selectedModel, projectPath: created.projectPath,
      preparedProfile: profile, runId: created.runId,
    })

    await expect(bridge.releaseSession(retained)).rejects.toThrow('replacement session')
    expect(releaseHostCalls).toBe(0)
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
      prepareProfile: async () => profile,
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
      prepareProfile: async () => profile,
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
    const promptBodies: Array<Record<string, unknown>> = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
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
              info: { id: 'msg_00008f4f44e4481a8e3b0bbe848d519c', role: 'user' },
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
      prepareProfile: async () => profile,
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
      prepareProfile: async () => profile,
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
      prepareProfile: async () => profile,
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
