import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { InboxPumpDecision } from './HostedTeamLeadInboxPump.js'
import type { HostedMessageDeliveryEffectPort } from './HostedTeamMessageService.js'
import type { HostedTeamInboxPumpPort } from './HostedControlProductionComposition.js'

/**
 * How long message_deliver waits for the pump before answering `pending`. It must
 * stay well inside Product's 5s owner-exchange deadline.
 */
export const HOSTED_INBOX_PUMP_CONFIRMATION_MS = 2_000

type RuntimeDelivery = Awaited<ReturnType<HostedMessageDeliveryEffectPort['deliver']>>

/**
 * Wraps the inbox append with the pump that prompts the recipient's OpenCode
 * session. `delivered` means the runtime accepted the prompt in that session,
 * or that a native recipient reads the appended row itself. An appended row the
 * pump has not confirmed yet is `pending`, never `delivered`; the pump keeps
 * working in the background and its recovery loop retries.
 */
export function confirmDeliveryThroughInboxPump(
  append: HostedMessageDeliveryEffectPort,
  pump: Pick<HostedTeamInboxPumpPort, 'wake'>,
  confirmationMs = HOSTED_INBOX_PUMP_CONFIRMATION_MS,
): HostedMessageDeliveryEffectPort {
  return {
    deliver: async (message, authority) => {
      const appended = await append.deliver(message, authority)
      if (appended.kind !== 'delivered') return appended
      const wake = pump.wake({ recipient: message.recipient ?? TEAM_LEAD_NAME, message, authority })
        .catch((): InboxPumpDecision => ({ kind: 'unavailable' }))
      const decision = await settleWithin(wake, confirmationMs)
      return decision === null ? { kind: 'pending' } : runtimeDeliveryFor(decision)
    },
  }
}

function runtimeDeliveryFor(decision: InboxPumpDecision): RuntimeDelivery {
  switch (decision.kind) {
    case 'accepted':
    case 'observed':
    case 'native_inbox':
      return { kind: 'delivered' }
    case 'operator_required':
      return { kind: 'operator_required' }
    default:
      return { kind: 'pending' }
  }
}

async function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}
