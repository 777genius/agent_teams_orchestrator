import { isGroupNonResponseText } from './groupNonResponse.js'
import { createHash } from 'node:crypto'
import type { GroupMailboxEnvelope } from './groupMailbox.js'

// Capture the existing app binding. Never retarget a live runtime via mutable env.
const controlUrl = process.env.AGENT_TEAMS_BOUND_CONTROL_URL
const context = process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON

export function hasBoundGroupChatControl(): boolean {
  return isBoundGroupChatControl(controlUrl, context)
}

export function isBoundGroupChatControl(controlUrl?: string, context?: string): boolean {
  if (!controlUrl || !context) return false
  try {
    const url = new URL(controlUrl)
    const binding = JSON.parse(context)
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
      !!url.port && url.origin === controlUrl && !url.username && !url.password &&
      typeof binding.appInstanceId === 'string' && !!binding.appInstanceId.trim() &&
      typeof binding.dataRootFingerprint === 'string' && !!binding.dataRootFingerprint.trim() &&
      Number.isSafeInteger(binding.connectionGeneration) && binding.connectionGeneration > 0
  } catch { return false }
}

export async function relayGroupAssistantText(input: {
  teamName: string; from: string; message: GroupMailboxEnvelope & { messageId?: string; from?: string }; text: string
}, binding = { controlUrl, context }): Promise<void> {
  if (!isBoundGroupChatControl(binding.controlUrl, binding.context) || !input.message.groupChatId || !input.message.messageId) {
    throw new Error('Group reply unavailable: missing bound app or physical inbound identity')
  }
  const sender = input.message.from?.trim().toLowerCase()
  // Invoked only after a native mailbox turn completes. Explicit tool sends
  // are separate; never suppress a human request or infer from a preview.
  if (sender && sender !== 'user' && sender !== 'system' && isGroupNonResponseText(input.text)) return
  // Retry of the same physical reply uses the same valid UUID, never a second post.
  const bytes = createHash('sha256').update(JSON.stringify([input.teamName, input.from, input.message.groupChatId, input.message.messageId, input.text])).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  const messageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  const response = await fetch(`${binding.controlUrl}/api/teams/${encodeURIComponent(input.teamName)}/group-chats/send`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', 'x-agent-teams-app-context': binding.context! },
    body: JSON.stringify({ from: input.from, groupChatId: input.message.groupChatId, messageId, relayOfMessageId: input.message.messageId, text: input.text }),
  })
  if (!response.ok) throw new Error(`Group reply blocked or unavailable: HTTP ${response.status}`)
  const result = await response.json() as { saved?: unknown; groupChatId?: unknown; groupMessageId?: unknown; messageId?: unknown; relayOfMessageId?: unknown }
  if (result.saved !== true || result.groupChatId !== input.message.groupChatId ||
      (result.groupMessageId ?? result.messageId) !== messageId || result.relayOfMessageId !== input.message.messageId) {
    throw new Error('Group reply has no exact canonical save acknowledgement')
  }
}

export async function readFreshGroupChatCatalog(teamName: string, from: string, binding = { controlUrl, context }): Promise<unknown> {
  if (!isBoundGroupChatControl(binding.controlUrl, binding.context)) throw new Error('Bound group catalog unavailable')
  const response = await fetch(`${binding.controlUrl}/api/teams/${encodeURIComponent(teamName)}/group-chats/list`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-agent-teams-app-context': binding.context! },
    body: JSON.stringify({ from }),
  })
  if (!response.ok) throw new Error(`Group catalog unavailable: HTTP ${response.status}`)
  const catalog: unknown = await response.json()
  if (!Array.isArray(catalog)) throw new Error('Group catalog unavailable: invalid response')
  return catalog
}

export async function getFreshGroupChatDiscoveryPrompt(teamName: string, from: string, binding = { controlUrl, context }): Promise<string> {
  let catalog: unknown
  try { catalog = await readFreshGroupChatCatalog(teamName, from, binding) } catch { /* Fail closed, never invent an empty catalog. */ }
  return [
    catalog === undefined ? 'Fresh group catalog unavailable.' : `Fresh group catalog: ${JSON.stringify(catalog)}`,
    `After compaction, call group_chat_list with ${JSON.stringify({ teamName, from })} before a proactive group post.`,
    'group_chat_react optionally acknowledges one informational inbound using its explicit groupChatId and physical relayOfMessageId. After success stop without an extra OK. Never answer a reaction; still send requested or substantive replies with group_chat_send.',
    'Use group_chat_send with an explicit groupChatId. For a reply preserve its physical inbound relayOfMessageId. Archived or blocked groups never fall back to a private message.',
  ].join('\n')
}
