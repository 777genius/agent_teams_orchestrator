import { z } from 'zod'

import {
  createHostedOwnerFdExchange,
  type HostedOwnerExchange,
  type HostedOwnerToolName,
} from './HostedOwnerFdTransport.js'

// OpenCode v1.18.32 packages/plugin/src/tool.ts uses a Zod raw shape and
// execute(args, ToolContext). Its registry forwards callID at runtime although
// the published ToolContext type omits it, so we validate that field ourselves.
const id = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/)
const taskId = z.string().regex(/^task_[0-9a-f]{32}$/)
const memberId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const commentText = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 20_000)
const messageText = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 4_000)
const contextId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

const argsByTool = {
  hosted_task_get: { taskId },
  hosted_task_start: { taskId },
  hosted_task_complete: { taskId },
  hosted_task_add_comment: { taskId, text: commentText },
  hosted_message_send: {
    to: memberId,
    text: messageText,
    taskRefs: z.array(z.strictObject({ teamName: id, taskId })).max(16).optional(),
  },
} as const

type OfficialToolDefinition = {
  description: string
  args: Record<string, z.ZodType>
  execute(args: unknown, context: unknown): Promise<string>
}

type OfficialPluginHooks = {
  tool: Readonly<Record<HostedOwnerToolName, OfficialToolDefinition>>
  dispose(): Promise<void>
}

const descriptions: Readonly<Record<HostedOwnerToolName, string>> = Object.freeze({
  hosted_task_get: 'Read a task from the hosted Owner.',
  hosted_task_start: 'Start a task through the hosted Owner.',
  hosted_task_complete: 'Complete a task through the hosted Owner.',
  hosted_task_add_comment: 'Add a task comment through the hosted Owner.',
  hosted_message_send: 'Send a team message through the hosted Owner.',
})

function strictContext(value: unknown): {
  context: { sessionID: string; messageID: string; callID: string }
  signal: AbortSignal
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Hosted tool runtime context unavailable')
  }
  const candidate = value as Record<string, unknown>
  const parsed = z.strictObject({
    sessionID: contextId,
    messageID: contextId,
    callID: contextId,
  }).safeParse({
    sessionID: candidate.sessionID,
    messageID: candidate.messageID,
    callID: candidate.callID,
  })
  if (!parsed.success) throw new Error('Hosted tool runtime context unavailable')
  if (!(candidate.abort instanceof AbortSignal)) {
    throw new Error('Hosted tool runtime context unavailable')
  }
  const signal = candidate.abort
  if (signal.aborted) {
    throw new Error('Hosted tool call aborted')
  }
  return { context: parsed.data, signal }
}

/** Structural match for the official v1.18.32 Plugin factory and tool hooks. */
export function createHostedOwnerToolPlugin(options: { exchange?: HostedOwnerExchange } = {}) {
  const exchange = options.exchange ?? createHostedOwnerFdExchange()
  const tool = Object.freeze(Object.fromEntries(
    (Object.keys(argsByTool) as HostedOwnerToolName[]).map(name => {
      const args = Object.freeze({ ...argsByTool[name] })
      const schema = z.strictObject(args)
      return [name, Object.freeze({
        description: descriptions[name],
        args,
        async execute(input: unknown, runtime: unknown): Promise<string> {
          const { context, signal } = strictContext(runtime)
          const parsed = schema.safeParse(input)
          if (!parsed.success) throw new Error('Hosted tool arguments invalid')
          return exchange({ tool: name, context, args: parsed.data }, signal)
        },
      })]
    }),
  )) as unknown as Readonly<Record<HostedOwnerToolName, OfficialToolDefinition>>
  const hooks: OfficialPluginHooks = Object.freeze({
    tool,
    async dispose(): Promise<void> {
      if ('dispose' in exchange && typeof exchange.dispose === 'function') exchange.dispose()
    },
  })
  return async () => hooks
}
