import { appendFile, lstat, mkdir, open, readFile } from 'node:fs/promises'
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
  | 'mailbox_bootstrap_written'
  | 'bootstrap_prompt_observed'
  | 'bootstrap_submit_attempted'
  | 'bootstrap_submit_deferred'
  | 'bootstrap_submit_rejected'
  | 'bootstrap_submit_accepted_without_uuid'
  | 'bootstrap_submitted'
  | 'bootstrap_context_loaded'
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
  bootstrapRunId?: string
  cwd?: string
  source?: string
  bootstrapProofToken?: string
  contextHash?: string
  briefingHash?: string
  bootstrapMessageId?: string
  bootstrapMirrorId?: string
  retryable?: boolean
  attempt?: number
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

export type TeammateRuntimeEventWriteParams = {
  type: TeammateRuntimeEventType
  eventsPath?: string
  pid?: number
  teamName?: string
  agentName?: string
  agentId?: string
  runId?: string
  bootstrapRunId?: string
  cwd?: string
  source?: string
  bootstrapProofToken?: string
  contextHash?: string
  briefingHash?: string
  bootstrapMessageId?: string
  bootstrapMirrorId?: string
  retryable?: boolean
  attempt?: number
  detail?: string
}

export type ParentOwnedTeammateRuntimeEventWriteParams =
  Omit<TeammateRuntimeEventWriteParams, 'pid'> & {
    pid: number
    source: string
  }

export type ChildOwnedTeammateRuntimeEventWriteParams =
  TeammateRuntimeEventWriteParams & {
    source?: string
  }

const MAX_RUNTIME_EVENT_DETAIL_CHARS = 500
const MAX_RUNTIME_EVENT_LINE_CHARS = 16 * 1024
const MAX_RECENT_RUNTIME_EVENT_BYTES = 256 * 1024
const MAX_RECENT_RUNTIME_EVENT_LINES = 256

function sanitizeRuntimeEventDetail(detail: string): string {
  return detail
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/g, '[redacted]')
    .replace(/\/[^\s"'`]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RUNTIME_EVENT_DETAIL_CHARS)
}

export async function writeTeammateRuntimeEvent(
  params: TeammateRuntimeEventWriteParams,
): Promise<void> {
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
    ...(params.bootstrapRunId ? { bootstrapRunId: params.bootstrapRunId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.bootstrapProofToken
      ? { bootstrapProofToken: params.bootstrapProofToken }
      : {}),
    ...(params.contextHash ? { contextHash: params.contextHash } : {}),
    ...(params.briefingHash ? { briefingHash: params.briefingHash } : {}),
    ...(params.bootstrapMessageId
      ? { bootstrapMessageId: params.bootstrapMessageId }
      : {}),
    ...(params.bootstrapMirrorId
      ? { bootstrapMirrorId: params.bootstrapMirrorId }
      : {}),
    ...(typeof params.retryable === 'boolean'
      ? { retryable: params.retryable }
      : {}),
    ...(typeof params.attempt === 'number' && Number.isFinite(params.attempt)
      ? { attempt: params.attempt }
      : {}),
    ...(params.detail ? { detail: sanitizeRuntimeEventDetail(params.detail) } : {}),
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

export async function writeParentOwnedTeammateRuntimeEvent(
  params: ParentOwnedTeammateRuntimeEventWriteParams,
): Promise<void> {
  // Parent-written events describe the child runtime, not the orchestrator.
  // Requiring the child pid keeps app-side diagnostics from misattributing
  // transport progress to the lead process.
  if (!Number.isInteger(params.pid) || params.pid <= 0) {
    throw new Error('Parent-owned runtime event requires child runtime pid')
  }
  await writeTeammateRuntimeEvent(params)
}

export async function writeChildOwnedTeammateRuntimeEvent(
  params: ChildOwnedTeammateRuntimeEventWriteParams,
): Promise<void> {
  await writeTeammateRuntimeEvent(params)
}

function parseRuntimeEventLine(line: string): TeammateRuntimeEvent | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > MAX_RUNTIME_EVENT_LINE_CHARS) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<TeammateRuntimeEvent>
    if (
      parsed.version === 1 &&
      typeof parsed.type === 'string' &&
      typeof parsed.timestamp === 'string' &&
      typeof parsed.pid === 'number'
    ) {
      return {
        ...(parsed as TeammateRuntimeEvent),
        ...(typeof parsed.retryable === 'boolean'
          ? { retryable: parsed.retryable }
          : {}),
        ...(typeof parsed.attempt === 'number' &&
        Number.isFinite(parsed.attempt) &&
        parsed.attempt > 0
          ? { attempt: parsed.attempt }
          : {}),
      }
    }
  } catch {
    // Ignore malformed or concurrently written partial JSONL rows.
  }
  return null
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
    const event = parseRuntimeEventLine(line)
    if (event) events.push(event)
  }
  return events
}

export async function readRecentTeammateRuntimeEvents(
  eventsPath: string,
  options: { maxBytes?: number; maxLines?: number } = {},
): Promise<TeammateRuntimeEvent[]> {
  // Runtime event files are append-only JSONL diagnostics. Tail reads are
  // bounded so a noisy or long-running teammate cannot make bootstrap polling
  // scan an unbounded log.
  const maxBytes = Math.max(1, options.maxBytes ?? MAX_RECENT_RUNTIME_EVENT_BYTES)
  const maxLines = Math.max(1, options.maxLines ?? MAX_RECENT_RUNTIME_EVENT_LINES)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const stat = await lstat(eventsPath)
    if (!stat.isFile()) {
      return []
    }
    handle = await open(eventsPath, 'r')
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      return []
    }
    const fileSize = fileStat.size
    const start = Math.max(0, fileSize - maxBytes)
    const length = Math.max(0, fileSize - start)
    if (length === 0) {
      return []
    }

    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const raw = buffer.subarray(0, bytesRead).toString('utf8')
    let lines = raw.split(/\r?\n/g)
    if (start > 0) {
      lines = lines.slice(1)
    }
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      const finalEvent = parseRuntimeEventLine(lines[lines.length - 1] ?? '')
      lines = lines.slice(0, -1)
      if (finalEvent) {
        lines.push(JSON.stringify(finalEvent))
      }
    }
    lines = lines.slice(-maxLines)

    const events: TeammateRuntimeEvent[] = []
    for (const line of lines) {
      const event = parseRuntimeEventLine(line)
      if (event) events.push(event)
    }
    return events
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export type BootstrapSubmissionOutcome =
  | { type: 'submitted'; event: TeammateRuntimeEvent }
  | { type: 'terminal_failure'; reason: string; event?: TeammateRuntimeEvent }
  | { type: 'timeout'; lastStage?: TeammateRuntimeEvent; reason: string }

const BOOTSTRAP_TRANSPORT_STAGE_RANK: Partial<
  Record<TeammateRuntimeEventType, number>
> = {
  process_spawned: 10,
  stdout_attached: 20,
  cli_started: 30,
  runtime_ready: 40,
  inbox_poller_ready: 50,
  mailbox_bootstrap_written: 60,
  bootstrap_prompt_observed: 70,
  bootstrap_submit_attempted: 80,
  bootstrap_submit_deferred: 90,
  bootstrap_submit_rejected: 100,
  bootstrap_submit_accepted_without_uuid: 110,
  bootstrap_submitted: 120,
  failed: 900,
  exited: 910,
}

function matchesBootstrapSubmissionIdentity(
  event: TeammateRuntimeEvent,
  expected: {
    pid?: number
    teamName?: string
    agentName?: string
    agentId?: string
    bootstrapRunId?: string
    bootstrapMirrorId?: string
    sinceMs?: number
  },
): boolean {
  if (typeof expected.pid === 'number' && event.pid !== expected.pid) return false
  if (expected.teamName && event.teamName && event.teamName !== expected.teamName) {
    return false
  }
  if (
    expected.agentName &&
    event.agentName &&
    event.agentName !== expected.agentName
  ) {
    return false
  }
  if (expected.agentId && event.agentId && event.agentId !== expected.agentId) {
    return false
  }
  if (
    expected.bootstrapRunId &&
    event.bootstrapRunId &&
    event.bootstrapRunId !== expected.bootstrapRunId
  ) {
    return false
  }
  if (
    expected.bootstrapMirrorId &&
    event.bootstrapMirrorId &&
    event.bootstrapMirrorId !== expected.bootstrapMirrorId
  ) {
    return false
  }
  if (typeof expected.sinceMs === 'number' && Number.isFinite(expected.sinceMs)) {
    const eventMs = Date.parse(event.timestamp)
    if (!Number.isFinite(eventMs) || eventMs < expected.sinceMs) return false
  }
  return true
}

function selectLastRelevantBootstrapTransportEvent(
  events: TeammateRuntimeEvent[],
): TeammateRuntimeEvent | undefined {
  let selected: TeammateRuntimeEvent | undefined
  let selectedRank = -1
  for (const event of events) {
    const rank = BOOTSTRAP_TRANSPORT_STAGE_RANK[event.type] ?? -1
    if (rank < 0) continue
    if (!selected || rank >= selectedRank) {
      selected = event
      selectedRank = rank
    }
  }
  return selected
}

function isFreshRetryableBootstrapSubmitRejection(
  event: TeammateRuntimeEvent | undefined,
  nowMs: number,
  freshMs: number,
): boolean {
  if (!event || event.type !== 'bootstrap_submit_rejected' || event.retryable !== true) {
    return false
  }
  const eventMs = Date.parse(event.timestamp)
  return Number.isFinite(eventMs) && nowMs - eventMs <= freshMs
}

export async function waitForBootstrapSubmissionOutcome(params: {
  eventsPath: string
  timeoutMs: number
  pid: number
  teamName?: string
  agentName?: string
  agentId?: string
  bootstrapRunId?: string
  bootstrapMirrorId?: string
  sinceMs?: number
  pollIntervalMs?: number
  retryableSubmitGraceMs?: number
  retryableSubmitFreshMs?: number
  isStillAlive?: () => boolean
}): Promise<BootstrapSubmissionOutcome> {
  const startedAt = Date.now()
  const pollIntervalMs = params.pollIntervalMs ?? 250
  const retryableSubmitGraceMs = Math.max(0, params.retryableSubmitGraceMs ?? 0)
  const retryableSubmitFreshMs = Math.max(
    0,
    params.retryableSubmitFreshMs ?? 10_000,
  )
  const baseDeadlineMs = startedAt + params.timeoutMs
  const finalDeadlineMs = baseDeadlineMs + retryableSubmitGraceMs
  let lastStage: TeammateRuntimeEvent | undefined

  while (Date.now() < finalDeadlineMs) {
    if (params.isStillAlive && !params.isStillAlive()) {
      return {
        type: 'terminal_failure',
        reason: 'teammate process exited before bootstrap_submitted',
        event: lastStage,
      }
    }

    const events = (await readRecentTeammateRuntimeEvents(params.eventsPath)).filter(
      event => matchesBootstrapSubmissionIdentity(event, params),
    )
    const submitted = events.find(event => event.type === 'bootstrap_submitted')
    if (submitted) {
      return { type: 'submitted', event: submitted }
    }
    const terminal = [...events].reverse().find(event => {
      if (event.type === 'failed' || event.type === 'exited') return true
      if (event.type === 'bootstrap_submit_accepted_without_uuid') return true
      // A retryable submit rejection means the child observed the bootstrap
      // prompt but the app asked it to try again. Keep waiting instead of
      // converting transient transport backpressure into launch failure.
      return event.type === 'bootstrap_submit_rejected' && event.retryable === false
    })
    if (terminal) {
      return {
        type: 'terminal_failure',
        reason:
          terminal.detail ??
          `teammate runtime failed before bootstrap_submitted (${terminal.type})`,
        event: terminal,
      }
    }
    lastStage =
      selectLastRelevantBootstrapTransportEvent(events) ?? lastStage

    const nowMs = Date.now()
    if (
      nowMs >= baseDeadlineMs &&
      !isFreshRetryableBootstrapSubmitRejection(
        lastStage,
        nowMs,
        retryableSubmitFreshMs,
      )
    ) {
      break
    }

    const activeDeadlineMs =
      nowMs < baseDeadlineMs ? baseDeadlineMs : finalDeadlineMs
    await sleep(Math.min(pollIntervalMs, Math.max(1, activeDeadlineMs - nowMs)))
  }

  return {
    type: 'timeout',
    lastStage,
    reason: lastStage
      ? `timed out waiting for bootstrap_submitted; last transport stage: ${lastStage.type}${
          lastStage.detail ? `: ${lastStage.detail}` : ''
        }`
      : 'timed out waiting for bootstrap_submitted',
  }
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
      const events = await readRecentTeammateRuntimeEvents(params.eventsPath)
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
