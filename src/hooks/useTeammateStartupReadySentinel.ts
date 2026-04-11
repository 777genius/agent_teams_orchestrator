import { useEffect, useRef } from 'react'

import type { AppState } from '../state/AppState.js'
import {
  TEAMMATE_STARTUP_READY_SENTINEL_ENV,
  shouldWriteTeammateStartupReadySentinel,
  writeStartupReadySentinel,
} from '../utils/swarm/startupReadySentinel.js'

export function useTeammateStartupReadySentinel(params: {
  enabled: boolean
  teamContext: AppState['teamContext'] | undefined
  sessionId: string
}): void {
  const didWriteRef = useRef(false)

  useEffect(() => {
    const sentinelPath = process.env[TEAMMATE_STARTUP_READY_SENTINEL_ENV]

    if (
      !shouldWriteTeammateStartupReadySentinel({
        enabled: params.enabled,
        didWriteAlready: didWriteRef.current,
        teamContext: params.teamContext,
        sentinelPath,
      })
    ) {
      return
    }

    // Probe-only signal. This only means the child reached REPL runtime init
    // with swarm hooks attached. It is not bootstrap completion or contact.
    didWriteRef.current = true

    void writeStartupReadySentinel({
      filePath: sentinelPath,
      teamName: params.teamContext.teamName,
      agentName: params.teamContext.selfAgentName,
      sessionId: params.sessionId,
    })
  }, [params.enabled, params.sessionId, params.teamContext])
}
