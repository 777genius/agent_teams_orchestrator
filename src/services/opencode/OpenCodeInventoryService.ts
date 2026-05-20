import path from 'node:path'
import stripAnsi from 'strip-ansi'

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getCwd } from '../../utils/cwd.js'
import {
  normalizeOpenCodeProviderId,
  parseFirstOpenCodeModelToken,
  parseOpenCodeProviderScopedModelRef,
} from './OpenCodeModelRef.js'
import { readOpenCodeAuthProviderSummaries } from './OpenCodeAuthStore.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'

import type {
  OpenCodeAgentMode,
  OpenCodeAgentSummary,
  OpenCodeConnectedProvider,
  OpenCodeInventorySnapshot,
  OpenCodeModelMetadata,
  OpenCodePreparedProfile,
} from './types.js'

const OPEN_CODE_PROBE_TIMEOUT_MS = 10_000
const OPEN_CODE_CACHE_TTL_MS = 10_000

type OpenCodeInventoryProbeMode = 'full' | 'summary'

type OpenCodeInventoryProbeOptions = {
  bypassCache?: boolean
  mode?: OpenCodeInventoryProbeMode
  includeAppMcp?: boolean
}

type CacheEntry = {
  expiresAt: number
  snapshot: OpenCodeInventorySnapshot
}

function normalizeProviderId(value: string): string {
  return normalizeOpenCodeProviderId(value.replace(/\s+/g, '-')) ?? value.trim().toLowerCase().replace(/\s+/g, '-')
}

function getTrimmedNonEmptyLines(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(Boolean)
}

function parseOpenCodeConnectedProviderLine(
  rawEntry: string,
): { provider: string; authHint: string | null } | null {
  const trimmed = rawEntry.trim()
  if (!trimmed) {
    return null
  }

  const parts = trimmed.split(/\s+/g)
  const lastToken = parts[parts.length - 1]
  if (!lastToken) {
    return { provider: trimmed, authHint: null }
  }

  const lowerLastToken = lastToken.toLowerCase()
  const isAuthHint =
    lowerLastToken === 'api'
    || lowerLastToken === 'oauth'
    || (
      /^[A-Z0-9_:-]+$/.test(lastToken)
      && (lastToken.includes('_') || lastToken.includes(':'))
    )

  if (!isAuthHint || parts.length === 1) {
    return { provider: trimmed, authHint: null }
  }

  return {
    provider: parts.slice(0, -1).join(' '),
    authHint: lowerLastToken,
  }
}

export function parseOpenCodeModelsOutput(output: string): string[] {
  return Array.from(new Set(
    getTrimmedNonEmptyLines(output)
      .map(line => parseFirstOpenCodeModelToken(line)?.raw)
      .filter((model): model is string => Boolean(model)),
  ))
}

export function getOpenCodeVerboseModelsArgs(): string[] {
  return ['models', '--verbose']
}

function collectFiniteNumbers(value: unknown): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectFiniteNumbers)
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectFiniteNumbers)
  }
  return []
}

function isFreeCost(cost: unknown): boolean {
  const numbers = collectFiniteNumbers(cost)
  return numbers.length > 0 && numbers.every(value => value === 0)
}

function isExplicitFreeOpenCodeModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return (
    normalized.startsWith('opencode/')
    || normalized.includes(':free')
    || normalized.endsWith('-free')
    || normalized.endsWith('/free')
  )
}

export function isOpenCodeBuiltinProviderModelId(modelId: string | null | undefined): boolean {
  return modelId?.trim().toLowerCase().startsWith('opencode/') === true
}

function getModelContextLimit(limits: unknown): number | null {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return null
  }
  const context = (limits as Record<string, unknown>).context
  return typeof context === 'number' && Number.isFinite(context) ? context : null
}

function findJsonBlockEnd(lines: readonly string[], startIndex: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    for (const char of line) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = inString
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (inString) {
        continue
      }
      if (char === '{') depth += 1
      if (char === '}') depth -= 1
    }
    if (depth === 0 && lineIndex >= startIndex) {
      return lineIndex
    }
  }
  return startIndex
}

export function parseOpenCodeModelsVerboseOutput(output: string): {
  models: string[]
  modelMetadata: OpenCodeModelMetadata[]
} {
  const lines = stripAnsi(output).split(/\r?\n/g).map(line => line.trim()).filter(Boolean)
  const models: string[] = []
  const modelMetadata: OpenCodeModelMetadata[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const modelRef = parseFirstOpenCodeModelToken(line)
    if (!modelRef) {
      continue
    }
    models.push(modelRef.raw)
    const nextLine = lines[index + 1]
    if (!nextLine?.startsWith('{')) {
      continue
    }
    const blockEnd = findJsonBlockEnd(lines, index + 1)
    const block = lines.slice(index + 1, blockEnd + 1).join('\n')
    try {
      const raw = JSON.parse(block) as Record<string, unknown>
      const limits = raw.limit ?? raw.limits ?? null
      modelMetadata.push({
        id: modelRef.raw,
        cost: raw.cost ?? null,
        context: getModelContextLimit(limits),
        limits,
        free: isFreeCost(raw.cost) && isExplicitFreeOpenCodeModelId(modelRef.raw),
        raw,
      })
      index = blockEnd
    } catch {
      // Keep the plain model id even if one metadata block is malformed.
    }
  }

  return {
    models,
    modelMetadata,
  }
}

export function isOpenCodeModelFree(
  modelId: string,
  modelMetadata: readonly OpenCodeModelMetadata[] | undefined,
): boolean {
  const normalizedModelId = modelId.trim()
  if (normalizedModelId.toLowerCase().endsWith(':free')) {
    return true
  }

  const metadata = modelMetadata?.find(item => item.id === normalizedModelId)
  return metadata?.free === true
}

export function isOpenCodeBuiltinFreeModelId(
  modelId: string | null | undefined,
  modelMetadata: readonly OpenCodeModelMetadata[] | undefined,
): boolean {
  const normalizedModelId = modelId?.trim()
  return Boolean(
    normalizedModelId
      && isOpenCodeBuiltinProviderModelId(normalizedModelId)
      && isOpenCodeModelFree(normalizedModelId, modelMetadata),
  )
}

export function hasOpenCodeBuiltinFreeModel(
  models: readonly string[],
  modelMetadata: readonly OpenCodeModelMetadata[] | undefined,
): boolean {
  return models.some(model => isOpenCodeBuiltinFreeModelId(model, modelMetadata))
}

export function parseOpenCodeProvidersOutput(output: string): {
  authStorePath: string | null
  connectedProviders: OpenCodeConnectedProvider[]
} {
  let currentSource: OpenCodeConnectedProvider['source'] | null = null
  let authStorePath: string | null = null
  const connectedProviders: OpenCodeConnectedProvider[] = []

  for (const line of stripAnsi(output).split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const normalizedLine = trimmed.replace(/^[┌└│]+\s*/u, '')

    if (normalizedLine.startsWith('Credentials ')) {
      currentSource = 'credentials'
      authStorePath = normalizedLine.slice('Credentials '.length).trim() || null
      continue
    }

    if (normalizedLine === 'Environment') {
      currentSource = 'environment'
      continue
    }

    if (!trimmed.startsWith('●') || currentSource === null) {
      continue
    }

    const rawEntry = trimmed.slice(1).trim()
    const parsed = parseOpenCodeConnectedProviderLine(rawEntry)
    if (!parsed?.provider) {
      continue
    }

    connectedProviders.push({
      id: normalizeProviderId(parsed.provider),
      authHint: parsed.authHint,
      source: currentSource,
    })
  }

  return {
    authStorePath,
    connectedProviders,
  }
}

function mergeConnectedProviders(
  providers: readonly OpenCodeConnectedProvider[],
): OpenCodeConnectedProvider[] {
  const merged = new Map<string, OpenCodeConnectedProvider>()

  for (const provider of providers) {
    const providerId = normalizeProviderId(provider.id)
    if (!providerId) {
      continue
    }

    const key = `${provider.source}:${providerId}`
    const existing = merged.get(key)
    const credentialScopes = provider.source === 'credentials'
      ? Array.from(new Set([
        ...(existing?.credentialScopes ?? []),
        ...(provider.credentialScopes ?? []),
      ]))
      : []
    merged.set(key, {
      id: providerId,
      authHint: provider.authHint ?? existing?.authHint ?? null,
      source: provider.source,
      ...(credentialScopes.length > 0 ? { credentialScopes } : {}),
    })
  }

  return Array.from(merged.values()).sort((left, right) => {
    const sourceSort = left.source.localeCompare(right.source)
    return sourceSort !== 0 ? sourceSort : left.id.localeCompare(right.id)
  })
}

export function parseOpenCodeAgentListOutput(output: string): OpenCodeAgentSummary[] {
  const agents: OpenCodeAgentSummary[] = []

  for (const line of getTrimmedNonEmptyLines(output)) {
    const match = /^(?<id>[A-Za-z0-9._-]+)\s+\((?<mode>primary|subagent)\)$/.exec(line)
    if (!match?.groups?.id) {
      continue
    }

    agents.push({
      id: match.groups.id,
      mode: (match.groups.mode as OpenCodeAgentMode | undefined) ?? 'unknown',
    })
  }

  return agents
}

export class OpenCodeInventoryService {
  private readonly cache = new Map<string, CacheEntry>()

  private getCommandFailureMessage(result: {
    stderr: string
    error?: string
  }, fallback: string): string {
    return result.error ?? (result.stderr.trim() || fallback)
  }

  private async execOpenCode(
    binaryPath: string,
    args: string[],
    profile: OpenCodePreparedProfile,
  ): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
    return execFileNoThrowWithCwd(binaryPath, args, {
      cwd: profile.projectPath,
      env: profile.env,
      timeout: OPEN_CODE_PROBE_TIMEOUT_MS,
      preserveOutputOnError: true,
    })
  }

  async probe(
    projectPath?: string | null,
    options: OpenCodeInventoryProbeOptions = {},
  ): Promise<OpenCodeInventorySnapshot> {
    const mode = options.mode ?? 'full'
    const resolvedProjectPath = path.resolve(projectPath?.trim() || getCwd())
    const cacheKey = `${resolvedProjectPath}\0${mode}\0${options.includeAppMcp === false ? 'without-app-mcp' : 'with-app-mcp'}`
    const cached = this.cache.get(cacheKey)
    const cacheEnabled = mode === 'full' && !options.bypassCache
    if (cacheEnabled && cached && cached.expiresAt > Date.now()) {
      return cached.snapshot
    }

    const binaryPath = resolveOpenCodeBinaryPath()
    if (!binaryPath) {
      const missingSnapshot: OpenCodeInventorySnapshot = {
        detected: false,
        binaryPath: null,
        version: null,
        projectPath: resolvedProjectPath,
        profile: null,
        connectedProviders: [],
        availableProviders: [],
        models: [],
        modelMetadata: [],
        agents: [],
        authStorePath: null,
        probeError: null,
        diagnostics: ['OpenCode CLI not detected on PATH'],
      }
      if (cacheEnabled) {
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + OPEN_CODE_CACHE_TTL_MS,
          snapshot: missingSnapshot,
        })
      }
      return missingSnapshot
    }

    const profile = await openCodeProfileManager.prepareProfile(resolvedProjectPath, {
      includeAppMcp: options.includeAppMcp !== false,
    })
    const [versionResult, providersResult, modelsResult, agentsResult] = await Promise.all([
      this.execOpenCode(binaryPath, ['--version'], profile),
      this.execOpenCode(binaryPath, ['providers', 'list'], profile),
      mode === 'summary'
        ? Promise.resolve({ stdout: '', stderr: '', code: 0 })
        : this.execOpenCode(binaryPath, getOpenCodeVerboseModelsArgs(), profile),
      mode === 'summary'
        ? Promise.resolve({ stdout: '', stderr: '', code: 0 })
        : this.execOpenCode(binaryPath, ['agent', 'list'], profile),
    ])

    const version = versionResult.code === 0 ? versionResult.stdout.trim() || null : null
    const providerParse = parseOpenCodeProvidersOutput(providersResult.stdout)
    const globalAuthProviderIds = new Set(
      (profile.globalAuthPath
        ? await readOpenCodeAuthProviderSummaries(profile.globalAuthPath, ['managed']).catch(() => [])
        : []
      ).map(provider => provider.id),
    )
    const sourceAuthProviderIds = new Set(
      (profile.sourceAuthPath
        ? await readOpenCodeAuthProviderSummaries(profile.sourceAuthPath, ['local']).catch(() => [])
        : []
      ).map(provider => provider.id),
    )
    const credentialScopesForProvider = (providerId: string): Array<'managed' | 'local'> => {
      const scopes: Array<'managed' | 'local'> = []
      if (globalAuthProviderIds.has(providerId)) scopes.push('managed')
      if (sourceAuthProviderIds.has(providerId)) scopes.push('local')
      return scopes.length > 0 ? scopes : ['managed']
    }
    const managedAuthProviders = (
      await readOpenCodeAuthProviderSummaries(profile.managedAuthPath, ['managed']).catch(() => [])
    ).map(provider => ({
      ...provider,
      credentialScopes: credentialScopesForProvider(provider.id),
    }))
    const cliConnectedProviders = providerParse.connectedProviders.map(provider => {
      if (provider.source !== 'credentials') {
        return provider
      }
      return {
        ...provider,
        credentialScopes: credentialScopesForProvider(provider.id),
      }
    })
    const connectedProviders = mergeConnectedProviders([
      ...cliConnectedProviders,
      ...managedAuthProviders,
    ])
    const verboseModels =
      mode === 'summary'
        ? {
            models: [],
            modelMetadata: [],
          }
        : modelsResult.code === 0
          ? parseOpenCodeModelsVerboseOutput(modelsResult.stdout)
          : { models: [], modelMetadata: [] }
    let models = verboseModels.models
    let modelMetadata = verboseModels.modelMetadata
    let finalModelsResult = modelsResult
    if (mode === 'full' && models.length === 0) {
      const fallbackModelsResult = await this.execOpenCode(binaryPath, ['models'], profile)
      finalModelsResult = fallbackModelsResult
      models = fallbackModelsResult.code === 0
        ? parseOpenCodeModelsOutput(fallbackModelsResult.stdout)
        : []
      modelMetadata = []
    }
    const agents = agentsResult.code === 0 ? parseOpenCodeAgentListOutput(agentsResult.stdout) : []

    const availableProviders = Array.from(
      new Set([
        ...connectedProviders.map(provider => provider.id),
        ...models.map(model => parseOpenCodeProviderScopedModelRef(model)?.providerId).filter(Boolean),
      ]),
    ).sort()

    const diagnostics: string[] = []
    if (profile.authState === 'stale') {
      diagnostics.push('Managed OpenCode auth differs from the source auth store')
    }
    if (providersResult.code !== 0) {
      diagnostics.push(this.getCommandFailureMessage(
        providersResult,
        'Failed to query OpenCode providers',
      ))
    }
    if (finalModelsResult.code !== 0) {
      diagnostics.push(this.getCommandFailureMessage(
        finalModelsResult,
        'Failed to query OpenCode models',
      ))
    }
    if (mode === 'full' && agentsResult.code !== 0) {
      diagnostics.push(this.getCommandFailureMessage(
        agentsResult,
        'Failed to query OpenCode agents',
      ))
    }

    const snapshot: OpenCodeInventorySnapshot = {
      detected: true,
      binaryPath,
      version,
      projectPath: resolvedProjectPath,
      profile,
      connectedProviders,
      availableProviders,
      models,
      modelMetadata,
      agents,
      authStorePath: providerParse.authStorePath ?? profile.managedAuthPath,
      probeError: diagnostics.length > 0 ? diagnostics[0] ?? 'OpenCode probe failed' : null,
      diagnostics,
    }

    if (cacheEnabled) {
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + OPEN_CODE_CACHE_TTL_MS,
        snapshot,
      })
    }

    return snapshot
  }
}

export const openCodeInventoryService = new OpenCodeInventoryService()
