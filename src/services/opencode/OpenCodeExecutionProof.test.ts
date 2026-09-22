import { describe, expect, test } from 'bun:test'

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
      nowMs: () => 46_001,
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
