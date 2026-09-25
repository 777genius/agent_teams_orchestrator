import {
  FailClosedHostedLifecycleAuthorityEffects,
} from './FailClosedHostedLifecycleAuthorityEffects.js'
import {
  HostedLifecycleCommandService,
  type HostedLifecycleAuthorityEffectPort,
  type HostedLifecycleAuthorityGuard,
  type HostedLifecyclePlanAdmissionPort,
} from './HostedLifecycleCommandService.js'
import { HostedMessageFileStore } from './HostedMessageFileStore.js'
import {
  FailClosedHostedMessageDelivery,
  HostedTeamMessageService,
  type HostedMessageAuthorityGuard,
  type HostedMessageDeliveryEffectPort,
} from './HostedTeamMessageService.js'
import type { HostedMessageRecipientRoster } from './HostedTeamRecipientRoster.js'

export type HostedControlEffectServicesOptions = {
  messageDirectory: string
  teamId: string
  lifecycleGuard: HostedLifecycleAuthorityGuard
  messageGuard: HostedMessageAuthorityGuard
  lifecycleEffects?: HostedLifecycleAuthorityEffectPort
  planAdmission?: HostedLifecyclePlanAdmissionPort
  messageDelivery?: HostedMessageDeliveryEffectPort
  /** Admits teammate recipients; without it only lead messages are persisted. */
  messageRecipients?: HostedMessageRecipientRoster
}

/** Creates the two concrete effect-backed ports consumed by HostedControlRuntime. */
export function createHostedControlEffectServices(options: HostedControlEffectServicesOptions): {
  lifecycle: HostedLifecycleCommandService
  messages: HostedTeamMessageService
} {
  const lifecycleEffects = options.lifecycleEffects ?? new FailClosedHostedLifecycleAuthorityEffects()
  const messagePersistence = new HostedMessageFileStore(options.messageDirectory, options.teamId)
  const messageDelivery = options.messageDelivery ?? new FailClosedHostedMessageDelivery()
  return {
    lifecycle: new HostedLifecycleCommandService(lifecycleEffects, options.lifecycleGuard, Date.now,
      options.planAdmission),
    messages: new HostedTeamMessageService(messagePersistence, messageDelivery, options.messageGuard,
      options.messageRecipients ?? null),
  }
}
