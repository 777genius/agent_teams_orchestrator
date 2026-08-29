import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID } from './OpenCodeHostManager.js'
import {
  classifyProbeFailure,
  OpenCodeExecutionProbe,
  resolveOpenCodeExecutionProbeContextTokens,
} from './OpenCodeExecutionProbe.js'
import { OPEN_CODE_MODEL_PROBE_AGENT_NAME } from './OpenCodeProfileManager.js'
import {
  fanOutOpenCodeOAuthCredential,
  readOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'
import {
  OpenCodeRuntimeDeadline,
  OpenCodeRuntimeDeadlineError,
} from './OpenCodeRuntimeDeadline.js'

import type {
  OpenCodeHostHandle,
  OpenCodeMessage,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeSessionStatusInput,
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
  test('classifies retired Google models as unavailable for the current account', () => {
    const message =
      'This model models/gemini-2.5-flash-lite is no longer available to new users.'

    expect(classifyProbeFailure({ message })).toEqual({
      outcome: 'unavailable',
      reason: message,
    })
  })

  test('classifies Cursor resource exhaustion as model unavailable', () => {
    for (const message of [
      'grpc_code=resource_exhausted error_code=upgrade',
      'grpc_code=resource-exhausted error_code=upgrade',
      'usage-limit reached',
      'quota_exceeded',
      'FreeUsageLimit',
      'ResourceExhaustedError',
      'RateLimitError',
      'grpc_code=8 error_code=upgrade',
      '{"grpcCode":8}',
      '{"statusCode":429}',
      'HTTP 429 Too Many Requests',
      'HTTP 403 Forbidden: grpc_code=RESOURCE_EXHAUSTED',
    ]) {
      expect(classifyProbeFailure({ message })).toEqual({
        outcome: 'unavailable',
        reason: message,
      })
    }
    expect(classifyProbeFailure({ message: 'error_code=upgrade' }).outcome).toBe('unknown')
    expect(classifyProbeFailure({ message: '{"usage":{"input_tokens":429}}' }).outcome).toBe(
      'unknown',
    )
    expect(classifyProbeFailure({ message: 'HTTP 403 Forbidden' }).outcome).toBe(
      'not_authenticated',
    )
  })

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
          if (input?.lease) retainedLeaseTeamIds.push(input.lease.teamId)
          return host
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
    expect(ensureHostInput).toMatchObject({
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
      lease: { teamId: OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID },
    })
  })

  async function expectCompletedAssistantResponseWithoutTextFailsFast(
    assistantParts: OpenCodeMessage['parts'],
  ): Promise<void> {
    let sleepCount = 0
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      probeTimeoutMs: 120_000,
      pollIntervalMs: 500,
      sleep: async () => {
        sleepCount += 1
        if (sleepCount > 1) {
          throw new Error('completed empty response should not be polled again')
        }
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-empty-assistant' }),
          getSession: async () => ({ id: 'session-empty-assistant' }),
          getSessionStatus: async () => ({ 'session-empty-assistant': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-empty-assistant',
                role: 'user',
                sessionID: 'session-empty-assistant',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-empty',
                role: 'assistant',
                parentID: 'msg-user-empty-assistant',
                sessionID: 'session-empty-assistant',
                time: { created: 101, completed: 110 },
              },
              parts: assistantParts,
            },
          ],
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-empty-assistant' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'OpenCode model verification completed without assistant output',
      durableState: 'idle',
      latestAssistantText: null,
    })
    expect(result.diagnostics).toContain(
      'OpenCode model verification completed without assistant output',
    )
    expect(sleepCount).toBe(1)
    expect(abortCount).toBe(0)
  }

  test('fails fast when OpenCode completes an empty assistant response', async () => {
    await expectCompletedAssistantResponseWithoutTextFailsFast([])
  })

  test('fails fast when OpenCode completes a reasoning-only assistant response', async () => {
    await expectCompletedAssistantResponseWithoutTextFailsFast([
      { type: 'reasoning', text: 'Internal reasoning without a final answer' },
    ])
  })

  test('fails fast after OpenCode stays idle without creating an assistant response', async () => {
    let statusCallCount = 0
    let messageCallCount = 0
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      probeTimeoutMs: 120_000,
      pollIntervalMs: 0,
      sleep: async () => {},
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-no-assistant' }),
          getSession: async () => ({ id: 'session-no-assistant' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return { 'session-no-assistant': 'idle' as const }
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            return [
              {
                info: {
                  id: 'msg-user-no-assistant',
                  role: 'user',
                  sessionID: 'session-no-assistant',
                  time: { created: 100 },
                },
                parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
              },
            ]
          },
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-no-assistant' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'OpenCode model verification became idle without producing an assistant response',
      rawStatus: 'idle',
      durableState: 'reply_pending',
      latestAssistantText: null,
    })
    expect(result.diagnostics).toContain(
      'OpenCode model verification became idle without producing an assistant response after 3 consecutive observations',
    )
    expect(statusCallCount).toBeGreaterThanOrEqual(4)
    expect(messageCallCount).toBeGreaterThanOrEqual(4)
    expect(abortCount).toBe(0)
  })

  test('fails fast and aborts when prompt_async never materializes a prompt', async () => {
    let abortCount = 0
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
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-empty' }),
          getSession: async () => ({ id: 'session-empty' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getSessionMessage: async () => null,
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
      promptStartTimeoutMs: 1,
    })

    const result = await probe.probeModel({
      selectedModel: 'ollama/gemma4:12b',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      failureCode: 'prompt_start_failed',
    })
    expect(result.reason).toContain('did not create a user message or enter a running state')
    expect(abortCount).toBeGreaterThanOrEqual(1)
  })

  for (const source of ['status', 'messages'] as const) {
    test(`classifies resource exhaustion thrown by ${source} while confirming prompt start`, async () => {
      const terminalError = () => {
        const error = new Error('OpenCode transport failed') as Error & { cause?: unknown }
        error.cause = {
          data: {
            error: {
              type: 'ResourceExhaustedError',
              message: 'grpc_code=RESOURCE_EXHAUSTED',
            },
          },
        }
        return error
      }
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
            getServerDoc: async () => { throw new Error('not used') },
            authorizeProviderOAuth: async () => { throw new Error('not used') },
            completeProviderOAuth: async () => { throw new Error('not used') },
            setProviderAuth: async () => { throw new Error('not used') },
            deleteProviderAuth: async () => { throw new Error('not used') },
            listAgents: async () => { throw new Error('not used') },
            getMcp: async () => { throw new Error('not used') },
            createSession: async () => ({ id: 'session-1' }),
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => {
              if (source === 'status') {
                throw terminalError()
              }
              return { 'session-1': 'idle' }
            },
            getSessionMessages: async () => {
              throw terminalError()
            },
            getPermissions: async () => [],
            listExperimentalToolIds: async () => [],
            listExperimentalTools: async () => [],
            answerPermission: async () => ({}),
            sendSessionMessage: async () => ({ info: {}, parts: [] }),
            promptSessionAsync: async () => {},
            abortSession: async () => true,
          }),
        },
        sessionCleanupTimeoutMs: 5,
      })

      const result = await probe.probeModel({
        selectedModel: 'cursor-acp/auto',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('unavailable')
      expect(result.reason).toContain('RESOURCE_EXHAUSTED')
      expect(result.failureCode).toBeUndefined()
      expect(result.errorCount).toBe(1)
    })
  }

  test('bounds session cleanup when the abort request ignores cancellation', async () => {
    let abortCount = 0
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
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-cleanup-timeout' }),
          getSession: async () => ({ id: 'session-cleanup-timeout' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getSessionMessage: async () => null,
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return new Promise<boolean>(() => {})
          },
        }),
      },
      promptStartTimeoutMs: 1,
      sessionCleanupTimeoutMs: 10,
    })

    const result = probe.probeModel({
      selectedModel: 'ollama/gemma4:12b',
      projectPath: '/tmp/project',
      bypassCache: true,
    })
    const testGuard = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('session cleanup did not settle')),
        500,
      )
      timer.unref?.()
    })

    await expect(Promise.race([result, testGuard])).resolves.toMatchObject({
      outcome: 'unknown',
      failureCode: 'prompt_start_failed',
    })
    expect(abortCount).toBe(1)
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
    expect(result.diagnostics.join('\n')).toContain(
      'assistant payload exposed a terminal provider failure',
    )
  })

  test('uses the native Cursor probe to stop a stuck OpenCode retry on resource exhaustion', async () => {
    let nativeProbeCalls = 0
    let abortCalls = 0
    let messageCalls = 0
    let statusCalls = 0
    let nativeProbeEnv: NodeJS.ProcessEnv | undefined
    let nativeProbeProjectPath: string | undefined
    let nativeProbeDelayMs: number | undefined
    let hungStatusSignal: AbortSignal | undefined
    let resolveNativeFailure!: (failure: {
      outcome: 'failure'
      message: string
      durationMs: number
      exitCode: number
    }) => void
    const nativeFailure = new Promise<{
      outcome: 'failure'
      message: string
      durationMs: number
      exitCode: number
    }>(resolve => {
      resolveNativeFailure = resolve
    })
    const profileEnv = {
      CURSOR_AGENT_EXECUTABLE: '/managed/profile/cursor-agent',
      PATH: '/managed/profile/bin',
    }
    const managedHost: OpenCodeHostHandle = {
      ...host,
      profile: {
        ...host.profile,
        env: profileEnv,
      },
    }
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => managedHost,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: (_baseUrl, requestContext) => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            if (statusCalls === 2) {
              hungStatusSignal = requestContext?.signal
              resolveNativeFailure({
                outcome: 'failure',
                message: 'grpc_code=resource_exhausted error_code=upgrade',
                durationMs: 12,
                exitCode: 1,
              })
              return await new Promise<Record<string, OpenCodeSessionStatusInput>>(() => {})
            }
            return { 'session-1': 'retry' }
          },
          getSessionMessages: async () => {
            messageCalls += 1
            return await new Promise<OpenCodeMessage[]>(() => {})
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCalls += 1
            return true
          },
        }),
      },
      cursorNativeFailureProbe: {
        probe: async input => {
          nativeProbeCalls += 1
          nativeProbeEnv = input.env
          nativeProbeProjectPath = input.projectPath
          if (nativeProbeCalls === 1) nativeProbeDelayMs = input.delayMs
          return nativeProbeCalls === 1 ? null : nativeFailure
        },
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const runtimeDeadline = new OpenCodeRuntimeDeadline(250)
    const result = await (async () => {
      try {
        return await probe.probeModel({
          selectedModel: 'cursor-acp/auto',
          projectPath: '/tmp/project',
          runtimeDeadline,
        })
      } finally {
        runtimeDeadline.dispose()
      }
    })()

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('resource_exhausted')
    expect(result.durableState).toBe('retrying')
    expect(result.diagnostics.join('\n')).toContain('native failure probe confirmed')
    expect(nativeProbeCalls).toBe(2)
    expect(nativeProbeEnv).toBe(profileEnv)
    expect(nativeProbeProjectPath).toBe(managedHost.profile.tmpPath)
    expect(nativeProbeDelayMs).toBe(0)
    expect(messageCalls).toBe(0)
    expect(statusCalls).toBeGreaterThanOrEqual(2)
    expect(hungStatusSignal?.aborted).toBe(true)
    expect(abortCalls).toBeGreaterThan(0)

    const cachedResult = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })
    expect(cachedResult.outcome).toBe('unavailable')
    expect(nativeProbeCalls).toBe(2)
  })

  test('uses a nested terminal OpenCode retry error without a second Cursor request', async () => {
    let nativeProbeCalls = 0
    let messageCalls = 0
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
          getSessionStatus: async () => ({
            'session-1': {
              type: 'retry',
              attempt: 1,
              message: 'HTTP 403 Forbidden',
              data: {
                metadata: {
                  code: 'RESOURCE_EXHAUSTED',
                },
              },
            } as OpenCodeSessionStatusInput & { data: Record<string, unknown> },
          }),
          getSessionMessages: async () => {
            messageCalls += 1
            return await new Promise<OpenCodeMessage[]>(() => {})
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          return null
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('RESOURCE_EXHAUSTED')
    expect(result.diagnostics.join('\n')).toContain('retry status exposed')
    expect(nativeProbeCalls).toBe(1)
    expect(messageCalls).toBe(0)
  })

  test('rechecks retry status while the session messages request is pending', async () => {
    let statusCalls = 0
    let messageCalls = 0
    let pendingMessagesSignal: AbortSignal | undefined
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: (_baseUrl, requestContext) => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            return {
              'session-1': statusCalls < 3
                ? 'busy'
                : {
                    type: 'retry',
                    attempt: 1,
                    message: 'grpc_code=resource_exhausted error_code=upgrade',
                  },
            }
          },
          getSessionMessages: async () => {
            messageCalls += 1
            pendingMessagesSignal = requestContext?.signal
            return await new Promise<OpenCodeMessage[]>((_resolve, reject) => {
              requestContext?.signal?.addEventListener(
                'abort',
                () => reject(requestContext.signal?.reason),
                { once: true },
              )
            })
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      sleep: async () => {},
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('resource_exhausted')
    expect(result.durableState).toBe('retrying')
    expect(statusCalls).toBeGreaterThanOrEqual(3)
    expect(messageCalls).toBe(1)
    expect(pendingMessagesSignal?.aborted).toBe(true)
  })

  for (const source of ['status', 'messages'] as const) {
    test(`classifies resource exhaustion thrown by the session ${source} request`, async () => {
      let statusCalls = 0
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
            getSessionStatus: async () => {
              statusCalls += 1
              if (source === 'status' && statusCalls > 1) {
                throw new Error('HTTP 403: grpc_code=RESOURCE_EXHAUSTED')
              }
              return { 'session-1': 'busy' }
            },
            getSessionMessages: async () => {
              if (source === 'messages') {
                throw new Error('HTTP 403: grpc_code=RESOURCE_EXHAUSTED')
              }
              return []
            },
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
            promptSessionAsync: async () => {},
            abortSession: async () => true,
          }),
        },
      })

      const result = await probe.probeModel({
        selectedModel: 'cursor-acp/auto',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('unavailable')
      expect(result.reason).toContain('RESOURCE_EXHAUSTED')
      expect(result.diagnostics.join('\n')).toContain(`session ${source} request`)
    })
  }

  test('continues the OpenCode probe after bounded native fallback rejections', async () => {
    let statusCalls = 0
    let nativeProbeCalls = 0
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
          getSessionStatus: async () => {
            statusCalls += 1
            return {
              'session-1': statusCalls === 1
                ? 'busy'
                : statusCalls === 2
                  ? 'retry'
                  : 'idle',
            }
          },
          getSessionMessages: async () => statusCalls < 3
            ? []
            : [{
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          throw new Error('native probe crashed')
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(nativeProbeCalls).toBe(3)
  })

  test('retries one inconclusive native fallback and uses a terminal second result', async () => {
    let nativeProbeCalls = 0
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
          getSessionStatus: async () => ({ 'session-1': 'retry' }),
          getSessionMessages: async () => await new Promise<OpenCodeMessage[]>(() => {}),
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          return nativeProbeCalls === 1
            ? {
                outcome: 'failure',
                message: 'Connection reset by server',
                durationMs: 10,
                exitCode: 1,
              }
            : {
                outcome: 'failure',
                message: 'grpc_code=resource_exhausted error_code=upgrade',
                durationMs: 12,
                exitCode: 1,
              }
        },
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('resource_exhausted')
    expect(nativeProbeCalls).toBe(2)
  })

  test('does not repeat the native fallback after a successful PONG result', async () => {
    let statusCalls = 0
    let nativeProbeCalls = 0
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
          getSessionStatus: async () => {
            statusCalls += 1
            return { 'session-1': statusCalls < 3 ? 'retry' : 'idle' }
          },
          getSessionMessages: async () => statusCalls < 3
            ? []
            : [{
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          if (nativeProbeCalls === 1) return null
          return {
            outcome: 'available',
            message: null,
            durationMs: 8,
            exitCode: 0,
          }
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(nativeProbeCalls).toBe(2)
  })

  test('prefers a recovered original OpenCode PONG over an auxiliary native failure', async () => {
    let statusCalls = 0
    let nativeProbeCalls = 0
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
          getSessionStatus: async () => {
            statusCalls += 1
            return { 'session-1': statusCalls === 1 ? 'retry' : 'idle' }
          },
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
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          if (nativeProbeCalls === 1) return null
          return {
            outcome: 'failure',
            message: 'grpc_code=resource_exhausted error_code=upgrade',
            durationMs: 8,
            exitCode: 1,
          }
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(result.latestAssistantText).toBe('PONG')
    expect(result.diagnostics.join('\n')).toContain('original probe recovered')
    expect(nativeProbeCalls).toBe(2)
  })

  test('does not repeat an inconclusive native preflight while OpenCode is busy', async () => {
    let statusCalls = 0
    let nativeFallbackCalls = 0
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
          getSessionStatus: async () => {
            statusCalls += 1
            return { 'session-1': statusCalls < 3 ? 'busy' : 'idle' }
          },
          getSessionMessages: async () => statusCalls < 3
            ? []
            : [{
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeFallbackCalls += 1
          return null
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(statusCalls).toBe(3)
    expect(nativeFallbackCalls).toBe(1)
  })

  test('surfaces terminal native Cursor preflight before creating an OpenCode session', async () => {
    let nativeFallbackCalls = 0
    let createSessionCalls = 0
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
          createSession: async () => {
            createSessionCalls += 1
            return { id: 'session-1' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'busy' }),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeFallbackCalls += 1
          return {
            outcome: 'failure',
            message: "cursor-acp error: You've hit your Cursor usage limit",
            durationMs: 12,
            exitCode: 1,
          }
        },
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('Cursor usage limit')
    expect(result.diagnostics.join('\n')).toContain('native failure probe confirmed')
    expect(nativeFallbackCalls).toBe(1)
    expect(createSessionCalls).toBe(0)
  })

  test('surfaces terminal native Cursor preflight before starting an OpenCode host', async () => {
    let prepareProfileCalls = 0
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      prepareProfile: async (_projectPath, options) => {
        prepareProfileCalls += 1
        expect(options?.includeAppMcp).toBe(false)
        return profile
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => {
          throw new Error('OpenCode client must not be created after terminal native preflight')
        },
      },
      cursorNativeFailureProbe: {
        probe: async input => {
          expect(input.projectPath).toBe(profile.tmpPath)
          expect(input.delayMs).toBe(0)
          return {
            outcome: 'failure',
            message: 'RESOURCE_EXHAUSTED: Cursor usage limit reached',
            durationMs: 9,
            exitCode: 1,
          }
        },
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      cursorNativePreflightBeforeHost: true,
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('RESOURCE_EXHAUSTED')
    expect(prepareProfileCalls).toBe(1)
    expect(ensureHostCalls).toBe(0)
  })

  test('uses and cleans a lightweight sandbox profile for production native preflight', async () => {
    let nativeProjectPath: string | null = null
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      cursorNativeFailureProbe: {
        probe: async input => {
          nativeProjectPath = input.projectPath
          expect((await stat(input.projectPath)).isDirectory()).toBe(true)
          expect(input.env?.CURSOR_AGENT_EXECUTABLE).toContain(
            'native-subscription-cli-bin',
          )
          return {
            outcome: 'failure',
            message: 'RESOURCE_EXHAUSTED: Cursor usage limit reached',
            durationMs: 8,
            exitCode: 1,
          }
        },
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    })

    expect(result.outcome).toBe('unavailable')
    expect(ensureHostCalls).toBe(0)
    expect(nativeProjectPath).not.toBeNull()
    await expect(stat(nativeProjectPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps an inconclusive native-only Cursor preflight from starting an OpenCode host', async () => {
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      cursorNativeFailureProbe: {
        probe: async () => null,
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    })

    expect(result.outcome).toBe('unknown')
    expect(result.diagnostics.join('\n')).toContain('was inconclusive before OpenCode startup')
    expect(ensureHostCalls).toBe(0)
  })

  test('returns a bounded failure code when native-only Cursor preflight times out', async () => {
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      cursorNativeFailureProbe: {
        probe: async () => ({
          outcome: 'timeout',
          message: 'Cursor native execution preflight timed out after 65000ms',
          durationMs: 65_000,
          exitCode: null,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      failureCode: 'execution_timeout',
      reason: 'Cursor native execution preflight timed out after 65000ms',
    })
    expect(ensureHostCalls).toBe(0)
  })

  test('accepts native Cursor execution proof before creating an OpenCode session', async () => {
    let createSessionCalls = 0
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
          createSession: async () => {
            createSessionCalls += 1
            return { id: 'session-1' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'busy' }),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => ({
          outcome: 'available',
          message: null,
          durationMs: 14,
          exitCode: 0,
        }),
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(result.verifiedAt).toBeTruthy()
    expect(result.diagnostics.join('\n')).toContain(
      'native execution probe confirmed model availability',
    )
    expect(createSessionCalls).toBe(0)
  })

  test('uses one inconclusive native preflight before a successful OpenCode response', async () => {
    let nativeFallbackCalls = 0
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
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeFallbackCalls += 1
          return null
        },
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(nativeFallbackCalls).toBe(1)
  })

  test('can release execution probe lease without disposing the live host', async () => {
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let releaseHostCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async input => {
          if (input?.lease) retainedLeaseTeamIds.push(input.lease.teamId)
          return host
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
        ensureHost: async input => {
          if (input?.lease) retainedLeaseTeamIds.push(input.lease.teamId)
          return host
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

  test.each([
    'Token refresh failed: 401',
    'Invalid API key.',
    'API key not valid. Please pass a valid API key.',
    'API key is revoked',
  ])('marks model auth as invalid when OpenCode returns %s', async authFailure => {
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
                  message: 'Model unavailable',
                  data: {
                    message: authFailure,
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
    expect(result.reason).toContain(authFailure)
    expect(result.durableState).toBe('error')
  })

  test('surfaces stringified nested provider rate-limit errors while the session is retrying', async () => {
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
          getSessionStatus: async () => ({
            'session-1': {
              type: 'retry',
              attempt: 1,
            },
          }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-error',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
                error: JSON.stringify({
                  name: 'AI_APICallError',
                  message: 'Provider request failed',
                  errors: [
                    {
                      data: {
                        error: {
                          type: 'FreeUsageLimitError',
                          message: 'Rate limit exceeded. Please try again later.',
                        },
                      },
                    },
                  ],
                  statusCode: 429,
                }),
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
    expect(result.durableState).toBe('retrying')
    expect(result.diagnostics.join('\n')).toContain(
      'retry/error payload exposed a terminal provider failure',
    )
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

  test('bounds an in-memory deduplicated caller by its own runtime deadline', async () => {
    let createSessionCount = 0
    let releaseCreateSession!: () => void
    let markCreateSessionStarted!: () => void
    const createSessionStarted = new Promise<void>(resolve => {
      markCreateSessionStarted = resolve
    })
    const createSessionGate = new Promise<void>(resolve => {
      releaseCreateSession = resolve
    })
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
          createSession: async () => {
            createSessionCount += 1
            markCreateSessionStarted()
            await createSessionGate
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
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })
    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const sharedProbe = probe.probeModel(input)
    await createSessionStarted
    const deadline = new OpenCodeRuntimeDeadline(20)
    try {
      await expect(probe.probeModel({
        ...input,
        runtimeDeadline: deadline,
      })).rejects.toMatchObject({
        name: 'OpenCodeRuntimeDeadlineError',
        phase: 'execution_poll',
      })
    } finally {
      deadline.dispose()
      releaseCreateSession()
    }

    await expect(sharedProbe).resolves.toMatchObject({ outcome: 'available' })
    expect(createSessionCount).toBe(1)
  })

  test('does not let a short in-flight owner deadline abort a longer caller', async () => {
    let createSessionCount = 0
    let markFirstCreateStarted!: () => void
    const firstCreateStarted = new Promise<void>(resolve => {
      markFirstCreateStarted = resolve
    })
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
          createSession: async () => {
            createSessionCount += 1
            if (createSessionCount === 1) {
              markFirstCreateStarted()
              return await new Promise<{ id: string }>(() => {})
            }
            return { id: `session-${createSessionCount}` }
          },
          getSession: async id => ({ id }),
          getSessionStatus: async () => ({ [`session-${createSessionCount}`]: 'idle' }),
          getSessionMessages: async () => [{
            info: {
              id: 'msg-assistant-1',
              role: 'assistant',
              sessionID: `session-${createSessionCount}`,
              time: { created: 101, completed: 110 },
            },
            parts: [{ type: 'text', text: 'PONG' }],
          }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })
    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const shortDeadline = new OpenCodeRuntimeDeadline(30)
    try {
      const shortOwner = probe.probeModel({
        ...input,
        runtimeDeadline: shortDeadline,
      })
      await firstCreateStarted
      const longerCaller = probe.probeModel(input)

      await expect(shortOwner).rejects.toMatchObject({
        name: 'OpenCodeRuntimeDeadlineError',
      })
      await expect(longerCaller).resolves.toMatchObject({ outcome: 'available' })
    } finally {
      shortDeadline.dispose()
    }
    expect(createSessionCount).toBe(2)
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
            return {
              'session-1':
                statusCallCount === 4
                  ? 'busy'
                  : 'idle',
            }
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            if (messageCallCount < 7) {
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
    expect(statusCallCount).toBeGreaterThanOrEqual(7)
    expect(messageCallCount).toBeGreaterThanOrEqual(7)
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

  test('uses the shared runtime deadline instead of the legacy local poll cap', async () => {
    let statusCallCount = 0
    let messageCallCount = 0
    const runtimeDeadline = new OpenCodeRuntimeDeadline(200)
    const probe = new OpenCodeExecutionProbe({
      probeTimeoutMs: 1,
      pollIntervalMs: 2,
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
          createSession: async () => ({ id: 'session-runtime-deadline' }),
          getSession: async () => ({ id: 'session-runtime-deadline' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return {
              'session-runtime-deadline': statusCallCount < 3 ? 'busy' : 'idle',
            }
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            const messages: OpenCodeMessage[] = [{
              info: {
                id: 'msg-user-runtime-deadline',
                role: 'user',
                sessionID: 'session-runtime-deadline',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            }]
            if (messageCallCount >= 3) {
              messages.push({
                info: {
                  id: 'msg-assistant-runtime-deadline',
                  role: 'assistant',
                  parentID: 'msg-user-runtime-deadline',
                  sessionID: 'session-runtime-deadline',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              })
            }
            return messages
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    try {
      const result = await probe.probeModel({
        selectedModel: 'ollama/gemma4:12b',
        projectPath: '/tmp/project',
        bypassCache: true,
        runtimeDeadline,
      })

      expect(result.outcome).toBe('available')
      expect(messageCallCount).toBeGreaterThanOrEqual(3)
    } finally {
      runtimeDeadline.dispose()
    }
  })

  test('returns the runtime deadline when host startup ignores cancellation', async () => {
    const runtimeDeadline = new OpenCodeRuntimeDeadline(10)
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => new Promise<OpenCodeHostHandle>(() => {}),
        releaseHost: async () => {},
      },
      hostStartupCleanupTimeoutMs: 10,
    })

    try {
      const result = probe.probeModel({
        selectedModel: 'ollama/gemma4:12b',
        projectPath: '/tmp/project',
        bypassCache: true,
        runtimeDeadline,
      })
      const testGuard = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('host startup deadline did not settle')),
          500,
        )
        timer.unref?.()
      })

      await expect(Promise.race([result, testGuard])).rejects.toBeInstanceOf(
        OpenCodeRuntimeDeadlineError,
      )
    } finally {
      runtimeDeadline.dispose()
    }
  })

  test('releases a host that finishes startup after the runtime deadline', async () => {
    let resolveHost: ((value: OpenCodeHostHandle) => void) | null = null
    let releaseHostCount = 0
    const runtimeDeadline = new OpenCodeRuntimeDeadline(10)
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => new Promise<OpenCodeHostHandle>(resolve => {
          resolveHost = resolve
        }),
        releaseHost: async () => {
          releaseHostCount += 1
        },
      },
      hostStartupCleanupTimeoutMs: 250,
    })

    try {
      const result = probe.probeModel({
        selectedModel: 'ollama/gemma4:12b',
        projectPath: '/tmp/project',
        bypassCache: true,
        runtimeDeadline,
      })
      setTimeout(() => resolveHost?.(host), 25)

      await expect(result).rejects.toBeInstanceOf(OpenCodeRuntimeDeadlineError)
      expect(releaseHostCount).toBe(1)
    } finally {
      runtimeDeadline.dispose()
    }
  })
})
