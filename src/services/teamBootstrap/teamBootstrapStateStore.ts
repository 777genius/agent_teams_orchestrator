import * as fs from 'fs/promises'
import { dirname, join } from 'path'
import { getTeamDir } from 'src/utils/swarm/teamHelpers.js'
import {
  assertBootstrapPhaseTransition,
  isTerminalBootstrapPhase,
  type TeamBootstrapPhase,
} from './teamBootstrapStateMachine.js'
import { readBoundRegularUtf8File } from './teamBootstrapBoundFileRead.js'
import { TeamBootstrapJournal } from './teamBootstrapJournal.js'
import type {
  BootstrapMemberState,
  PersistedBootstrapState,
  TeamBootstrapRequest,
} from './teamBootstrapTypes.js'

const MAX_BOOTSTRAP_STATE_BYTES = 256 * 1024

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  await fs.rename(tempPath, filePath)
}

function getBootstrapStatePath(teamName: string): string {
  return join(getTeamDir(teamName), 'bootstrap-state.json')
}

async function readPersistedBootstrapState(
  teamName: string,
): Promise<PersistedBootstrapState | null> {
  try {
    const raw = JSON.parse(
      await readBoundRegularUtf8File({
        filePath: getBootstrapStatePath(teamName),
        maxBytes: MAX_BOOTSTRAP_STATE_BYTES,
        messages: {
          notRegular:
            'persisted deterministic bootstrap state must be a regular file and must not be a symlink',
          oversized: 'persisted deterministic bootstrap state is too large',
          invalid:
            'persisted deterministic bootstrap state changed while being validated or could not be read safely',
        },
      }),
    ) as PersistedBootstrapState
    return raw.version === 1 ? raw : null
  } catch {
    return null
  }
}

export class TeamBootstrapStateStore {
  private readonly statePath: string
  private readonly journal: TeamBootstrapJournal
  private state: PersistedBootstrapState

  constructor(request: TeamBootstrapRequest, now: () => number) {
    const startedAt = now()
    this.statePath = getBootstrapStatePath(request.teamName)
    this.journal = new TeamBootstrapJournal(request.teamName)
    this.state = {
      version: 1,
      runId: request.runId,
      requestHash: request.requestHash,
      teamName: request.teamName,
      mode: request.mode,
      ownerPid: process.pid,
      ownerStartedAt: startedAt,
      phase: 'validating_spec',
      phaseEnteredAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      realTaskSubmissionState: 'not_submitted',
      members: request.members.map<BootstrapMemberState>(member => ({
        name: member.displayName,
        logicalIdentity: member.normalizedName,
        desiredRole: member.role,
        status: 'pending',
      })),
    }
  }

  getStatePath(): string {
    return this.statePath
  }

  getState(): PersistedBootstrapState {
    return this.state
  }

  async initialize(): Promise<void> {
    await writeJsonAtomic(this.statePath, this.state)
    await this.journal.append({
      ts: this.state.startedAt,
      type: 'phase',
      runId: this.state.runId,
      phase: this.state.phase,
    })
  }

  async transitionTo(phase: TeamBootstrapPhase, now: () => number): Promise<void> {
    assertBootstrapPhaseTransition(this.state.phase, phase)
    const timestamp = now()
    this.state = {
      ...this.state,
      phase,
      phaseEnteredAt: timestamp,
      updatedAt: timestamp,
    }
    await writeJsonAtomic(this.statePath, this.state)
    await this.journal.append({
      ts: timestamp,
      type: 'phase',
      runId: this.state.runId,
      phase,
    })
  }

  async markMemberSpawnStarted(
    memberName: string,
    now: () => number,
  ): Promise<void> {
    const timestamp = now()
    this.state = {
      ...this.state,
      updatedAt: timestamp,
      members: this.state.members.map(member =>
        member.name === memberName
          ? {
              ...member,
              status: 'spawn_started',
              lastAttemptAt: timestamp,
              lastObservedAt: timestamp,
            }
          : member,
      ),
    }
    await writeJsonAtomic(this.statePath, this.state)
    await this.journal.append({
      ts: timestamp,
      type: 'member',
      runId: this.state.runId,
      name: memberName,
      action: 'spawn_started',
    })
  }

  async markMemberResult(
    memberName: string,
    result: {
      status: BootstrapMemberState['status']
      agentId?: string
      backendType?: string
      failureReason?: string
    },
    now: () => number,
  ): Promise<void> {
    const timestamp = now()
    this.state = {
      ...this.state,
      updatedAt: timestamp,
      members: this.state.members.map(member =>
        member.name === memberName
          ? {
              ...member,
              status: result.status,
              lastObservedAt: timestamp,
              ...(result.agentId ? { agentId: result.agentId } : {}),
              ...(result.backendType ? { backendType: result.backendType } : {}),
              ...(result.failureReason
                ? { failureReason: result.failureReason }
                : {}),
            }
          : member,
      ),
    }
    await writeJsonAtomic(this.statePath, this.state)
    await this.journal.append({
      ts: timestamp,
      type: 'member',
      runId: this.state.runId,
      name: memberName,
      action:
        result.status === 'failed'
          ? 'spawn_failed'
          : result.status === 'registered'
            ? 'spawn_succeeded'
            : 'classified',
      ...(result.failureReason ? { detail: result.failureReason } : {}),
    })
  }

  async setTerminal(
    terminal: PersistedBootstrapState['terminal'],
    now: () => number,
  ): Promise<void> {
    const timestamp = now()
    const nextPhase: TeamBootstrapPhase =
      terminal?.status === 'canceled'
        ? 'canceled'
        : terminal?.status === 'failed'
          ? 'failed'
          : 'completed'

    if (!isTerminalBootstrapPhase(this.state.phase)) {
      assertBootstrapPhaseTransition(this.state.phase, nextPhase)
    }

    this.state = {
      ...this.state,
      phase: nextPhase,
      phaseEnteredAt: timestamp,
      updatedAt: timestamp,
      terminal: {
        ...terminal,
        finishedAt: terminal?.finishedAt ?? timestamp,
      },
    }
    await writeJsonAtomic(this.statePath, this.state)
    await this.journal.append({
      ts: timestamp,
      type: 'terminal',
      runId: this.state.runId,
      status: this.state.terminal.status,
      ...(this.state.terminal.reason ? { reason: this.state.terminal.reason } : {}),
    })
  }

  async markRealTaskSubmissionState(
    state: PersistedBootstrapState['realTaskSubmissionState'],
    now: () => number,
    detail?: string,
  ): Promise<void> {
    const timestamp = now()
    this.state = {
      ...this.state,
      updatedAt: timestamp,
      realTaskSubmissionState: state,
    }
    await writeJsonAtomic(this.statePath, this.state)
    await this.journal.append({
      ts: timestamp,
      type: 'real_task',
      runId: this.state.runId,
      state,
      ...(detail ? { detail } : {}),
    })
  }

  static async updateRealTaskSubmissionState(params: {
    teamName: string
    runId: string
    state: PersistedBootstrapState['realTaskSubmissionState']
    now?: () => number
    detail?: string
  }): Promise<boolean> {
    const current = await readPersistedBootstrapState(params.teamName)
    if (!current || current.runId !== params.runId) {
      return false
    }
    const timestamp = (params.now ?? (() => Date.now()))()
    const nextState: PersistedBootstrapState = {
      ...current,
      updatedAt: timestamp,
      realTaskSubmissionState: params.state,
    }
    await writeJsonAtomic(getBootstrapStatePath(params.teamName), nextState)
    const journal = new TeamBootstrapJournal(params.teamName)
    await journal.append({
      ts: timestamp,
      type: 'real_task',
      runId: params.runId,
      state: params.state,
      ...(params.detail ? { detail: params.detail } : {}),
    })
    return true
  }
}
