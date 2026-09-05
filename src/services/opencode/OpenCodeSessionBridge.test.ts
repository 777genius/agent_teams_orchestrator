import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import * as lockfile from '../../utils/lockfile.js'
import {
  buildOpenCodeRuntimePromptMessageId,
  resetOpenCodeRuntimePromptMessageIdAllocatorForTest,
} from './OpenCodeMessageIds.js'
import { canonicalizeOpenCodeProjectPath, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { isOpenCodeStrictSessionCompatible, OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'

import type {
  OpenCodeHostHandle,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeSessionPreviewSummary,
  OpenCodeSessionRecord,
} from './types.js'

const profile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  canonicalProjectPath: '/tmp/project',
  workingDirectoryPath: '/tmp/project',
  scopeToken: null,
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
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'alice',
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4-mini',
    projectPath: '/tmp/project',
    profileRootKey: 'profile-root',
    hostKey: 'host-key',
    profileScope: profile.profileScope ?? null,
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
  let isolatedRoot: string
  const originalAppMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
  const originalDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
  const originalCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
  const originalHome = process.env.HOME
  const originalXdgDataHome = process.env.XDG_DATA_HOME

  beforeEach(async () => {
    resetOpenCodeRuntimePromptMessageIdAllocatorForTest()
    isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-bridge-'))
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(isolatedRoot, 'data')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(isolatedRoot, 'cache')
    process.env.HOME = path.join(isolatedRoot, 'home')
    process.env.XDG_DATA_HOME = path.join(isolatedRoot, 'xdg-data')
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = path.join(
      isolatedRoot,
      'agent-teams-mcp.js',
    )
    await writeFile(process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY, '')
    await mkdir(path.join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
    await writeFile(
      path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      JSON.stringify({
        openai: { type: 'api', key: 'test-openai-key' },
        opencode: { type: 'api', key: 'test-opencode-key' },
        xai: {
          type: 'oauth',
          access: 'test-xai-access-token',
          refresh: 'test-xai-refresh-token',
          expires: 4_102_444_800_000,
        },
        'kimi-for-coding': { type: 'api', key: 'test-kimi-key' },
      }),
    )
    profile.canonicalProjectPath = await canonicalizeOpenCodeProjectPath(profile.projectPath)
    // These general session tests exercise the legacy unscoped contract.
    // Scoped sessions need real sealed behavior evidence (covered separately).
    profile.profileScope = null
    profile.scopeToken = null
  })

  afterEach(async () => {
    await rm(isolatedRoot, { recursive: true, force: true })
    if (originalDataHome === undefined) delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    else process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = originalDataHome
    if (originalCacheHome === undefined) delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    else process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = originalCacheHome
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalXdgDataHome
    if (originalAppMcpEntry === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    } else process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = originalAppMcpEntry
  })

  test('strict compatibility rejects stale, different-effort, behavior, bootstrap, and member identities', () => {
    const bootstrap = {
      schemaVersion: 1 as const,
      messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing',
      injectionVerifiedAt: '2026-04-21T00:00:00.000Z',
      model: 'openai/gpt-5.4-mini', agent: 'teammate',
    }
    const compatible = buildRecord({
      runId: 'run-1',
      selectedVariant: 'high',
      profileScope: profile.profileScope,
      toolApprovalMode: 'auto',
      resolvedBehaviorFingerprint: host.resolvedConfigFingerprint,
      managedConfigFingerprint: profile.managedConfigFingerprint,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      bootstrapMode: 'app_managed_context',
      bootstrapEvidenceSource: 'app_managed_bootstrap',
      appManagedBootstrap: bootstrap,
    })
    const expected = {
      teamId: 'team-a', runId: 'run-1', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', selectedVariant: 'high', host,
      toolApprovalMode: 'auto' as const, expectedBehaviorFingerprint: 'a'.repeat(64),
      bootstrap: {
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      },
    }
    expect(isOpenCodeStrictSessionCompatible(compatible, expected)).toBe(true)

    const incompatible: Array<Partial<OpenCodeSessionRecord>> = [
      { runId: undefined }, { runId: 'stale-run' },
      { staleReason: 'old_attempt' },
      { teamId: 'other-team' }, { laneId: 'other-lane' }, { memberName: 'bob' },
      { selectedModel: 'openai/other' }, { selectedVariant: 'low' },
      { hostKey: 'other-host' }, { resolvedBehaviorFingerprint: 'other-resolved' },
      { projectBehaviorFingerprint: 'other-behavior' },
      { managedConfigFingerprint: 'other-config' },
      { sourceAuthFingerprint: 'other-source-auth' }, { managedAuthFingerprint: 'other-auth' },
      { expectedBehaviorFingerprint: 'b'.repeat(64) },
      { bootstrapMode: undefined }, { bootstrapEvidenceSource: undefined },
      { appManagedBootstrap: { ...bootstrap, messageID: 'msg_other' } },
      { appManagedBootstrap: { ...bootstrap, contextHash: 'other-context' } },
      { appManagedBootstrap: { ...bootstrap, briefingHash: 'other-briefing' } },
      { appManagedBootstrap: { ...bootstrap, agent: 'other-agent' } },
    ]
    for (const mismatch of incompatible) {
      expect(isOpenCodeStrictSessionCompatible({ ...compatible, ...mismatch }, expected)).toBe(false)
    }
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

  test('rejects scoped prepared-profile reuse without sealed session authority', async () => {
    let prepareProfileCalls = 0
    let createSessionCalls = 0
    const profileScope = await resolveOpenCodeProfileScope({
      projectPath: '/tmp/project',
      purpose: 'launch_runtime',
      selectedModel: 'openai/gpt-5.4-mini',
    })
    const preparedProfile: OpenCodePreparedProfile = {
      ...profile,
      profileScope,
      scopeToken: profileScope.scopeToken,
      managedConfig: { agent: { teammate: { permission: { '*': 'ask' } } } },
    }
    const existing = {
      ...buildRecord(),
      profileScope,
      toolApprovalMode: 'auto' as const,
      managedConfigFingerprint: preparedProfile.managedConfigFingerprint,
    }
    let updated: OpenCodeSessionRecord | null = null
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => {
        prepareProfileCalls += 1
        throw new Error('prepareProfile should not be called')
      },
      sessionStore: {
        get: async () => existing,
        upsert: async record => {
          updated = record
          return 'updated'
        },
        markStale: async () => existing,
      },
      hostManager: {
        ensureHost: async input => {
          expect(input?.preparedProfile).toBe(preparedProfile)
          return { ...host, profile: preparedProfile }
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

    await expect(bridge.ensureSession({
      teamId: 'team-a',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      preparedProfile,
    })).rejects.toThrow('relaunch the lane')
    expect(updated).toBeNull()
    expect(prepareProfileCalls).toBe(0)
    expect(createSessionCalls).toBe(0)
  })

  test('rejects caller-provided profiles without the exact resolver scope token', async () => {
    const bridge = new OpenCodeSessionBridge({
      sessionStore: {
        get: async () => null,
        upsert: async () => 'created',
        markStale: async () => null,
      },
    })
    await expect(bridge.ensureSession({
      teamId: 'team-a',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      preparedProfile: {
        ...profile,
        profileScope: {
          purpose: 'launch_runtime',
          providerId: 'openai',
          configFingerprint: 'forged',
          selectedAuthIdentity: 'absent',
          scopeToken: 'forged',
        },
        scopeToken: 'forged',
      },
    })).rejects.toThrow('scope token is invalid or expired')
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
    const profileScope = await resolveOpenCodeProfileScope({
      projectPath: '/tmp/project',
      purpose: 'launch_runtime',
      selectedModel: 'openai/gpt-5.4-mini',
    })
    const manualProfile: OpenCodePreparedProfile = {
      ...profile,
      profileScope,
      scopeToken: profileScope.scopeToken,
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
    const prepareProfileScopes: Array<OpenCodePrepareProfileOptions['profileScope']> = []
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
        prepareProfileScopes.push(options?.profileScope)
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
    expect(prepareProfileScopes).toEqual([
      expect.objectContaining({ purpose: 'launch_runtime', providerId: 'openai' }),
      expect.objectContaining({ purpose: 'launch_runtime', providerId: 'openai' }),
    ])
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

  test('strict exact-host materialization never retries an unknown create result', async () => {
    let ensureHostCalls = 0
    let createSessionCalls = 0
    const controller = new AbortController()
    const bridge = new OpenCodeSessionBridge({
      sessionStore: {
        get: async () => null,
        upsert: async () => 'created',
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          throw new Error('strict materialization must use the retained host')
        },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: (baseUrl, context) => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => {
            expect(baseUrl).toBe(host.baseUrl)
            expect(context?.signal).toBe(controller.signal)
            createSessionCalls += 1
            throw new Error('socket connection was closed unexpectedly')
          },
          getSession: async () => ({ id: 'unused' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      runId: 'run-1',
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({ messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate' }),
      host,
      signal: controller.signal,
      remainingMs: () => 1_000,
    })).rejects.toThrow('socket connection was closed unexpectedly')
    expect(createSessionCalls).toBe(1)
    expect(ensureHostCalls).toBe(0)
  })

  test('strict exact-host materialization rejects legacy records without a behavior digest', async () => {
    let clientCalls = 0
    const controller = new AbortController()
    const legacy = buildRecord({ expectedBehaviorFingerprint: undefined })
    const bridge = new OpenCodeSessionBridge({
      sessionStore: {
        get: async () => legacy,
        upsert: async () => { throw new Error('must not update a legacy record') },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => {
          clientCalls += 1
          throw new Error('must reject before creating an OpenCode client')
        },
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      runId: 'run-1',
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({ messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate' }),
      host,
      signal: controller.signal,
      remainingMs: () => 1_000,
    })).rejects.toThrow('committed session identity does not match strict launch')
    expect(clientCalls).toBe(0)
    expect(legacy.expectedBehaviorFingerprint).toBeUndefined()
  })

  test('strict exact-host materialization persists the requested behavior digest', async () => {
    let persisted: OpenCodeSessionRecord | null = null
    const controller = new AbortController()
    const bridge = new OpenCodeSessionBridge({
      sessionStore: {
        get: async () => null,
        upsert: async record => { persisted = record; return 'created' },
        markStale: async () => null,
      },
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => ({ id: 'strict-session' }),
        }) as never,
      },
    })
    const digest = 'a'.repeat(64)

    const materialized = await bridge.materializeSessionOnHost({
      teamId: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini',
      runId: 'run-1',
      expectedBehaviorFingerprint: digest,
      expectedBootstrapForSession: () => ({ messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate' }),
      host,
      signal: controller.signal,
      remainingMs: () => 1_000,
    })

    expect(materialized.record.expectedBehaviorFingerprint).toBe(digest)
    expect(persisted?.expectedBehaviorFingerprint).toBe(digest)
    expect(materialized.record.runId).toBe('run-1')
    expect(persisted?.runId).toBe('run-1')
  })

  test('propagates claim cancellation and releases a boundary-acquired claim without the cancelled signal', async () => {
    const controller = new AbortController()
    const abortReason = new Error('cancel after claim acquisition')
    let claimRunId: string | undefined
    let claimSignal: AbortSignal | undefined
    let cleanupSignal: AbortSignal | undefined
    let releaseCalls = 0
    let clientCalls = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: {
        get: async () => null,
        upsert: async () => { throw new Error('must not upsert after cancellation') },
        markStale: async () => null,
        claimMaterialization: async (_identity, _attemptId, requestedRunId, signal) => {
          claimRunId = requestedRunId
          claimSignal = signal
          controller.abort(abortReason)
          return { kind: 'claimed', ownerToken: { attemptId: 'test', sessionId: '', version: 1 } }
        },
        releaseMaterializationClaim: async (_identity, _attemptId, requestedRunId) => {
          releaseCalls += 1
          expect(requestedRunId).toBe('run-1')
          cleanupSignal = undefined
          return true
        },
      },
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => {
          clientCalls += 1
          throw new Error('must not create a client after cancellation')
        },
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    })).rejects.toBe(abortReason)
    expect(claimRunId).toBe('run-1')
    expect(claimSignal).toBe(controller.signal)
    expect(releaseCalls).toBe(1)
    expect(cleanupSignal).toBeUndefined()
    expect(clientCalls).toBe(0)
  })

  test('does not release another run claim when cancellation follows an existing-record result', async () => {
    const controller = new AbortController()
    const abortReason = new Error('cancel after observing existing record')
    let releaseCalls = 0
    const existing = buildRecord({ runId: 'run-1' })
    const bridge = new OpenCodeSessionBridge({
      sessionStore: {
        get: async () => existing,
        upsert: async () => 'unchanged',
        markStale: async () => null,
        claimMaterialization: async () => {
          controller.abort(abortReason)
          return { kind: 'existing', record: existing }
        },
        releaseMaterializationClaim: async () => {
          releaseCalls += 1
          return true
        },
      },
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => { throw new Error('must not create a client after cancellation') },
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'shared-attempt', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    })).rejects.toBe(abortReason)
    expect(releaseCalls).toBe(0)
  })

  test('allows only one compatible concurrent attempt to create a remote session', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    let signalCreateStarted!: () => void
    const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
    let createCalls = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => {
            createCalls += 1
            signalCreateStarted()
            await createGate
            return { id: 'session-winner' }
          },
        }) as never,
      },
    })
    const controller = new AbortController()
    const input = {
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    }
    const winner = bridge.materializeSessionOnHost({ ...input, attemptId: 'attempt-a' })
    await createStarted
    await expect(bridge.materializeSessionOnHost({
      ...input,
      attemptId: 'attempt-b',
    })).rejects.toThrow('owned by another launch attempt')
    releaseCreate()
    expect((await winner).record.opencodeSessionId).toBe('session-winner')
    expect(createCalls).toBe(1)
  })

  test('allows only one concurrent create for replayed requests from the same attempt', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    let signalCreateStarted!: () => void
    const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
    let createCalls = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => {
            createCalls += 1
            signalCreateStarted()
            await createGate
            return { id: 'session-winner' }
          },
        }) as never,
      },
    })
    const controller = new AbortController()
    const input = {
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    }

    const winner = bridge.materializeSessionOnHost(input)
    await createStarted
    await expect(bridge.materializeSessionOnHost(input)).rejects.toThrow(
      'owned by another launch attempt',
    )
    releaseCreate()
    expect((await winner).record.opencodeSessionId).toBe('session-winner')
    expect(createCalls).toBe(1)
  })

  test('confirmed stop propagates persistent lease release failure without weakening legacy best effort', async () => {
    let attempts = 0
    const bridge = new OpenCodeSessionBridge({ hostManager: {
      ensureHost: async () => { throw new Error('release must not start a host') },
      releaseHost: async () => { throw new Error('lease failure must precede host release') },
      releaseHostLease: async () => { attempts += 1; throw new Error('registry write failed') },
      releaseHostLeaseStrict: async () => { attempts += 1; throw new Error('registry write failed') },
    } })
    await expect(bridge.releaseSession(buildRecord(), { strictLeaseRelease: true }))
      .rejects.toThrow('registry write failed')
    await bridge.releaseSession(buildRecord())
    expect(attempts).toBe(2)
  })

  test('strict release keeps a retained persistent host alive for lease-aware reconciliation', async () => {
    const releaseOptions: Array<{ keepPersistentAlive?: boolean }> = []
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => { throw new Error('release must not start a host') },
        releaseHost: async (_hostKey, options) => { releaseOptions.push(options) },
        releaseHostLeaseStrict: async () => true,
      },
    })
    const record = buildRecord({ runId: 'run-1' })
    const retained = (bridge as unknown as {
      retainedSessionHosts: Map<string, string>
    }).retainedSessionHosts
    retained.set('team-a::primary::alice', record.hostKey)

    await bridge.releaseSession(record, { strictLeaseRelease: true })

    expect(releaseOptions).toEqual([{ keepPersistentAlive: true }])
  })

  test('restores the exact persistent lease for stop CAS compensation', async () => {
    const retained: Array<{ hostKey: string; lease: unknown }> = []
    const bridge = new OpenCodeSessionBridge({
      hostManager: {
        ensureHost: async () => { throw new Error('compensation must not start a host') },
        releaseHost: async () => {},
        retainHostLease: async (hostKey, lease) => { retained.push({ hostKey, lease }) },
      },
    })
    const record = buildRecord({ runId: 'run-1', opencodeSessionId: 'session-stop' })

    await bridge.restoreSessionLease(record)

    expect(retained).toEqual([{
      hostKey: record.hostKey,
      lease: {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        runId: 'run-1',
        sessionId: 'session-stop',
      },
    }])
  })

  test('keeps the stop observer host retained until observer disposal', async () => {
    const events: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => host,
        retainHostLease: async () => { events.push('lease retained') },
        releaseHost: async (_hostKey, options) => {
          events.push(`host released:${options.keepPersistentAlive === true}`)
        },
      },
      stopObserverFactory: async () => ({
        arm: () => {},
        currentStatus: () => null,
        waitForIdle: async () => false,
        dispose: async () => { events.push('observer disposed') },
      }),
    })
    const observer = await bridge.observeStopIdle(buildRecord({
      profileScope: null,
      managedConfigFingerprint: profile.managedConfigFingerprint,
    }))

    expect(events).toEqual(['lease retained'])
    await observer.dispose()
    expect(events).toEqual([
      'lease retained',
      'observer disposed',
      'host released:true',
    ])
  })

  test('threads stop cancellation and remaining budget through profile, host, and client', async () => {
    const controller = new AbortController()
    const remainingMs = () => 321
    let profileSignal: AbortSignal | undefined
    let hostSignal: AbortSignal | undefined
    let clientContext: { signal?: AbortSignal; remainingMs?: () => number } | undefined
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async (_projectPath, options) => {
        profileSignal = options?.abortSignal
        return profile
      },
      hostManager: {
        ensureHost: async input => {
          hostSignal = input.abortSignal
          return host
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: (_baseUrl, context) => {
          clientContext = context
          return { abortSession: async () => true } as never
        },
      },
    })

    expect(await bridge.abort(buildRecord(), { signal: controller.signal, remainingMs })).toBe(true)
    expect(profileSignal).toBe(controller.signal)
    expect(hostSignal).toBe(controller.signal)
    expect(clientContext?.signal).toBe(controller.signal)
    expect(clientContext?.remainingMs?.()).toBe(321)
  })

  test('confirmed stop fails on a real registry lock filesystem error', async () => {
    const blockedParent = path.join(isolatedRoot, 'not-a-directory')
    await writeFile(blockedParent, 'sandbox fixture')
    const bridge = new OpenCodeSessionBridge({ hostManager: new OpenCodeHostManager({
      persistentRegistryPath: path.join(blockedParent, 'host-registry.json'),
      spawnHostProcess: () => { throw new Error('stop must not create a host') },
    }) })
    await expect(bridge.releaseSession(buildRecord(), { strictLeaseRelease: true })).rejects.toThrow()
    await bridge.releaseSession(buildRecord())
  })

  test('strict stopped session rejects same-run replay and materializes a new run exactly once', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    let creates = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: { ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {}, retainHostLease: async () => {} },
      clientFactory: { create: () => ({ createSession: async () => ({ id: `session-${++creates}` }) }) as never },
    })
    const input = { teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', host,
      signal: new AbortController().signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({ messageID: 'msg_expected', contextHash: 'context',
        briefingHash: 'briefing', agent: 'teammate' }) }
    const first = await bridge.materializeSessionOnHost(input)
    const stopped = await store.markStoppedIfSession(first.record)
    expect(stopped?.stoppedAt).toBeDefined()
    await expect(bridge.materializeSessionOnHost(input)).rejects.toThrow('session is stopped')
    expect(creates).toBe(1)
    const next = await bridge.materializeSessionOnHost({ ...input, runId: 'run-2' })
    expect(next.created).toBe(true)
    expect(next.record.runId).toBe('run-2')
    expect(next.record.stoppedAt).toBeUndefined()
    expect(next.record.opencodeSessionId).not.toBe(first.record.opencodeSessionId)
    expect(creates).toBe(2)
    await expect(bridge.materializeSessionOnHost(input)).rejects.toThrow('committed session identity')
    expect(await store.markStoppedIfSession(first.record)).toBeNull()
    expect(creates).toBe(2)
  })

  test('aborting after a different-run replacement claim preserves stop authority for an exact-once retry', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    let creates = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: { ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {}, retainHostLease: async () => {} },
      clientFactory: { create: () => ({ createSession: async () => ({ id: `session-${++creates}` }) }) as never },
    })
    const baseInput = { teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'old-attempt', host,
      signal: new AbortController().signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({ messageID: 'msg_expected', contextHash: 'context',
        briefingHash: 'briefing', agent: 'teammate' }) }
    const first = await bridge.materializeSessionOnHost(baseInput)
    const stopped = await store.markStoppedIfSession(first.record)
    expect(stopped?.stoppedAt).toBeDefined()

    const controller = new AbortController()
    const abortReason = new Error('cancel after different-run replacement claim')
    const claimMaterialization = store.claimMaterialization.bind(store)
    let abortedReplacementClaim = false
    store.claimMaterialization = async (identity, attemptId, requestedRunId, signal) => {
      const result = await claimMaterialization(identity, attemptId, requestedRunId, signal)
      if (!abortedReplacementClaim && requestedRunId === 'run-2' && result.kind === 'claimed') {
        abortedReplacementClaim = true
        controller.abort(abortReason)
      }
      return result
    }

    await expect(bridge.materializeSessionOnHost({
      ...baseInput, runId: 'run-2', attemptId: 'cancelled-attempt', signal: controller.signal,
    })).rejects.toBe(abortReason)
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(stopped)
    expect(creates).toBe(1)
    await expect(bridge.materializeSessionOnHost({
      ...baseInput, attemptId: 'same-run-replay', signal: new AbortController().signal,
    })).rejects.toThrow('session is stopped')
    expect(creates).toBe(1)

    const retryInput = { ...baseInput, runId: 'run-2', attemptId: 'retry-attempt',
      signal: new AbortController().signal }
    const successor = await bridge.materializeSessionOnHost(retryInput)
    expect(successor).toMatchObject({ created: true, record: { runId: 'run-2', opencodeSessionId: 'session-2' } })
    expect(creates).toBe(2)
    expect(successor.ownerToken).toBeDefined()
    expect(await store.releaseMaterializationOwner(successor.record, successor.ownerToken!)).toBe(true)
    const replay = await bridge.materializeSessionOnHost({
      ...retryInput, attemptId: 'retry-replay', signal: new AbortController().signal,
    })
    expect(replay).toMatchObject({ created: false, record: { runId: 'run-2', opencodeSessionId: 'session-2' } })
    expect(creates).toBe(2)
  })

  test('does not create again after an unknown outcome is replayed by the same attempt', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    let createCalls = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => {
            createCalls += 1
            throw new Error('transport closed after request write')
          },
        }) as never,
      },
    })
    const controller = new AbortController()
    const input = {
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    }

    await expect(bridge.materializeSessionOnHost(input)).rejects.toThrow(
      'transport closed after request write',
    )
    await expect(bridge.materializeSessionOnHost(input)).rejects.toThrow(
      'owned by another launch attempt',
    )
    expect(createCalls).toBe(1)
    expect(await store.get('team-a', 'primary', 'alice')).toBeNull()
  })

  test('resumes bootstrap for a persisted known create after cancellation with a fresh bridge', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    const controller = new AbortController()
    const claimRunIds: Array<string | undefined> = []
    const claimSignals: Array<AbortSignal | undefined> = []
    const commitSignals: Array<AbortSignal | undefined> = []
    const claimMaterialization = store.claimMaterialization.bind(store)
    const commitMaterialization = store.commitMaterialization.bind(store)
    store.claimMaterialization = async (identity, attemptId, requestedRunId, signal) => {
      claimRunIds.push(requestedRunId)
      claimSignals.push(signal)
      return claimMaterialization(identity, attemptId, requestedRunId, signal)
    }
    store.commitMaterialization = async (record, attemptId, signal) => {
      commitSignals.push(signal)
      return commitMaterialization(record, attemptId, signal)
    }
    let createCalls = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => {
            createCalls += 1
            controller.abort(new Error('cancelled after create'))
            return { id: 'session-known' }
          },
        }) as never,
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    })).rejects.toThrow('cancelled after create')
    expect(createCalls).toBe(1)
    expect(claimRunIds).toEqual(['run-1'])
    expect(claimSignals).toEqual([controller.signal])
    expect(commitSignals).toEqual([controller.signal, undefined])
    const interrupted = await store.get('team-a', 'primary', 'alice')
    expect(interrupted?.opencodeSessionId).toBe('session-known')
    expect(await store.markStaleIfSession(interrupted!, 'launch_failed')).not.toBeNull()


    const retryController = new AbortController()
    const restartedStore = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    const restartedBridge = new OpenCodeSessionBridge({
      sessionStore: restartedStore,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => {
            createCalls += 1
            throw new Error('known create must not be duplicated')
          },
        }) as never,
      },
    })
    const resumeInput = {
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-b', host,
      signal: retryController.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    }
    await expect(restartedBridge.materializeSessionOnHost({
      ...resumeInput, runId: 'run-2',
    })).rejects.toThrow('committed session identity does not match strict launch')
    const acquireMaterializationOwner = restartedStore.acquireMaterializationOwner.bind(restartedStore)
    let ownerTransferArrivals = 0
    let releaseOwnerTransfers!: () => void
    const ownerTransferBarrier = new Promise<void>(resolve => { releaseOwnerTransfers = resolve })
    restartedStore.acquireMaterializationOwner = async (...args) => {
      ownerTransferArrivals += 1
      if (ownerTransferArrivals === 2) releaseOwnerTransfers()
      await ownerTransferBarrier
      return acquireMaterializationOwner(...args)
    }
    const resumeAttempts = await Promise.allSettled([
      restartedBridge.materializeSessionOnHost(resumeInput),
      restartedBridge.materializeSessionOnHost({ ...resumeInput, attemptId: 'attempt-c' }),
    ])
    const resumed = resumeAttempts.find(result => result.status === 'fulfilled')
    const rejected = resumeAttempts.find(result => result.status === 'rejected')
    expect(resumeAttempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(resumeAttempts.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(resumed).toMatchObject({ value: {
      created: false,
      resumeBootstrap: true,
      record: { opencodeSessionId: 'session-known' },
    } })
    expect(rejected).toMatchObject({ reason: expect.objectContaining({
      message: 'OpenCode committed session changed before bootstrap ownership transfer',
    }) })
    expect(createCalls).toBe(1)
    if (!resumed || resumed.status !== 'fulfilled') throw new Error('one retry must resume bootstrap')
    expect(await store.markStaleIfSession(resumed.value.record, 'old-cleanup', { attemptId: 'attempt-a', sessionId: '', version: 1 })).toBeNull()
    expect(await store.deleteIfSession(resumed.value.record, { attemptId: 'attempt-a', sessionId: '', version: 1 })).toBe(false)
  })

  test('fails closed when completed bootstrap evidence differs from retry evidence', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    const completed = buildRecord({
      runId: 'run-1',
      toolApprovalMode: 'auto',
      managedConfigFingerprint: profile.managedConfigFingerprint,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      bootstrapMode: 'app_managed_context',
      bootstrapEvidenceSource: 'app_managed_bootstrap',
      appManagedBootstrap: {
        schemaVersion: 1, messageID: 'msg_e1', contextHash: 'context-e1',
        briefingHash: 'briefing-e1', injectionVerifiedAt: '2026-04-21T00:01:00.000Z',
        model: 'openai/gpt-5.4-mini', agent: 'teammate',
      },
    })
    await store.upsert(completed)
    let createCalls = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => { createCalls += 1; return { id: 'session-new' } },
        }) as never,
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-b', host,
      signal: new AbortController().signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_e2', contextHash: 'context-e2',
        briefingHash: 'briefing-e2', agent: 'teammate',
      }),
    })).rejects.toThrow('bootstrap evidence does not match strict launch')
    expect(createCalls).toBe(0)
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(completed)
  })

  test.each([
    ['partial source-only evidence', {
      bootstrapEvidenceSource: 'app_managed_bootstrap' as const,
    }],
    ['malformed payload-only evidence', {
      appManagedBootstrap: {
        schemaVersion: 1 as const, messageID: 'msg_partial', contextHash: '', briefingHash: '',
        injectionVerifiedAt: '', model: '', agent: '',
      },
    }],
    ['alternate-source evidence', {
      bootstrapEvidenceSource: 'runtime_bootstrap_checkin' as const,
    }],
    ['legacy bootstrap mode', { bootstrapMode: 'model_tool_checkin' as never }],
    ['null bootstrap mode', { bootstrapMode: null as never }],
    ['empty bootstrap mode', { bootstrapMode: '' as never }],
    ['null evidence source', { bootstrapEvidenceSource: null as never }],
    ['null managed evidence', { appManagedBootstrap: null as never }],
  ])('fails closed for %s after strict compatibility fails', async (_label, evidence) => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    const persisted = buildRecord({
      runId: 'run-1',
      toolApprovalMode: 'auto',
      managedConfigFingerprint: profile.managedConfigFingerprint,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      bootstrapMode: 'app_managed_context',
      ...evidence,
    })
    await store.upsert(persisted)
    let createCalls = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          createSession: async () => { createCalls += 1; return { id: 'session-new' } },
        }) as never,
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-b', host,
      signal: new AbortController().signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context',
        briefingHash: 'briefing', agent: 'teammate',
      }),
    })).rejects.toThrow('bootstrap evidence does not match strict launch')
    expect(createCalls).toBe(0)
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(persisted)
  })

  test('records a known session after ambiguous lease retention and restores its exact lease on resume', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    let createCalls = 0
    const retained: unknown[] = []
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async (_hostKey, lease) => {
          retained.push(lease)
          if (retained.length === 1) throw new Error('lease write acknowledgement lost')
        },
      },
      clientFactory: { create: () => ({ createSession: async () => {
        createCalls += 1
        return { id: 'session-known' }
      } }) as never },
    })
    const input = {
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: new AbortController().signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({ messageID: 'msg_expected', contextHash: 'context',
        briefingHash: 'briefing', agent: 'teammate' }),
    }

    await expect(bridge.materializeSessionOnHost(input)).rejects.toThrow('acknowledgement lost')
    expect((await store.get('team-a', 'primary', 'alice'))?.opencodeSessionId).toBe('session-known')
    const resumed = await bridge.materializeSessionOnHost({ ...input, attemptId: 'attempt-b' })
    expect(resumed).toMatchObject({ created: false, resumeBootstrap: true,
      record: { opencodeSessionId: 'session-known' } })
    expect(createCalls).toBe(1)
    expect(retained).toEqual([
      { teamId: 'team-a', laneId: 'primary', memberName: 'alice', runId: 'run-1', sessionId: 'session-known' },
      { teamId: 'team-a', laneId: 'primary', memberName: 'alice', runId: 'run-1', sessionId: 'session-known' },
    ])
  })

  test('tracks signal-free commit reconciliation so command cleanup drains it', async () => {
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'))
    const commitMaterialization = store.commitMaterialization.bind(store)
    let commitCalls = 0
    let notifyReconciliationStarted!: () => void
    const reconciliationStarted = new Promise<void>(resolve => { notifyReconciliationStarted = resolve })
    let finishReconciliation!: () => void
    const reconciliationGate = new Promise<void>(resolve => { finishReconciliation = resolve })
    store.commitMaterialization = async (record, attemptId, signal) => {
      commitCalls += 1
      if (signal) return commitMaterialization(record, attemptId, signal)
      notifyReconciliationStarted()
      await reconciliationGate
      return commitMaterialization(record, attemptId)
    }
    const retainedLeases: unknown[] = []
    const releasedLeases: unknown[] = []
    const controller = new AbortController()
    let notifyRemoteAborted!: () => void
    const remoteAborted = new Promise<void>(resolve => { notifyRemoteAborted = resolve })
    let finishRemoteCreate!: () => void
    const remoteCreateGate = new Promise<void>(resolve => { finishRemoteCreate = resolve })
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async (_hostKey, input) => { retainedLeases.push(input) },
        releaseHostLease: async (_hostKey, input) => { releasedLeases.push(input) },
      },
      clientFactory: {
        create: () => ({
          createSession: async () => {
            controller.abort(new Error('deadline after remote create'))
            notifyRemoteAborted()
            await remoteCreateGate
            return { id: 'session-known' }
          },
        }) as never,
      },
    })

    const materialization = bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: controller.signal, remainingMs: () => 0,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    })
    await remoteAborted
    let cleanupDrained = false
    const cleanup = store.drainPendingLateLockReleases().then(() => { cleanupDrained = true })
    await Promise.resolve()
    expect(cleanupDrained).toBe(false)

    finishRemoteCreate()
    await reconciliationStarted
    await Promise.resolve()
    expect(cleanupDrained).toBe(false)
    finishReconciliation()
    await expect(materialization).rejects.toThrow('deadline after remote create')
    await cleanup
    expect(cleanupDrained).toBe(true)
    expect(commitCalls).toBe(2)
    expect((await store.get('team-a', 'primary', 'alice'))?.opencodeSessionId).toBe('session-known')
    expect(retainedLeases).toHaveLength(1)
    expect(releasedLeases).toEqual([])
  })

  test('keeps the retained lease when a live commit writes before lock release fails', async () => {
    const releaseError = new Error('commit lock release failed')
    let lockReleaseCalls = 0
    const store = new OpenCodeSessionStore(path.join(isolatedRoot, 'sessions.json'), {
      lock: (async () => async () => {
        lockReleaseCalls += 1
        if (lockReleaseCalls === 2) throw releaseError
      }) as typeof lockfile.lock,
    })
    const retainedLeases: unknown[] = []
    const releasedLeases: unknown[] = []
    const controller = new AbortController()
    const bridge = new OpenCodeSessionBridge({
      sessionStore: store,
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async (_hostKey, input) => { retainedLeases.push(input) },
        releaseHostLease: async (_hostKey, input) => { releasedLeases.push(input) },
      },
      clientFactory: {
        create: () => ({
          createSession: async () => ({ id: 'session-known' }),
        }) as never,
      },
    })

    const result = await bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    })

    expect(controller.signal.aborted).toBe(false)
    expect(result).toMatchObject({
      created: true,
      record: { runId: 'run-1', opencodeSessionId: 'session-known' },
    })
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(result.record)
    expect(lockReleaseCalls).toBe(3)
    expect(retainedLeases).toHaveLength(1)
    expect(releasedLeases).toEqual([])
  })

  test('fails closed and releases the lease when live commit reconciliation finds a mismatch', async () => {
    const commitError = new Error('ambiguous commit failure')
    let attemptedRecord: OpenCodeSessionRecord | null = null
    let commitCalls = 0
    const releasedLeases: unknown[] = []
    const controller = new AbortController()
    const bridge = new OpenCodeSessionBridge({
      sessionStore: {
        get: async () => attemptedRecord
          ? { ...attemptedRecord, selectedModel: 'foreign/model' }
          : null,
        upsert: async () => { throw new Error('must use materialization commit') },
        markStale: async () => null,
        claimMaterialization: async () => ({ kind: 'claimed', ownerToken: { attemptId: 'test', sessionId: '', version: 1 } }),
        commitMaterialization: async record => {
          commitCalls += 1
          attemptedRecord = record
          throw commitError
        },
      },
      hostManager: {
        ensureHost: async () => { throw new Error('must use retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
        releaseHostLease: async (_hostKey, input) => { releasedLeases.push(input) },
      },
      clientFactory: {
        create: () => ({
          createSession: async () => ({ id: 'session-known' }),
        }) as never,
      },
    })

    await expect(bridge.materializeSessionOnHost({
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      selectedModel: 'openai/gpt-5.4-mini', runId: 'run-1', attemptId: 'attempt-a', host,
      signal: controller.signal, remainingMs: () => 1_000,
      expectedBehaviorFingerprint: 'a'.repeat(64),
      expectedBootstrapForSession: () => ({
        messageID: 'msg_expected', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate',
      }),
    })).rejects.toBe(commitError)

    expect(controller.signal.aborted).toBe(false)
    expect(commitCalls).toBe(2)
    expect(releasedLeases).toEqual([{
      teamId: 'team-a', laneId: 'primary', memberName: 'alice',
      runId: 'run-1', sessionId: 'session-known',
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
        runId: null,
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
        retainHostLease: async (_hostKey, input) => { retainedLeases.push(input) },
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

    const result = await bridge.ensureSessionAppMcpReady(buildRecord({ runId: 'run-1' }), {
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
    expect(retainedLeases).toEqual([{
      teamId: 'team-a',
      laneId: 'primary',
      memberName: 'alice',
      runId: 'run-1',
      sessionId: 'session-1',
    }])
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
        runId: 'run-1',
        sessionId: 'session-new',
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
              info: { id: 'msg_0d008f4f44e4481a8e3b0bbe848d519c', role: 'user' },
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

  test('resolves a fresh scope after restart and safely stales the old process identity', async () => {
    const oldScope = {
      ...profile.profileScope!,
      selectedAuthIdentity: 'known:old-process-auth' as const,
      scopeToken: 'old-process-opaque-token',
    }
    let preparedScope: OpenCodePrepareProfileOptions['profileScope']
    const staleMarks: string[] = []
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async (_projectPath, options) => {
        preparedScope = options?.profileScope
        return {
          ...profile,
          profileScope: options?.profileScope,
          scopeToken: options?.profileScope?.scopeToken ?? null,
        }
      },
      hostManager: {
        ensureHost: async () => { throw new Error('stale restart must not start the old host') },
        releaseHost: async () => {},
      },
      sessionStore: {
        get: async () => null,
        upsert: async () => 'unchanged',
        markStale: async (_teamId, _laneId, _memberName, reason) => {
          staleMarks.push(reason)
          return buildRecord({ profileScope: oldScope, staleReason: reason })
        },
      },
      clientFactory: { create: () => { throw new Error('stale restart must not create a client') } },
    })

    const result = await bridge.reconcileSession(buildRecord({ profileScope: oldScope }))

    expect(preparedScope?.scopeToken).not.toBe(oldScope.scopeToken)
    expect(result.summary.reconcileOutcome).toBe('stale')
    expect(staleMarks).toEqual(['profile_scope_changed'])
  })

  test.each([
    ['absent', 'OpenCode strict profile requires explicit selected authentication'],
    ['error', 'OpenCode strict profile selected authentication is unavailable'],
  ] as const)(
    'rejects persisted host restart when credential identity is %s',
    async (credentialIdentity, expectedError) => {
      if (credentialIdentity === 'absent') {
        await writeFile(path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json'), '{}')
      } else {
        const authPath = path.join(process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]!, 'opencode', 'auth.json')
        await mkdir(path.dirname(authPath), { recursive: true })
        await writeFile(authPath, '{invalid-json')
      }

      await expect(resolveOpenCodeProfileScope({
        projectPath: profile.projectPath,
        purpose: 'launch_runtime',
        selectedModel: 'openai/gpt-5.4-mini',
      })).rejects.toThrow(expectedError)
    },
  )

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
