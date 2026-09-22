import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { getSessionId } from '../../bootstrap/state.js'
import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { getAgentId, getAgentName, getTeamName } from '../../utils/teammate.js'

export const RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV =
  'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT'

export type CodexNativeTurnSettledOutcome =
  | 'success'
  | 'error'
  | 'no_assistant'
  | 'unsupported'

export interface CodexNativeTurnSettledEvent {
  schemaVersion: 1
  provider: 'codex'
  eventName: 'runtime_turn_settled'
  hookEventName: 'Stop'
  source: 'agent-teams-orchestrator-codex-native'
  recordedAt: string
  sessionId: string
  agentId: string
  agentName: string
  teamName: string
  cwd: string
  outcome: CodexNativeTurnSettledOutcome
  threadId?: string
  turnId?: string
  runtimeInstanceId?: string
  completedGeneration?: number
  detail?: string
}

export interface CodexNativeTurnSettledEmitterPort {
  emit(event: CodexNativeTurnSettledEvent): Promise<void>
}

export interface CodexNativeTurnSettledIdentity {
  agentId?: string | null
  agentName?: string | null
  teamName?: string | null
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function buildCodexNativeTurnSettledEvent(input: {
  cwd: string
  outcome: CodexNativeTurnSettledOutcome
  threadId?: string | null
  turnId?: string | null
  runtimeInstanceId?: string | null
  completedGeneration?: number | null
  detail?: string
  now?: () => Date
  identity?: CodexNativeTurnSettledIdentity
}): CodexNativeTurnSettledEvent | null {
  const agentId =
    trimOptional(getAgentId()) ?? trimOptional(input.identity?.agentId)
  const agentName =
    trimOptional(getAgentName()) ?? trimOptional(input.identity?.agentName)
  const teamName =
    trimOptional(getTeamName()) ?? trimOptional(input.identity?.teamName)
  if (!agentId || !agentName || !teamName) {
    return null
  }

  const threadId = input.threadId?.trim()
  const turnId = input.turnId?.trim()
  const runtimeInstanceId = input.runtimeInstanceId?.trim()
  const detail = input.detail?.trim()
  return {
    schemaVersion: 1,
    provider: 'codex',
    eventName: 'runtime_turn_settled',
    hookEventName: 'Stop',
    source: 'agent-teams-orchestrator-codex-native',
    recordedAt: (input.now ?? (() => new Date()))().toISOString(),
    sessionId: getSessionId(),
    agentId,
    agentName,
    teamName,
    cwd: input.cwd,
    outcome: input.outcome,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
    ...(typeof input.completedGeneration === 'number'
      ? { completedGeneration: input.completedGeneration }
      : {}),
    ...(detail ? { detail } : {}),
  }
}

export class FileCodexNativeTurnSettledEmitter
  implements CodexNativeTurnSettledEmitterPort
{
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async emit(event: CodexNativeTurnSettledEvent): Promise<void> {
    const spoolRoot = this.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]?.trim()
    if (!spoolRoot) {
      return
    }

    const stamp = event.recordedAt.replace(/[-:.]/g, '')
    const suffix = `${process.pid}-${randomUUID()}`
    const finalPath = join(spoolRoot, 'incoming', `${stamp}-.turn-settled.${suffix}.codex.json`)
    await writeFileAtomic(finalPath, `${JSON.stringify(event)}\n`)
  }
}

const defaultEmitter = new FileCodexNativeTurnSettledEmitter()

export async function emitCodexNativeTurnSettledBestEffort(
  event: CodexNativeTurnSettledEvent,
  emitter: CodexNativeTurnSettledEmitterPort = defaultEmitter,
): Promise<void> {
  try {
    await emitter.emit(event)
  } catch {
    // Turn-settled telemetry must never fail the user's Codex turn.
  }
}
