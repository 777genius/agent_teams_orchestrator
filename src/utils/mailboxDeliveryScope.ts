export type MailboxDeliveryScopeInput = {
  viewedTeammate: boolean
  inProcessTeammate: boolean
  nonInteractiveSession: boolean
}

export function shouldUseLiveInboxOwnerPath(
  scope: MailboxDeliveryScopeInput,
): boolean {
  return (
    !scope.viewedTeammate &&
    !scope.inProcessTeammate &&
    !scope.nonInteractiveSession
  )
}

export function shouldReadRegularMailboxMessagesFromFile(
  scope: MailboxDeliveryScopeInput,
): boolean {
  return (
    scope.viewedTeammate ||
    scope.inProcessTeammate ||
    scope.nonInteractiveSession
  )
}

export function shouldReadProtocolMailboxMessagesFromFile(
  scope: MailboxDeliveryScopeInput,
): boolean {
  return !shouldUseLiveInboxOwnerPath(scope)
}

export function shouldFinalizeFileBackedRegularMessages(
  scope: MailboxDeliveryScopeInput,
): boolean {
  return (
    shouldReadRegularMailboxMessagesFromFile(scope) &&
    !scope.nonInteractiveSession &&
    !scope.viewedTeammate
  )
}

export function shouldFinalizeFileBackedProtocolMessages(
  scope: MailboxDeliveryScopeInput,
): boolean {
  return (
    shouldReadProtocolMailboxMessagesFromFile(scope) &&
    scope.inProcessTeammate &&
    !scope.viewedTeammate &&
    !scope.nonInteractiveSession
  )
}
