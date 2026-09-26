import {
  FailClosedHostedLifecycleAuthorityEffects,
} from './FailClosedHostedLifecycleAuthorityEffects.js'
import {
  HostedLifecycleCommandService,
  type HostedLifecycleAuthorityEffectPort,
  type HostedLifecycleAuthorityGuard,
  type HostedLifecyclePlanAdmissionPort,
} from './HostedLifecycleCommandService.js'
import {
  HostedTeamMessageService,
  type HostedMessageAuthorityGuard,
  type HostedMessageDeliveryWaker,
} from './HostedTeamMessageService.js'
import type { HostedMessageRecipientRoster } from './HostedTeamRecipientRoster.js'

export type HostedControlEffectServicesOptions = {
  /** Canonical team root whose inboxes hosted user messages are appended to. */
  canonicalTeamRoot: string
  lifecycleGuard: HostedLifecycleAuthorityGuard
  messageGuard: HostedMessageAuthorityGuard
  lifecycleEffects?: HostedLifecycleAuthorityEffectPort
  planAdmission?: HostedLifecyclePlanAdmissionPort
  /** Admits teammate recipients; without it only lead messages are sent. */
  messageRecipients?: HostedMessageRecipientRoster
  /** Prompts OpenCode recipients; without it the appended row is the delivery. */
  messagePump?: HostedMessageDeliveryWaker
}

/** Creates the two concrete effect-backed ports consumed by HostedControlRuntime. */
export function createHostedControlEffectServices(options: HostedControlEffectServicesOptions): {
  lifecycle: HostedLifecycleCommandService
  messages: HostedTeamMessageService
} {
  const lifecycleEffects = options.lifecycleEffects ?? new FailClosedHostedLifecycleAuthorityEffects()
  return {
    lifecycle: new HostedLifecycleCommandService(lifecycleEffects, options.lifecycleGuard, Date.now,
      options.planAdmission),
    messages: new HostedTeamMessageService({
      canonicalTeamRoot: options.canonicalTeamRoot,
      guard: options.messageGuard,
      recipients: options.messageRecipients ?? null,
      ...(options.messagePump ? { pump: options.messagePump } : {}),
    }),
  }
}
