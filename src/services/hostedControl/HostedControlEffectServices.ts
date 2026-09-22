import {
  FailClosedHostedLifecycleAuthorityEffects,
} from './FailClosedHostedLifecycleAuthorityEffects.js'
import {
  HostedLifecycleCommandService,
  type HostedLifecycleAuthorityEffectPort,
  type HostedLifecycleAuthorityGuard,
} from './HostedLifecycleCommandService.js'
import { HostedMessageFileStore } from './HostedMessageFileStore.js'
import {
  FailClosedHostedMessageDelivery,
  HostedTeamMessageService,
  type HostedMessageAuthorityGuard,
  type HostedMessageDeliveryEffectPort,
} from './HostedTeamMessageService.js'

export type HostedControlEffectServicesOptions = {
  messageDirectory: string
  teamId: string
  lifecycleGuard: HostedLifecycleAuthorityGuard
  messageGuard: HostedMessageAuthorityGuard
  lifecycleEffects?: HostedLifecycleAuthorityEffectPort
  messageDelivery?: HostedMessageDeliveryEffectPort
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
    lifecycle: new HostedLifecycleCommandService(lifecycleEffects, options.lifecycleGuard),
    messages: new HostedTeamMessageService(messagePersistence, messageDelivery, options.messageGuard),
  }
}
