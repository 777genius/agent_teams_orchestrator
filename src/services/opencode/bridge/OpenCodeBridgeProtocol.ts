import type { OpenCodePromptPart } from '../OpenCodeSessionBridge.js'
const BRIDGE_SCHEMA_VERSION = 1
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export const SUPPORTED_COMMANDS = [
  'opencode.handshake',
  'opencode.commandStatus',
  'opencode.stopOutcome',
  'opencode.reconcileStop',
  'opencode.readiness',
  'opencode.cleanupHosts',
  'opencode.cleanupStartupHosts',
  'opencode.reapUnleasedCursorAgentTrees',
  'opencode.launchTeam',
  'opencode.reconcileTeam',
  'opencode.stopTeam',
  'opencode.sendMessage',
  'opencode.observeMessageDelivery',
  'opencode.answerPermission',
  'opencode.listRuntimePermissions',
  'opencode.getRuntimeTranscript',
  'opencode.backfillTaskLedger',
  'opencode.recoverDeliveryJournal',
] as const

export type BridgeCommandName = typeof SUPPORTED_COMMANDS[number]

export type BridgeEnvelope = {
  schemaVersion: 1
  requestId: string
  command: BridgeCommandName
  cwd: string
  startedAt: string
  timeoutMs: number
  body: Record<string, unknown>
}

export function validateEnvelope(input: unknown): BridgeEnvelope {
  const envelope = asRecord(input)
  if (!envelope) {
    throw new Error('Bridge envelope must be an object')
  }
  if (envelope.schemaVersion !== BRIDGE_SCHEMA_VERSION) {
    throw new Error('Unsupported bridge schemaVersion')
  }
  const command = asString(envelope.command)
  if (!command || !SUPPORTED_COMMANDS.includes(command as BridgeCommandName)) {
    throw new Error(`Unsupported bridge command: ${String(envelope.command)}`)
  }
  const requestId = asString(envelope.requestId)
  const cwd = asString(envelope.cwd)
  const startedAt = asString(envelope.startedAt)
  const body = asRecord(envelope.body)
  if (!requestId || !cwd || !startedAt || !body) {
    throw new Error('Bridge envelope missing requestId, cwd, startedAt or body')
  }
  if (typeof envelope.timeoutMs === 'number' && !Number.isFinite(envelope.timeoutMs)) {
    throw new Error('Bridge envelope timeoutMs must be finite')
  }
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    requestId,
    command: command as BridgeCommandName,
    cwd,
    startedAt,
    timeoutMs: typeof envelope.timeoutMs === 'number' && envelope.timeoutMs > 0
      ? envelope.timeoutMs
      : 0,
    body,
  }
}


const SUPPORTED_OPENCODE_PROMPT_FILE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
])

export function parseOpenCodePromptFileParts(value: unknown): OpenCodePromptPart[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error('OpenCode attachment parts must be an array.')
  }

  return value.map((item, index): OpenCodePromptPart => {
    const record = asRecord(item)
    if (!record || record.type !== 'file') {
      throw new Error(`OpenCode attachment part at index ${index} must be a file part.`)
    }
    const mime = asString(record.mime)
    const url = asString(record.url)
    const filename = asString(record.filename)
    if (!mime || !url || !filename) {
      throw new Error(`OpenCode file part at index ${index} is missing mime, url, or filename.`)
    }
    if (!SUPPORTED_OPENCODE_PROMPT_FILE_MIME_TYPES.has(mime)) {
      throw new Error(`OpenCode file part at index ${index} has unsupported MIME: ${mime}`)
    }
    if (!url.startsWith(`data:${mime};base64,`)) {
      throw new Error(`OpenCode file part at index ${index} must use a matching data URL.`)
    }
    return {
      type: 'file',
      mime,
      url,
      filename,
    }
  })
}

