import { isOpenCodeInventoryTimeoutSnapshot } from '../opencode/OpenCodeInventoryService.js'

import type { OpenCodeInventorySnapshot } from '../opencode/types.js'
import type { RuntimeProviderStatus } from './types.js'

type RuntimeProviderStatusCheck = Pick<
  RuntimeProviderStatus,
  'statusCheckOutcome' | 'statusCheckErrorCode'
>

/**
 * Inventory timeouts are an observation failure, not evidence that OpenCode
 * disconnected. Only completed inventory snapshots can make runtime truth
 * authoritative.
 */
export function getOpenCodeRuntimeStatusCheck(
  snapshot: OpenCodeInventorySnapshot,
): RuntimeProviderStatusCheck {
  if (isOpenCodeInventoryTimeoutSnapshot(snapshot)) {
    return {
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
    }
  }

  if (snapshot.probeError) {
    return {
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
    }
  }

  if (!snapshot.detected) {
    return {
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: 'runtime_missing',
    }
  }

  return { statusCheckOutcome: 'authoritative' }
}
