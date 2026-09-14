import { useEffect, useSyncExternalStore } from 'react'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'
import type { QueryGuard } from '../utils/QueryGuard.js'
import {
  getBoundWorkSyncContinuationTicket,
  isWorkSyncPostTurnAdmissionWindowOpen,
  processBoundWorkSyncContinuationAdmission,
} from '../utils/workSyncContinuationAdmission.js'
import { processQueueIfReady } from '../utils/queueProcessor.js'

type UseQueueProcessorParams = {
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>
  hasActiveLocalJsxUI: boolean
  isBootstrapAdmissionPending: boolean
  queryGuard: QueryGuard
}

/**
 * Hook that processes queued commands when conditions are met.
 *
 * Uses a single unified command queue (module-level store). Priority determines
 * processing order: 'now' > 'next' (user input) > 'later' (task notifications).
 * The dequeue() function handles priority ordering automatically.
 *
 * Processing triggers when:
 * - Bootstrap admission is no longer pending
 * - No query active (queryGuard — reactive via useSyncExternalStore)
 * - Queue has items
 * - No active local JSX UI blocking input
 */
export function useQueueProcessor({
  executeQueuedInput,
  hasActiveLocalJsxUI,
  isBootstrapAdmissionPending,
  queryGuard,
}: UseQueueProcessorParams): void {
  // Subscribe to the query guard. Re-renders when a query starts or ends
  // (or when reserve/cancelReservation transitions dispatching state).
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )

  // Subscribe to the unified command queue via useSyncExternalStore.
  // This guarantees re-render when the store changes, bypassing
  // React context propagation delays that cause missed notifications in Ink.
  const queueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )

  useEffect(() => {
    if (isQueryActive) return
    if (hasActiveLocalJsxUI) return
    if (queueSnapshot.length === 0) return

    // Drain D1 mailbox commands before ordinary queued prompts. A leftover D0
    // nudge must not tryStart during the idle window after settle.
    void (async () => {
      while (isWorkSyncPostTurnAdmissionWindowOpen()) {
        await processBoundWorkSyncContinuationAdmission()
        if (queryGuard.isActive || getBoundWorkSyncContinuationTicket()) {
          return
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await processBoundWorkSyncContinuationAdmission()
      if (queryGuard.isActive || getBoundWorkSyncContinuationTicket()) {
        return
      }
      processQueueIfReady({
        executeInput: executeQueuedInput,
        isBootstrapAdmissionPending,
      })
    })()
  }, [
    queueSnapshot,
    isBootstrapAdmissionPending,
    isQueryActive,
    executeQueuedInput,
    hasActiveLocalJsxUI,
    queryGuard,
  ])
}
