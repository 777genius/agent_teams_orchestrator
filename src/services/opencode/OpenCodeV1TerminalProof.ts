import type { OpenCodeCanonicalMessage, OpenCodeSessionRecord } from './types.js'

export type OpenCodeV1TerminalAuthority = Pick<OpenCodeSessionRecord, 'hostKey' | 'runId' | 'profileRootKey' | 'projectPath'>

/** A captured, bounded native read. Completeness and interaction state are explicit. */
export type OpenCodeV1TerminalEvidence = {
  authority?: OpenCodeV1TerminalAuthority
  sessionId: string
  messages: OpenCodeCanonicalMessage[]
  messageSessionIds: Array<string | null>
  /** Transport budget/deadline prevented the first read; no native response was observed. */
  readUnavailable?: boolean
  complete: boolean
  interactionsSettled: boolean
  diagnostics: string[]
}
export type OpenCodeV1TerminalProof = {
  sessionId: string
  runtimePromptMessageId: string
  assistantMessageId: string
  outcome: 'success' | 'error'
  evidence: OpenCodeV1TerminalEvidence
}
export function qualifyOpenCodeV1TerminalProof(
  evidence: OpenCodeV1TerminalEvidence | null | undefined,
  sessionId: string,
  runtimePromptMessageId: string | null | undefined,
): { proof: OpenCodeV1TerminalProof | null; diagnostics: string[] } {
  const reject = (reason: string) => ({ proof: null, diagnostics: [reason] })
  if (!runtimePromptMessageId || !sessionId || evidence?.sessionId !== sessionId) return reject('Missing or conflicting native session/prompt identity')
  if (evidence.complete !== true || evidence.interactionsSettled !== true) return reject('Incomplete transcript or unsettled interaction evidence')
  const messages = evidence.messages
  if (messages.length !== evidence.messageSessionIds.length || evidence.messageSessionIds.some(id => id !== sessionId)) return reject('Missing or foreign native message session')
  const ids = new Set<string>()
  let previousCreated = -1
  for (const message of messages) {
    if (!message.id || ids.has(message.id)) return reject('Missing or duplicate native message ID')
    ids.add(message.id)
    if (message.createdAt === null || !Number.isFinite(message.createdAt) || message.createdAt < 0 || message.createdAt < previousCreated) return reject('Invalid transcript chronology')
    previousCreated = message.createdAt
    if (message.role !== 'user' && message.role !== 'assistant') return reject('Unknown native message role')
  }
  const anchor = messages.findIndex(message => message.role === 'user' && message.id === runtimePromptMessageId)
  if (anchor < 0) return reject('Persisted exact user anchor missing')
  const following = messages.slice(anchor + 1)
  const nextUser = following.findIndex(message => message.role === 'user')
  const window = following.slice(0, nextUser < 0 ? undefined : nextUser)
  // A parent link crossing a later user boundary conflicts with the captured window.
  if (nextUser >= 0 && following.slice(nextUser).some(message => message.parentId === runtimePromptMessageId)) return reject('Native parent crosses user boundary')
  if (window.some(message => message.parentId !== runtimePromptMessageId)) return reject('Foreign parent in native user window')
  const latest = window.at(-1)
  if (!latest || latest.role !== 'assistant' || !latest.id) return reject('No latest relevant assistant')
  for (const message of window) {
    if (message.completedAt === null || !Number.isFinite(message.completedAt) || message.completedAt < (message.createdAt ?? Infinity)) return reject('Incomplete relevant assistant history')
    if (message.toolCalls.some(tool => !tool.callId || (tool.status !== 'completed' && tool.status !== 'errored') || tool.startedAt === null || tool.completedAt === null || !Number.isFinite(tool.startedAt) || !Number.isFinite(tool.completedAt) || tool.completedAt < tool.startedAt)) return reject('Unsettled or unknown native tool disposition')
  }
  if (latest.completedAt === null || !Number.isFinite(latest.completedAt) || latest.completedAt < (latest.createdAt ?? Infinity)) return reject('Latest assistant is incomplete or has invalid completion timestamp')
  // Only the measured native V1 variants qualify. Tool errors are step progress.
  let outcome: 'success' | 'error'
  if (latest.errorName === 'MessageAbortedError' && latest.finishReason === null) outcome = 'error'
  else if (!latest.hasError && latest.errorName === null && latest.errorMessage === null && latest.finishReason === 'stop') outcome = 'success'
  else return reject(`Unqualified native finish/error: ${latest.finishReason ?? 'none'}/${latest.errorName ?? 'none'}`)
  return { proof: { sessionId, runtimePromptMessageId, assistantMessageId: latest.id, outcome, evidence }, diagnostics: [] }
}
