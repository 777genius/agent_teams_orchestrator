import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID } from './OpenCodeHostManager.js'
import {
  OpenCodeExecutionProbe,
  resolveOpenCodeExecutionProbeContextTokens,
} from './OpenCodeExecutionProbe.js'
import { OPEN_CODE_MODEL_PROBE_AGENT_NAME } from './OpenCodeProfileManager.js'
import {
  fanOutOpenCodeOAuthCredential,
  readOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'

import type {
  OpenCodeHostHandle,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
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

test('keeps native subscription CLI probes above their hidden bootstrap context', () => {
  expect(resolveOpenCodeExecutionProbeContextTokens('cursor-acp/auto')).toBe(262_144)
  expect(resolveOpenCodeExecutionProbeContextTokens('kiro/auto')).toBe(262_144)
  expect(resolveOpenCodeExecutionProbeContextTokens('opencode/big-pickle')).toBe(32_000)
})

describe('OpenCodeExecutionProbe', () => {
  test('marks model available when the durable assistant reply matches the expected probe output', async () => {
    let promptAsyncCount = 0
    let sendMessageCount = 0
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let releaseHostCount = 0
    let promptAgent: string | null = null
    let ensureHostInput: {
      projectPath?: string | null
      profileOptions?: OpenCodePrepareProfileOptions
      hostLifetime?: string
    } | null = null
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async input => {
          ensureHostInput = input
          return host
        },
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseHostCount += 1
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
          createSession: async () => ({ id: 'session-1' }),
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
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            sendMessageCount += 1
            return { info: { id: 'msg-assistant-1' }, parts: [] }
          },
          promptSessionAsync: async (_sessionId, message) => {
            promptAsyncCount += 1
            promptAgent = message.agent ?? null
          },
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(result.reason).toBeNull()
    expect(result.durableState).toBe('idle')
    expect(result.latestAssistantText).toBe('PONG')
    expect(promptAsyncCount).toBe(1)
    expect(promptAgent).toBe(OPEN_CODE_MODEL_PROBE_AGENT_NAME)
    expect(sendMessageCount).toBe(0)
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseHostCount).toBe(1)
    expect(ensureHostInput).toEqual({
      projectPath: '/tmp/project',
      profileOptions: {
        includeAppMcp: false,
        modelOutputLimitOverrides: [
          {
            modelId: 'opencode/big-pickle',
            outputTokens: 512,
            contextTokens: 32_000,
          },
        ],
      },
      hostLifetime: 'process',
    })
  })

  test('fans out a potentially rotated xAI OAuth credential after a real model probe', async () => {
    const fanOutInputs: Array<{ providerId: string; sourceAuthPath: string }> = []
    const refreshLockInputs: Array<{ authPath: string; providerId: string }> = []
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => ({ id: 'session-1' }),
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
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      fanOutOAuthCredential: async input => {
        fanOutInputs.push(input)
      },
      withOAuthRefreshLock: async input => {
        refreshLockInputs.push({
          authPath: input.authPath,
          providerId: input.providerId,
        })
        return input.operation()
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'xai/grok-4.3',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result.outcome).toBe('available')
    expect(fanOutInputs).toEqual([{
      providerId: 'xai',
      sourceAuthPath: profile.managedAuthPath,
    }])
    expect(refreshLockInputs).toEqual([{
      authPath: profile.managedAuthPath,
      providerId: 'xai',
    }])
  })

  test('simulates an expired xAI access token refresh and persists the rotated credential', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-xai-refresh-success-'))
    const globalAuthPath = path.join(tempDir, 'global', 'opencode', 'auth.json')
    const activeAuthPath = path.join(tempDir, 'profiles', 'active', 'opencode', 'auth.json')
    const peerAuthPath = path.join(tempDir, 'profiles', 'peer', 'opencode', 'auth.json')
    const expiredCredential = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'refresh-before-rotation',
      expires: Date.now() - 60_000,
      accountId: 'supergrok-account',
    }
    const rotatedCredential = {
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refresh-after-rotation',
      expires: Date.now() + 3_600_000,
      accountId: 'supergrok-account',
    }
    const refreshProfile = {
      ...profile,
      managedAuthPath: activeAuthPath,
    }
    const refreshHost = {
      ...host,
      profile: refreshProfile,
    }

    try {
      await Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          upsertOpenCodeAuthCredential({
            authPath,
            providerId: 'xai',
            credential: expiredCredential,
          }),
        ),
      )

      const probe = new OpenCodeExecutionProbe({
        hostManager: {
          ensureHost: async () => refreshHost,
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
            createSession: async () => ({ id: 'session-1' }),
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => ({ 'session-1': 'idle' }),
            getSessionMessages: async () => [{
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            }],
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
            promptSessionAsync: async () => {
              await upsertOpenCodeAuthCredential({
                authPath: activeAuthPath,
                providerId: 'xai',
                credential: rotatedCredential,
              })
            },
            abortSession: async () => true,
          }),
        },
        fanOutOAuthCredential: async input => {
          await fanOutOpenCodeOAuthCredential({
            ...input,
            targetAuthPaths: [globalAuthPath, activeAuthPath, peerAuthPath],
          })
        },
      })

      const result = await probe.probeModel({
        selectedModel: 'xai/grok-4.3',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('available')
      await expect(Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          readOpenCodeAuthCredential({ authPath, providerId: 'xai' }),
        ),
      )).resolves.toEqual([rotatedCredential, rotatedCredential, rotatedCredential])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('preserves the previous xAI credential when an expired-token refresh fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-xai-refresh-failure-'))
    const globalAuthPath = path.join(tempDir, 'global', 'opencode', 'auth.json')
    const activeAuthPath = path.join(tempDir, 'profiles', 'active', 'opencode', 'auth.json')
    const peerAuthPath = path.join(tempDir, 'profiles', 'peer', 'opencode', 'auth.json')
    const expiredCredential = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'still-valid-refresh-token',
      expires: Date.now() - 60_000,
      accountId: 'supergrok-account',
    }
    const refreshProfile = {
      ...profile,
      managedAuthPath: activeAuthPath,
    }
    const refreshHost = {
      ...host,
      profile: refreshProfile,
    }

    try {
      await Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          upsertOpenCodeAuthCredential({
            authPath,
            providerId: 'xai',
            credential: expiredCredential,
          }),
        ),
      )

      const probe = new OpenCodeExecutionProbe({
        hostManager: {
          ensureHost: async () => refreshHost,
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
            createSession: async () => ({ id: 'session-1' }),
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => ({}),
            getSessionMessages: async () => [],
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
            promptSessionAsync: async () => {
              throw new Error('xAI token refresh failed: invalid_grant')
            },
            abortSession: async () => true,
          }),
        },
        fanOutOAuthCredential: async input => {
          await fanOutOpenCodeOAuthCredential({
            ...input,
            targetAuthPaths: [globalAuthPath, activeAuthPath, peerAuthPath],
          })
        },
      })

      const result = await probe.probeModel({
        selectedModel: 'xai/grok-4.3',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('not_authenticated')
      expect(result.reason).toContain('token refresh failed')
      await expect(Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          readOpenCodeAuthCredential({ authPath, providerId: 'xai' }),
        ),
      )).resolves.toEqual([expiredCredential, expiredCredential, expiredCredential])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('treats a completed non-empty assistant response as execution proof even when it is not PONG', async () => {
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => ({ id: 'session-1' }),
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
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PING' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'ollama/qwen2.5-coder:0.5b',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(result.reason).toBeNull()
    expect(result.latestAssistantText).toBe('PING')
    expect(result.diagnostics.join('\n')).toContain(
      'Model verification completed with non-matching assistant output',
    )
  })

  test('does not treat a plain-text Cursor authentication error as execution proof', async () => {
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => ({ id: 'session-1' }),
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
              parts: [{
                type: 'text',
                text: "cursor-acp error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY.",
              }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('not_authenticated')
    expect(result.reason).toContain('Authentication required')
  })

  test('does not treat a plain-text Cursor usage-limit error as execution proof', async () => {
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => ({ id: 'session-1' }),
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
              parts: [{
                type: 'text',
                text: "cursor-acp error: You've hit your Cursor usage limit",
              }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('Cursor usage limit')
  })

  test('can release execution probe lease without disposing the live host', async () => {
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let releaseHostCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseHostCount += 1
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
          createSession: async () => ({ id: 'session-1' }),
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
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      disposeHostOnRelease: false,
    })

    expect(result.outcome).toBe('available')
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseHostCount).toBe(0)
  })

  test('starts the polling timeout after the host has accepted the probe prompt', async () => {
    let messageReadCount = 0
    const probe = new OpenCodeExecutionProbe({
      probeTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async () => {},
      hostManager: {
        ensureHost: async () => {
          await new Promise(resolve => setTimeout(resolve, 20))
          return host
        },
        retainHostLease: async () => {},
        releaseHostLease: async () => {},
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
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({
            'session-1': messageReadCount < 1 ? 'busy' : 'idle',
          }),
          getSessionMessages: async () => {
            messageReadCount += 1
            const messages = [
              {
                info: {
                  id: 'msg-user-1',
                  role: 'user',
                  sessionID: 'session-1',
                  time: { created: 100 },
                },
                parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
              },
            ]
            if (messageReadCount > 1) {
              messages.push({
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  parentID: 'msg-user-1',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              })
            }
            return messages
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(messageReadCount).toBe(2)
  })

  test('still releases execution probe lease without disposing the live host when setup fails', async () => {
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let releaseHostCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseHostCount += 1
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
            throw new Error('create session failed')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => true,
        }),
      },
    })

    await expect(probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      disposeHostOnRelease: false,
    })).rejects.toThrow('create session failed')

    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseHostCount).toBe(0)
  })

  test('marks model auth as invalid when OpenCode returns a token refresh failure', async () => {
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-error',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
                error: {
                  name: 'UnknownError',
                  data: {
                    message: 'Token refresh failed: 401',
                  },
                },
              },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-error' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('not_authenticated')
    expect(result.reason).toContain('Token refresh failed: 401')
    expect(result.durableState).toBe('error')
  })

  test('surfaces nested provider rate-limit errors from assistant message metadata', async () => {
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-error',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
                error: {
                  name: 'AI_APICallError',
                  data: {
                    error: {
                      type: 'FreeUsageLimitError',
                      message: 'Rate limit exceeded. Please try again later.',
                    },
                    statusCode: 429,
                  },
                },
              },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-error' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/ling-2.6-flash-free',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toBe('Rate limit exceeded. Please try again later.')
    expect(result.durableState).toBe('error')
  })

  test('deduplicates concurrent probes and reuses a short-lived successful result', async () => {
    let createSessionCount = 0
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => {
            createSessionCount += 1
            return { id: 'session-1' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const [first, second] = await Promise.all([
      probe.probeModel(input),
      probe.probeModel(input),
    ])
    const third = await probe.probeModel(input)

    expect(first.outcome).toBe('available')
    expect(second.outcome).toBe('available')
    expect(third.outcome).toBe('available')
    expect(createSessionCount).toBe(1)
  })

  test('bypasses in-memory probe cache when requested', async () => {
    let createSessionCount = 0
    const probe = new OpenCodeExecutionProbe({
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
          createSession: async () => {
            createSessionCount += 1
            return { id: `session-${createSessionCount}` }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ [`session-${createSessionCount}`]: 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: `msg-assistant-${createSessionCount}`,
                role: 'assistant',
                parentID: `msg-user-${createSessionCount}`,
                sessionID: `session-${createSessionCount}`,
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const first = await probe.probeModel(input)
    const second = await probe.probeModel({ ...input, bypassCache: true })
    const third = await probe.probeModel(input)

    expect(first.outcome).toBe('available')
    expect(second.outcome).toBe('available')
    expect(third.outcome).toBe('available')
    expect(createSessionCount).toBe(2)
  })

  test('deduplicates concurrent probes across probe instances with the persistent cache', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-probe-cache-'))
    try {
      let createSessionCount = 0
      const cachedProfile: OpenCodePreparedProfile = {
        ...profile,
        profileRootPath: tempDir,
        homePath: path.join(tempDir, 'home'),
        tmpPath: path.join(tempDir, 'tmp'),
        xdgConfigHome: path.join(tempDir, 'config'),
        xdgDataHome: path.join(tempDir, 'data'),
        xdgCacheHome: path.join(tempDir, 'cache'),
        managedAuthPath: path.join(tempDir, 'data/opencode/auth.json'),
      }
      const cachedHost: OpenCodeHostHandle = {
        ...host,
        profile: cachedProfile,
      }
      const makeProbe = (
        resolvedConfigFingerprint = cachedHost.resolvedConfigFingerprint,
      ) => new OpenCodeExecutionProbe({
        persistentCache: true,
        persistentCacheRoot: tempDir,
        sleep: async () => new Promise(resolve => setTimeout(resolve, 1)),
        hostManager: {
          ensureHost: async () => ({
            ...cachedHost,
            resolvedConfigFingerprint,
          }),
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
            createSession: async () => {
              createSessionCount += 1
              await new Promise(resolve => setTimeout(resolve, 20))
              return { id: 'session-1' }
            },
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => ({ 'session-1': 'idle' }),
            getSessionMessages: async () => [
              {
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  parentID: 'msg-user-1',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              },
            ],
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
            promptSessionAsync: async () => {},
            abortSession: async () => true,
          }),
        },
      })

      const input = {
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPath: '/tmp/project',
      }
      const [first, second] = await Promise.all([
        makeProbe().probeModel(input),
        makeProbe().probeModel(input),
      ])
      const third = await makeProbe('resolved-after-app-mcp-refresh').probeModel(input)

      expect(first.outcome).toBe('available')
      expect(second.outcome).toBe('available')
      expect(third.outcome).toBe('available')
      expect(createSessionCount).toBe(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('waits for a delayed assistant reply before deciding the probe outcome', async () => {
    let statusCallCount = 0
    let messageCallCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      pollIntervalMs: 0,
      probeTimeoutMs: 50,
      sleep: async () => {},
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
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return { 'session-1': statusCallCount < 2 ? 'busy' : 'idle' }
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            if (messageCallCount < 2) {
              return [
                {
                  info: {
                    id: 'msg-user-1',
                    role: 'user',
                    sessionID: 'session-1',
                    time: { created: 100 },
                  },
                  parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
                },
              ]
            }
            return [
              {
                info: {
                  id: 'msg-user-1',
                  role: 'user',
                  sessionID: 'session-1',
                  time: { created: 100 },
                },
                parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
              },
              {
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  parentID: 'msg-user-1',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              },
            ]
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-user-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(statusCallCount).toBeGreaterThanOrEqual(2)
    expect(messageCallCount).toBeGreaterThanOrEqual(2)
  })

  test('returns a timeout when OpenCode never produces an assistant reply before the probe deadline', async () => {
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      pollIntervalMs: 0,
      probeTimeoutMs: 1,
      sleep: async () => {},
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
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'busy' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-user-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unknown')
    expect(result.reason).toBe('Model verification timed out')
  })
})
