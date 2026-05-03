import type {
  OpenCodeCanonicalToolCall,
  OpenCodeSessionReconcileSummary,
} from './types.js'

const BOOTSTRAP_MCP_TOOL_NAMES = new Set([
  'runtime_bootstrap_checkin',
  'member_briefing',
])
const REQUIRED_BOOTSTRAP_MCP_TOOL_NAMES = [
  'runtime_bootstrap_checkin',
  'member_briefing',
]

export type OpenCodeBootstrapMcpFailureSummary = {
  failedTools: string[]
  missingTools: string[]
  message: string
}

export type OpenCodeBootstrapMcpReadinessSummary = {
  ready: boolean
  completedTools: string[]
  missingTools: string[]
  runningTools: string[]
  failure: OpenCodeBootstrapMcpFailureSummary | null
}

export function normalizeAgentTeamsToolName(toolName: string | null | undefined): string {
  return String(toolName || '')
    .trim()
    .replace(/^mcp__agent-teams__/, '')
    .replace(/^agent-teams_/, '')
    .toLowerCase()
}

function collectDiagnosticText(value: unknown, output: string[], depth = 0): void {
  if (value == null || depth > 3) {
    return
  }
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      collectDiagnosticText(item, output, depth + 1)
    }
    return
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>).slice(0, 40)) {
      collectDiagnosticText(nested, output, depth + 1)
    }
  }
}

function compactToolOutput(tool: OpenCodeCanonicalToolCall): string {
  const values: string[] = []
  collectDiagnosticText(tool.outputText, values)
  collectDiagnosticText(tool.outputPreview, values)
  collectDiagnosticText(tool.output, values)
  return values
    .filter(value => value.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function isFailedBootstrapToolCall(tool: OpenCodeCanonicalToolCall): boolean {
  if (tool.isError || tool.status === 'errored') {
    return true
  }
  const output = compactToolOutput(tool)
  return output.includes('not connected') || output.includes('mcp not connected')
}

export function summarizeOpenCodeBootstrapMcpReadiness(
  summary: OpenCodeSessionReconcileSummary,
): OpenCodeBootstrapMcpReadinessSummary {
  const successfulTools = new Set<string>()
  const failedTools = new Set<string>()
  const runningTools = new Set<string>()

  for (const message of summary.messages) {
    for (const tool of message.toolCalls) {
      const toolName = normalizeAgentTeamsToolName(tool.toolName)
      if (!BOOTSTRAP_MCP_TOOL_NAMES.has(toolName)) {
        continue
      }
      if (isFailedBootstrapToolCall(tool)) {
        failedTools.add(toolName)
        continue
      }
      if (tool.status === 'running') {
        runningTools.add(toolName)
        continue
      }
      if (tool.status === 'completed') {
        successfulTools.add(toolName)
      }
    }
  }

  const failedWithoutLaterSuccess = [...failedTools].filter(toolName => !successfulTools.has(toolName))
  const missingTools = REQUIRED_BOOTSTRAP_MCP_TOOL_NAMES.filter(toolName => !successfulTools.has(toolName))
  const completedTools = REQUIRED_BOOTSTRAP_MCP_TOOL_NAMES.filter(toolName => successfulTools.has(toolName))
  const assistantTurnFinished = Boolean(summary.latestAssistantMessageId) &&
    summary.rawStatus !== 'busy' &&
    [...runningTools].every(toolName => successfulTools.has(toolName))

  if (failedWithoutLaterSuccess.length > 0) {
    return {
      ready: false,
      completedTools,
      missingTools,
      runningTools: [...runningTools],
      failure: {
        failedTools: failedWithoutLaterSuccess,
        missingTools,
        message: `OpenCode bootstrap MCP tool failed before required attach completed: ${failedWithoutLaterSuccess.join(', ')}`,
      },
    }
  }

  if (missingTools.length > 0 && assistantTurnFinished) {
    return {
      ready: false,
      completedTools,
      missingTools,
      runningTools: [...runningTools],
      failure: {
        failedTools: [],
        missingTools,
        message: `OpenCode bootstrap MCP did not complete required tools before assistant response: ${missingTools.join(', ')}`,
      },
    }
  }

  return {
    ready: missingTools.length === 0,
    completedTools,
    missingTools,
    runningTools: [...runningTools],
    failure: null,
  }
}

export function summarizeOpenCodeBootstrapMcpFailure(
  summary: OpenCodeSessionReconcileSummary,
): OpenCodeBootstrapMcpFailureSummary | null {
  return summarizeOpenCodeBootstrapMcpReadiness(summary).failure
}

export function hasOpenCodeBootstrapMcpNotConnectedFailure(
  summary: OpenCodeSessionReconcileSummary,
): boolean {
  if (summarizeOpenCodeBootstrapMcpReadiness(summary).ready) {
    return false
  }
  for (const message of summary.messages) {
    for (const tool of message.toolCalls) {
      const toolName = normalizeAgentTeamsToolName(tool.toolName)
      if (!BOOTSTRAP_MCP_TOOL_NAMES.has(toolName)) {
        continue
      }
      const output = compactToolOutput(tool)
      if (
        tool.isError ||
        tool.status === 'errored' ||
        output.includes('not connected') ||
        output.includes('mcp not connected')
      ) {
        if (output.includes('not connected') || output.includes('mcp not connected')) {
          return true
        }
      }
    }
  }
  return false
}
