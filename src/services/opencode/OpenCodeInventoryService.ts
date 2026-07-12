import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import stripAnsi from 'strip-ansi'

import { getCwd } from '../../utils/cwd.js'
import * as lockfile from '../../utils/lockfile.js'
import { killProcessTreeAndWait } from '../../utils/processKill.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import {
  normalizeOpenCodeProviderId,
  parseFirstOpenCodeModelToken,
  parseOpenCodeProviderScopedModelRef,
} from './OpenCodeModelRef.js'
import { readOpenCodeAuthProviderSummaries } from './OpenCodeAuthStore.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import {
  getOpenCodeManagedSubscriptionPluginPackages,
  isOpenCodeCuratedSubscriptionProviderId,
} from './OpenCodeCuratedSubscriptionCatalog.js'
import {
  areOpenCodeManagedPluginCachesReady,
  openCodeProfileManager,
  repairEmptyOpenCodeManagedPluginCaches,
} from './OpenCodeProfileManager.js'

import type {
  OpenCodeAgentMode,
  OpenCodeAgentSummary,
  OpenCodeConnectedProvider,
  OpenCodeInventorySnapshot,
  OpenCodeModelMetadata,
  OpenCodePreparedProfile,
  OpenCodeToolApprovalMode,
} from './types.js'

export const OPEN_CODE_PROBE_TIMEOUT_MS = 10_000
export const OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS = 8_000
export const OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS = OPEN_CODE_PROBE_TIMEOUT_MS * 6
const OPEN_CODE_CACHE_TTL_MS = 10_000
const OPEN_CODE_INVENTORY_TIMEOUT_MESSAGE_PREFIX = 'OpenCode inventory probe timed out'
const OPEN_CODE_MANAGED_PLUGIN_FIRST_LOAD_TIMEOUT_MS = 45_000
const OPEN_CODE_MANAGED_PLUGIN_INSTALL_LOCK_OPTIONS = {
  stale: 30_000,
  update: 5_000,
  retries: {
    retries: 120,
    minTimeout: 50,
    maxTimeout: 250,
  },
}

type OpenCodeInventoryProbeMode = 'full' | 'summary' | 'profile'

type OpenCodeInventoryProbeOptions = {
  bypassCache?: boolean
  mode?: OpenCodeInventoryProbeMode
  includeAppMcp?: boolean
  toolApprovalMode?: OpenCodeToolApprovalMode
  abortSignal?: AbortSignal
  progress?: OpenCodeInventoryProbeProgressTracker
}

export type OpenCodeCommandResult = {
  stdout: string
  stderr: string
  code: number
  error?: string
}

export type OpenCodeInventoryProbeProgressSnapshot = {
  elapsedMs: number
  currentStep: string | null
  currentStepElapsedMs: number | null
  completedSteps: Array<{
    label: string
    durationMs: number
  }>
}

export type OpenCodeInventoryProbeProgressTracker = {
  enterStep(label: string): () => void
  snapshot(): OpenCodeInventoryProbeProgressSnapshot
}

export function createOpenCodeInventoryProbeProgressTracker(
  now: () => number = () => Date.now(),
): OpenCodeInventoryProbeProgressTracker {
  const startedAtMs = now()
  const completedSteps: OpenCodeInventoryProbeProgressSnapshot['completedSteps'] = []
  let currentStep: { label: string; startedAtMs: number } | null = null

  return {
    enterStep(label: string): () => void {
      const step = { label, startedAtMs: now() }
      currentStep = step
      let active = true
      return () => {
        if (!active || currentStep !== step) {
          return
        }
        active = false
        completedSteps.push({
          label,
          durationMs: Math.max(0, now() - step.startedAtMs),
        })
        currentStep = null
      }
    },
    snapshot(): OpenCodeInventoryProbeProgressSnapshot {
      const elapsedMs = Math.max(0, now() - startedAtMs)
      return {
        elapsedMs,
        currentStep: currentStep?.label ?? null,
        currentStepElapsedMs: currentStep ? Math.max(0, now() - currentStep.startedAtMs) : null,
        completedSteps: completedSteps.slice(-6),
      }
    },
  }
}

type OpenCodeInventoryCommandResults = {
  versionResult: OpenCodeCommandResult
  providersResult: OpenCodeCommandResult
  modelsResult: OpenCodeCommandResult
  agentsResult: OpenCodeCommandResult
}

type CacheEntry = {
  expiresAt: number
  snapshot: OpenCodeInventorySnapshot
}

function normalizeProviderId(value: string): string {
  return (
    normalizeOpenCodeProviderId(value.replace(/\s+/g, '-')) ??
    value.trim().toLowerCase().replace(/\s+/g, '-')
  )
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
    lowerLastToken === 'api' ||
    lowerLastToken === 'oauth' ||
    (/^[A-Z0-9_:-]+$/.test(lastToken) && (lastToken.includes('_') || lastToken.includes(':')))

  if (!isAuthHint || parts.length === 1) {
    return { provider: trimmed, authHint: null }
  }

  return {
    provider: parts.slice(0, -1).join(' '),
    authHint: lowerLastToken,
  }
}

export function parseOpenCodeModelsOutput(output: string): string[] {
  return Array.from(
    new Set(
      getTrimmedNonEmptyLines(output)
        .map(line => parseFirstOpenCodeModelToken(line)?.raw)
        .filter((model): model is string => Boolean(model)),
    ),
  )
}

export function getOpenCodeVerboseModelsArgs(): string[] {
  return ['models', '--verbose']
}

const EMPTY_OPEN_CODE_COMMAND_RESULT: OpenCodeCommandResult = {
  stdout: '',
  stderr: '',
  code: 0,
}

function stripOneFinalNewline(value: string): string {
  return value.replace(/\r?\n$/, '')
}

export function execOpenCodePortableCommand(input: {
  binaryPath: string
  args: string[]
  profile: OpenCodePreparedProfile
  abortSignal?: AbortSignal
  timeoutMs?: number
}): Promise<OpenCodeCommandResult> {
  return new Promise(resolve => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let stopping = false
    let child: ReturnType<typeof spawnPortableCli> | null = null
    const timeoutMs = input.timeoutMs ?? OPEN_CODE_PROBE_TIMEOUT_MS

    const finish = (result: OpenCodeCommandResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      input.abortSignal?.removeEventListener('abort', abort)
      resolve({
        ...result,
        stdout: stripOneFinalNewline(result.stdout),
        stderr: stripOneFinalNewline(result.stderr),
      })
    }

    const stopChildAndFinish = (error: string): void => {
      if (settled || stopping) {
        return
      }
      stopping = true
      clearTimeout(timeout)
      input.abortSignal?.removeEventListener('abort', abort)

      const pid = child?.pid
      if (!pid) {
        finish({
          ...snapshotOutput(),
          code: 1,
          error,
        })
        return
      }

      void killProcessTreeAndWait(pid, 'SIGKILL').finally(() => {
        finish({
          ...snapshotOutput(),
          code: 1,
          error,
        })
      })
    }

    const snapshotOutput = (): Pick<OpenCodeCommandResult, 'stdout' | 'stderr'> => ({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    })

    const abort = (): void => {
      stopChildAndFinish('OpenCode command aborted')
    }

    const timeout = setTimeout(() => {
      stopChildAndFinish(`OpenCode command timed out after ${timeoutMs}ms`)
    }, timeoutMs)

    if (input.abortSignal?.aborted) {
      abort()
      return
    }
    input.abortSignal?.addEventListener('abort', abort, { once: true })

    try {
      child = spawnPortableCli(input.binaryPath, input.args, {
        cwd: input.profile.projectPath,
        env: input.profile.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({
        ...snapshotOutput(),
        code: 1,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('error', error => {
      if (stopping) {
        return
      }
      finish({
        ...snapshotOutput(),
        code: 1,
        error: error.message,
      })
    })
    child.once('close', (code, signal) => {
      if (stopping) {
        return
      }
      finish({
        ...snapshotOutput(),
        code: code ?? 1,
        ...(signal ? { error: signal } : {}),
      })
    })
  })
}

export async function collectOpenCodeInventoryCommandResults(input: {
  mode: OpenCodeInventoryProbeMode
  execOpenCode: (args: string[]) => Promise<OpenCodeCommandResult>
  modelsResult?: OpenCodeCommandResult
}): Promise<OpenCodeInventoryCommandResults> {
  const versionResult =
    input.mode === 'profile'
      ? EMPTY_OPEN_CODE_COMMAND_RESULT
      : await input.execOpenCode(['--version'])
  const providersResult =
    input.mode === 'profile'
      ? EMPTY_OPEN_CODE_COMMAND_RESULT
      : await input.execOpenCode(['providers', 'list'])
  const modelsResult =
    input.mode !== 'full'
      ? EMPTY_OPEN_CODE_COMMAND_RESULT
      : input.modelsResult ?? await input.execOpenCode(getOpenCodeVerboseModelsArgs())
  const agentsResult =
    input.mode !== 'full'
      ? EMPTY_OPEN_CODE_COMMAND_RESULT
      : await input.execOpenCode(['agent', 'list'])

  return {
    versionResult,
    providersResult,
    modelsResult,
    agentsResult,
  }
}

async function withManagedPluginInstallLock<T>(
  profile: OpenCodePreparedProfile,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(
    profile.xdgCacheHome,
    'opencode',
    'managed-subscription-plugin-install.lock',
  )
  await mkdir(path.dirname(lockPath), { recursive: true })
  await writeFile(lockPath, '', { flag: 'a' })

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(lockPath, OPEN_CODE_MANAGED_PLUGIN_INSTALL_LOCK_OPTIONS)
    await repairEmptyOpenCodeManagedPluginCaches(profile.xdgCacheHome)
    return await callback()
  } finally {
    if (release) {
      await release()
    }
  }
}

function profileUsesManagedSubscriptionPlugins(profile: OpenCodePreparedProfile): boolean {
  const configuredPlugins = Array.isArray(profile.managedConfig.plugin)
    ? profile.managedConfig.plugin.filter((value): value is string => typeof value === 'string')
    : []
  const managedPlugins = new Set(getOpenCodeManagedSubscriptionPluginPackages())
  return configuredPlugins.some(plugin => managedPlugins.has(plugin))
}

export async function prewarmOpenCodeManagedSubscriptionPlugins(input: {
  binaryPath: string
  profile: OpenCodePreparedProfile
  abortSignal?: AbortSignal
  progress?: OpenCodeInventoryProbeProgressTracker
}): Promise<OpenCodeCommandResult | undefined> {
  if (!profileUsesManagedSubscriptionPlugins(input.profile)) {
    return undefined
  }
  return withManagedPluginInstallLock(input.profile, async () => {
    if (await areOpenCodeManagedPluginCachesReady(input.profile.xdgCacheHome)) {
      return undefined
    }
    const leaveStep = input.progress?.enterStep('install managed OpenCode provider plugins')
    try {
      return await execOpenCodePortableCommand({
        binaryPath: input.binaryPath,
        args: getOpenCodeVerboseModelsArgs(),
        profile: input.profile,
        abortSignal: input.abortSignal,
        timeoutMs: OPEN_CODE_MANAGED_PLUGIN_FIRST_LOAD_TIMEOUT_MS,
      })
    } finally {
      leaveStep?.()
    }
  })
}

export function isOpenCodeInventoryTimeoutMessage(message: string | null | undefined): boolean {
  return message?.startsWith(OPEN_CODE_INVENTORY_TIMEOUT_MESSAGE_PREFIX) === true
}

export function isOpenCodeInventoryTimeoutSnapshot(snapshot: OpenCodeInventorySnapshot): boolean {
  return isOpenCodeInventoryTimeoutMessage(snapshot.probeError)
}

export function buildOpenCodeInventoryTimeoutSnapshot(input: {
  projectPath?: string | null
  timeoutMs: number
  progress?: OpenCodeInventoryProbeProgressSnapshot | null
}): OpenCodeInventorySnapshot {
  const resolvedProjectPath = path.resolve(input.projectPath?.trim() || getCwd())
  const binaryPath = resolveOpenCodeBinaryPath()
  const currentStep = input.progress?.currentStep?.trim() || null
  const message = currentStep
    ? `${OPEN_CODE_INVENTORY_TIMEOUT_MESSAGE_PREFIX} after ${input.timeoutMs}ms during ${currentStep}`
    : `${OPEN_CODE_INVENTORY_TIMEOUT_MESSAGE_PREFIX} after ${input.timeoutMs}ms`
  const diagnostics = [message]
  if (input.progress) {
    diagnostics.push(
      currentStep && input.progress.currentStepElapsedMs !== null
        ? `Current OpenCode inventory step: ${currentStep} has been running for ${input.progress.currentStepElapsedMs}ms.`
        : 'No OpenCode inventory step was active when the timeout fired.',
    )
    diagnostics.push(
      input.progress.completedSteps.length > 0
        ? `Completed OpenCode inventory steps before timeout: ${input.progress.completedSteps
            .map(step => `${step.label} (${step.durationMs}ms)`)
            .join(', ')}.`
        : 'No OpenCode inventory step completed before timeout.',
    )
  }
  diagnostics.push(
    'Agent Teams runtime stayed alive, but OpenCode did not finish inventory probing before the UI timeout budget.',
  )
  diagnostics.push(
    'Common causes: slow or hung OpenCode CLI startup, provider catalog/model listing, project OpenCode plugins, corrupted OpenCode cache/profile, or Windows security software delaying child processes.',
  )

  return {
    detected: Boolean(binaryPath),
    binaryPath,
    version: null,
    projectPath: resolvedProjectPath,
    profile: null,
    connectedProviders: [],
    availableProviders: [],
    models: [],
    modelMetadata: [],
    agents: [],
    authStorePath: null,
    probeError: message,
    diagnostics,
  }
}

export async function withOpenCodeInventoryProbeTimeout(
  probe: Promise<OpenCodeInventorySnapshot>,
  input: {
    projectPath?: string | null
    timeoutMs: number
    progress?: OpenCodeInventoryProbeProgressTracker | null
    onTimeout?: () => void
  },
): Promise<OpenCodeInventorySnapshot> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      probe,
      new Promise<OpenCodeInventorySnapshot>(resolve => {
        timeout = setTimeout(() => {
          input.onTimeout?.()
          resolve(
            buildOpenCodeInventoryTimeoutSnapshot({
              projectPath: input.projectPath,
              timeoutMs: input.timeoutMs,
              progress: input.progress?.snapshot() ?? null,
            }),
          )
        }, input.timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
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
  const lines = stripAnsi(output)
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(Boolean)
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
        free: isFreeCost(raw.cost),
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
  const providerId = normalizedModelId.split('/', 1)[0] ?? ''
  // Subscription catalogs often publish zero monetary cost because usage is
  // deducted from a purchased plan quota. That is not a free model and must
  // not be advertised as usable without connecting the subscription.
  if (isOpenCodeCuratedSubscriptionProviderId(providerId)) {
    return false
  }
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
    normalizedModelId &&
    isOpenCodeBuiltinProviderModelId(normalizedModelId) &&
    isOpenCodeModelFree(normalizedModelId, modelMetadata),
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
    const credentialScopes =
      provider.source === 'credentials'
        ? Array.from(
            new Set([...(existing?.credentialScopes ?? []), ...(provider.credentialScopes ?? [])]),
          )
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

  clearCache(): void {
    this.cache.clear()
  }

  private getCommandFailureMessage(
    result: {
      stderr: string
      error?: string
    },
    fallback: string,
  ): string {
    return result.error ?? (result.stderr.trim() || fallback)
  }

  private async execOpenCode(
    binaryPath: string,
    args: string[],
    profile: OpenCodePreparedProfile,
    options: {
      abortSignal?: AbortSignal
      progress?: OpenCodeInventoryProbeProgressTracker
      timeoutMs?: number
    } = {},
  ): Promise<OpenCodeCommandResult> {
    const leaveStep = options.progress?.enterStep(`opencode ${args.join(' ')}`)
    try {
      return await execOpenCodePortableCommand({
        binaryPath,
        args,
        profile,
        abortSignal: options.abortSignal,
        timeoutMs: options.timeoutMs ?? OPEN_CODE_PROBE_TIMEOUT_MS,
      })
    } finally {
      leaveStep?.()
    }
  }

  async probe(
    projectPath?: string | null,
    options: OpenCodeInventoryProbeOptions = {},
  ): Promise<OpenCodeInventorySnapshot> {
    const mode = options.mode ?? 'full'
    const resolvedProjectPath = path.resolve(projectPath?.trim() || getCwd())
    const toolApprovalMode = options.toolApprovalMode ?? 'auto'
    const cacheKey = `${resolvedProjectPath}\0${mode}\0${options.includeAppMcp === false ? 'without-app-mcp' : 'with-app-mcp'}\0${toolApprovalMode}`
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

    const leaveProfileStep = options.progress?.enterStep('prepare managed OpenCode profile')
    const profile = await openCodeProfileManager
      .prepareProfile(resolvedProjectPath, {
        includeAppMcp: options.includeAppMcp !== false,
        includeManagedSubscriptionPlugins: mode !== 'summary',
        toolApprovalMode,
      })
      .finally(() => {
        leaveProfileStep?.()
      })
    const prewarmedModelsResult =
      mode === 'full'
        ? await prewarmOpenCodeManagedSubscriptionPlugins({
            binaryPath,
            profile,
            abortSignal: options.abortSignal,
            progress: options.progress,
          })
        : undefined
    const collectCommandResults = () =>
      collectOpenCodeInventoryCommandResults({
        mode,
        modelsResult: prewarmedModelsResult,
        execOpenCode: args =>
          this.execOpenCode(binaryPath, args, profile, {
            abortSignal: options.abortSignal,
            progress: options.progress,
          }),
      })
    const { versionResult, providersResult, modelsResult, agentsResult } =
      await collectCommandResults()

    const version = versionResult.code === 0 ? versionResult.stdout.trim() || null : null
    const providerParse = parseOpenCodeProvidersOutput(providersResult.stdout)
    const globalAuthProviderIds = new Set(
      (profile.globalAuthPath
        ? await readOpenCodeAuthProviderSummaries(profile.globalAuthPath, ['managed']).catch(
            () => [],
          )
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
      mode !== 'full'
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
      const fallbackModelsResult = await this.execOpenCode(binaryPath, ['models'], profile, {
        abortSignal: options.abortSignal,
        progress: options.progress,
      })
      finalModelsResult = fallbackModelsResult
      models =
        fallbackModelsResult.code === 0
          ? parseOpenCodeModelsOutput(fallbackModelsResult.stdout)
          : []
      modelMetadata = []
    }
    const agents = agentsResult.code === 0 ? parseOpenCodeAgentListOutput(agentsResult.stdout) : []

    const availableProviders = Array.from(
      new Set([
        ...connectedProviders.map(provider => provider.id),
        ...models
          .map(model => parseOpenCodeProviderScopedModelRef(model)?.providerId)
          .filter(Boolean),
      ]),
    ).sort()

    const diagnostics: string[] = []
    if (profile.authState === 'stale') {
      diagnostics.push('Managed OpenCode auth differs from the source auth store')
    }
    if (providersResult.code !== 0) {
      diagnostics.push(
        this.getCommandFailureMessage(providersResult, 'Failed to query OpenCode providers'),
      )
    }
    if (finalModelsResult.code !== 0) {
      diagnostics.push(
        this.getCommandFailureMessage(finalModelsResult, 'Failed to query OpenCode models'),
      )
    }
    if (mode === 'full' && agentsResult.code !== 0) {
      diagnostics.push(
        this.getCommandFailureMessage(agentsResult, 'Failed to query OpenCode agents'),
      )
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
      probeError: diagnostics.length > 0 ? (diagnostics[0] ?? 'OpenCode probe failed') : null,
      diagnostics,
    }

    if (cacheEnabled && !options.abortSignal?.aborted) {
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + OPEN_CODE_CACHE_TTL_MS,
        snapshot,
      })
    }

    return snapshot
  }
}

export const openCodeInventoryService = new OpenCodeInventoryService()
