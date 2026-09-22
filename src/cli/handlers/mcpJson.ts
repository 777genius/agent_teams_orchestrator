import pMap from 'p-map'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  buildMcpDiagnoseJsonPayload,
  buildMcpListJsonPayload,
  describeMcpServerTarget,
  filterExtensionsManagedMcpServers,
  getMcpTransport,
  type McpDiagnoseJsonEntry,
} from '../../services/mcp/cliJson.js'
import { connectToServer, getMcpServerConnectionBatchSize } from '../../services/mcp/client.js'
import { getAllMcpConfigs } from '../../services/mcp/config.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const MCP_DIAGNOSE_TIMEOUT_MS = 15_000

function writeJson(payload: unknown): void {
  process.stdout.write(jsonStringify(payload, null, 2) + '\n')
}

function toDiagnosticStatus(
  statusMessage: string,
): Pick<McpDiagnoseJsonEntry, 'status' | 'statusLabel'> {
  if (statusMessage.startsWith('✓')) {
    return { status: 'connected', statusLabel: statusMessage.slice(1).trim() || 'Connected' }
  }
  if (statusMessage.startsWith('!')) {
    return {
      status: 'needs-authentication',
      statusLabel: statusMessage.slice(1).trim() || 'Needs authentication',
    }
  }
  if (statusMessage.startsWith('⏱')) {
    return { status: 'timeout', statusLabel: statusMessage.slice(1).trim() || 'Timed out' }
  }
  return { status: 'failed', statusLabel: statusMessage.replace(/^✗\s*/, '').trim() || 'Failed' }
}

async function checkMcpServerHealth(
  name: string,
  server: ScopedMcpServerConfig,
): Promise<string> {
  try {
    const result = await connectToServer(name, server)
    if (result.type === 'connected') {
      return '✓ Connected'
    }
    if (result.type === 'needs-auth') {
      return '! Needs authentication'
    }
    return '✗ Failed to connect'
  } catch {
    return '✗ Connection error'
  }
}

async function diagnoseMcpServer(
  name: string,
  server: ScopedMcpServerConfig,
): Promise<McpDiagnoseJsonEntry> {
  const healthPromise = checkMcpServerHealth(name, server)
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<string>(resolve => {
    timeoutHandle = setTimeout(() => resolve('⏱ Timed out'), MCP_DIAGNOSE_TIMEOUT_MS)
    timeoutHandle.unref?.()
  })
  const statusMessage = await Promise.race([healthPromise, timeoutPromise])
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
  }

  return {
    name,
    scope: server.scope,
    transport: getMcpTransport(server),
    target: describeMcpServerTarget(server),
    ...toDiagnosticStatus(statusMessage),
  }
}

export async function mcpListJsonHandler(): Promise<void> {
  logEvent('tengu_mcp_list', {})
  const { servers: configs } = await getAllMcpConfigs()
  writeJson(buildMcpListJsonPayload(filterExtensionsManagedMcpServers(configs)))
  await gracefulShutdown(0)
}

export async function mcpDiagnoseJsonHandler(): Promise<void> {
  logEvent('tengu_mcp_diagnose', {})
  const { servers: configs } = await getAllMcpConfigs()
  const entries = Object.entries(filterExtensionsManagedMcpServers(configs))

  if (entries.length === 0) {
    writeJson(buildMcpDiagnoseJsonPayload([]))
    await gracefulShutdown(0)
    return
  }

  const diagnostics = await pMap(
    entries,
    async ([name, server]) => diagnoseMcpServer(name, server),
    { concurrency: getMcpServerConnectionBatchSize() },
  )

  writeJson(buildMcpDiagnoseJsonPayload(diagnostics))
  await gracefulShutdown(0)
}
