import * as fs from 'fs/promises'
import { dirname, join } from 'path'
import { getTeamDir } from 'src/utils/swarm/teamHelpers.js'
import type { TeamBootstrapPhase } from './teamBootstrapStateMachine.js'

type BootstrapJournalRecord =
  | {
      ts: number
      type: 'phase'
      runId: string
      phase: TeamBootstrapPhase
    }
  | {
      ts: number
      type: 'member'
      runId: string
      name: string
      action: 'spawn_started' | 'spawn_succeeded' | 'spawn_failed' | 'classified'
      detail?: string
    }
  | {
      ts: number
      type: 'terminal'
      runId: string
      status: 'completed' | 'partial_success' | 'failed' | 'canceled'
      reason?: string
    }
  | {
      ts: number
      type: 'real_task'
      runId: string
      state: 'not_submitted' | 'submitted' | 'unknown'
      detail?: string
    }
  | {
      ts: number
      type: 'lock'
      runId: string
      action: 'acquired' | 'reclaimed' | 'released'
      ownerPid?: number
      detail?: string
    }

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export class TeamBootstrapJournal {
  private readonly journalPath: string

  constructor(teamName: string) {
    this.journalPath = join(getTeamDir(teamName), 'bootstrap-journal.jsonl')
  }

  async append(record: BootstrapJournalRecord): Promise<void> {
    await appendJsonLine(this.journalPath, record)
  }
}
