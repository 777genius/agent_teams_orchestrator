import type { InboxPromptSubmitOptions, InboxPromptSubmitResult } from './useInboxPoller.js'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useMailbox } from '../context/mailbox.js'

type Props = {
  isLoading: boolean
  onSubmitMessage: (
    content: string,
    options?: InboxPromptSubmitOptions,
  ) => InboxPromptSubmitResult
}

export function useMailboxBridge({ isLoading, onSubmitMessage }: Props): void {
  const mailbox = useMailbox()

  const subscribe = useMemo(() => mailbox.subscribe.bind(mailbox), [mailbox])
  const getSnapshot = useCallback(() => mailbox.revision, [mailbox])
  const revision = useSyncExternalStore(subscribe, getSnapshot)

  useEffect(() => {
    if (isLoading) return
    const msg = mailbox.poll()
    if (msg) onSubmitMessage(msg.content, { submissionKind: 'mailbox' })
  }, [isLoading, revision, mailbox, onSubmitMessage])
}
