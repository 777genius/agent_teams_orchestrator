import { assertNoDuplicateJsonObjectKeys } from '../ownerProof.js'

export const HOSTED_AGENT_TOOL_MAX_FRAME_BYTES = 64 * 1024

export type HostedAgentToolName =
  | 'hosted_task_get'
  | 'hosted_task_start'
  | 'hosted_task_complete'
  | 'hosted_task_add_comment'
  | 'hosted_message_send'

export type HostedAgentToolArgs =
  | { taskId: string }
  | { taskId: string; text: string }
  | { to: string; text: string; taskRefs?: readonly { teamName: string; taskId: string }[] }

export type HostedAgentToolRequest = {
  version: 1
  type: 'request'
  requestId: string
  tool: HostedAgentToolName
  context: { sessionID: string; messageID: string; callID: string }
  args: HostedAgentToolArgs
}

export type HostedAgentToolResponse =
  | { version: 1; type: 'response'; requestId: string; ok: true; result: string }
  | { version: 1; type: 'response'; requestId: string; ok: false; error: string }

/** Parses only the five hosted tools. Team, member, root and actor are Owner-derived. */
export function decodeHostedAgentToolRequest(raw: string): HostedAgentToolRequest {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') < 2 ||
    Buffer.byteLength(raw, 'utf8') > HOSTED_AGENT_TOOL_MAX_FRAME_BYTES ||
    raw.includes('\n') || raw.includes('\r')) {
    throw new TypeError('Invalid hosted agent tool frame')
  }
  assertNoDuplicateJsonObjectKeys(raw)
  const frame = exactRecord(JSON.parse(raw), ['version', 'type', 'requestId', 'tool', 'context', 'args'], 'frame')
  if (frame.version !== 1 || frame.type !== 'request') throw new TypeError('Invalid hosted agent tool version/type')
  const context = exactRecord(frame.context, ['sessionID', 'messageID', 'callID'], 'context')
  const parsedContext = {
    sessionID: boundedId(context.sessionID, 'sessionID'),
    messageID: boundedId(context.messageID, 'messageID'),
    callID: boundedId(context.callID, 'callID'),
  }
  const requestId = boundedId(frame.requestId, 'requestId')
  const args = asRecord(frame.args, 'args')
  switch (frame.tool) {
    case 'hosted_task_get':
    case 'hosted_task_start':
    case 'hosted_task_complete':
      exactKeys(args, ['taskId'], 'args')
      return { version: 1, type: 'request', requestId, tool: frame.tool,
        context: parsedContext, args: { taskId: taskId(args.taskId) } }
    case 'hosted_task_add_comment':
      exactKeys(args, ['taskId', 'text'], 'args')
      return { version: 1, type: 'request', requestId, tool: frame.tool,
        context: parsedContext, args: { taskId: taskId(args.taskId), text: text(args.text, 20_000) } }
    case 'hosted_message_send': {
      const hasRefs = Object.hasOwn(args, 'taskRefs')
      exactKeys(args, ['to', 'text', ...(hasRefs ? ['taskRefs'] : [])], 'args')
      if (typeof args.to !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(args.to)) {
        throw new TypeError('Invalid hosted message recipient')
      }
      const taskRefs = hasRefs ? parseTaskRefs(args.taskRefs) : undefined
      return { version: 1, type: 'request', requestId, tool: frame.tool,
        context: parsedContext,
        args: { to: args.to, text: text(args.text, 4_000), ...(taskRefs ? { taskRefs } : {}) } }
    }
    default:
      throw new TypeError('Unsupported hosted agent tool')
  }
}

export function hostedAgentToolResponse(
  requestId: string,
  outcome: { result: string } | { error: string },
): HostedAgentToolResponse {
  const id = boundedId(requestId, 'requestId')
  if ('result' in outcome) return { version: 1, type: 'response', requestId: id,
    ok: true, result: validateHostedAgentToolResult(outcome.result) }
  return { version: 1, type: 'response', requestId: id,
    ok: false, error: responseText(outcome.error, 1024) }
}

/** The durable terminal value must always be serializable as a successful response. */
export function validateHostedAgentToolResult(value: unknown): string {
  return responseText(value, 64 * 1024)
}

function parseTaskRefs(value: unknown): readonly { teamName: string; taskId: string }[] {
  if (!Array.isArray(value) || value.length > 16) throw new TypeError('Invalid hosted taskRefs')
  return value.map((candidate, index) => {
    const ref = exactRecord(candidate, ['teamName', 'taskId'], `taskRef ${index}`)
    return { teamName: text(ref.teamName, 128), taskId: taskId(ref.taskId) }
  })
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^task_[0-9a-f]{32}$/.test(value)) {
    throw new TypeError('Invalid hosted taskId')
  }
  return value
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new TypeError(`Invalid hosted ${field}`)
  }
  return value
}

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > maxBytes || hasDisallowedControl(value)) {
    throw new TypeError('Invalid hosted agent tool text')
  }
  return value
}

function hasDisallowedControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code === 127 || (code < 32 && code !== 9 && code !== 10) ||
      (code >= 0x80 && code <= 0x9f) || code === 0x061c ||
      (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)) return true
  }
  return false
}

function responseText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) {
    throw new TypeError('Invalid hosted agent tool response text')
  }
  return value
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid hosted ${field}`)
  return value as Record<string, unknown>
}

function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const record = asRecord(value, field)
  exactKeys(record, keys, field)
  return record
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Reflect.ownKeys(record)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError(`Invalid hosted ${field} keys`)
  }
}
