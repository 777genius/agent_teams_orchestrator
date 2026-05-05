import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { errorMessage } from '../errors.js'
import { logForDebugging } from '../debug.js'
import { sleep } from '../sleep.js'
import { getTeamDir, sanitizeName } from './teamHelpers.js'

export const TEAMMATE_RUNTIME_EVENTS_ENV =
  'CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH'
export const TEAMMATE_BOOTSTRAP_PROOF_TOKEN_ENV =
  'CLAUDE_CODE_BOOTSTRAP_PROOF_TOKEN'

export type TeammateRuntimeEventType =
  | 'process_spawned'
  | 'stdout_attached'
  | 'cli_started'
  | 'runtime_ready'
  | 'inbox_poller_ready'
  | 'bootstrap_submitted'
  | 'bootstrap_confirmed'
  | 'heartbeat'
  | 'failed'
  | 'exited'

export type TeammateRuntimeEvent = {
  version: 1
  type: TeammateRuntimeEventType
  timestamp: string
  pid: number
  teamName?: string
  agentName?: string
  agentId?: string
  runId?: string
  cwd?: string
  source?: string
  bootstrapProofToken?: string
  bootstrapMessageId?: string
  bootstrapMirrorId?: string
  detail?: string
}

export type TeammateRuntimePaths = {
  dir: string
  eventsPath: string
  stdoutPath: string
  stderrPath: string
}

export function getTeammateRuntimePaths(params: {
  teamName: string
  agentName: string
}): TeammateRuntimePaths {
  const dir = join(getTeamDir(params.teamName), 'runtime')
  const filePrefix = sanitizeName(params.agentName)
  return {
    dir,
    eventsPath: join(dir, `${filePrefix}.runtime.jsonl`),
    stdoutPath: join(dir, `${filePrefix}.stdout.log`),
    stderrPath: join(dir, `${filePrefix}.stderr.log`),
  }
}

export async function ensureTeammateRuntimePaths(
  paths: TeammateRuntimePaths,
): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
}

export async function writeTeammateRuntimeEvent(params: {
  type: TeammateRuntimeEventType
  eventsPath?: string
  pid?: number
  teamName?: string
  agentName?: string
  agentId?: string
  runId?: string
  cwd?: string
  source?: string
  bootstrapProofToken?: string
  bootstrapMessageId?: string
  bootstrapMirrorId?: string
  detail?: string
}): Promise<void> {
  const eventsPath = params.eventsPath ?? process.env[TEAMMATE_RUNTIME_EVENTS_ENV]
  if (!eventsPath) {
    return
  }

  const event: TeammateRuntimeEvent = {
    version: 1,
    type: params.type,
    timestamp: new Date().toISOString(),
    pid: params.pid ?? process.pid,
    ...(params.teamName ? { teamName: params.teamName } : {}),
    ...(params.agentName ? { agentName: params.agentName } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.bootstrapProofToken
      ? { bootstrapProofToken: params.bootstrapProofToken }
      : {}),
    ...(params.bootstrapMessageId
      ? { bootstrapMessageId: params.bootstrapMessageId }
      : {}),
    ...(params.bootstrapMirrorId
      ? { bootstrapMirrorId: params.bootstrapMirrorId }
      : {}),
    ...(params.detail ? { detail: params.detail } : {}),
  }

  try {
    await mkdir(dirname(eventsPath), { recursive: true })
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    logForDebugging(
      `[TeammateRuntime] event write failed for ${params.type}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

export async function readTeammateRuntimeEvents(
  eventsPath: string,
): Promise<TeammateRuntimeEvent[]> {
  let raw: string
  try {
    raw = await readFile(eventsPath, 'utf8')
  } catch {
    return []
  }

  const events: TeammateRuntimeEvent[] = []
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      const parsed = JSON.parse(trimmed) as Partial<TeammateRuntimeEvent>
      if (
        parsed.version === 1 &&
        typeof parsed.type === 'string' &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.pid === 'number'
      ) {
        events.push(parsed as TeammateRuntimeEvent)
      }
    } catch {
      // Ignore partial lines from a concurrently writing runtime.
    }
  }
  return events
}

export async function waitForTeammateRuntimeEvent(params: {
  eventsPath: string
  type: TeammateRuntimeEventType
  timeoutMs: number
  pid?: number
  pollIntervalMs?: number
  isStillAlive?: () => boolean
}): Promise<{ ok: true; event: TeammateRuntimeEvent } | { ok: false; reason: string }> {
  const startedAt = Date.now()
  const pollIntervalMs = params.pollIntervalMs ?? 250
  let lastReadError: string | undefined

  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.isStillAlive && !params.isStillAlive()) {
      return {
        ok: false,
        reason: `teammate process exited before ${params.type}`,
      }
    }

    try {
      const events = await readTeammateRuntimeEvents(params.eventsPath)
      const matchesPid = (event: TeammateRuntimeEvent): boolean =>
        typeof params.pid !== 'number' || event.pid === params.pid
      const match = events.find(
        event => event.type === params.type && matchesPid(event),
      )
      if (match) {
        return { ok: true, event: match }
      }
      const failure = [...events]
        .reverse()
        .find(event => event.type === 'failed' && matchesPid(event))
      if (failure) {
        return {
          ok: false,
          reason: failure.detail ?? `teammate runtime failed before ${params.type}`,
        }
      }
    } catch (error) {
      lastReadError = errorMessage(error)
    }

    await sleep(pollIntervalMs)
  }

  return {
    ok: false,
    reason: lastReadError
      ? `timed out waiting for ${params.type}; last runtime log error: ${lastReadError}`
      : `timed out waiting for ${params.type}`,
  }
}
