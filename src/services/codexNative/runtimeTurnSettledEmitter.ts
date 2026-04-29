import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { getSessionId } from '../../bootstrap/state.js'
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
  detail?: string
}

export interface CodexNativeTurnSettledEmitterPort {
  emit(event: CodexNativeTurnSettledEvent): Promise<void>
}

export function buildCodexNativeTurnSettledEvent(input: {
  cwd: string
  outcome: CodexNativeTurnSettledOutcome
  threadId?: string | null
  detail?: string
  now?: () => Date
}): CodexNativeTurnSettledEvent | null {
  const agentId = getAgentId()?.trim()
  const agentName = getAgentName()?.trim()
  const teamName = getTeamName()?.trim()
  if (!agentId || !agentName || !teamName) {
    return null
  }

  const threadId = input.threadId?.trim()
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

    const incomingDir = join(spoolRoot, 'incoming')
    await mkdir(incomingDir, { recursive: true })

    const stamp = event.recordedAt.replace(/[-:.]/g, '')
    const suffix = `${process.pid}-${randomUUID()}`
    const tempPath = join(incomingDir, `.turn-settled.${suffix}`)
    const finalPath = join(incomingDir, `${stamp}-${basename(tempPath)}.codex.json`)
    await writeFile(tempPath, `${JSON.stringify(event)}\n`, 'utf8')
    await rename(tempPath, finalPath)
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
