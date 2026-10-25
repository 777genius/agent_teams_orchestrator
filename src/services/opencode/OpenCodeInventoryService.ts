import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import stripAnsi from 'strip-ansi'

import { getCwd } from '../../utils/cwd.js'
import * as lockfile from '../../utils/lockfile.js'
import { killProcessTreeAndWait } from '../../utils/processKill.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import { gte } from '../../utils/semver.js'
import {
  parseFirstOpenCodeModelToken,
  parseOpenCodeProviderScopedModelRef,
} from './OpenCodeModelRef.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import { readOpenCodeAuthProviderSummaries } from './OpenCodeAuthStore.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { inspectOpenCodeReadSelection } from './compatibility/OpenCodeNativeIdentity.js'
import { probeOpenCodeV2Inventory } from './catalog/OpenCodeV2InventoryService.js'
import { openCodeV2KeyIntegrations, readOpenCodeV2ConnectedProviders } from './catalog/OpenCodeV2KeyIntegrations.js'
import {
  getOpenCodeManagedSubscriptionPluginPackages,
  isOpenCodeCuratedSubscriptionProviderId,
} from './OpenCodeCuratedSubscriptionCatalog.js'
import {
  areOpenCodeManagedPluginCachesReady,
  canonicalizeOpenCodeProjectPath,
  openCodeProfileManager,
  repairEmptyOpenCodeManagedPluginCaches,
} from './OpenCodeProfileManager.js'
import {
  raceOpenCodeAbortSignal,
  throwOpenCodeAbortReason,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'

import type {
  OpenCodeAgentMode,
  OpenCodeAgentSummary,
  OpenCodeConnectedProvider,
  OpenCodeInventorySnapshot,
  OpenCodeModelMetadata,
  OpenCodePreparedProfile,
  OpenCodeProfileScope,
  OpenCodeToolApprovalMode,
} from './types.js'

export const OPEN_CODE_SUPERGROK_OAUTH_MIN_VERSION = '1.15.7'

export function supportsOpenCodeSuperGrokOAuth(version: string | null | undefined): boolean {
  const normalizedVersion = version?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
  if (!normalizedVersion) {
    return false
  }
  try {
    return gte(normalizedVersion, OPEN_CODE_SUPERGROK_OAUTH_MIN_VERSION)
  } catch {
    return false
  }
}

export function filterOpenCodeConnectedProvidersForRuntime(input: {
  providers: readonly OpenCodeConnectedProvider[]
  version: string | null
}): {
  connectedProviders: OpenCodeConnectedProvider[]
  unsupportedSuperGrokOAuth: boolean
} {
  const versionKnown = Boolean(input.version?.match(/\d+\.\d+\.\d+/))
  const unsupportedSuperGrokOAuth = versionKnown && input.providers.some(
    provider =>
      provider.id === 'xai'
      && provider.authHint === 'oauth'
      && !supportsOpenCodeSuperGrokOAuth(input.version),
  )
  return {
    connectedProviders: unsupportedSuperGrokOAuth
      ? input.providers.filter(
          provider => !(provider.id === 'xai' && provider.authHint === 'oauth'),
        )
      : [...input.providers],
    unsupportedSuperGrokOAuth,
  }
}

export const OPEN_CODE_PROBE_TIMEOUT_MS = 10_000
// Summary still prepares the profile and runs sequential version/auth probes.
// Allow profile I/O plus both per-command budgets without starting a model host.
export const OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS = OPEN_CODE_PROBE_TIMEOUT_MS * 3
export const OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS = OPEN_CODE_PROBE_TIMEOUT_MS * 6
export const OPEN_CODE_MODEL_LIST_TIMEOUT_MS = 30_000
const OPEN_CODE_MODEL_REFRESH_OUTPUT_PROVIDER = 'opencode'
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
const OPEN_CODE_INVENTORY_COMMAND_LOCK_OPTIONS = {
  stale: OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS * 2,
  update: 5_000,
  realpath: false,
  retries: {
    retries: 240,
    minTimeout: 25,
    maxTimeout: 250,
  },
}

type OpenCodeProperLockOptions = NonNullable<Parameters<typeof lockfile.lock>[1]>

async function acquireOpenCodeLock(
  lockPath: string,
  options: OpenCodeProperLockOptions,
  abortSignal?: AbortSignal,
): Promise<() => Promise<void>> {
  if (!abortSignal) {
    return lockfile.lock(lockPath, options)
  }

  for (;;) {
    if (abortSignal.aborted) throwOpenCodeAbortReason(abortSignal)
    try {
      return await lockfile.lock(lockPath, {
        ...options,
        retries: 0,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') {
        throw error
      }
    }
    await waitForOpenCodeAbortableDelay(50, abortSignal)
  }
}

type OpenCodeInventoryProbeMode = 'full' | 'summary' | 'profile' | 'passive'

type OpenCodeInventoryProbeOptions = {
  onV2ReadStarted?: () => void
  onReadAcquisitionStarted?: () => void
  onReadAcquisitionSettled?: () => void
  remainingMs?: () => number
  bypassCache?: boolean
  mode?: OpenCodeInventoryProbeMode
  v1SettingsOnly?: boolean
  refreshModels?: boolean
  includeAppMcp?: boolean
  toolApprovalMode?: OpenCodeToolApprovalMode
  abortSignal?: AbortSignal
  progress?: OpenCodeInventoryProbeProgressTracker
  profileScope?: OpenCodeProfileScope
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
  now: () => number = () => performance.now(),
): OpenCodeInventoryProbeProgressTracker {
  const startedAtMs = now()
  const completedSteps: OpenCodeInventoryProbeProgressSnapshot['completedSteps'] = []
  let currentStep: { label: string; startedAtMs: number } | null = null

  return {
    enterStep(label: string): () => void {
      if (currentStep) {
        completedSteps.push({
          label: currentStep.label,
          durationMs: Math.max(0, now() - currentStep.startedAtMs),
        })
      }
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
  return canonicalizeOpenCodeProviderId(value)
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

export function getOpenCodeRefreshModelsArgs(): string[] {
  // OpenCode refreshes the shared Models.dev cache before applying the optional
  // provider filter. Filtering stdout keeps an explicit UI refresh fast and
  // bounded instead of serializing every model from every provider.
  return ['models', OPEN_CODE_MODEL_REFRESH_OUTPUT_PROVIDER, '--refresh']
}

export function getOpenCodeInventoryCommandTimeoutMs(args: readonly string[]): number {
  return args[0] === 'models'
    ? OPEN_CODE_MODEL_LIST_TIMEOUT_MS
    : OPEN_CODE_PROBE_TIMEOUT_MS
}

function getOpenCodeCatalogRefreshProfile(
  profile: OpenCodePreparedProfile,
): OpenCodePreparedProfile {
  return {
    ...profile,
    env: {
      ...profile.env,
      // Catalog refresh only needs OpenCode core and the shared XDG cache. Do
      // not start every configured provider plugin just to update Models.dev.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false,
        plugin: [],
        mcp: {},
      }),
    },
  }
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
  progress?: OpenCodeInventoryProbeProgressTracker
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

      const leaveCleanup = input.progress?.enterStep('clean up OpenCode inventory command')
      void killProcessTreeAndWait(pid, 'SIGKILL').finally(() => {
        leaveCleanup?.()
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
  verifiedVersion?: string
  execOpenCode: (args: string[]) => Promise<OpenCodeCommandResult>
  modelsResult?: OpenCodeCommandResult
  refreshModels?: boolean
}): Promise<OpenCodeInventoryCommandResults> {
  const versionResult =
    input.mode === 'profile' || input.refreshModels
      ? input.mode === 'profile' && input.verifiedVersion
        ? { ...EMPTY_OPEN_CODE_COMMAND_RESULT, stdout: input.verifiedVersion }
        : EMPTY_OPEN_CODE_COMMAND_RESULT
      : await input.execOpenCode(['--version'])
  const providersResult =
    input.mode === 'profile'
      ? EMPTY_OPEN_CODE_COMMAND_RESULT
      : await input.execOpenCode(['providers', 'list'])
  const modelsResult =
    input.mode !== 'full'
      ? EMPTY_OPEN_CODE_COMMAND_RESULT
      : input.refreshModels
        ? await input.execOpenCode(getOpenCodeRefreshModelsArgs())
        : input.modelsResult ?? await input.execOpenCode(getOpenCodeVerboseModelsArgs())
  const agentsResult =
    input.mode !== 'full' || input.refreshModels
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
  abortSignal?: AbortSignal,
  progress?: OpenCodeInventoryProbeProgressTracker,
): Promise<T> {
  const leaveLock = progress?.enterStep('wait for managed OpenCode plugin install lock')
  const lockPath = path.join(
    profile.xdgCacheHome,
    'opencode',
    'managed-subscription-plugin-install.lock',
  )
  await mkdir(path.dirname(lockPath), { recursive: true })
  await writeFile(lockPath, '', { flag: 'a' })

  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireOpenCodeLock(
      lockPath,
      OPEN_CODE_MANAGED_PLUGIN_INSTALL_LOCK_OPTIONS,
      abortSignal,
    ).finally(() => leaveLock?.())
    if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
    await repairEmptyOpenCodeManagedPluginCaches(profile.xdgCacheHome)
    return await callback()
  } finally {
    if (release) {
      await release()
    }
  }
}

async function withOpenCodeInventoryCommandLock<T>(
  profile: OpenCodePreparedProfile,
  callback: () => Promise<T>,
  abortSignal?: AbortSignal,
  progress?: OpenCodeInventoryProbeProgressTracker,
): Promise<T> {
  const leaveLock = progress?.enterStep('wait for OpenCode inventory command lock')
  const lockPath = path.join(profile.profileRootPath, 'inventory-command.lock')
  await mkdir(path.dirname(lockPath), { recursive: true })
  await writeFile(lockPath, '', { flag: 'a' })

  const release = await acquireOpenCodeLock(
    lockPath,
    OPEN_CODE_INVENTORY_COMMAND_LOCK_OPTIONS,
    abortSignal,
  ).finally(() => leaveLock?.())
  try {
    if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
    return await callback()
  } finally {
    await release()
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
        progress: input.progress,
      })
    } finally {
      leaveStep?.()
    }
  }, input.abortSignal, input.progress)
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
    probeError: diagnostics.slice(0, input.progress ? 3 : 1).join(' '),
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
      const rawStatus = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : ''
      const catalogStatus =
        raw.deprecated === true || rawStatus === 'deprecated'
          ? 'deprecated'
          : rawStatus === 'alpha'
            ? 'alpha'
            : rawStatus === 'beta'
              ? 'beta'
              : 'active'
      modelMetadata.push({
        id: modelRef.raw,
        cost: raw.cost ?? null,
        context: getModelContextLimit(limits),
        limits,
        free: isFreeCost(raw.cost),
        catalogStatus,
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

export function deriveOpenCodeProfileConnectedProviders(input: {
  profileScope?: OpenCodeProfileScope
  profile: OpenCodePreparedProfile
  settingsOnly?: boolean
  readAuthProviderSummaries?: typeof readOpenCodeAuthProviderSummaries
}): { providers: OpenCodeConnectedProvider[]; profileScopeError: boolean } {
  const requestedScope = input.profileScope
  const preparedScope = input.profile.profileScope
  // Unscoped settings obtains auth and connections from the managed HTTP host.
  if (input.settingsOnly && !requestedScope && !preparedScope) {
    return { providers: [], profileScopeError: false }
  }
  const sourceIdentity = input.profile.selectedSourceAuthIdentity
  const managedIdentity = input.profile.selectedManagedAuthIdentity
  const valid = Boolean(
    requestedScope
    && preparedScope
    && JSON.stringify(preparedScope) === JSON.stringify(requestedScope)
    && input.profile.scopeToken === requestedScope.scopeToken
    && sourceIdentity !== undefined
    && sourceIdentity !== 'error'
    && managedIdentity !== undefined
    && managedIdentity !== 'error'
    && sourceIdentity === managedIdentity
    && sourceIdentity === requestedScope.selectedAuthIdentity,
  )
  return {
    providers: valid && sourceIdentity !== 'absent'
      ? [{ id: requestedScope!.providerId, authHint: null, source: 'credentials' }]
      : [],
    profileScopeError: !valid,
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
    const detail = result.error ?? result.stderr.trim()
    return detail ? `${fallback}: ${detail}` : fallback
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
        timeoutMs: options.timeoutMs ?? getOpenCodeInventoryCommandTimeoutMs(args),
        progress: options.progress,
      })
    } finally {
      leaveStep?.()
    }
  }

  async probe(
    projectPath?: string | null,
    options: OpenCodeInventoryProbeOptions = {},
  ): Promise<OpenCodeInventorySnapshot> {
    let mode = options.mode ?? 'full'
    if (mode === 'passive') {
      const binaryPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH?.trim() || process.env.OPENCODE_BIN_PATH?.trim() || null
      return { detected: Boolean(binaryPath), binaryPath, version: null, projectPath: path.resolve(projectPath?.trim() || getCwd()),
        profile: null, connectedProviders: [], availableProviders: [], models: [], agents: [], authStorePath: null,
        probeError: null, diagnostics: ['Passive metadata only; no authentication or launch proof.'] }
    }
    const resolvedProjectPath = await canonicalizeOpenCodeProjectPath(projectPath)
    // Select generation before V1 profile preparation, plugin prewarming, locks or cache lookup.
    const leaveSelection = options.progress?.enterStep('select OpenCode binary generation')
    let selection: Awaited<ReturnType<typeof inspectOpenCodeReadSelection>>
    try { selection = await inspectOpenCodeReadSelection(options.abortSignal, options.onReadAcquisitionStarted) }
    catch (failure) {
      return {
        detected: false, binaryPath: null, version: null, projectPath: resolvedProjectPath,
        profile: null, connectedProviders: [], availableProviders: [], models: [], agents: [], authStorePath: null,
        probeError: failure instanceof Error && failure.message === 'cleanup_unknown'
          ? 'Selected OpenCode owned acquisition cleanup unknown.'
          : 'Selected OpenCode identity unavailable; choose a verified native binary.',
        diagnostics: ['capabilities_pending'], readGeneration: 'unsupported',
      }
    }
    finally { leaveSelection?.(); options.onReadAcquisitionSettled?.() }
    if (selection.native && mode === 'full') {
      options.onV2ReadStarted?.()
      return probeOpenCodeV2Inventory(selection.native, resolvedProjectPath, { signal: options.abortSignal, remainingMs: options.remainingMs })
    }
    if (selection.path && selection.policy.generation !== 'v1') {
      // Passive V2 reads still list the native key integrations and their completed connections.
      const v2 = selection.policy.generation === 'v2'
      let connectedProviders: OpenCodeInventorySnapshot['connectedProviders'] = []
      if (v2) { try { connectedProviders = await readOpenCodeV2ConnectedProviders(resolvedProjectPath) } catch { /* unknown is not connected */ } }
      return {
        detected: true, binaryPath: selection.path, version: selection.policy.version, projectPath: resolvedProjectPath,
        profile: null, connectedProviders, availableProviders: v2 ? openCodeV2KeyIntegrations().map(entry => entry.providerId) : [],
        models: [], agents: [], authStorePath: null,
        probeError: 'This selected generation requires an explicit qualified V2 full catalog read.',
        diagnostics: ['capabilities_pending'], readGeneration: selection.policy.generation,
      }
    }
    // Preserve the selected V2 full read above; only V1 settings avoids CLI sweeps.
    if (options.v1SettingsOnly && !options.profileScope) mode = 'profile'
    const toolApprovalMode = options.toolApprovalMode ?? 'auto'
    const scopeKey = options.profileScope ? JSON.stringify(options.profileScope) : 'legacy'
    const cacheKey = `${selection.path}\0${selection.fingerprint}\0${selection.policy.version}\0${resolvedProjectPath}\0${mode}\0${options.includeAppMcp === false ? 'without-app-mcp' : 'with-app-mcp'}\0${toolApprovalMode}\0${scopeKey}`
    const cached = this.cache.get(cacheKey)
    const cacheEnabled = mode === 'full' && !options.bypassCache
    if (cacheEnabled && cached && cached.expiresAt > Date.now()) {
      return cached.snapshot
    }

    const binaryPath = selection.path
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

    const profile = await raceOpenCodeAbortSignal(
      openCodeProfileManager.prepareProfile(resolvedProjectPath, {
        abortSignal: options.abortSignal,
        progress: options.progress,
        includeAppMcp: options.includeAppMcp !== false,
        includeManagedSubscriptionPlugins: true,
        toolApprovalMode,
        profileScope: options.profileScope,
      }),
      options.abortSignal,
    )
    return withOpenCodeInventoryCommandLock(profile, () =>
      this.probePreparedProfile({
        mode,
        resolvedProjectPath,
        options,
        cacheKey,
        cacheEnabled,
        binaryPath,
        profile,
        verifiedVersion: options.v1SettingsOnly ? selection.policy.version ?? undefined : undefined,
      }), options.abortSignal, options.progress,
    )
  }

  private async probePreparedProfile(input: {
    mode: OpenCodeInventoryProbeMode
    resolvedProjectPath: string
    options: OpenCodeInventoryProbeOptions
    cacheKey: string
    cacheEnabled: boolean
    binaryPath: string
    profile: OpenCodePreparedProfile
    verifiedVersion?: string
  }): Promise<OpenCodeInventorySnapshot> {
    const {
      mode,
      resolvedProjectPath,
      options,
      cacheKey,
      cacheEnabled,
      binaryPath,
      profile,
    } = input
    const refreshedCached = cacheEnabled ? this.cache.get(cacheKey) : undefined
    if (refreshedCached && refreshedCached.expiresAt > Date.now()) {
      return refreshedCached.snapshot
    }
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
        verifiedVersion: input.verifiedVersion,
        modelsResult: options.refreshModels ? undefined : prewarmedModelsResult,
        refreshModels: options.refreshModels,
        execOpenCode: args =>
          this.execOpenCode(
            binaryPath,
            args,
            options.refreshModels && args[0] === 'models'
              ? getOpenCodeCatalogRefreshProfile(profile)
              : profile,
            {
              abortSignal: options.abortSignal,
              progress: options.progress,
              ...(options.refreshModels && args[0] === 'models'
                ? { timeoutMs: OPEN_CODE_MODEL_LIST_TIMEOUT_MS }
                : {}),
            },
          ),
      })
    const { versionResult, providersResult, modelsResult, agentsResult } =
      await collectCommandResults()

    const version = versionResult.code === 0 ? versionResult.stdout.trim() || null : null
    const providerParse = parseOpenCodeProvidersOutput(providersResult.stdout)
    const globalAuthProviderIds = new Set(
      mode === 'profile' || !profile.globalAuthPath
        ? []
        : (await readOpenCodeAuthProviderSummaries(profile.globalAuthPath, ['managed']).catch(
            () => [],
          )).map(provider => provider.id),
    )
    const sourceAuthProviderIds = new Set(
      mode === 'profile' || !profile.sourceAuthPath
        ? []
        : (await readOpenCodeAuthProviderSummaries(profile.sourceAuthPath, ['local']).catch(
            () => [],
          )).map(provider => provider.id),
    )
    const credentialScopesForProvider = (providerId: string): Array<'managed' | 'local'> => {
      const scopes: Array<'managed' | 'local'> = []
      if (globalAuthProviderIds.has(providerId)) scopes.push('managed')
      if (sourceAuthProviderIds.has(providerId)) scopes.push('local')
      return scopes.length > 0 ? scopes : ['managed']
    }
    const discovered = mode === 'profile'
      ? deriveOpenCodeProfileConnectedProviders({
          profileScope: options.profileScope, profile,
          settingsOnly: options.v1SettingsOnly === true,
        })
      : {
          providers: mergeConnectedProviders([
            ...providerParse.connectedProviders.map(provider => provider.source === 'credentials'
              ? { ...provider, credentialScopes: credentialScopesForProvider(provider.id) }
              : provider),
            ...(await readOpenCodeAuthProviderSummaries(profile.managedAuthPath, ['managed'])
              .catch(() => []))
              .map(provider => ({
                ...provider,
                credentialScopes: credentialScopesForProvider(provider.id),
              })),
          ]),
          profileScopeError: false,
        }
    const {
      connectedProviders,
      unsupportedSuperGrokOAuth,
    } = filterOpenCodeConnectedProvidersForRuntime({
      providers: discovered.providers,
      version,
    })
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
      const fallbackModelsResult = await this.execOpenCode(binaryPath, [
        'models',
        ...(options.refreshModels ? ['--refresh'] : []),
      ], profile, {
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
          .filter((provider): provider is string => typeof provider === 'string' && provider.length > 0),
      ]),
    ).sort()

    const diagnostics: string[] = []
    if (profile.authState === 'stale') {
      diagnostics.push('Managed OpenCode auth differs from the source auth store')
    }
    if (discovered.profileScopeError) {
      diagnostics.push('OpenCode profile scope auth evidence is invalid')
    }
    if (unsupportedSuperGrokOAuth) {
      diagnostics.push(
        `SuperGrok OAuth requires OpenCode ${OPEN_CODE_SUPERGROK_OAUTH_MIN_VERSION} or newer; detected ${version ?? 'an unknown version'}`,
      )
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
