import path from 'node:path'
import stripAnsi from 'strip-ansi'

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getCwd } from '../../utils/cwd.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'

import type {
  OpenCodeAgentMode,
  OpenCodeAgentSummary,
  OpenCodeConnectedProvider,
  OpenCodeInventorySnapshot,
  OpenCodePreparedProfile,
} from './types.js'

const OPEN_CODE_PROBE_TIMEOUT_MS = 10_000
const OPEN_CODE_CACHE_TTL_MS = 10_000

type CacheEntry = {
  expiresAt: number
  snapshot: OpenCodeInventorySnapshot
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}

function getTrimmedNonEmptyLines(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(Boolean)
}

export function parseOpenCodeModelsOutput(output: string): string[] {
  return getTrimmedNonEmptyLines(output).filter(line =>
    /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/i.test(line),
  )
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
    const match = /^(?<provider>[A-Za-z0-9 _-]+?)(?:\s+(?<authHint>[A-Z0-9_:-]+|oauth))?$/.exec(
      rawEntry,
    )
    if (!match?.groups?.provider) {
      continue
    }

    connectedProviders.push({
      id: normalizeProviderId(match.groups.provider),
      authHint: match.groups.authHint?.trim().toLowerCase() ?? null,
      source: currentSource,
    })
  }

  return {
    authStorePath,
    connectedProviders,
  }
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

  async probe(projectPath?: string | null): Promise<OpenCodeInventorySnapshot> {
    const resolvedProjectPath = path.resolve(projectPath?.trim() || getCwd())
    const cacheKey = resolvedProjectPath
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot
    }

    const binaryPath = Bun.which('opencode')
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
        agents: [],
        authStorePath: null,
        probeError: null,
        diagnostics: ['OpenCode CLI not detected on PATH'],
      }
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + OPEN_CODE_CACHE_TTL_MS,
        snapshot: missingSnapshot,
      })
      return missingSnapshot
    }

    const profile = await openCodeProfileManager.prepareProfile(resolvedProjectPath)
    const [versionResult, providersResult, modelsResult, agentsResult] = await Promise.all([
      this.execOpenCode(binaryPath, ['--version'], profile),
      this.execOpenCode(binaryPath, ['providers', 'list'], profile),
      this.execOpenCode(binaryPath, ['models'], profile),
      this.execOpenCode(binaryPath, ['agent', 'list'], profile),
    ])

    const version = versionResult.code === 0 ? versionResult.stdout.trim() || null : null
    const providerParse = parseOpenCodeProvidersOutput(providersResult.stdout)
    const models = modelsResult.code === 0 ? parseOpenCodeModelsOutput(modelsResult.stdout) : []
    const agents = agentsResult.code === 0 ? parseOpenCodeAgentListOutput(agentsResult.stdout) : []

    const availableProviders = Array.from(
      new Set([
        ...providerParse.connectedProviders.map(provider => provider.id),
        ...models.map(model => model.split('/')[0]?.trim().toLowerCase()).filter(Boolean),
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
    if (modelsResult.code !== 0) {
      diagnostics.push(this.getCommandFailureMessage(
        modelsResult,
        'Failed to query OpenCode models',
      ))
    }
    if (agentsResult.code !== 0) {
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
      connectedProviders: providerParse.connectedProviders,
      availableProviders,
      models,
      agents,
      authStorePath: providerParse.authStorePath ?? profile.managedAuthPath,
      probeError: diagnostics.length > 0 ? diagnostics[0] ?? 'OpenCode probe failed' : null,
      diagnostics,
    }

    this.cache.set(cacheKey, {
      expiresAt: Date.now() + OPEN_CODE_CACHE_TTL_MS,
      snapshot,
    })

    return snapshot
  }
}

export const openCodeInventoryService = new OpenCodeInventoryService()
