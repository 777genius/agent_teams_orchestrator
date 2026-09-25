import type { HostedAgentToolBinding } from '../agentTools/HostedAgentToolWal.js'
import type { HostedControlAuthority, HostedControlOwnerBinding } from '../protocol.js'

export type HostedAgentProductEffectScope = Readonly<{
  binding: Readonly<HostedAgentToolBinding>
  authority: Readonly<HostedControlAuthority>
  ownerBinding: Readonly<HostedControlOwnerBinding>
  messageID: string
  callID: string
  signal: AbortSignal
}>

export type HostedAgentProductTaskPin = Readonly<{
  taskId: string
  sourceGeneration: string
  revision: string
}>

export type HostedAgentProductRecipientPin = Readonly<{
  teamId: string
  runId: string
  laneId: string
  memberId: string
  memberName: string
}>

/**
 * Trusted Root/Product port. Each method must re-read Product-owned admission,
 * task/recipient identity and revision under the same fence as its durable write.
 * The Owner supplies only a proposed action; Product derives the canonical record.
 * The call ID must be idempotent for the exact binding and proposed action.
 */
export interface HostedAgentProductEffectWriter {
  commitTaskStatus(input: HostedAgentProductEffectScope & Readonly<{
    task: HostedAgentProductTaskPin
    status: 'in_progress' | 'completed'
  }>): Promise<string>
  appendTaskComment(input: HostedAgentProductEffectScope & Readonly<{
    task: HostedAgentProductTaskPin
    text: string
  }>): Promise<string>
  appendPeerMessage(input: HostedAgentProductEffectScope & Readonly<{
    recipient: HostedAgentProductRecipientPin
    text: string
    taskRefs: readonly HostedAgentProductTaskPin[]
  }>): Promise<string>
}

/** No Product final-write API is installed yet. Never fall back to Owner files. */
export const INACTIVE_HOSTED_AGENT_PRODUCT_EFFECT_WRITER: HostedAgentProductEffectWriter = Object.freeze({
  commitTaskStatus: async () => { throw new Error('Hosted Product task writer unavailable') },
  appendTaskComment: async () => { throw new Error('Hosted Product comment writer unavailable') },
  appendPeerMessage: async () => { throw new Error('Hosted Product message writer unavailable') },
})
