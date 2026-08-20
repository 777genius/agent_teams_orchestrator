import { stat, writeFile } from 'node:fs/promises'

import {
  OpenCodeProviderCatalogService,
  OpenCodeProviderCatalogUnavailableError,
} from './OpenCodeProviderCatalogService.js'

const [
  cacheHome, generationText, model, projectPath, maxEntriesText, gatePath = '', retentionGatePath = '',
  visibilityGatePath = '',
] = process.argv.slice(2)
const generation = Number(generationText)
const maxEntries = Number(maxEntriesText)
if (!cacheHome || !model || !projectPath || !Number.isSafeInteger(generation)
  || generation < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) process.exit(2)
process.env.CLAUDE_MULTIMODEL_CACHE_HOME = cacheHome

const service = new OpenCodeProviderCatalogService({
  now: () => 1_000 + generation,
  ttlMs: 1,
  timeoutMs: 10_000,
  maxEntries,
  canonicalizeProjectPath: async value => value,
  allocateAttempt: () => ({
    requestGeneration: generation,
    attemptIdentity: `sha256:${generation.toString(16).padStart(64, '0')}`,
  }),
  prepareProfile: async plan => ({
    scopeSchema: 'opencode-scoped-profile-v1',
    purpose: 'provider-catalog',
    providerId: plan.providerId,
    projectPath: plan.projectPath,
    profileRootPath: `/fake/${generation}`,
    binaryFingerprint: 'binary',
    managedConfigFingerprint: 'config',
    selectedAuthBaselineFingerprint: 'auth',
    policy: {
      inventory: 'selected-provider-only',
      inventoryFallback: 'forbidden',
      launchAuthorization: 'forbidden',
    },
  } as never),
  ensureHost: async () => ({ hostKey: `host-${generation}`, baseUrl: 'http://127.0.0.1:4430' }),
  releaseHost: async () => undefined,
  fetchProviderCatalog: async () => ({
    all: [{ id: 'deepinfra', name: 'deepinfra', models: {
      [model]: { name: model, capabilities: { tools: true } },
    } }],
    connected: ['deepinfra'],
  }),
  ...(gatePath ? { beforeFinalPublication: async () => {
    await writeFile(`${gatePath}.entered`, '')
    while (!await stat(`${gatePath}.release`).catch(() => null)) {
      await new Promise<void>(resolve => setTimeout(resolve, 1))
    }
  } } : {}),
  ...(retentionGatePath ? { afterRetentionAuthorityRemoval: async () => {
    await writeFile(`${retentionGatePath}.entered`, '')
    while (!await stat(`${retentionGatePath}.release`).catch(() => null)) {
      await new Promise<void>(resolve => setTimeout(resolve, 1))
    }
  } } : {}),
  ...(visibilityGatePath ? { beforeVisibilitySync: async () => {
    await writeFile(`${visibilityGatePath}.entered`, '')
    while (!await stat(`${visibilityGatePath}.release`).catch(() => null)) {
      await new Promise<void>(resolve => setTimeout(resolve, 1))
    }
  } } : {}),
})

try {
  const result = await service.loadCatalog({ providerId: 'deepinfra', projectPath })
  process.stdout.write(`${JSON.stringify({ outcome: 'success', model: result.catalog.models[0]?.id })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    outcome: 'rejected',
    type: error instanceof OpenCodeProviderCatalogUnavailableError ? error.outcome : 'transient',
  })}\n`)
}
