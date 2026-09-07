import { resolveOpenCodeAppMcpLaunchConfig as resolveLaunchInputs, type ResolvedAppMcpLaunchConfig,
  asRecord, asString, asStringRecord, parseMcpRemoteUrl, getMcpEnvironmentJsonKeys,
  hasOpenCodeLocalMcpLaunchOverride, OPEN_CODE_MCP_URL_ENV, OPEN_CODE_MCP_ENVIRONMENT_IDENTITY_KEYS,
} from './OpenCodeAppMcpLaunchConfig.js'
export { resolveOpenCodeBridgeRepoRootForStartDir, getCandidateClaudeTeamRootsForBridgeRoot } from './OpenCodeAppMcpLaunchConfig.js'
export type { ResolvedAppMcpLaunchConfig } from './OpenCodeAppMcpLaunchConfig.js'

/** Desktop adapter preserves the established public API and executable lookup. */
export function resolveOpenCodeAppMcpLaunchConfig(deps: {
  env?: NodeJS.ProcessEnv
  pathExists?: (targetPath: string) => Promise<boolean>
} = {}): Promise<ResolvedAppMcpLaunchConfig> {
  return resolveLaunchInputs({ env: deps.env ?? process.env, pathExists: deps.pathExists,
    workingDirectory: process.cwd(), moduleDirectory: path.dirname(fileURLToPath(import.meta.url)),
    repositoryRoot: null, entrypoint: process.argv[1] ?? null, home: os.homedir(),
    platform: process.platform, resolveExecutable: command => Bun.which(command),
  })
}

import { assertTrustedOpenCodeCustody, type OpenCodeHostAcquisitionPolicy, type TrustedOpenCodeCustody } from './OpenCodeSupervisedHostCustody.js'
import { isOpenCodeClientFactoryBoundToCustody } from './OpenCodeClientFactory.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

import { openCodeClientFactory } from './OpenCodeClientFactory.js'

import type {
  OpenCodeClientRequestContext,
} from './OpenCodeClientFactory.js'
import type {
  OpenCodeAppMcpSummary,
  OpenCodeMcpResponse,
  OpenCodeMcpServerConfig,
  OpenCodeMcpStatusEntry,
} from './types.js'

import { OPEN_CODE_APP_MCP_SERVER_NAME } from './OpenCodeAppMcpName.js'
export { OPEN_CODE_APP_MCP_SERVER_NAME } from './OpenCodeAppMcpName.js'
const OPEN_CODE_APP_MCP_SERVER_ALIASES = [
  OPEN_CODE_APP_MCP_SERVER_NAME,
  'agent_teams',
] as const
const OPEN_CODE_APP_MCP_VERIFY_TIMEOUT_MS = 5_000
const OPEN_CODE_APP_MCP_VERIFY_POLL_MS = 250
type OpenCodeMcpClient = {
  getConfig?(): Promise<unknown>
  getMcp(): Promise<OpenCodeMcpResponse>
  addMcp?(name: string, config: OpenCodeMcpServerConfig): Promise<OpenCodeMcpResponse>
  connectMcp?(name: string): Promise<OpenCodeMcpResponse>
}

type OpenCodeMcpManagerDeps = {
  acquisitionPolicy?: OpenCodeHostAcquisitionPolicy
  clientFactory?: {
    create(baseUrl: string, context?: OpenCodeClientRequestContext): OpenCodeMcpClient
  }
  resolveLaunchConfig?: () => Promise<ResolvedAppMcpLaunchConfig>
  pathExists?: (targetPath: string) => Promise<boolean>
  env?: NodeJS.ProcessEnv
  sleepMs?: (ms: number) => Promise<void>
  verifyTimeoutMs?: number
  verifyPollMs?: number
}

type EnsureAppMcpResult = {
  mcp: OpenCodeMcpResponse
  summary: OpenCodeAppMcpSummary
}

function getMcpServerNames(mcp: OpenCodeMcpResponse): string[] {
  return Object.keys(asRecord(mcp) ?? {}).sort()
}

function getMatchedAppMcpEntry(mcp: OpenCodeMcpResponse): {
  matchedServerName: string | null
  entry: OpenCodeMcpStatusEntry | null
} {
  const record = asRecord(mcp) ?? {}
  for (const serverName of OPEN_CODE_APP_MCP_SERVER_ALIASES) {
    const entry = asRecord(record[serverName])
    if (entry) {
      return {
        matchedServerName: serverName,
        entry,
      }
    }
  }
  return {
    matchedServerName: null,
    entry: null,
  }
}

function getMatchedAppMcpConfigEntry(config: unknown): OpenCodeMcpStatusEntry | null {
  const record = asRecord(config)
  const mcp = asRecord(record?.mcp)
  if (!mcp) {
    return null
  }

  for (const serverName of OPEN_CODE_APP_MCP_SERVER_ALIASES) {
    const entry = asRecord(mcp[serverName])
    if (entry) {
      return entry
    }
  }
  return null
}

function getEntryEnvironment(entry: OpenCodeMcpStatusEntry | null): Record<string, string> | null {
  const candidates = [
    entry,
    asRecord(entry?.config),
    asRecord(entry?.server),
    asRecord(entry?.options),
  ]
  for (const candidate of candidates) {
    const environment = asStringRecord(candidate?.environment)
    if (environment) {
      return environment
    }
  }
  return null
}

function getEntryCommand(entry: OpenCodeMcpStatusEntry | null): string[] | null {
  const candidates = [
    entry,
    asRecord(entry?.config),
    asRecord(entry?.server),
    asRecord(entry?.options),
  ]
  for (const candidate of candidates) {
    const command = candidate?.command
    if (!Array.isArray(command)) {
      continue
    }
    const normalized = command.filter((part): part is string => typeof part === 'string')
    if (normalized.length === command.length && normalized.length > 0) {
      return normalized
    }
  }
  return null
}

function getEntryUrl(entry: OpenCodeMcpStatusEntry | null): string | null {
  const candidates = [
    entry,
    asRecord(entry?.config),
    asRecord(entry?.server),
    asRecord(entry?.options),
  ]
  for (const candidate of candidates) {
    const url = parseMcpRemoteUrl(asString(candidate?.url))
    if (url) {
      return url
    }
  }
  return null
}

function shouldVerifyExistingAppMcpConfig(
  entry: OpenCodeMcpStatusEntry | null,
  client: OpenCodeMcpClient,
  env: NodeJS.ProcessEnv,
  attachIfMissing?: boolean,
): boolean {
  if (attachIfMissing !== true) {
    return false
  }

  if (
    asString(env[OPEN_CODE_MCP_URL_ENV]) !== null
    || hasOpenCodeLocalMcpLaunchOverride(env)
    || OPEN_CODE_MCP_ENVIRONMENT_IDENTITY_KEYS.some(key => {
      const value = env[key]
      return typeof value === 'string' && value.length > 0
    })
  ) {
    return true
  }

  return (
    typeof client.getConfig === 'function'
    && getEntryCommand(entry) === null
    && getEntryEnvironment(entry) === null
    && getEntryUrl(entry) === null
  )
}

function appMcpConfigMatchesRequiredRuntime(
  entry: OpenCodeMcpStatusEntry | null,
  desiredConfig: OpenCodeMcpServerConfig,
  options: { requiredEnvironmentKeys?: readonly string[] } = {},
): { ok: boolean; reason: string | null } {
  const desiredEnvironment = desiredConfig.environment ?? {}
  const desiredIdentityKeys = OPEN_CODE_MCP_ENVIRONMENT_IDENTITY_KEYS.filter(key =>
    typeof desiredEnvironment[key] === 'string' && desiredEnvironment[key].length > 0,
  )
  const desiredIdentityKeySet = new Set<string>(desiredIdentityKeys)
  const requiredEnvironmentKeys = Array.from(new Set([
    ...desiredIdentityKeys,
    ...(options.requiredEnvironmentKeys ?? []).filter(
      key => typeof desiredEnvironment[key] === 'string',
    ),
  ]))
  const entryEnvironment = getEntryEnvironment(entry)

  for (const key of requiredEnvironmentKeys) {
    if (!entryEnvironment) {
      return {
        ok: false,
        reason: `existing app MCP config does not expose environment; ${key} cannot be verified`,
      }
    }
    if (entryEnvironment[key] !== desiredEnvironment[key]) {
      return {
        ok: false,
        reason: desiredIdentityKeySet.has(key)
          ? `existing app MCP ${key} does not match current runtime root`
          : `existing app MCP ${key} does not match current MCP child environment`,
      }
    }
  }

  const desiredCommand = desiredConfig.command
  const entryCommand = getEntryCommand(entry)
  if (desiredCommand?.length && entryCommand) {
    if (desiredCommand.join('\0') !== entryCommand.join('\0')) {
      return {
        ok: false,
        reason: 'existing app MCP command does not match current launch command',
      }
    }
  }

  const desiredUrl = parseMcpRemoteUrl(asString(desiredConfig.url))
  if (desiredUrl) {
    const entryUrl = getEntryUrl(entry)
    if (entryUrl !== desiredUrl) {
      return {
        ok: false,
        reason: 'existing app MCP URL does not match current launch URL',
      }
    }
  }

  return { ok: true, reason: null }
}

function inferMcpConnected(entry: OpenCodeMcpStatusEntry | null): boolean | null {
  if (!entry) {
    return null
  }
  if (typeof entry.connected === 'boolean') {
    return entry.connected
  }

  const stateValue =
    asString(entry.status)
    ?? asString(entry.state)
    ?? asString(entry.connection)
    ?? asString(entry.health)

  if (!stateValue) {
    return null
  }

  const normalizedState = stateValue.toLowerCase()
  if (
    normalizedState === 'connected'
    || normalizedState === 'ready'
    || normalizedState === 'healthy'
    || normalizedState === 'active'
  ) {
    return true
  }

  if (
    normalizedState === 'disconnected'
    || normalizedState === 'failed'
    || normalizedState === 'error'
    || normalizedState === 'disabled'
  ) {
    return false
  }

  return null
}

const supervisedManagers = new WeakMap<object, TrustedOpenCodeCustody>()
export function isOpenCodeMcpManagerBoundToCustody(value: object, custody: TrustedOpenCodeCustody): boolean {
  return supervisedManagers.get(value) === custody
}

export class OpenCodeMcpManager {
  private readonly ensureAppMcpInFlight = new Map<string, Promise<EnsureAppMcpResult>>()

  private readonly deps: OpenCodeMcpManagerDeps
  private readonly custody?: TrustedOpenCodeCustody
  constructor(deps: OpenCodeMcpManagerDeps = {}) {
    const policy = deps.acquisitionPolicy
    if (policy?.mode === 'supervisor-adopt-only') {
      const custody = policy.custody
      assertTrustedOpenCodeCustody(custody)
      if (new.target !== OpenCodeMcpManager || !deps.clientFactory ||
        !isOpenCodeClientFactoryBoundToCustody(deps.clientFactory, custody) ||
        deps.resolveLaunchConfig || deps.env || deps.pathExists) {
        throw new Error('OpenCode supervised MCP requires the custody-bound client and profile')
      }
      this.custody = custody
      this.deps = Object.freeze({ ...deps,
        clientFactory: Object.freeze({ create: deps.clientFactory.create.bind(deps.clientFactory) }),
        env: Object.freeze({}),
      })
      supervisedManagers.set(this, custody)
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(OpenCodeMcpManager.prototype))) {
        if (name === 'constructor') continue
        if (typeof descriptor.value === 'function') Object.defineProperty(this, name, { value: descriptor.value.bind(this) })
        else if (descriptor.get) Object.defineProperty(this, name, { get: descriptor.get.bind(this) })
      }
      Object.freeze(this)
    } else this.deps = deps
  }

  private get clientFactory() {
    return this.deps.clientFactory ?? openCodeClientFactory
  }

  private async sleepMs(ms: number): Promise<void> {
    if (this.deps.sleepMs) {
      await this.deps.sleepMs(ms)
      return
    }
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private get verifyTimeoutMs(): number {
    return this.deps.verifyTimeoutMs ?? OPEN_CODE_APP_MCP_VERIFY_TIMEOUT_MS
  }

  private get verifyPollMs(): number {
    return this.deps.verifyPollMs ?? OPEN_CODE_APP_MCP_VERIFY_POLL_MS
  }

  private async resolveLaunchConfig(): Promise<ResolvedAppMcpLaunchConfig> {
    if (this.custody) {
      const profile = await this.custody.readPreparedProfile()
      const mcp = asRecord(profile.managedConfig.mcp)
      const config = mcp && asRecord(mcp[OPEN_CODE_APP_MCP_SERVER_NAME])
      if (!config || (config.type !== 'local' && config.type !== 'remote') ||
        (config.type === 'local' && (!Array.isArray(config.command) || config.command.length === 0 ||
          !config.command.every(part => typeof part === 'string' && part.length > 0))) ||
        (config.type === 'remote' && typeof config.url !== 'string')) {
        throw new Error('OpenCode supervised profile MCP configuration unavailable')
      }
      return { source: 'supervised-profile', config: structuredClone(config) as OpenCodeMcpServerConfig }
    }
    if (this.deps.resolveLaunchConfig) {
      return this.deps.resolveLaunchConfig()
    }

    return resolveOpenCodeAppMcpLaunchConfig({
      env: this.deps.env,
      pathExists: this.deps.pathExists,
    })
  }

  async ensureAppMcp(params: {
    baseUrl: string
    attachIfMissing?: boolean
    requestContext?: OpenCodeClientRequestContext
  }): Promise<EnsureAppMcpResult> {
    if (params.requestContext) {
      return this.ensureAppMcpOnce(params)
    }
    const cacheKey = `${params.baseUrl}::${params.attachIfMissing === true ? 'attach' : 'read'}`
    const inFlight = this.ensureAppMcpInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }

    const work = this.ensureAppMcpOnce(params).finally(() => {
      if (this.ensureAppMcpInFlight.get(cacheKey) === work) {
        this.ensureAppMcpInFlight.delete(cacheKey)
      }
    })
    this.ensureAppMcpInFlight.set(cacheKey, work)
    return work
  }

  private async ensureAppMcpOnce(params: {
    baseUrl: string
    attachIfMissing?: boolean
    requestContext?: OpenCodeClientRequestContext
  }): Promise<EnsureAppMcpResult> {
    const client = this.clientFactory.create(params.baseUrl, params.requestContext)
    if (this.custody) {
      // /mcp is status-only. Require actual complete private /config on every
      // verification, even when the status identity subset happens to match.
      if (!client.getConfig) throw new Error('OpenCode supervised MCP configuration unavailable')
      this.custody.assertPrivateMcpConfiguration(await client.getConfig())
    }
    const existingMcp = await client.getMcp()
    const existingMatch = getMatchedAppMcpEntry(existingMcp)

    if (existingMatch.matchedServerName) {
      const connected = inferMcpConnected(existingMatch.entry)
      let launchConfig: ResolvedAppMcpLaunchConfig | null = null
      const currentEnv = this.deps.env ?? process.env
      const shouldVerifyExistingConfig = !!this.custody || shouldVerifyExistingAppMcpConfig(
        existingMatch.entry,
        client,
        currentEnv,
        params.attachIfMissing,
      )
      if (shouldVerifyExistingConfig) {
        launchConfig = await this.resolveLaunchConfig()
        const requiredEnvironmentKeys =
          launchConfig.source === 'env-override' && launchConfig.config.type === 'local'
            ? getMcpEnvironmentJsonKeys(currentEnv)
            : []
        let compatibility = this.custody ? { ok: true, reason: null } : appMcpConfigMatchesRequiredRuntime(
          existingMatch.entry,
          launchConfig.config,
          { requiredEnvironmentKeys },
        )
        if (!compatibility.ok && typeof client.getConfig === 'function') {
          try {
            const configEntry = getMatchedAppMcpConfigEntry(await client.getConfig())
            if (configEntry) {
              const configCompatibility = appMcpConfigMatchesRequiredRuntime(
                configEntry,
                launchConfig.config,
                { requiredEnvironmentKeys },
              )
              if (configCompatibility.ok) {
                compatibility = configCompatibility
              }
            }
          } catch {
            // Best effort: fall back to the /mcp compatibility result.
          }
        }
        if (!compatibility.ok) {
          if (typeof client.addMcp !== 'function') {
            return {
              mcp: existingMcp,
              summary: {
                serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                matchedServerName: existingMatch.matchedServerName,
                status: 'attach_failed',
                connected,
                launchSource: launchConfig.source,
                availableServerNames: getMcpServerNames(existingMcp),
                diagnostics: [
                  `OpenCode app MCP server ${existingMatch.matchedServerName} is stale: ${compatibility.reason}`,
                  'OpenCode client does not expose dynamic MCP attach support',
                ],
              },
            }
          }
          try {
            await client.addMcp(OPEN_CODE_APP_MCP_SERVER_NAME, launchConfig.config)
            const refreshedMcp = await this.waitForMcpConnected(
              client,
              OPEN_CODE_APP_MCP_SERVER_NAME,
            )
            const refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
            const refreshedConnected = inferMcpConnected(refreshedMatch.entry)
            return {
              mcp: refreshedMcp,
              summary: {
                serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                matchedServerName: refreshedMatch.matchedServerName,
                status: 'attached',
                connected: refreshedConnected,
                launchSource: launchConfig.source,
                availableServerNames: getMcpServerNames(refreshedMcp),
                diagnostics: refreshedConnected === true
                  ? [`Reattached stale OpenCode app MCP server: ${compatibility.reason}`]
                  : [
                      `Reattached stale OpenCode app MCP server: ${compatibility.reason}`,
                      `OpenCode app MCP server ${OPEN_CODE_APP_MCP_SERVER_NAME} did not report connected after reattach`,
                    ],
              },
            }
          } catch (error) {
            return {
              mcp: existingMcp,
              summary: {
                serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                matchedServerName: existingMatch.matchedServerName,
                status: 'attach_failed',
                connected,
                launchSource: launchConfig.source,
                availableServerNames: getMcpServerNames(existingMcp),
                diagnostics: [
                  `OpenCode app MCP server ${existingMatch.matchedServerName} is stale: ${compatibility.reason}`,
                  `OpenCode app MCP reattach failed: ${error instanceof Error ? error.message : String(error)}`,
                ],
              },
            }
          }
        }
      }
      if (connected !== true && params.attachIfMissing && typeof client.connectMcp === 'function') {
        try {
          await client.connectMcp(existingMatch.matchedServerName)
          const connectedMcp = await this.waitForMcpConnected(client, existingMatch.matchedServerName)
          const connectedMatch = getMatchedAppMcpEntry(connectedMcp)
          const refreshedConnected = inferMcpConnected(connectedMatch.entry)
          return {
            mcp: connectedMcp,
            summary: {
              serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
              matchedServerName: connectedMatch.matchedServerName,
              status: refreshedConnected === true ? 'attached' : 'present',
              connected: refreshedConnected,
              launchSource: launchConfig?.source ?? null,
              availableServerNames: getMcpServerNames(connectedMcp),
              diagnostics: refreshedConnected === true
                ? []
                : [`OpenCode app MCP server ${existingMatch.matchedServerName} did not report connected after connect`],
            },
          }
        } catch (error) {
          if (typeof client.addMcp === 'function') {
            try {
              launchConfig ??= await this.resolveLaunchConfig()
              await client.addMcp(OPEN_CODE_APP_MCP_SERVER_NAME, launchConfig.config)
              const refreshedMcp = await this.waitForMcpConnected(
                client,
                OPEN_CODE_APP_MCP_SERVER_NAME,
              )
              const refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
              const refreshedConnected = inferMcpConnected(refreshedMatch.entry)
              return {
                mcp: refreshedMcp,
                summary: {
                  serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                  matchedServerName: refreshedMatch.matchedServerName,
                  status: 'attached',
                  connected: refreshedConnected,
                  launchSource: launchConfig.source,
                  availableServerNames: getMcpServerNames(refreshedMcp),
                  diagnostics: refreshedConnected === true
                    ? [
                        `Reattached OpenCode app MCP server after connect failed: ${error instanceof Error ? error.message : String(error)}`,
                      ]
                    : [
                        `Reattached OpenCode app MCP server after connect failed: ${error instanceof Error ? error.message : String(error)}`,
                        `OpenCode app MCP server ${OPEN_CODE_APP_MCP_SERVER_NAME} did not report connected after reattach`,
                      ],
                },
              }
            } catch (reattachError) {
              return {
                mcp: existingMcp,
                summary: {
                  serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                  matchedServerName: existingMatch.matchedServerName,
                  status: 'attach_failed',
                  connected,
                  launchSource: launchConfig?.source ?? null,
                  availableServerNames: getMcpServerNames(existingMcp),
                  diagnostics: [
                    `OpenCode app MCP connect failed: ${error instanceof Error ? error.message : String(error)}`,
                    `OpenCode app MCP reattach after connect failure failed: ${reattachError instanceof Error ? reattachError.message : String(reattachError)}`,
                  ],
                },
              }
            }
          }
          return {
            mcp: existingMcp,
            summary: {
              serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
              matchedServerName: existingMatch.matchedServerName,
              status: 'attach_failed',
              connected,
              launchSource: launchConfig?.source ?? null,
              availableServerNames: getMcpServerNames(existingMcp),
              diagnostics: [`OpenCode app MCP connect failed: ${error instanceof Error ? error.message : String(error)}`],
            },
          }
        }
      }

      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: existingMatch.matchedServerName,
          status: 'present',
          connected,
          launchSource: launchConfig?.source ?? null,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: [],
        },
      }
    }

    if (this.custody) throw new Error('OpenCode supervised MCP server missing')

    if (!params.attachIfMissing) {
      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: null,
          status: 'missing',
          connected: null,
          launchSource: null,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: ['OpenCode host is missing the app-owned agent-teams MCP server'],
        },
      }
    }

    const launchConfig = await this.resolveLaunchConfig()
    if (typeof client.addMcp !== 'function') {
      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: null,
          status: 'attach_failed',
          connected: null,
          launchSource: launchConfig.source,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: ['OpenCode client does not expose dynamic MCP attach support'],
        },
      }
    }

    try {
      await client.addMcp(OPEN_CODE_APP_MCP_SERVER_NAME, launchConfig.config)
      let refreshedMcp = await client.getMcp()
      let refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
      const verifyStartedAt = Date.now()

      while (
        !refreshedMatch.matchedServerName
        && Date.now() - verifyStartedAt < this.verifyTimeoutMs
      ) {
        await this.sleepMs(this.verifyPollMs)
        refreshedMcp = await client.getMcp()
        refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
      }

      if (!refreshedMatch.matchedServerName) {
        return {
          mcp: refreshedMcp,
          summary: {
            serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
            matchedServerName: null,
            status: 'attach_failed',
            connected: null,
            launchSource: launchConfig.source,
            availableServerNames: getMcpServerNames(refreshedMcp),
            diagnostics: [
              `OpenCode accepted the app MCP attach request, but the MCP server is still absent from /mcp after ${this.verifyTimeoutMs}ms`,
            ],
          },
        }
      }

      return {
        mcp: refreshedMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: refreshedMatch.matchedServerName,
          status: 'attached',
          connected: inferMcpConnected(refreshedMatch.entry),
          launchSource: launchConfig.source,
          availableServerNames: getMcpServerNames(refreshedMcp),
          diagnostics: [],
        },
      }
    } catch (error) {
      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: null,
          status: 'attach_failed',
          connected: null,
          launchSource: launchConfig.source,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: [
            error instanceof Error ? error.message : String(error),
          ],
        },
      }
    }
  }

  private async waitForMcpConnected(
    client: OpenCodeMcpClient,
    serverName: string,
  ): Promise<OpenCodeMcpResponse> {
    const verifyStartedAt = Date.now()
    let latest = await client.getMcp()
    while (Date.now() - verifyStartedAt < this.verifyTimeoutMs) {
      const match = getMatchedAppMcpEntry(latest)
      if (match.matchedServerName === serverName && inferMcpConnected(match.entry) === true) {
        return latest
      }
      await this.sleepMs(this.verifyPollMs)
      latest = await client.getMcp()
    }
    return latest
  }
}

export const openCodeMcpManager = new OpenCodeMcpManager()
