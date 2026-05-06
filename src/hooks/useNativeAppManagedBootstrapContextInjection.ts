import { useCallback, useRef } from 'react'

import type { AppState } from '../state/AppState.js'
import { createUserMessage } from '../utils/messages.js'
import { writeTeammateRuntimeEvent } from '../utils/swarm/teammateRuntimeEvents.js'
import {
  loadNativeAppManagedBootstrapContextInjection,
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV,
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_SOURCE,
  type NativeAppManagedBootstrapContextInjection,
} from '../services/teamBootstrap/nativeAppManagedBootstrapContext.js'

export type NativeAppManagedBootstrapTurnInjection = {
  prefixMessages: AppState['messages']
  contextHash: string
  briefingHash: string
  bootstrapProofToken: string
  runId: string
  markContextLoaded: () => Promise<void>
}

export type GetNativeAppManagedBootstrapContextInjection = () => Promise<
  NativeAppManagedBootstrapTurnInjection | null
>

export function useNativeAppManagedBootstrapContextInjection(): {
  getNativeAppManagedBootstrapContextInjection: GetNativeAppManagedBootstrapContextInjection
} {
  const loadPromiseRef = useRef<Promise<NativeAppManagedBootstrapContextInjection | null> | null>(null)
  const contextLoadedWrittenRef = useRef(false)

  const getNativeAppManagedBootstrapContextInjection = useCallback(async () => {
    const contextPath = process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]
    if (!contextPath) {
      return null
    }

    if (!loadPromiseRef.current) {
      loadPromiseRef.current = loadNativeAppManagedBootstrapContextInjection(contextPath)
        .catch(async error => {
          await writeTeammateRuntimeEvent({
            type: 'failed',
            detail: `Native app-managed bootstrap context failed to load: ${String(error instanceof Error ? error.message : error)}`,
          })
          return null
        })
    }

    const injection = await loadPromiseRef.current
    if (!injection) {
      return null
    }

    const prefixMessage = createUserMessage({
      content: injection.prefixMessagesText,
      isMeta: true,
    })

    return {
      prefixMessages: [prefixMessage],
      contextHash: injection.contextHash,
      briefingHash: injection.briefingHash,
      bootstrapProofToken: injection.bootstrapProofToken,
      runId: injection.runId,
      markContextLoaded: async () => {
        if (contextLoadedWrittenRef.current) {
          return
        }
        contextLoadedWrittenRef.current = true
        await writeTeammateRuntimeEvent({
          type: 'bootstrap_context_loaded',
          teamName: injection.teamName,
          agentName: injection.memberName,
          agentId: injection.agentId,
          runId: injection.runId,
          source: NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_SOURCE,
          bootstrapProofToken: injection.bootstrapProofToken,
          contextHash: injection.contextHash,
          briefingHash: injection.briefingHash,
          detail: JSON.stringify({
            contextHash: injection.contextHash,
            briefingHash: injection.briefingHash,
          }),
        })
      },
    }
  }, [])

  return { getNativeAppManagedBootstrapContextInjection }
}
