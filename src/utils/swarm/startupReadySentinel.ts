import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'

export const TEAMMATE_STARTUP_READY_SENTINEL_ENV =
  'CLAUDE_CODE_TEAMMATE_STARTUP_READY_SENTINEL_PATH'

export type StartupReadyPayload = {
  version: 1
  kind: 'startup_ready'
  teamName: string
  agentName: string
  sessionId: string
  pid: number
  ts: string
}

export type SpawnReadySentinel = {
  dir: string
  filePath: string
}

export async function createSpawnReadySentinel(): Promise<SpawnReadySentinel> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-teammate-ready-'))
  return {
    dir,
    filePath: join(dir, 'startup-ready.json'),
  }
}

export async function cleanupSpawnReadySentinelDir(
  dir: string | undefined,
): Promise<void> {
  if (!dir) {
    return
  }

  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    logForDebugging(
      `[StartupReadySentinel] cleanup failed for ${dir}: ${String(error)}`,
    )
  }
}

export function shouldWriteTeammateStartupReadySentinel(params: {
  enabled: boolean
  didWriteAlready: boolean
  teamContext: AppState['teamContext'] | undefined
  sentinelPath: string | undefined
}): params is {
  enabled: true
  didWriteAlready: false
  teamContext: NonNullable<AppState['teamContext']>
  sentinelPath: string
} {
  const { enabled, didWriteAlready, teamContext, sentinelPath } = params

  if (didWriteAlready || !enabled || !teamContext || teamContext.isLeader) {
    return false
  }

  if (!sentinelPath || !teamContext.selfAgentName) {
    return false
  }

  return true
}

export async function writeStartupReadySentinel(params: {
  filePath: string
  teamName: string
  agentName: string
  sessionId: string
}): Promise<void> {
  const payload: StartupReadyPayload = {
    version: 1,
    kind: 'startup_ready',
    teamName: params.teamName,
    agentName: params.agentName,
    sessionId: params.sessionId,
    pid: process.pid,
    ts: new Date().toISOString(),
  }

  try {
    await writeFile(params.filePath, JSON.stringify(payload), { mode: 0o600 })
  } catch (error) {
    // Best-effort only. Parent may already have timed out and cleaned the temp
    // dir, and that must never break the child session after startup.
    logForDebugging(`[StartupReadySentinel] write failed: ${String(error)}`)
  }
}

export async function tryReadStartupReadySentinel(
  filePath: string,
): Promise<StartupReadyPayload | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StartupReadyPayload>

    if (
      parsed.version !== 1 ||
      parsed.kind !== 'startup_ready' ||
      typeof parsed.teamName !== 'string' ||
      typeof parsed.agentName !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.ts !== 'string'
    ) {
      return null
    }

    return parsed as StartupReadyPayload
  } catch {
    return null
  }
}
