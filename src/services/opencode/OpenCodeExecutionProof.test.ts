import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  buildOpenCodeExecutionProof,
  parseOpenCodeExecutionProof,
  validateOpenCodeExecutionProof,
} from './OpenCodeExecutionProof.js'
import { computeOpenCodeExpectedBehaviorFingerprint } from './OpenCodeExpectedBehaviorFingerprint.js'

import type { OpenCodeProvisioningSnapshot } from './types.js'

function snapshot(): OpenCodeProvisioningSnapshot {
  return {
    detected: true,
    hostHealthy: true,
    projectPath: '/tmp/proof-project',
    profile: {
      projectPath: '/tmp/proof-project',
      canonicalProjectPath: '/tmp/proof-project',
      workingDirectoryPath: '/tmp/proof-project',
      scopeToken: null,
      profileRootKey: 'root',
      profileRootPath: '/tmp/profile',
      projectBehaviorFingerprint: 'b'.repeat(64),
      behaviorSources: [],
      managedConfig: {},
      managedConfigFingerprint: 'c'.repeat(64),
      homePath: '/tmp/home',
      tmpPath: '/tmp/tmp',
      xdgConfigHome: '/tmp/config',
      xdgDataHome: '/tmp/data',
      xdgCacheHome: '/tmp/cache',
      managedAuthPath: '/tmp/auth.json',
      sourceAuthPath: null,
      sourceAuthFingerprint: null,
      managedAuthFingerprint: 'auth',
      authState: 'ok',
      env: {},
    },
    host: {
      hostKey: 'host',
      profileRootKey: 'root',
      projectPath: '/tmp/proof-project',
      projectBehaviorFingerprint: 'b'.repeat(64),
      baseUrl: 'http://127.0.0.1:1',
      port: 1,
      pid: 1,
      version: '1.18.2',
      state: 'healthy',
      profile: null as never,
      resolvedConfigFingerprint: 'd'.repeat(64),
      diagnostics: [],
    },
    config: null,
    configProviders: null,
    providers: null,
    providerAuth: null,
    agents: [],
    mcp: null,
    appMcp: null,
    probeError: null,
    diagnostics: [],
  }
}

const identityDeps = {
  nowMs: () => 1_000,
  resolveBinaryPath: () => '/tmp/opencode',
  resolveBinaryIdentity: async () => 'binary-1',
}

describe('OpenCodeExecutionProof', () => {
  test('reuses a fresh exact proof for authless local models', async () => {
    const current = snapshot()
    current.host!.profile = current.profile!
    const proof = await buildOpenCodeExecutionProof({
      selectedModel: 'ollama/gemma4:12b',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, {
      ...identityDeps,
      readCredential: async () => null,
    })

    expect(proof.reusable).toBe(true)
    await expect(validateOpenCodeExecutionProof({
      proof,
      selectedModel: 'ollama/gemma4:12b',
      projectPath: current.projectPath,
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, identityDeps)).resolves.toEqual({ valid: true, reason: null })
  })

  test('forces a fresh check for OAuth credentials', async () => {
    const current = snapshot()
    current.host!.profile = current.profile!
    const proof = await buildOpenCodeExecutionProof({
      selectedModel: 'xai/grok-code-fast-1',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, {
      ...identityDeps,
      readCredential: async () => ({ type: 'oauth', access: 'secret' }),
    })

    expect(proof.reusable).toBe(false)
    const result = await validateOpenCodeExecutionProof({
      proof,
      selectedModel: proof.modelId,
      projectPath: current.projectPath,
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, identityDeps)
    expect(result).toEqual({
      valid: false,
      reason: 'execution proof is not reusable for oauth credentials',
    })
  })

  test('rejects self-consistent changed evidence when the enclosing proof hash is stale', async () => {
    const current = snapshot()
    current.host!.profile = current.profile!
    const proof = await buildOpenCodeExecutionProof({
      selectedModel: 'ollama/gemma4:12b',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, { ...identityDeps, readCredential: async () => null })
    const changed = structuredClone(proof)
    changed.expectedBehaviorEvidence.effectiveConfigFingerprint = 'e'.repeat(64)
    changed.expectedBehaviorEvidence.expectedBehaviorFingerprint =
      computeOpenCodeExpectedBehaviorFingerprint(changed.expectedBehaviorEvidence)
    expect(parseOpenCodeExecutionProof(changed)).not.toBeNull()
    await expect(validateOpenCodeExecutionProof({
      proof: changed,
      selectedModel: proof.modelId,
      projectPath: current.projectPath,
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, identityDeps)).resolves.toMatchObject({
      valid: false,
      reason: 'execution proof integrity mismatch',
    })
  })

  test('rejects expired or changed runtime identity', async () => {
    const current = snapshot()
    current.host!.profile = current.profile!
    const proof = await buildOpenCodeExecutionProof({
      selectedModel: 'ollama/gemma4:12b',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, {
      ...identityDeps,
      readCredential: async () => null,
    })

    await expect(validateOpenCodeExecutionProof({
      proof,
      selectedModel: proof.modelId,
      projectPath: current.projectPath,
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, {
      ...identityDeps,
      nowMs: () => Date.parse(proof.expiresAt),
    })).resolves.toMatchObject({ valid: false, reason: 'execution proof expired' })

    await expect(validateOpenCodeExecutionProof({
      proof,
      selectedModel: proof.modelId,
      projectPath: current.projectPath,
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, {
      ...identityDeps,
      resolveBinaryIdentity: async () => 'binary-2',
    })).resolves.toMatchObject({ valid: false, reason: 'execution proof binary changed' })
  })

  test('preserves evidence time through measured cleanup and launch preparation', async () => {
    const current = snapshot()
    current.host!.profile = current.profile!
    const verifiedAt = new Date(1_000).toISOString()
    const deps = { ...identityDeps, readCredential: async () => null }
    const proof = await buildOpenCodeExecutionProof({
      selectedModel: 'ollama/gemma4:12b',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
      verifiedAt,
    }, { ...deps, nowMs: () => 20_015 })
    expect(proof.verifiedAt).toBe(verifiedAt)
    const input = {
      proof, selectedModel: proof.modelId, projectPath: current.projectPath,
      snapshot: current, capabilitySnapshotId: 'capability-1',
    }
    // Actual r20: retirement 19.015s + handshake 7.238s + launch preparation 20.399s.
    await expect(validateOpenCodeExecutionProof(input, {
      ...deps, nowMs: () => 1_000 + 46_652,
    })).resolves.toEqual({ valid: true, reason: null })
    await expect(validateOpenCodeExecutionProof(input, {
      ...deps, nowMs: () => Date.parse(proof.expiresAt) - 1,
    })).resolves.toEqual({ valid: true, reason: null })
    await expect(validateOpenCodeExecutionProof(input, {
      ...deps, nowMs: () => Date.parse(proof.expiresAt),
    })).resolves.toEqual({ valid: false, reason: 'execution proof expired' })
  })

  test('honors an already signed shorter supplied expiry', async () => {
    const current = snapshot()
    current.host!.profile = current.profile!
    const deps = { ...identityDeps, readCredential: async () => null }
    const original = await buildOpenCodeExecutionProof({
      selectedModel: 'ollama/gemma4:12b', snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, deps)
    const { proofHash: _hash, ...unsigned } = original
    unsigned.expiresAt = new Date(6_000).toISOString()
    // Sign a supplied proof fixture with a shorter authority window.
    const bytes = JSON.stringify(unsigned, (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        : value)
    const proof = { ...unsigned, proofHash: createHash('sha256').update(bytes).digest('hex') }
    const input = {
      proof, selectedModel: proof.modelId, projectPath: current.projectPath,
      snapshot: current, capabilitySnapshotId: 'capability-1',
    }
    await expect(validateOpenCodeExecutionProof(input, {
      ...deps, nowMs: () => 5_999,
    })).resolves.toEqual({ valid: true, reason: null })
    await expect(validateOpenCodeExecutionProof(input, {
      ...deps, nowMs: () => 6_000,
    })).resolves.toEqual({ valid: false, reason: 'execution proof expired' })
  })

  test('normalizes Windows project casing before reusing a proof', async () => {
    const current = snapshot()
    current.projectPath = '/TMP/Proof-Project'
    current.profile!.projectPath = current.projectPath
    current.host!.projectPath = current.projectPath
    current.host!.profile = current.profile!
    const windowsDeps = {
      ...identityDeps,
      platform: 'win32' as const,
      readCredential: async () => null,
    }
    const proof = await buildOpenCodeExecutionProof({
      selectedModel: 'ollama/gemma4:12b',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, windowsDeps)

    await expect(validateOpenCodeExecutionProof({
      proof,
      selectedModel: proof.modelId,
      projectPath: '/tmp/proof-project',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, windowsDeps)).resolves.toEqual({ valid: true, reason: null })
  })

  test('does not reuse a proof when the OpenCode version is unknown', async () => {
    const current = snapshot()
    current.host!.version = null
    current.host!.profile = current.profile!
    const proof = await buildOpenCodeExecutionProof({
      selectedModel: 'ollama/gemma4:12b',
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, {
      ...identityDeps,
      readCredential: async () => null,
    })

    expect(proof.reusable).toBe(false)
    await expect(validateOpenCodeExecutionProof({
      proof,
      selectedModel: proof.modelId,
      projectPath: current.projectPath,
      snapshot: current,
      capabilitySnapshotId: 'capability-1',
    }, identityDeps)).resolves.toMatchObject({
      valid: false,
      reason: 'execution proof is not reusable for none credentials',
    })
  })
})
