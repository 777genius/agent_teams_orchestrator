import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV =
  'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT'

export type OpenCodeRuntimeTurnSettledOutcome =
  | 'success'
  | 'error'
  | 'timeout'
  | 'stream_unavailable'
  | 'prompt_rejected'
  | 'idle_without_assistant_activity'
  | 'unknown'

export type OpenCodeRuntimeTurnSettledEvent = {
  schemaVersion: 1
  provider: 'opencode'
  eventName: 'runtime_turn_settled'
  hookEventName: 'Stop'
  source: 'agent-teams-orchestrator-opencode'
  recordedAt: string
  sessionId: string
  teamName: string
  memberName: string
  laneId: string
  cwd: string
  outcome: OpenCodeRuntimeTurnSettledOutcome
  runtimePromptMessageId?: string
  turnId?: string
  selectedModel?: string
  runtimePid?: number
  detail?: string
}

export interface OpenCodeRuntimeTurnSettledEmitterPort {
  emit(event: OpenCodeRuntimeTurnSettledEvent): Promise<void>
}

export class FileOpenCodeRuntimeTurnSettledEmitter
  implements OpenCodeRuntimeTurnSettledEmitterPort
{
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async emit(event: OpenCodeRuntimeTurnSettledEvent): Promise<void> {
    const spoolRoot = this.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]?.trim()
    if (!spoolRoot) {
      return
    }

    const incomingDir = join(spoolRoot, 'incoming')
    await mkdir(incomingDir, { recursive: true })

    const stamp = event.recordedAt.replace(/[-:.]/g, '')
    const suffix = `${process.pid}-${randomUUID()}`
    const tempPath = join(incomingDir, `.turn-settled.${suffix}`)
    const finalPath = join(incomingDir, `${stamp}-${basename(tempPath)}.opencode.json`)
    await writeFile(tempPath, `${JSON.stringify(event)}\n`, 'utf8')
    await rename(tempPath, finalPath)
  }
}

const defaultEmitter = new FileOpenCodeRuntimeTurnSettledEmitter()

export async function emitOpenCodeRuntimeTurnSettledBestEffort(
  event: OpenCodeRuntimeTurnSettledEvent,
  emitter: OpenCodeRuntimeTurnSettledEmitterPort = defaultEmitter,
): Promise<void> {
  try {
    await emitter.emit(event)
  } catch {
    // Runtime turn-settled telemetry must never fail OpenCode delivery.
  }
}
