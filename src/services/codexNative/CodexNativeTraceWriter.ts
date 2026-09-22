import { randomUUID } from 'crypto'
import { copyFile, mkdir, open, readdir, rm, stat, type FileHandle } from 'fs/promises'
import { homedir } from 'os'
import path from 'path'

import { touchBoardTaskLogFreshnessSignal } from '../boardTaskActivity/TaskLogFreshnessSignal.js'
import { renamePathWithRetry } from '../../utils/atomicWrite.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import { mapCodexNativeExecLine } from './jsonlMapper.js'
import type { CodexNativeNormalizedEvent } from './normalizedEvents.js'

const TRACE_SCHEMA_VERSION = 1
const MAX_RAW_EVENT_BYTES = 256 * 1024
const MAX_STDERR_LINE_BYTES = 32 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024
const MAX_PENDING_RECORDS = 1000
const FRESHNESS_THROTTLE_MS = 500
const MAX_TRACE_FILES_PER_TASK = 5
const MAX_TRACE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TRACE_FILE_BYTES = 10 * 1024 * 1024

type TraceOutcome = 'success' | 'error' | 'timeout' | 'aborted' | 'interrupted'

type TaskHint = {
  teamName?: string
  taskId?: string
}

type Projection = {
  kind: 'tool_start' | 'tool_result' | 'message' | 'meta'
  toolSource?: 'mcp' | 'native'
  rawItemType?: string
  itemId?: string
  toolName?: string
  status?: string
  input?: Record<string, unknown>
  result?: unknown
  isError?: boolean
  text?: string
}

type TraceRecord = Record<string, unknown>

function isEnabledFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue
  }
  return /^(1|true|yes|on)$/i.test(value.trim())
}

function getTraceRoot(): string | null {
  if (!isEnabledFlag(process.env.CLAUDE_CODE_CODEX_NATIVE_TRACE_WRITE_ENABLED, true)) {
    return null
  }
  const explicit = process.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT?.trim()
  const root =
    explicit && explicit.length > 0
      ? explicit
      : path.join(homedir(), '.claude', 'teams', '.member-work-sync', 'runtime-hooks')
  return path.join(root, 'codex-native-traces')
}

function safeSegment(value: string): string {
  const encoded = encodeURIComponent(value)
  return encoded.length > 0 && encoded.length <= 160
    ? encoded
    : `segment-${Buffer.from(value).toString('base64url').slice(0, 80)}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }
  return undefined
}

function findTaskHintInValue(value: unknown, depth = 0): TaskHint {
  if (depth > 4) {
    return {}
  }
  const record = asRecord(value)
  if (record) {
    const direct = {
      teamName: pickString(record, ['teamName', 'team', 'teamId']),
      taskId: pickString(record, ['taskId', 'taskID', 'task', 'targetId', 'canonicalId', 'displayId']),
    }
    if (direct.teamName || direct.taskId) {
      return direct
    }
    for (const nested of Object.values(record)) {
      const hint = findTaskHintInValue(nested, depth + 1)
      if (hint.teamName || hint.taskId) {
        return hint
      }
    }
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const hint = findTaskHintInValue(nested, depth + 1)
      if (hint.teamName || hint.taskId) {
        return hint
      }
    }
  }
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      return findTaskHintInValue(JSON.parse(value), depth + 1)
    } catch {
      return {}
    }
  }
  return {}
}

function truncateString(value: string, maxBytes: number): {
  value: string
  truncated: boolean
  originalLength: number
} {
  const bytes = Buffer.byteLength(value)
  if (bytes <= maxBytes) {
    return { value, truncated: false, originalLength: bytes }
  }
  return {
    value: Buffer.from(value).subarray(0, maxBytes).toString('utf8'),
    truncated: true,
    originalLength: bytes,
  }
}

function capRawEvent(raw: unknown): {
  raw: unknown
  rawTruncated: boolean
  originalLength?: number
} {
  const serialized = JSON.stringify(raw)
  const capped = truncateString(serialized, MAX_RAW_EVENT_BYTES)
  if (!capped.truncated) {
    return { raw, rawTruncated: false }
  }
  return {
    raw: JSON.parse(JSON.stringify({ preview: capped.value })),
    rawTruncated: true,
    originalLength: capped.originalLength,
  }
}

function inferTaskHint(raw: unknown): TaskHint {
  const event = asRecord(raw)
  const item = asRecord(event?.item)
  if (item?.type !== 'mcp_tool_call') {
    return findTaskHintInValue(raw)
  }
  const args = asRecord(item.arguments) ?? {}
  const resultHint = findTaskHintInValue(item.result)
  const teamName = pickString(args, ['teamName', 'team', 'teamId']) ?? resultHint.teamName
  const taskId = pickString(args, ['taskId', 'taskID', 'task', 'id', 'targetId']) ?? resultHint.taskId
  return {
    ...(teamName ? { teamName } : {}),
    ...(taskId ? { taskId } : {}),
  }
}

function chooseTaskId(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) {
    return current
  }
  if (!current) {
    return next
  }
  const currentLooksShort = current.length <= 12
  const nextLooksCanonical = next.length > current.length
  return currentLooksShort && nextLooksCanonical ? next : current
}

function buildToolName(event: Extract<
  CodexNativeNormalizedEvent,
  { type: 'tool_call_started' | 'tool_call_completed' }
>): string {
  if (event.toolSource === 'mcp' && event.serverName) {
    return `mcp__${event.serverName}__${event.toolName}`
  }
  return event.toolName
}

function projectionFromEvent(event: CodexNativeNormalizedEvent): Projection | null {
  if (event.type === 'tool_call_started') {
    return {
      kind: 'tool_start',
      toolSource: event.toolSource,
      rawItemType: event.rawItemType,
      itemId: event.itemId,
      toolName: buildToolName(event),
      status: event.status,
      input: event.arguments,
    }
  }
  if (event.type === 'tool_call_completed') {
    return {
      kind: 'tool_result',
      toolSource: event.toolSource,
      rawItemType: event.rawItemType,
      itemId: event.itemId,
      toolName: buildToolName(event),
      status: event.status,
      input: event.arguments,
      result: capProjectionResult(event.rawResult),
      isError: event.isError,
    }
  }
  if (event.type === 'assistant_text') {
    return {
      kind: 'message',
      itemId: event.itemId,
      text: event.text,
    }
  }
  if (event.type === 'usage_updated' || event.type === 'turn_completed' || event.type === 'turn_started') {
    return { kind: 'meta' }
  }
  return null
}

function capProjectionResult(value: unknown): unknown {
  if (typeof value === 'string') {
    const capped = truncateString(value, MAX_COMMAND_OUTPUT_BYTES)
    return capped.truncated
      ? { content: capped.value, truncated: true, originalLength: capped.originalLength }
      : value
  }
  const record = asRecord(value)
  if (!record) {
    return value
  }
  const cappedRecord: Record<string, unknown> = { ...record }
  for (const key of ['content', 'stdout', 'stderr', 'output', 'aggregated_output'] as const) {
    if (typeof cappedRecord[key] === 'string') {
      const capped = truncateString(cappedRecord[key], MAX_COMMAND_OUTPUT_BYTES)
      if (capped.truncated) {
        cappedRecord[key] = capped.value
        cappedRecord[`${key}Truncated`] = true
        cappedRecord[`${key}OriginalLength`] = capped.originalLength
      }
    }
  }
  return cappedRecord
}

export class CodexNativeTraceWriter {
  private readonly runId = randomUUID()
  private readonly traceRoot = getTraceRoot()
  private readonly ownerName = getAgentName()
  private readonly contextTeamName = getTeamName()
  private taskHint: TaskHint = {}
  private file: FileHandle | null = null
  private tmpPath: string | null = null
  private processedPath: string | null = null
  private sourceOrder = 0
  private stdoutEventCount = 0
  private stderrLineCount = 0
  private bytesWritten = 0
  private pendingRecords: TraceRecord[] = []
  private lastFreshnessAt = 0

  constructor(
    private readonly params: {
      cwd: string
      codexVersion: string | null
    },
  ) {}

  async recordStdoutLine(line: string): Promise<void> {
    if (!this.traceRoot) {
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }

    this.updateTaskHint(inferTaskHint(raw))
    const projections = mapCodexNativeExecLine(line)
      .map(projectionFromEvent)
      .filter((projection): projection is Projection => projection !== null)
    const capped = capRawEvent(raw)
    const baseRecord: TraceRecord = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: 'codex_native_stdout_event',
      receivedAt: new Date().toISOString(),
      sourceOrder: ++this.sourceOrder,
      raw: capped.raw,
      rawTruncated: capped.rawTruncated,
      ...(capped.originalLength ? { originalLength: capped.originalLength } : {}),
      ...(projections[0] ? { projection: projections[0] } : {}),
    }

    this.stdoutEventCount += 1
    await this.writeOrBuffer(baseRecord)
    await this.touchFreshnessThrottled(false)
  }

  async recordStderrLine(rawLine: string, rewrittenLine: string | null): Promise<void> {
    if (!this.traceRoot) {
      return
    }
    const capped = truncateString(rewrittenLine ?? rawLine, MAX_STDERR_LINE_BYTES)
    this.stderrLineCount += 1
    await this.writeOrBuffer({
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: 'codex_native_stderr_line',
      receivedAt: new Date().toISOString(),
      sourceOrder: ++this.sourceOrder,
      line: capped.value,
      truncated: capped.truncated,
      ...(capped.truncated ? { originalLength: capped.originalLength } : {}),
      suppressed: rewrittenLine === null,
    })
  }

  async finish(params: {
    outcome: TraceOutcome
    exitCode?: number | null
    signal?: string | null
  }): Promise<void> {
    if (!this.traceRoot) {
      return
    }
    if (!this.file && !this.taskHint.taskId) {
      return
    }
    await this.ensureOpen()
    if (!this.file) {
      return
    }
    await this.writeRecord({
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: 'codex_native_trace_footer',
      finishedAt: new Date().toISOString(),
      outcome: params.outcome,
      exitCode: params.exitCode ?? null,
      signal: params.signal ?? null,
      stdoutEventCount: this.stdoutEventCount,
      stderrLineCount: this.stderrLineCount,
    })
    await this.touchFreshnessThrottled(true)
    await this.file.close()
    this.file = null
    if (this.tmpPath && this.processedPath) {
      await mkdir(path.dirname(this.processedPath), { recursive: true, mode: 0o700 })
      await renamePathWithRetry(this.tmpPath, this.processedPath).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV' || !this.tmpPath || !this.processedPath) {
          throw error
        }
        await copyFile(this.tmpPath, this.processedPath)
      })
      await rm(this.tmpPath, { force: true }).catch(() => undefined)
      await this.cleanupRetention(path.dirname(this.processedPath)).catch(() => undefined)
    }
  }

  private updateTaskHint(hint: TaskHint): void {
    this.taskHint = {
      teamName: this.taskHint.teamName ?? hint.teamName ?? this.contextTeamName,
      taskId: chooseTaskId(this.taskHint.taskId, hint.taskId),
    }
  }

  private async writeOrBuffer(record: TraceRecord): Promise<void> {
    if (!this.file && this.taskHint.taskId) {
      await this.ensureOpen()
    }
    if (!this.file) {
      if (this.pendingRecords.length < MAX_PENDING_RECORDS) {
        this.pendingRecords.push(record)
      }
      return
    }
    await this.writeRecord(record)
  }

  private async ensureOpen(): Promise<void> {
    if (this.file || !this.traceRoot || !this.taskHint.taskId) {
      return
    }
    const teamSegment = safeSegment(this.taskHint.teamName ?? this.contextTeamName ?? 'unknown-team')
    const taskSegment = safeSegment(this.taskHint.taskId)
    const incomingDir = path.join(this.traceRoot, 'incoming', teamSegment, taskSegment)
    const processedDir = path.join(this.traceRoot, 'processed', teamSegment, taskSegment)
    await mkdir(incomingDir, { recursive: true, mode: 0o700 })
    this.tmpPath = path.join(incomingDir, `${this.runId}.jsonl.tmp`)
    this.processedPath = path.join(processedDir, `${this.runId}.jsonl`)
    this.file = await open(this.tmpPath, 'ax', 0o600)
    await this.writeRecord({
      schemaVersion: TRACE_SCHEMA_VERSION,
      recordType: 'codex_native_trace_header',
      runId: this.runId,
      teamName: this.taskHint.teamName ?? this.contextTeamName ?? null,
      taskId: this.taskHint.taskId,
      ownerName: this.ownerName ?? null,
      provider: 'codex',
      cwd: this.params.cwd,
      codexVersion: this.params.codexVersion,
      startedAt: new Date().toISOString(),
    })
    for (const pending of this.pendingRecords) {
      await this.writeRecord(pending)
    }
    this.pendingRecords = []
  }

  private async writeRecord(record: TraceRecord): Promise<void> {
    if (!this.file) {
      return
    }
    let writableRecord = record
    if (this.bytesWritten > MAX_TRACE_FILE_BYTES && Object.prototype.hasOwnProperty.call(record, 'raw')) {
      writableRecord = {
        ...record,
        raw: { omitted: true },
        rawTruncated: true,
        traceFileLimitExceeded: true,
      }
    }
    const line = `${JSON.stringify(writableRecord)}\n`
    this.bytesWritten += Buffer.byteLength(line)
    await this.file.appendFile(line, 'utf8')
  }

  private async cleanupRetention(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const files = (
      await Promise.all(
        entries
          .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map(async entry => {
            const filePath = path.join(dir, entry.name)
            const fileStat = await stat(filePath).catch(() => null)
            return fileStat?.isFile()
              ? { filePath, mtimeMs: fileStat.mtimeMs }
              : null
          }),
      )
    )
      .filter((file): file is { filePath: string; mtimeMs: number } => file !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)

    const cutoff = Date.now() - MAX_TRACE_AGE_MS
    await Promise.all(
      files
        .filter((file, index) => index >= MAX_TRACE_FILES_PER_TASK || file.mtimeMs < cutoff)
        .map(file => rm(file.filePath, { force: true }).catch(() => undefined)),
    )
  }

  private async touchFreshnessThrottled(force: boolean): Promise<void> {
    const taskId = this.taskHint.taskId
    const teamName = this.taskHint.teamName ?? this.contextTeamName
    if (!taskId || !teamName) {
      return
    }
    const now = Date.now()
    if (!force && now - this.lastFreshnessAt < FRESHNESS_THROTTLE_MS) {
      return
    }
    this.lastFreshnessAt = now
    await touchBoardTaskLogFreshnessSignal({
      projectDir: this.params.cwd,
      taskId,
      teamName,
      provider: 'codex',
      source: 'codex-native-trace',
    }).catch(() => undefined)
  }
}
