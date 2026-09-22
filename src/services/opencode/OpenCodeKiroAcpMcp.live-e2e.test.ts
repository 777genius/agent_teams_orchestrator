import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { OpenCodeClientFactory, type OpenCodeClient } from './OpenCodeClientFactory.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { getOpenCodeCuratedSubscriptionProvider } from './OpenCodeCuratedSubscriptionCatalog.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import {
  execOpenCodePortableCommand,
  getOpenCodeVerboseModelsArgs,
} from './OpenCodeInventoryService.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'
import { OpenCodeProfileManager } from './OpenCodeProfileManager.js'

import type { OpenCodeSessionReconcileSummary } from './types.js'

const liveTest = process.env.KIRO_ACP_MCP_LIVE_E2E === '1' ? test : test.skip
const keepArtifacts = process.env.KIRO_ACP_MCP_LIVE_E2E_KEEP === '1'
const MCP_SERVER_NAME = 'agent-teams'
const MCP_TOOL_BASENAME = 'readiness_echo'
const MCP_TOOL_ID = `${MCP_SERVER_NAME}_${MCP_TOOL_BASENAME}`
const MODEL_REF = {
  providerID: 'kiro',
  modelID: 'auto',
} as const
const TURN_TIMEOUT_MS = 180_000
const COLD_PLUGIN_INSTALL_TIMEOUT_MS = 180_000

type EnvironmentSnapshot = Record<string, string | undefined>

function snapshotEnvironment(keys: string[]): EnvironmentSnapshot {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]))
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function expectPathInside(rootPath: string, targetPath: string): void {
  const relativePath = path.relative(rootPath, targetPath)
  expect(relativePath).not.toBe('')
  expect(relativePath).not.toBe('..')
  expect(relativePath.startsWith(`..${path.sep}`)).toBe(false)
  expect(path.isAbsolute(relativePath)).toBe(false)
}

async function writeReadinessMcpServer(input: {
  serverPath: string
  callLogPath: string
  resultToken: string
}): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, '../../..')
  const sdkServerUrl = pathToFileURL(path.join(
    repositoryRoot,
    'node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js',
  )).href
  const sdkStdioUrl = pathToFileURL(path.join(
    repositoryRoot,
    'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',
  )).href
  const sdkTypesUrl = pathToFileURL(path.join(
    repositoryRoot,
    'node_modules/@modelcontextprotocol/sdk/dist/esm/types.js',
  )).href

  await writeFile(
    input.serverPath,
    [
      `import { appendFile } from 'node:fs/promises'`,
      `import { Server } from ${JSON.stringify(sdkServerUrl)}`,
      `import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)}`,
      `import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypesUrl)}`,
      '',
      `const callLogPath = ${JSON.stringify(input.callLogPath)}`,
      `const server = new Server({ name: 'kiro-acp-mcp-live-e2e', version: '1.0.0' }, { capabilities: { tools: {} } })`,
      '',
      'server.setRequestHandler(ListToolsRequestSchema, async () => ({',
      '  tools: [{',
      `    name: ${JSON.stringify(MCP_TOOL_BASENAME)},`,
      "    description: 'Return a server-generated readiness result that is unavailable before execution. Use only when explicitly asked.',",
      '    inputSchema: {',
      "      type: 'object',",
      '      properties: {',
      "        token: { type: 'string', description: 'Unique invocation correlation token' },",
      '      },',
      "      required: ['token'],",
      '      additionalProperties: false,',
      '    },',
      '  }],',
      '}))',
      '',
      'server.setRequestHandler(CallToolRequestSchema, async request => {',
      `  if (request.params.name !== ${JSON.stringify(MCP_TOOL_BASENAME)}) {`,
      "    throw new Error(`Unknown tool: ${request.params.name}`)",
      '  }',
      "  const token = typeof request.params.arguments?.token === 'string'",
      '    ? request.params.arguments.token',
      "    : ''",
      "  await appendFile(callLogPath, `${JSON.stringify({ tool: request.params.name, token })}\\n`, 'utf8')",
      '  return {',
      `    content: [{ type: 'text', text: ${JSON.stringify(`KIRO_MCP_TOOL_RESULT:${input.resultToken}`)} }],`,
      '  }',
      '})',
      '',
      'await server.connect(new StdioServerTransport())',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function waitForReadinessMcp(client: OpenCodeClient): Promise<void> {
  const deadline = Date.now() + 30_000
  let latest: Record<string, unknown> | undefined
  let connectRequested = false
  while (Date.now() < deadline) {
    latest = (await client.getMcp())[MCP_SERVER_NAME]
    if (latest?.connected === true || latest?.status === 'connected') return
    if (!connectRequested) {
      connectRequested = true
      await client.connectMcp?.(MCP_SERVER_NAME)
    }
    await Bun.sleep(250)
  }
  throw new Error(`Readiness MCP did not connect: ${JSON.stringify(latest)}`)
}

async function waitForCompletedToolCall(input: {
  client: OpenCodeClient
  sessionId: string
  toolId: string
  resultToken: string
}): Promise<OpenCodeSessionReconcileSummary> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let latestSummary: OpenCodeSessionReconcileSummary | null = null

  while (Date.now() < deadline) {
    const [statuses, messages] = await Promise.all([
      input.client.getSessionStatus(),
      input.client.getSessionMessages(input.sessionId),
    ])
    latestSummary = openCodeEventTranslator.reconcileSessionMessages({
      sessionId: input.sessionId,
      rawStatus: statuses[input.sessionId] ?? null,
      messages,
    })
    if (latestSummary.errorCount > 0 && latestSummary.durableState === 'error') {
      throw new Error(`Kiro MCP turn failed: ${JSON.stringify(latestSummary)}`)
    }
    const completedCall = latestSummary.messages
      .flatMap(message => message.toolCalls)
      .find(call =>
        call.toolName === input.toolId
        && call.status === 'completed'
        && call.outputText?.includes(`KIRO_MCP_TOOL_RESULT:${input.resultToken}`),
      )
    if (completedCall && latestSummary.durableState === 'idle') {
      return latestSummary
    }
    if (
      latestSummary.durableState === 'idle'
      && latestSummary.toolCallCount === 0
      && latestSummary.latestAssistantText
    ) {
      throw new Error(
        `Kiro completed without calling ${input.toolId}: ${latestSummary.latestAssistantText}`,
      )
    }
    await Bun.sleep(500)
  }

  throw new Error(
    `Kiro MCP tool call did not complete within ${TURN_TIMEOUT_MS}ms. Last summary: ${JSON.stringify(latestSummary)}`,
  )
}

describe('OpenCode Kiro ACP MCP live e2e', () => {
  liveTest('calls a local MCP tool through the pinned Kiro ACP provider', async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-kiro-acp-mcp-live-'))
    const projectPath = path.join(isolatedRoot, 'project')
    const dataHome = path.join(isolatedRoot, 'managed-data')
    const cacheHome = path.join(isolatedRoot, 'managed-cache')
    const sourceConfigHome = path.join(isolatedRoot, 'source-config')
    const sourceDataHome = path.join(isolatedRoot, 'source-data')
    const sourceCacheHome = path.join(isolatedRoot, 'source-cache')
    const serverPath = path.join(isolatedRoot, 'readiness-mcp-server.mjs')
    const callLogPath = path.join(isolatedRoot, 'readiness-mcp-calls.jsonl')
    const inputToken = `kiro-mcp-input-${randomUUID()}`
    const resultToken = `kiro-mcp-result-${randomUUID()}`
    const environmentKeys = [
      CLAUDE_MULTIMODEL_DATA_HOME_ENV,
      CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
    ]
    const originalEnvironment = snapshotEnvironment(environmentKeys)
    let hostManager: OpenCodeHostManager | null = null
    let hostKey: string | null = null
    let client: OpenCodeClient | null = null
    let sessionId: string | null = null

    try {
      await Promise.all([
        mkdir(projectPath, { recursive: true }),
        mkdir(sourceConfigHome, { recursive: true }),
        mkdir(sourceDataHome, { recursive: true }),
        mkdir(sourceCacheHome, { recursive: true }),
      ])
      await writeReadinessMcpServer({ serverPath, callLogPath, resultToken })
      await writeFile(
        path.join(projectPath, 'opencode.json'),
        `${JSON.stringify({
          mcp: {
            [MCP_SERVER_NAME]: {
              type: 'local',
              command: [process.execPath, serverPath],
              enabled: true,
            },
          },
        }, null, 2)}\n`,
        'utf8',
      )

      process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = dataHome
      process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = cacheHome
      process.env.XDG_CONFIG_HOME = sourceConfigHome
      process.env.XDG_DATA_HOME = sourceDataHome
      process.env.XDG_CACHE_HOME = sourceCacheHome

      const profileOptions = {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: true,
        toolApprovalMode: 'auto' as const,
      }
      const profileManager = new OpenCodeProfileManager()
      const preparedProfile = await profileManager.prepareProfile(projectPath, profileOptions)
      const binaryPath = resolveOpenCodeBinaryPath()
      if (!binaryPath) {
        throw new Error('OpenCode binary is unavailable for the Kiro ACP live E2E')
      }
      const coldInstall = await execOpenCodePortableCommand({
        binaryPath,
        args: getOpenCodeVerboseModelsArgs(),
        profile: preparedProfile,
        timeoutMs: COLD_PLUGIN_INSTALL_TIMEOUT_MS,
      })
      if (coldInstall.code !== 0) {
        throw new Error(
          coldInstall.error
          || coldInstall.stderr.trim()
          || coldInstall.stdout.trim()
          || 'Failed to cold-install managed OpenCode provider plugins',
        )
      }

      hostManager = new OpenCodeHostManager({
        prepareProfile: profileManager.prepareProfile.bind(profileManager),
        persistentRegistryPath: path.join(isolatedRoot, 'persistent-hosts.json'),
      })
      const host = await hostManager.ensureHost({
        projectPath,
        preparedProfile,
        hostLifetime: 'process',
        healthTimeoutMs: 60_000,
      })
      hostKey = host.hostKey
      client = new OpenCodeClientFactory().create(host.baseUrl)

      for (const isolatedPath of [
        host.profile.profileRootPath,
        host.profile.homePath,
        host.profile.tmpPath,
        host.profile.xdgConfigHome,
        host.profile.xdgDataHome,
        host.profile.xdgCacheHome,
        host.profile.globalAuthPath,
        host.profile.managedAuthPath,
      ]) {
        expectPathInside(isolatedRoot, isolatedPath)
      }

      const configuredKiro = getOpenCodeCuratedSubscriptionProvider('kiro')?.config as {
        npm?: string
      } | null
      expect(configuredKiro?.npm).toContain('github.com/777genius/kiro-acp-ai-provider')
      const resolvedProviders = await client.getConfigProviders()
      expect(resolvedProviders.providers?.some(provider => provider.id === 'kiro')).toBe(true)

      const providerSnapshot = await client.getProviders()
      expect(providerSnapshot.connected).toContain('kiro')
      await waitForReadinessMcp(client)
      const toolId = MCP_TOOL_ID

      const session = await client.createSession({
        title: `KIRO_ACP_MCP_LIVE_E2E ${inputToken}`,
      })
      sessionId = session.id
      await client.promptSessionAsync(session.id, {
        agent: 'teammate',
        model: MODEL_REF,
        tools: {
          bash: false,
          edit: false,
          glob: false,
          grep: false,
          read: false,
          todowrite: false,
          write: false,
          [toolId]: true,
        },
        parts: [{
          type: 'text',
          text: [
            'This is a deterministic MCP transport check.',
            'Select the available MCP tool whose description says it returns a server-generated readiness result.',
            `Call that tool exactly once with this JSON: ${JSON.stringify({ token: inputToken })}.`,
            'Do not call any other tool.',
            'The result contains a secret value that is not present in this prompt.',
          ].join('\n'),
        }],
      })

      const summary = await waitForCompletedToolCall({
        client,
        sessionId: session.id,
        toolId,
        resultToken,
      })
      const completedCall = summary.messages
        .flatMap(message => message.toolCalls)
        .find(call => call.toolName === toolId && call.status === 'completed')

      expect(summary.durableState).toBe('idle')
      expect(summary.errorCount).toBe(0)
      expect(completedCall).toMatchObject({
        toolName: toolId,
        status: 'completed',
        isError: false,
      })
      expect(completedCall?.input).toEqual({ token: inputToken })
      expect(completedCall?.outputText).toContain(`KIRO_MCP_TOOL_RESULT:${resultToken}`)
      expect(await readFile(callLogPath, 'utf8')).toContain(
        JSON.stringify({ tool: MCP_TOOL_BASENAME, token: inputToken }),
      )
    } finally {
      if (client && sessionId) {
        await client.abortSession(sessionId).catch(() => undefined)
      }
      if (hostManager && hostKey) {
        await hostManager.releaseHost(hostKey).catch(() => undefined)
        await hostManager.disposeHost(hostKey).catch(() => undefined)
      }
      restoreEnvironment(originalEnvironment)
      if (keepArtifacts) {
        process.stderr.write(`Kiro ACP MCP live E2E artifacts: ${isolatedRoot}\n`)
      } else {
        await rm(isolatedRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }, 480_000)
})
