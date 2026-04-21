import type {
  BoardTaskActorContext,
  BoardTaskLocator,
  BoardTaskPhase,
} from './contract.js'
import type { BoardTaskTransition } from './BoardTaskToolInterpreter.js'

type ActiveScope = {
  locator: BoardTaskLocator
  phase: BoardTaskPhase
  activeExecutionSeq: number
}

type ActorExecutionState = {
  openScopes: Map<string, ActiveScope>
  nextSeqByScopeKey: Map<string, number>
  processedToolUseIds: Set<string>
}

const MAX_PROCESSED_TOOL_USE_IDS = 2048

function cloneLocator(locator: BoardTaskLocator): BoardTaskLocator {
  return {
    ref: locator.ref,
    refKind: locator.refKind,
    ...(locator.canonicalId ? { canonicalId: locator.canonicalId } : {}),
  }
}

function buildActorKey(sessionId: string, agentId?: string): string {
  return `${sessionId}::${agentId ?? 'main'}`
}

function buildTaskIdentityKey(locator: BoardTaskLocator): string {
  return locator.canonicalId ?? `${locator.refKind}:${locator.ref}`
}

function buildScopeKey(
  phase: BoardTaskPhase,
  locator: BoardTaskLocator,
): string {
  return `${phase}::${buildTaskIdentityKey(locator)}`
}

function isSameTask(
  left: BoardTaskLocator,
  right: BoardTaskLocator,
): boolean {
  const leftIdentity = buildTaskIdentityKey(left)
  const rightIdentity = buildTaskIdentityKey(right)
  return leftIdentity === rightIdentity
}

function mergeLocator(
  current: BoardTaskLocator,
  incoming: BoardTaskLocator,
): BoardTaskLocator {
  if (current.canonicalId && !incoming.canonicalId) {
    return cloneLocator(current)
  }

  return {
    ref: incoming.ref,
    refKind: incoming.refKind,
    ...(incoming.canonicalId ?? current.canonicalId
      ? { canonicalId: incoming.canonicalId ?? current.canonicalId }
      : {}),
  }
}

export class RuntimeBoardTaskExecutionStore {
  private readonly stateByActorKey = new Map<string, ActorExecutionState>()

  private getState(sessionId: string, agentId?: string): ActorExecutionState | undefined {
    return this.stateByActorKey.get(buildActorKey(sessionId, agentId))
  }

  private getOrCreateState(sessionId: string, agentId?: string): ActorExecutionState {
    const actorKey = buildActorKey(sessionId, agentId)
    const existing = this.stateByActorKey.get(actorKey)
    if (existing) {
      return existing
    }

    const created: ActorExecutionState = {
      openScopes: new Map(),
      nextSeqByScopeKey: new Map(),
      processedToolUseIds: new Set(),
    }
    this.stateByActorKey.set(actorKey, created)
    return created
  }

  hasProcessedToolUseId(
    sessionId: string,
    agentId: string | undefined,
    toolUseId: string,
  ): boolean {
    return this.getState(sessionId, agentId)?.processedToolUseIds.has(toolUseId) ?? false
  }

  markProcessedToolUseId(
    sessionId: string,
    agentId: string | undefined,
    toolUseId: string,
  ): void {
    const processedToolUseIds = this.getOrCreateState(
      sessionId,
      agentId,
    ).processedToolUseIds
    processedToolUseIds.add(toolUseId)
    while (processedToolUseIds.size > MAX_PROCESSED_TOOL_USE_IDS) {
      const oldest = processedToolUseIds.values().next().value
      if (typeof oldest !== 'string') {
        break
      }
      processedToolUseIds.delete(oldest)
    }
  }

  getSingleActiveScope(
    sessionId: string,
    agentId?: string,
  ): ActiveScope | null {
    const state = this.getState(sessionId, agentId)
    if (!state) {
      return null
    }
    const openScopes = [...state.openScopes.values()]
    if (openScopes.length !== 1) {
      return null
    }
    const scope = openScopes[0]
    return {
      locator: cloneLocator(scope.locator),
      phase: scope.phase,
      activeExecutionSeq: scope.activeExecutionSeq,
    }
  }

  getOpenScopeCount(
    sessionId: string,
    agentId?: string,
  ): number {
    return this.getState(sessionId, agentId)?.openScopes.size ?? 0
  }

  getActiveScopes(
    sessionId: string,
    agentId?: string,
  ): ActiveScope[] {
    const state = this.getState(sessionId, agentId)
    if (!state) {
      return []
    }
    return [...state.openScopes.values()].map(scope => ({
      locator: cloneLocator(scope.locator),
      phase: scope.phase,
      activeExecutionSeq: scope.activeExecutionSeq,
    }))
  }

  getActorContextForTarget(
    sessionId: string,
    agentId: string | undefined,
    targetTask: BoardTaskLocator,
  ): BoardTaskActorContext {
    const state = this.getState(sessionId, agentId)
    if (!state) {
      return { relation: 'idle' }
    }
    const openScopes = [...state.openScopes.values()]

    if (openScopes.length === 0) {
      return { relation: 'idle' }
    }

    if (openScopes.length > 1) {
      return { relation: 'ambiguous' }
    }

    const scope = openScopes[0]
    if (isSameTask(scope.locator, targetTask)) {
      return { relation: 'same_task' }
    }

    return {
      relation: 'other_active_task',
      activeTask: cloneLocator(scope.locator),
      activePhase: scope.phase,
      activeExecutionSeq: scope.activeExecutionSeq,
    }
  }

  applyTransitions(
    sessionId: string,
    agentId: string | undefined,
    transitions: BoardTaskTransition[],
  ): void {
    const state = this.getOrCreateState(sessionId, agentId)

    for (const transition of transitions) {
      const scopeKey = buildScopeKey(transition.phase, transition.task)

      if (transition.type === 'open') {
        const existing = state.openScopes.get(scopeKey)
        if (existing) {
          state.openScopes.set(scopeKey, {
            ...existing,
            locator: mergeLocator(existing.locator, transition.task),
          })
          continue
        }

        const nextExecutionSeq = state.nextSeqByScopeKey.get(scopeKey) ?? 1
        state.nextSeqByScopeKey.set(scopeKey, nextExecutionSeq + 1)
        state.openScopes.set(scopeKey, {
          locator: cloneLocator(transition.task),
          phase: transition.phase,
          activeExecutionSeq: nextExecutionSeq,
        })
        continue
      }

      state.openScopes.delete(scopeKey)
    }
  }

  clearForTests(): void {
    this.stateByActorKey.clear()
  }
}

const runtimeBoardTaskExecutionStore = new RuntimeBoardTaskExecutionStore()

export function getRuntimeBoardTaskExecutionStore(): RuntimeBoardTaskExecutionStore {
  return runtimeBoardTaskExecutionStore
}
