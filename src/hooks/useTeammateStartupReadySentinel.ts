import { useEffect, useRef } from 'react'

import type { AppState } from '../state/AppState.js'
import { getCwd } from '../utils/cwd.js'
import {
  TEAMMATE_STARTUP_READY_SENTINEL_ENV,
  shouldWriteTeammateStartupReadySentinel,
  writeStartupReadySentinel,
} from '../utils/swarm/startupReadySentinel.js'
import { writeTeammateRuntimeEvent } from '../utils/swarm/teammateRuntimeEvents.js'

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
    void writeTeammateRuntimeEvent({
      type: 'runtime_ready',
      teamName: params.teamContext.teamName,
      agentName: params.teamContext.selfAgentName,
      agentId: params.teamContext.selfAgentId,
      runId: params.sessionId,
      cwd: getCwd(),
    })
  }, [params.enabled, params.sessionId, params.teamContext])
}
