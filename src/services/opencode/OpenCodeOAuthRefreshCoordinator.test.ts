import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  readOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'
import {
  isOpenCodeOAuthCredentialExpiring,
  OpenCodeOAuthRefreshCoordinator,
} from './OpenCodeOAuthRefreshCoordinator.js'

import type { OpenCodeExecutionProbeResult, OpenCodePreparedProfile } from './types.js'

function probeResult(
  outcome: OpenCodeExecutionProbeResult['outcome'],
  reason: string | null = null,
): OpenCodeExecutionProbeResult {
  return {
    providerId: 'opencode',
    modelId: 'xai/grok-4.3',
    probePrompt: 'PONG',
    expectedOutput: 'PONG',
    outcome,
    reason,
    durationMs: 1,
    rawStatus: null,
    durableState: 'idle',
    latestAssistantText: outcome === 'available' ? 'PONG' : null,
    latestAssistantPreview: outcome === 'available' ? 'PONG' : null,
    toolCallCount: 0,
    errorCount: outcome === 'available' ? 0 : 1,
    diagnostics: [],
  }
}

function profile(managedAuthPath: string): OpenCodePreparedProfile {
  return {
    projectPath: '/tmp/project',
    profileRootKey: 'profile-root',
    profileRootPath: '/tmp/profile-root',
    projectBehaviorFingerprint: 'behavior-v1',
    behaviorSources: [],
    managedConfig: {},
    managedConfigFingerprint: 'managed-config-v1',
    homePath: '/tmp/profile-root/home',
    tmpPath: '/tmp/profile-root/tmp',
    xdgConfigHome: '/tmp/profile-root/config',
    xdgDataHome: '/tmp/profile-root/data',
    xdgCacheHome: '/tmp/profile-root/cache',
    managedAuthPath,
    sourceAuthPath: '/tmp/source/opencode/auth.json',
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    authState: 'ok',
    env: {},
  }
}

describe('OpenCodeOAuthRefreshCoordinator', () => {
  let tempDir: string
  let authPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-refresh-'))
    authPath = path.join(tempDir, 'opencode', 'profiles', 'project', 'data', 'opencode', 'auth.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('skips non-xAI models and xAI API credentials', async () => {
    let probeCalls = 0
    const coordinator = new OpenCodeOAuthRefreshCoordinator({
      readCredential: async () => ({ type: 'api', key: 'hidden' }),
      probeModel: async () => {
        probeCalls += 1
        return probeResult('available')
      },
    })

    await expect(coordinator.ensureFreshForPrompt({
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
      profile: profile(authPath),
    })).resolves.toEqual({ checked: false, refreshed: false })
    await expect(coordinator.ensureFreshForPrompt({
      selectedModel: 'xai/grok-4.3',
      projectPath: '/tmp/project',
      profile: profile(authPath),
    })).resolves.toEqual({ checked: false, refreshed: false })
    expect(probeCalls).toBe(0)
  })

  test('keeps normal xAI prompts parallel while the OAuth credential is fresh', async () => {
    let probeCalls = 0
    const coordinator = new OpenCodeOAuthRefreshCoordinator({
      nowMs: () => 1_000,
      readCredential: async () => ({
        type: 'oauth',
        access: 'fresh-access',
        refresh: 'fresh-refresh',
        expires: 500_000,
      }),
      probeModel: async () => {
        probeCalls += 1
        return probeResult('available')
      },
    })

    await expect(Promise.all(Array.from({ length: 3 }, () =>
      coordinator.ensureFreshForPrompt({
        selectedModel: 'xai/grok-4.3',
        projectPath: '/tmp/project',
        profile: profile(authPath),
      })))).resolves.toEqual(Array.from({ length: 3 }, () => ({
      checked: true,
      refreshed: false,
    })))
    expect(probeCalls).toBe(0)
  })

  test('collapses simultaneous expired-token prompts onto one refresh probe', async () => {
    const now = Date.now()
    const expiredCredential = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'rotating-refresh-before',
      expires: now - 1,
    }
    const refreshedCredential = {
      type: 'oauth',
      access: 'fresh-access',
      refresh: 'rotating-refresh-after',
      expires: now + 3_600_000,
    }
    await upsertOpenCodeAuthCredential({
      authPath,
      providerId: 'xai',
      credential: expiredCredential,
    })
    let probeCalls = 0
    const coordinator = new OpenCodeOAuthRefreshCoordinator({
      nowMs: () => now,
      probeModel: async input => {
        probeCalls += 1
        expect(input).toMatchObject({
          selectedModel: 'xai/grok-4.3',
          projectPath: '/tmp/project',
          bypassCache: true,
        })
        await upsertOpenCodeAuthCredential({
          authPath,
          providerId: 'xai',
          credential: refreshedCredential,
        })
        return probeResult('available')
      },
    })

    const results = await Promise.all(Array.from({ length: 3 }, () =>
      coordinator.ensureFreshForPrompt({
        selectedModel: 'xai/grok-4.3',
        projectPath: '/tmp/project',
        profile: profile(authPath),
      })))

    expect(results).toEqual(Array.from({ length: 3 }, () => ({
      checked: true,
      refreshed: true,
    })))
    expect(probeCalls).toBe(1)
    await expect(readOpenCodeAuthCredential({ authPath, providerId: 'xai' }))
      .resolves.toEqual(refreshedCredential)
  })

  test('blocks the real prompt when refresh is rejected', async () => {
    const now = Date.now()
    const coordinator = new OpenCodeOAuthRefreshCoordinator({
      nowMs: () => now,
      readCredential: async () => ({
        type: 'oauth',
        access: 'expired-access',
        refresh: 'revoked-refresh',
        expires: now - 1,
      }),
      withRefreshLock: async input => input.operation(),
      probeModel: async () => probeResult('not_authenticated', 'invalid_grant'),
    })

    await expect(coordinator.ensureFreshForPrompt({
      selectedModel: 'xai/grok-4.3',
      projectPath: '/tmp/project',
      profile: profile(authPath),
    })).rejects.toThrow('invalid_grant')
  })

  test('rejects a successful probe when rotated credentials were not persisted', async () => {
    const now = Date.now()
    const coordinator = new OpenCodeOAuthRefreshCoordinator({
      nowMs: () => now,
      readCredential: async () => ({
        type: 'oauth',
        access: 'expired-access',
        refresh: 'refresh-before',
        expires: now - 1,
      }),
      withRefreshLock: async input => input.operation(),
      probeModel: async () => probeResult('available'),
    })

    await expect(coordinator.ensureFreshForPrompt({
      selectedModel: 'xai/grok-4.3',
      projectPath: '/tmp/project',
      profile: profile(authPath),
    })).rejects.toThrow('rotated credential was not persisted')
  })

  test('uses the earlier JWT expiry when the stored deadline is stale', () => {
    const now = 1_000_000
    const jwtPayload = Buffer.from(JSON.stringify({ exp: (now + 30_000) / 1_000 }))
      .toString('base64url')
    expect(isOpenCodeOAuthCredentialExpiring({
      credential: {
        type: 'oauth',
        access: `header.${jwtPayload}.signature`,
        refresh: 'refresh',
        expires: now + 3_600_000,
      },
      nowMs: now,
    })).toBe(true)
  })
})
