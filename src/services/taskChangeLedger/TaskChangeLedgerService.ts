import { createHash, randomUUID } from 'crypto'
import { constants as fsConstants } from 'fs'
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'fs/promises'
import { diffLines } from 'diff'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import type { AgentId } from '../../types/ids.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { getRuntimeBoardTaskExecutionStore } from '../boardTaskActivity/RuntimeBoardTaskExecutionStore.js'
import type { BoardTaskLocator, BoardTaskPhase } from '../boardTaskActivity/contract.js'
import {
  getGitCommittedPathEntries,
  getGitStatusPathEntries,
  type GitChangePathEntry,
  type GitChangeRelation,
} from './GitChangePathProvider.js'

const TASK_CHANGE_LEDGER_SCHEMA_VERSION = 1
const TASK_CHANGE_LEDGER_DIRNAME = '.board-task-changes'
const TASK_CHANGE_FRESHNESS_DIRNAME = '.board-task-change-freshness'
const TASK_CHANGE_FILE_SUFFIX = '.json'
const MAX_TEXT_BLOB_BYTES = 1024 * 1024
const MAX_SHELL_SNAPSHOT_FILES = 80
const MAX_GIT_PATH_ENTRIES = 500
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 2000

type TaskChangeConfidence = 'exact' | 'high' | 'medium' | 'low' | 'ambiguous'
type TaskChangeOperation = 'create' | 'modify' | 'delete'
type TaskChangeSource =
  | 'file_edit'
  | 'file_write'
  | 'notebook_edit'
  | 'bash_simulated_sed'
  | 'shell_snapshot'
  | 'powershell_snapshot'
  | 'post_tool_hook_snapshot'
export type TaskChangeToolStatus = 'succeeded' | 'failed' | 'killed' | 'backgrounded'

type ResolvedTaskScope = {
  taskId: string
  task: BoardTaskLocator
  phase: BoardTaskPhase
  executionSeq: number
}

type ContentRef = {
  sha256: string
  sizeBytes: number
  blobRef?: string
  unavailableReason?: string
}

type ContentStateRef = {
  exists?: boolean
  sha256?: string
  sizeBytes?: number
  unavailableReason?: string
}

type TaskChangeRelation = GitChangeRelation

type TaskChangeEventV1 = {
  schemaVersion: typeof TASK_CHANGE_LEDGER_SCHEMA_VERSION
  eventId: string
  taskId: string
  taskRef: string
  taskRefKind: BoardTaskLocator['refKind']
  phase: BoardTaskPhase
  executionSeq: number
  sessionId: string
  agentId?: string
  toolUseId: string
  source: TaskChangeSource
  operation: TaskChangeOperation
  confidence: TaskChangeConfidence
  workspaceRoot: string
  filePath: string
  relativePath: string
  timestamp: string
  toolStatus: TaskChangeToolStatus
  before: ContentRef | null
  after: ContentRef | null
  beforeState?: ContentStateRef
  afterState?: ContentStateRef
  relation?: TaskChangeRelation
  oldString?: string
  newString?: string
  linesAdded?: number
  linesRemoved?: number
  replaceAll?: boolean
  structuredPatch?: unknown
  warnings?: string[]
}

type TaskChangeNoticeV1 = {
  schemaVersion: typeof TASK_CHANGE_LEDGER_SCHEMA_VERSION
  noticeId: string
  taskId: string
  taskRef: string
  taskRefKind: BoardTaskLocator['refKind']
  phase: BoardTaskPhase
  executionSeq: number
  sessionId: string
  agentId?: string
  toolUseId: string
  timestamp: string
  severity: 'warning'
  message: string
}

type TaskChangeBundleFileV1 = {
  filePath: string
  relativePath: string
  eventIds: string[]
  linesAdded: number
  linesRemoved: number
  isNewFile: boolean
  latestAfterHash: string | null
}

type TaskChangeBundleV1 = {
  schemaVersion: typeof TASK_CHANGE_LEDGER_SCHEMA_VERSION
  source: 'task-change-ledger'
  taskId: string
  generatedAt: string
  eventCount: number
  files: TaskChangeBundleFileV1[]
  totalLinesAdded: number
  totalLinesRemoved: number
  totalFiles: number
  confidence: 'high' | 'medium' | 'low'
  warnings: string[]
  events: TaskChangeEventV1[]
  notices?: TaskChangeNoticeV1[]
}

type ExactFileChange = {
  filePath: string
  beforeContent: string | null
  afterContent: string | null
  source: TaskChangeSource
  confidence: TaskChangeConfidence
  operation?: TaskChangeOperation
  beforeState?: ContentStateRef
  afterState?: ContentStateRef
  relation?: TaskChangeRelation
  oldString?: string
  newString?: string
  replaceAll?: boolean
  structuredPatch?: unknown
  warnings?: string[]
}

type ShellSnapshotFile = {
  content: string | null
  exists?: boolean
  sha256?: string
  sizeBytes?: number
  unavailableReason?: string
  fingerprint?: string
}

export type ShellSnapshot = {
  id: string
  scope: ResolvedTaskScope
  sessionId: string
  agentId?: AgentId
  toolUseId: string
  workspaceRoot: string
  gitRoot: string
  beforeHead: string | null
  beforeFiles: Map<string, ShellSnapshotFile>
  beforeStatusPaths: Set<string>
  beforeStatusEntries: Map<string, GitChangePathEntry>
  warnings: string[]
  startedAt: string
}

type FinishShellSnapshotOptions = {
  source?: Extract<
    TaskChangeSource,
    'shell_snapshot' | 'powershell_snapshot' | 'post_tool_hook_snapshot'
  >
  confidence?: TaskChangeConfidence
  excludedFilePaths?: Iterable<string>
}

const pendingShellSnapshots = new Map<
  string,
  { snapshot: ShellSnapshot; options?: FinishShellSnapshotOptions }
>()
const taskWriteQueues = new Map<string, Promise<void>>()

function encodeTaskId(taskId: string): string {
  return encodeURIComponent(taskId)
}

function getLedgerProjectDir(): string {
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

function getLedgerDir(projectDir = getLedgerProjectDir()): string {
  return join(projectDir, TASK_CHANGE_LEDGER_DIRNAME)
}

function getEventsPath(taskId: string, projectDir = getLedgerProjectDir()): string {
  return join(getLedgerDir(projectDir), 'events', `${encodeTaskId(taskId)}.jsonl`)
}

function getNoticesPath(taskId: string, projectDir = getLedgerProjectDir()): string {
  return join(getLedgerDir(projectDir), 'notices', `${encodeTaskId(taskId)}.jsonl`)
}

function getBundlePath(taskId: string, projectDir = getLedgerProjectDir()): string {
  return join(getLedgerDir(projectDir), 'bundles', `${encodeTaskId(taskId)}.json`)
}

function getFreshnessPath(taskId: string, projectDir = getLedgerProjectDir()): string {
  return join(
    projectDir,
    TASK_CHANGE_FRESHNESS_DIRNAME,
    `${encodeTaskId(taskId)}${TASK_CHANGE_FILE_SUFFIX}`,
  )
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8')
}

function normalizeFilePath(filePath: string, workspaceRoot: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath)
}

function displayRelativePath(filePath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, filePath)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel
  }
  return filePath.split(/[\\/]/).slice(-3).join('/')
}

function getTaskIdFromScope(locator: BoardTaskLocator): string | null {
  if (locator.canonicalId?.trim()) {
    return locator.canonicalId.trim()
  }
  if (locator.refKind === 'canonical' && locator.ref.trim()) {
    return locator.ref.trim()
  }
  return null
}

function resolvedScopeFromActiveScope(activeScope: {
  locator: BoardTaskLocator
  phase: BoardTaskPhase
  activeExecutionSeq: number
}): ResolvedTaskScope | null {
  const taskId = getTaskIdFromScope(activeScope.locator)
  if (!taskId) {
    return null
  }
  return {
    taskId,
    task: activeScope.locator,
    phase: activeScope.phase,
    executionSeq: activeScope.activeExecutionSeq,
  }
}

function resolveTaskScope(sessionId: string, agentId?: AgentId): ResolvedTaskScope | null {
  const store = getRuntimeBoardTaskExecutionStore()
  const activeScopes = store.getActiveScopes(sessionId, agentId)
  if (activeScopes.length !== 1 || !activeScopes[0]) {
    return null
  }
  return resolvedScopeFromActiveScope(activeScopes[0])
}

async function maybePersistAmbiguousScopeNotice(params: {
  sessionId: string
  agentId?: AgentId
  toolUseId: string
}): Promise<void> {
  const store = getRuntimeBoardTaskExecutionStore()
  const activeScopes = store.getActiveScopes(params.sessionId, params.agentId)
  if (activeScopes.length <= 1) {
    return
  }
  const message =
    'Task change ledger skipped attribution because multiple task scopes were active.'
  await Promise.all(
    activeScopes.flatMap(activeScope => {
      const scope = resolvedScopeFromActiveScope(activeScope)
      if (!scope) {
        return []
      }
      return persistNotice({
        scope,
        sessionId: params.sessionId,
        agentId: params.agentId,
        toolUseId: params.toolUseId,
        message,
      })
    }),
  )
}

async function resolveTaskScopeForLedger(params: {
  sessionId: string
  agentId?: AgentId
  toolUseId: string
}): Promise<ResolvedTaskScope | null> {
  const scope = resolveTaskScope(params.sessionId, params.agentId)
  if (scope) {
    return scope
  }
  await maybePersistAmbiguousScopeNotice(params)
  return null
}

function relationFromGitEntry(entry?: GitChangePathEntry): TaskChangeRelation | undefined {
  if (!entry?.relation) {
    return undefined
  }
  return {
    kind: entry.relation.kind,
    oldPath: entry.relation.oldPath,
    newPath: entry.relation.newPath,
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tmpPath, filePath)
}

async function buildContentRef(
  content: string | null,
  projectDir: string,
): Promise<ContentRef | null> {
  if (content === null) {
    return null
  }

  const sizeBytes = byteLength(content)
  const hash = sha256(content)
  if (sizeBytes > MAX_TEXT_BLOB_BYTES) {
    return null
  }

  const blobRef = `sha256/${hash}`
  const blobPath = join(getLedgerDir(projectDir), 'blobs', blobRef)
  if (!(await pathExists(blobPath))) {
    await writeAtomic(blobPath, content)
  }
  return { sha256: hash, sizeBytes, blobRef }
}

function contentStateFromTextContent(content: string): ContentStateRef {
  const sizeBytes = byteLength(content)
  return {
    exists: true,
    sha256: sha256(content),
    sizeBytes,
    ...(sizeBytes > MAX_TEXT_BLOB_BYTES
      ? { unavailableReason: `content exceeds ${MAX_TEXT_BLOB_BYTES} byte ledger limit` }
      : {}),
  }
}

function contentStateFromContentRef(ref: ContentRef): ContentStateRef {
  return {
    exists: true,
    sha256: ref.sha256,
    sizeBytes: ref.sizeBytes,
    ...(ref.unavailableReason ? { unavailableReason: ref.unavailableReason } : {}),
  }
}

function defaultStateForSide(
  explicitState: ContentStateRef | undefined,
  ref: ContentRef | null,
  content: string | null,
  operation: TaskChangeOperation,
  side: 'before' | 'after',
): ContentStateRef | undefined {
  if (explicitState) {
    return explicitState
  }
  if (ref) {
    return contentStateFromContentRef(ref)
  }
  if (content !== null) {
    return contentStateFromTextContent(content)
  }
  if (
    (side === 'before' && operation === 'create') ||
    (side === 'after' && operation === 'delete')
  ) {
    return { exists: false }
  }
  return undefined
}

function operationForContents(
  beforeContent: string | null,
  afterContent: string | null,
): TaskChangeOperation {
  if (beforeContent === null && afterContent !== null) {
    return 'create'
  }
  if (beforeContent !== null && afterContent === null) {
    return 'delete'
  }
  return 'modify'
}

function operationForShellSources(
  beforeSource: ShellSnapshotFile,
  afterSource: ShellSnapshotFile,
): TaskChangeOperation {
  if (beforeSource.exists === false && afterSource.exists !== false) {
    return 'create'
  }
  if (beforeSource.exists !== false && afterSource.exists === false) {
    return 'delete'
  }
  return 'modify'
}

function countLineChanges(beforeContent: string | null, afterContent: string | null): {
  added: number
  removed: number
} {
  const before = beforeContent ?? ''
  const after = afterContent ?? ''
  if (byteLength(before) > MAX_TEXT_BLOB_BYTES || byteLength(after) > MAX_TEXT_BLOB_BYTES) {
    return { added: 0, removed: 0 }
  }
  let added = 0
  let removed = 0
  for (const change of diffLines(before, after)) {
    if (change.added) {
      added += change.count ?? 0
    }
    if (change.removed) {
      removed += change.count ?? 0
    }
  }
  return { added, removed }
}

function buildEventId(event: Omit<TaskChangeEventV1, 'eventId'>): string {
  return sha256(
    JSON.stringify({
      taskId: event.taskId,
      sessionId: event.sessionId,
      agentId: event.agentId ?? null,
      toolUseId: event.toolUseId,
      source: event.source,
      filePath: event.filePath,
      before: event.before?.sha256 ?? null,
      after: event.after?.sha256 ?? null,
      executionSeq: event.executionSeq,
    }),
  )
}

function buildNoticeId(notice: Omit<TaskChangeNoticeV1, 'noticeId'>): string {
  return sha256(
    JSON.stringify({
      taskId: notice.taskId,
      sessionId: notice.sessionId,
      agentId: notice.agentId ?? null,
      toolUseId: notice.toolUseId,
      executionSeq: notice.executionSeq,
      message: notice.message,
    }),
  )
}

async function appendEvent(event: TaskChangeEventV1, projectDir: string): Promise<void> {
  const eventsPath = getEventsPath(event.taskId, projectDir)
  await mkdir(dirname(eventsPath), { recursive: true, mode: 0o700 })
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

async function appendNotice(notice: TaskChangeNoticeV1, projectDir: string): Promise<void> {
  const noticesPath = getNoticesPath(notice.taskId, projectDir)
  await mkdir(dirname(noticesPath), { recursive: true, mode: 0o700 })
  await appendFile(noticesPath, `${JSON.stringify(notice)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

async function readTaskEvents(taskId: string, projectDir: string): Promise<TaskChangeEventV1[]> {
  const eventsPath = getEventsPath(taskId, projectDir)
  let raw: string
  try {
    raw = await readFile(eventsPath, 'utf8')
  } catch {
    return []
  }

  const deduped = new Map<string, TaskChangeEventV1>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const parsed = JSON.parse(line) as TaskChangeEventV1
      if (
        parsed?.schemaVersion === TASK_CHANGE_LEDGER_SCHEMA_VERSION &&
        typeof parsed.eventId === 'string' &&
        parsed.taskId === taskId
      ) {
        deduped.set(parsed.eventId, parsed)
      }
    } catch {
      // Ignore partial/corrupt trailing lines; future appends remain readable.
    }
  }
  return [...deduped.values()].sort((a, b) => {
    const timeDiff = Date.parse(a.timestamp) - Date.parse(b.timestamp)
    return timeDiff === 0 ? a.eventId.localeCompare(b.eventId) : timeDiff
  })
}

async function readTaskNotices(taskId: string, projectDir: string): Promise<TaskChangeNoticeV1[]> {
  const noticesPath = getNoticesPath(taskId, projectDir)
  let raw: string
  try {
    raw = await readFile(noticesPath, 'utf8')
  } catch {
    return []
  }

  const deduped = new Map<string, TaskChangeNoticeV1>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const parsed = JSON.parse(line) as TaskChangeNoticeV1
      if (
        parsed?.schemaVersion === TASK_CHANGE_LEDGER_SCHEMA_VERSION &&
        typeof parsed.noticeId === 'string' &&
        parsed.taskId === taskId
      ) {
        deduped.set(parsed.noticeId, parsed)
      }
    } catch {
      // Ignore partial/corrupt trailing lines; future appends remain readable.
    }
  }
  return [...deduped.values()].sort((a, b) => {
    const timeDiff = Date.parse(a.timestamp) - Date.parse(b.timestamp)
    return timeDiff === 0 ? a.noticeId.localeCompare(b.noticeId) : timeDiff
  })
}

async function rebuildBundle(taskId: string, projectDir: string): Promise<void> {
  const events = await readTaskEvents(taskId, projectDir)
  const notices = await readTaskNotices(taskId, projectDir)
  const warnings = new Set<string>()
  const filesByPath = new Map<
    string,
    {
      filePath: string
      relativePath: string
      eventIds: string[]
      linesAdded: number
      linesRemoved: number
      isNewFile: boolean
      latestAfterHash: string | null
    }
  >()

  for (const event of events) {
    for (const warning of event.warnings ?? []) {
      warnings.add(warning)
    }

    const existing = filesByPath.get(event.filePath) ?? {
      filePath: event.filePath,
      relativePath: event.relativePath,
      eventIds: [],
      linesAdded: 0,
      linesRemoved: 0,
      isNewFile: event.operation === 'create',
      latestAfterHash: null,
    }

    const { added, removed } =
      event.linesAdded !== undefined && event.linesRemoved !== undefined
        ? { added: event.linesAdded, removed: event.linesRemoved }
        : countLineChanges(event.oldString ?? null, event.newString ?? null)
    existing.eventIds.push(event.eventId)
    existing.linesAdded += added
    existing.linesRemoved += removed
    existing.isNewFile ||= event.operation === 'create'
    existing.latestAfterHash = event.after?.sha256 ?? null
    filesByPath.set(event.filePath, existing)
  }
  for (const notice of notices) {
    warnings.add(notice.message)
  }

  const files = [...filesByPath.values()]
  const hasLowConfidence = events.some(
    event => event.confidence === 'medium' || event.confidence === 'low',
  )
  const bundle: TaskChangeBundleV1 = {
    schemaVersion: TASK_CHANGE_LEDGER_SCHEMA_VERSION,
    source: 'task-change-ledger',
    taskId,
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    files,
    totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
    totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
    totalFiles: files.length,
    confidence: hasLowConfidence ? 'medium' : 'high',
    warnings: [...warnings],
    events,
    ...(notices.length > 0 ? { notices } : {}),
  }

  await writeAtomic(getBundlePath(taskId, projectDir), JSON.stringify(bundle))
  await writeAtomic(
    getFreshnessPath(taskId, projectDir),
    JSON.stringify({
      taskId,
      updatedAt: bundle.generatedAt,
      eventCount: events.length,
      source: 'task-change-ledger',
    }),
  )
}

function enqueueTaskWrite(taskId: string, write: () => Promise<void>): Promise<void> {
  const previous = taskWriteQueues.get(taskId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(write)
    .finally(() => {
      if (taskWriteQueues.get(taskId) === next) {
        taskWriteQueues.delete(taskId)
      }
    })
  taskWriteQueues.set(taskId, next)
  return next
}

async function persistNotice(params: {
  scope: ResolvedTaskScope
  sessionId: string
  agentId?: AgentId
  toolUseId: string
  message: string
}): Promise<void> {
  const projectDir = getLedgerProjectDir()
  const noticeBase: Omit<TaskChangeNoticeV1, 'noticeId'> = {
    schemaVersion: TASK_CHANGE_LEDGER_SCHEMA_VERSION,
    taskId: params.scope.taskId,
    taskRef: params.scope.task.ref,
    taskRefKind: params.scope.task.refKind,
    phase: params.scope.phase,
    executionSeq: params.scope.executionSeq,
    sessionId: params.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    toolUseId: params.toolUseId,
    timestamp: new Date().toISOString(),
    severity: 'warning',
    message: params.message,
  }
  const notice: TaskChangeNoticeV1 = {
    ...noticeBase,
    noticeId: buildNoticeId(noticeBase),
  }
  await enqueueTaskWrite(params.scope.taskId, async () => {
    await appendNotice(notice, projectDir)
    await rebuildBundle(params.scope.taskId, projectDir)
  })
}

async function persistEvents(changes: ExactFileChange[], params: {
  scope: ResolvedTaskScope
  sessionId: string
  agentId?: AgentId
  toolUseId: string
  workspaceRoot: string
  toolStatus: TaskChangeToolStatus
}): Promise<void> {
  if (changes.length === 0) {
    return
  }

  const projectDir = getLedgerProjectDir()
  const timestamp = new Date().toISOString()
  const events: TaskChangeEventV1[] = []

  for (const change of changes) {
    const filePath = normalizeFilePath(change.filePath, params.workspaceRoot)
    if (change.beforeContent !== null && change.afterContent !== null) {
      if (sha256(change.beforeContent) === sha256(change.afterContent)) {
        continue
      }
    }

    const before = await buildContentRef(change.beforeContent, projectDir)
    const after = await buildContentRef(change.afterContent, projectDir)
    const operation = change.operation ??
      operationForContents(change.beforeContent, change.afterContent)
    const beforeState = defaultStateForSide(
      change.beforeState,
      before,
      change.beforeContent,
      operation,
      'before',
    )
    const afterState = defaultStateForSide(
      change.afterState,
      after,
      change.afterContent,
      operation,
      'after',
    )
    const lineStats = countLineChanges(
      change.oldString ?? change.beforeContent,
      change.newString ?? change.afterContent,
    )
    const eventBase: Omit<TaskChangeEventV1, 'eventId'> = {
      schemaVersion: TASK_CHANGE_LEDGER_SCHEMA_VERSION,
      taskId: params.scope.taskId,
      taskRef: params.scope.task.ref,
      taskRefKind: params.scope.task.refKind,
      phase: params.scope.phase,
      executionSeq: params.scope.executionSeq,
      sessionId: params.sessionId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      toolUseId: params.toolUseId,
      source: change.source,
      operation,
      confidence: change.confidence,
      workspaceRoot: params.workspaceRoot,
      filePath,
      relativePath: displayRelativePath(filePath, params.workspaceRoot),
      timestamp,
      toolStatus: params.toolStatus,
      before,
      after,
      ...(beforeState ? { beforeState } : {}),
      ...(afterState ? { afterState } : {}),
      ...(change.relation ? { relation: change.relation } : {}),
      linesAdded: lineStats.added,
      linesRemoved: lineStats.removed,
      ...(change.oldString !== undefined ? { oldString: change.oldString } : {}),
      ...(change.newString !== undefined ? { newString: change.newString } : {}),
      ...(change.replaceAll !== undefined ? { replaceAll: change.replaceAll } : {}),
      ...(change.structuredPatch !== undefined
        ? { structuredPatch: change.structuredPatch }
        : {}),
      ...(change.warnings?.length ? { warnings: change.warnings } : {}),
    }
    events.push({ ...eventBase, eventId: buildEventId(eventBase) })
  }

  if (events.length === 0) {
    return
  }

  await enqueueTaskWrite(params.scope.taskId, async () => {
    for (const event of events) {
      await appendEvent(event, projectDir)
    }
    await rebuildBundle(params.scope.taskId, projectDir)
  })
}

function getStringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined
  }
  const value = (record as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function getBooleanField(record: unknown, key: string): boolean | undefined {
  if (!record || typeof record !== 'object') {
    return undefined
  }
  const value = (record as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

function extractExactFileChanges(toolName: string, resultData: unknown): ExactFileChange[] {
  if (!resultData || typeof resultData !== 'object') {
    return []
  }

  if (toolName === FILE_EDIT_TOOL_NAME) {
    const filePath = getStringField(resultData, 'filePath')
    const beforeContent = getStringField(resultData, 'originalFile')
    const afterContent = getStringField(resultData, 'updatedFile')
    if (!filePath || beforeContent === undefined || afterContent === undefined) {
      return []
    }
    return [
      {
        filePath,
        beforeContent,
        afterContent,
        source: 'file_edit',
        confidence: 'exact',
        oldString: getStringField(resultData, 'oldString'),
        newString: getStringField(resultData, 'actualNewString') ??
          getStringField(resultData, 'newString'),
        replaceAll: getBooleanField(resultData, 'replaceAll'),
        structuredPatch: (resultData as Record<string, unknown>).structuredPatch,
      },
    ]
  }

  if (toolName === FILE_WRITE_TOOL_NAME) {
    const filePath = getStringField(resultData, 'filePath')
    const afterContent = getStringField(resultData, 'content')
    if (!filePath || afterContent === undefined) {
      return []
    }
    const originalFile = (resultData as Record<string, unknown>).originalFile
    const beforeContent = typeof originalFile === 'string' ? originalFile : null
    const type = getStringField(resultData, 'type')
    return [
      {
        filePath,
        beforeContent,
        afterContent,
        source: 'file_write',
        confidence: 'exact',
        structuredPatch: (resultData as Record<string, unknown>).structuredPatch,
        warnings: type === 'create' ? undefined : [],
      },
    ]
  }

  if (toolName === NOTEBOOK_EDIT_TOOL_NAME) {
    const filePath = getStringField(resultData, 'notebook_path')
    const beforeContent = getStringField(resultData, 'original_file')
    const afterContent = getStringField(resultData, 'updated_file')
    const error = getStringField(resultData, 'error')
    if (!filePath || error || beforeContent === undefined || afterContent === undefined) {
      return []
    }
    return [
      {
        filePath,
        beforeContent,
        afterContent,
        source: 'notebook_edit',
        confidence: 'exact',
      },
    ]
  }

  if (toolName === BASH_TOOL_NAME) {
    const rawChanges = (resultData as Record<string, unknown>).ledgerFileChanges
    if (!Array.isArray(rawChanges)) {
      return []
    }
    return rawChanges.flatMap(change => {
      if (!change || typeof change !== 'object') {
        return []
      }
      const filePath = getStringField(change, 'filePath')
      const beforeContent = getStringField(change, 'beforeContent')
      const afterContent = getStringField(change, 'afterContent')
      if (!filePath || beforeContent === undefined || afterContent === undefined) {
        return []
      }
      return [
        {
          filePath,
          beforeContent,
          afterContent,
          source: 'bash_simulated_sed' as const,
          confidence: 'exact' as const,
        },
      ]
    })
  }

  return []
}

async function materializePostHookDiskState(
  changes: ExactFileChange[],
  workspaceRoot: string,
): Promise<ExactFileChange[]> {
  const materialized: ExactFileChange[] = []
  for (const change of changes) {
    if (change.afterContent === null) {
      materialized.push(change)
      continue
    }

    const filePath = normalizeFilePath(change.filePath, workspaceRoot)
    const diskState = await readSmallTextFile(filePath)
    if (diskState.unavailableReason) {
      materialized.push({
        ...change,
        warnings: [
          ...(change.warnings ?? []),
          `PostToolUse disk validation skipped for ${displayRelativePath(filePath, workspaceRoot)}: ${diskState.unavailableReason}.`,
        ],
      })
      continue
    }
    if (
      diskState.content !== null &&
      sha256(diskState.content) === sha256(change.afterContent)
    ) {
      materialized.push(change)
      continue
    }
    if (change.beforeContent === null && diskState.content === null) {
      continue
    }

    materialized.push({
      ...change,
      afterContent: diskState.content,
      confidence: change.confidence === 'exact' ? 'high' : change.confidence,
      oldString: undefined,
      newString: undefined,
      warnings: [
        ...(change.warnings ?? []),
        `PostToolUse hooks changed ${displayRelativePath(filePath, workspaceRoot)} after the tool result; ledger stores final disk content.`,
      ],
    })
  }
  return materialized
}

export async function captureTaskChangeToolResult(params: {
  toolName: string
  resultData: unknown
  toolUseId: string
  sessionId?: string
  agentId?: AgentId
  toolStatus?: TaskChangeToolStatus
  materializePostHookDiskState?: boolean
}): Promise<string[]> {
  try {
    const sessionId = params.sessionId ?? getSessionId()
    const scope = await resolveTaskScopeForLedger({
      sessionId,
      agentId: params.agentId,
      toolUseId: params.toolUseId,
    })
    if (!scope) {
      return []
    }

    const workspaceRoot = getCwd()
    const extractedChanges = extractExactFileChanges(params.toolName, params.resultData)
    const changes = params.materializePostHookDiskState
      ? await materializePostHookDiskState(extractedChanges, workspaceRoot)
      : extractedChanges
    if (changes.length === 0) {
      return []
    }

    await persistEvents(changes, {
      scope,
      sessionId,
      agentId: params.agentId,
      toolUseId: params.toolUseId,
      workspaceRoot,
      toolStatus: params.toolStatus ?? 'succeeded',
    })
    return changes.map(change => normalizeFilePath(change.filePath, workspaceRoot))
  } catch (error) {
    logError(error)
    return []
  }
}

async function getGitRoot(cwd: string): Promise<string | null> {
  const result = await execFileNoThrowWithCwd('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  if (result.code !== 0) {
    return null
  }
  return result.stdout.trim() || null
}

async function getGitHead(gitRoot: string): Promise<string | null> {
  const result = await execFileNoThrowWithCwd('git', ['rev-parse', 'HEAD'], {
    cwd: gitRoot,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  if (result.code !== 0) {
    return null
  }
  return result.stdout.trim() || null
}

async function isGitAncestor(
  gitRoot: string,
  possibleAncestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    'git',
    ['merge-base', '--is-ancestor', possibleAncestor, descendant],
    {
      cwd: gitRoot,
      timeout: GIT_TIMEOUT_MS,
      preserveOutputOnError: false,
    },
  )
  return result.code === 0
}

async function getGitStatusPathResult(gitRoot: string) {
  return getGitStatusPathEntries({
    gitRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: MAX_GIT_OUTPUT_BYTES,
    maxPaths: MAX_GIT_PATH_ENTRIES,
  })
}

function looksBinary(content: string): boolean {
  return content.includes('\0')
}

function bufferLooksBinary(content: Buffer): boolean {
  return content.includes(0)
}

async function readSmallTextFile(filePath: string): Promise<ShellSnapshotFile> {
  try {
    const fileStat = await stat(filePath)
    const statFingerprint = `fs:${fileStat.isFile() ? 'file' : 'other'}:${fileStat.size}:${Math.round(fileStat.mtimeMs)}`
    if (!fileStat.isFile()) {
      return {
        content: null,
        exists: true,
        sizeBytes: fileStat.size,
        unavailableReason: 'not a regular file',
        fingerprint: statFingerprint,
      }
    }
    if (fileStat.size > MAX_TEXT_BLOB_BYTES) {
      return {
        content: null,
        exists: true,
        sizeBytes: fileStat.size,
        unavailableReason: `content exceeds ${MAX_TEXT_BLOB_BYTES} byte ledger limit`,
        fingerprint: statFingerprint,
      }
    }
    const content = await readFile(filePath)
    const contentFingerprint = sha256(content)
    if (bufferLooksBinary(content)) {
      return {
        content: null,
        exists: true,
        sha256: contentFingerprint,
        sizeBytes: fileStat.size,
        unavailableReason: 'binary file',
        fingerprint: contentFingerprint,
      }
    }
    return {
      content: content.toString('utf8'),
      exists: true,
      sha256: contentFingerprint,
      sizeBytes: fileStat.size,
      fingerprint: contentFingerprint,
    }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    if (code === 'ENOENT') {
      return { content: null, exists: false, fingerprint: 'missing' }
    }
    return { content: null, unavailableReason: 'unable to read file' }
  }
}

async function readGitBlob(
  gitRoot: string,
  revision: string,
  relativePath: string,
): Promise<ShellSnapshotFile> {
  const objectSpec = `${revision}:${relativePath}`
  const objectIdResult = await execFileNoThrowWithCwd('git', ['rev-parse', objectSpec], {
    cwd: gitRoot,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  const objectId = objectIdResult.code === 0 ? objectIdResult.stdout.trim() : ''
  const sizeResult = await execFileNoThrowWithCwd('git', ['cat-file', '-s', objectSpec], {
    cwd: gitRoot,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  const size =
    sizeResult.code === 0 && sizeResult.stdout.trim()
      ? Number(sizeResult.stdout.trim())
      : Number.NaN
  const fingerprint = objectId
    ? `git:${objectId}:${Number.isFinite(size) ? size : 'unknown'}`
    : undefined

  if (Number.isFinite(size) && size > MAX_TEXT_BLOB_BYTES) {
    return {
      content: null,
      exists: true,
      sizeBytes: Number.isFinite(size) ? size : undefined,
      unavailableReason: `content exceeds ${MAX_TEXT_BLOB_BYTES} byte ledger limit`,
      fingerprint,
    }
  }

  const result = await execFileNoThrowWithCwd('git', ['show', objectSpec], {
    cwd: gitRoot,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
    maxBuffer: MAX_TEXT_BLOB_BYTES,
  })
  if (result.code !== 0) {
    return objectId || sizeResult.code === 0
      ? {
          content: null,
          exists: true,
          sizeBytes: Number.isFinite(size) ? size : undefined,
          unavailableReason: 'unable to read git blob',
          fingerprint,
        }
      : { content: null, exists: false, fingerprint: 'missing' }
  }
  if (looksBinary(result.stdout)) {
    return {
      content: null,
      exists: true,
      sizeBytes: Number.isFinite(size) ? size : undefined,
      unavailableReason: 'binary file',
      fingerprint: fingerprint ?? sha256(result.stdout),
    }
  }
  return {
    content: result.stdout,
    exists: true,
    sha256: sha256(result.stdout),
    sizeBytes: Number.isFinite(size) ? size : byteLength(result.stdout),
    fingerprint: fingerprint ?? sha256(result.stdout),
  }
}

function contentStateFromShellSource(source: ShellSnapshotFile): ContentStateRef {
  return {
    ...(source.exists !== undefined ? { exists: source.exists } : {}),
    ...(source.sha256 ? { sha256: source.sha256 } : {}),
    ...(source.sizeBytes !== undefined ? { sizeBytes: source.sizeBytes } : {}),
    ...(source.unavailableReason ? { unavailableReason: source.unavailableReason } : {}),
  }
}

function shouldPersistUnavailableShellChange(params: {
  relativePath: string
  beforeSource: ShellSnapshotFile
  afterSource: ShellSnapshotFile
  beforeStatusPaths: Set<string>
  afterStatusPaths: Set<string>
  committedChangePaths: Set<string>
}): boolean {
  const {
    relativePath,
    beforeSource,
    afterSource,
    beforeStatusPaths,
    afterStatusPaths,
    committedChangePaths,
  } = params
  if (beforeSource.content !== null || afterSource.content !== null) {
    return true
  }
  if (committedChangePaths.has(relativePath)) {
    return true
  }

  const wasDirty = beforeStatusPaths.has(relativePath)
  const isDirty = afterStatusPaths.has(relativePath)
  if (wasDirty !== isDirty) {
    return true
  }
  if (
    beforeSource.exists !== undefined &&
    afterSource.exists !== undefined &&
    beforeSource.exists !== afterSource.exists
  ) {
    return true
  }
  if (beforeSource.fingerprint && afterSource.fingerprint) {
    return beforeSource.fingerprint !== afterSource.fingerprint
  }
  return (
    (beforeSource.unavailableReason ?? '') !==
    (afterSource.unavailableReason ?? '')
  )
}

async function getCommittedChangePaths(
  gitRoot: string,
  beforeHead: string | null,
  afterHead: string | null,
): Promise<{
  entries: Map<string, GitChangePathEntry>
  paths: Set<string>
  warnings: string[]
  skippedReason?: string
}> {
  if (!beforeHead || !afterHead || beforeHead === afterHead) {
    return { entries: new Map(), paths: new Set(), warnings: [] }
  }

  const isAncestor = await isGitAncestor(gitRoot, beforeHead, afterHead)
  if (!isAncestor) {
    return {
      entries: new Map(),
      paths: new Set(),
      warnings: [],
      skippedReason:
        'Git HEAD changed but is not a descendant of the command start HEAD; committed diff skipped.',
    }
  }

  const result = await getGitCommittedPathEntries({
    gitRoot,
    beforeHead,
    afterHead,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: MAX_GIT_OUTPUT_BYTES,
    maxPaths: MAX_GIT_PATH_ENTRIES,
  })
  const unableWarning = result.warnings.find(warning =>
    warning.includes('Unable to read committed diff'),
  )
  if (unableWarning) {
    return {
      ...result,
      skippedReason: unableWarning,
    }
  }
  return result
}

async function snapshotFiles(
  gitRoot: string,
  paths: Set<string>,
): Promise<Map<string, ShellSnapshotFile>> {
  const entries = new Map<string, ShellSnapshotFile>()
  for (const relativePath of [...paths].slice(0, MAX_SHELL_SNAPSHOT_FILES)) {
    entries.set(relativePath, await readSmallTextFile(join(gitRoot, relativePath)))
  }
  return entries
}

function buildExcludedRelativePaths(
  gitRoot: string,
  filePaths?: Iterable<string>,
): Set<string> {
  const excluded = new Set<string>()
  if (!filePaths) {
    return excluded
  }
  for (const filePath of filePaths) {
    const normalized = normalizeFilePath(filePath, gitRoot)
    const relativePath = relative(gitRoot, normalized)
    if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      excluded.add(relativePath)
    }
  }
  return excluded
}

export async function maybeBeginTaskChangeShellSnapshot(params: {
  toolName: string
  input: unknown
  toolUseId: string
  sessionId?: string
  agentId?: AgentId
  includeNonBashTool?: boolean
}): Promise<ShellSnapshot | null> {
  if (params.toolName !== BASH_TOOL_NAME && !params.includeNonBashTool) {
    return null
  }
  if (
    params.toolName === BASH_TOOL_NAME &&
    params.input &&
    typeof params.input === 'object' &&
    '_simulatedSedEdit' in params.input &&
    !params.includeNonBashTool
  ) {
    return null
  }

  try {
    const sessionId = params.sessionId ?? getSessionId()
    const scope = await resolveTaskScopeForLedger({
      sessionId,
      agentId: params.agentId,
      toolUseId: params.toolUseId,
    })
    if (!scope) {
      return null
    }

    const workspaceRoot = getCwd()
    const gitRoot = await getGitRoot(workspaceRoot)
    if (!gitRoot) {
      return null
    }

    const beforeHead = await getGitHead(gitRoot)
    const beforeStatus = await getGitStatusPathResult(gitRoot)
    const beforeStatusPaths = beforeStatus.paths
    const beforeFiles = await snapshotFiles(gitRoot, beforeStatusPaths)
    return {
      id: sha256(`${sessionId}:${params.agentId ?? 'main'}:${params.toolUseId}:${Date.now()}`),
      scope,
      sessionId,
      agentId: params.agentId,
      toolUseId: params.toolUseId,
      workspaceRoot,
      gitRoot,
      beforeHead,
      beforeFiles,
      beforeStatusPaths,
      beforeStatusEntries: beforeStatus.entries,
      warnings: beforeStatus.warnings,
      startedAt: new Date().toISOString(),
    }
  } catch (error) {
    logError(error)
    return null
  }
}

export function deferTaskChangeShellSnapshot(
  backgroundTaskId: string,
  snapshot: ShellSnapshot | null,
  options?: FinishShellSnapshotOptions,
): void {
  if (!snapshot) {
    return
  }
  pendingShellSnapshots.set(backgroundTaskId, { snapshot, options })
}

export async function finishTaskChangeShellSnapshot(
  snapshot: ShellSnapshot | null,
  toolStatus: TaskChangeToolStatus,
  options: FinishShellSnapshotOptions = {},
): Promise<void> {
  if (!snapshot) {
    return
  }

  try {
    const afterStatus = await getGitStatusPathResult(snapshot.gitRoot)
    const afterStatusPaths = afterStatus.paths
    const afterHead = await getGitHead(snapshot.gitRoot)
    const committedChangePaths = await getCommittedChangePaths(
      snapshot.gitRoot,
      snapshot.beforeHead,
      afterHead,
    )
    const allPathEntries = new Map<string, GitChangePathEntry>([
      ...snapshot.beforeStatusEntries,
      ...afterStatus.entries,
      ...committedChangePaths.entries,
    ])
    const allPaths = new Set(allPathEntries.keys())
    const excludedRelativePaths = buildExcludedRelativePaths(
      snapshot.gitRoot,
      options.excludedFilePaths,
    )
    for (const relativePath of excludedRelativePaths) {
      allPaths.delete(relativePath)
    }
    const warnings: string[] = [
      ...snapshot.warnings,
      ...afterStatus.warnings,
      ...committedChangePaths.warnings,
    ]
    if (committedChangePaths.skippedReason) {
      warnings.push(committedChangePaths.skippedReason)
    }
    if (allPaths.size > MAX_SHELL_SNAPSHOT_FILES) {
      warnings.push(
        `Shell snapshot touched ${allPaths.size} files; captured first ${MAX_SHELL_SNAPSHOT_FILES}.`,
      )
    }

    const changes: ExactFileChange[] = []
    for (const relativePath of [...allPaths].slice(0, MAX_SHELL_SNAPSHOT_FILES)) {
      const beforeSnapshot = snapshot.beforeFiles.get(relativePath)
      const beforeSource =
        beforeSnapshot ??
        (snapshot.beforeHead
          ? await readGitBlob(snapshot.gitRoot, snapshot.beforeHead, relativePath)
          : { content: null, unavailableReason: 'git HEAD unavailable at command start' })
      const beforeContent = beforeSource.content
      const afterSnapshot = await readSmallTextFile(join(snapshot.gitRoot, relativePath))
      const afterSource =
        afterStatusPaths.has(relativePath) || !afterHead
          ? afterSnapshot
          : await readGitBlob(snapshot.gitRoot, afterHead, relativePath)
      const afterContent = afterSource.content

      if (
        beforeContent === null &&
        afterContent === null &&
        !shouldPersistUnavailableShellChange({
          relativePath,
          beforeSource,
          afterSource,
          beforeStatusPaths: snapshot.beforeStatusPaths,
          afterStatusPaths,
          committedChangePaths: committedChangePaths.paths,
        })
      ) {
        continue
      }
      if (
        beforeContent !== null &&
        afterContent !== null &&
        sha256(beforeContent) === sha256(afterContent)
      ) {
        continue
      }

      const fileWarnings = [
        ...warnings,
        beforeSource.unavailableReason
          ? `Before content unavailable for ${relativePath}: ${beforeSource.unavailableReason}.`
          : '',
        afterSource.unavailableReason
          ? `After content unavailable for ${relativePath}: ${afterSource.unavailableReason}.`
          : '',
      ].filter(Boolean)

      changes.push({
        filePath: join(snapshot.gitRoot, relativePath),
        beforeContent,
        afterContent,
        source: options.source ?? 'shell_snapshot',
        confidence: options.confidence ?? 'high',
        operation: operationForShellSources(beforeSource, afterSource),
        beforeState: contentStateFromShellSource(beforeSource),
        afterState: contentStateFromShellSource(afterSource),
        relation: relationFromGitEntry(allPathEntries.get(relativePath)),
        warnings: fileWarnings.length > 0 ? fileWarnings : undefined,
      })
    }

    await persistEvents(changes, {
      scope: snapshot.scope,
      sessionId: snapshot.sessionId,
      agentId: snapshot.agentId,
      toolUseId: snapshot.toolUseId,
      workspaceRoot: snapshot.workspaceRoot,
      toolStatus,
    })
  } catch (error) {
    logError(error)
  }
}

export async function completeDeferredTaskChangeShellSnapshot(
  backgroundTaskId: string,
  toolStatus: TaskChangeToolStatus,
): Promise<void> {
  const pending = pendingShellSnapshots.get(backgroundTaskId)
  if (!pending) {
    return
  }
  pendingShellSnapshots.delete(backgroundTaskId)
  await finishTaskChangeShellSnapshot(
    pending.snapshot,
    toolStatus,
    pending.options,
  )
}

export function buildTaskChangeLedgerDebugPath(taskId: string): string {
  return join(getLedgerDir(), 'bundles', `${encodeTaskId(taskId)}.json`)
}
