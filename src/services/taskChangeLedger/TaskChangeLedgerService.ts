import { createHash, randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { constants as fsConstants } from 'fs'
import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
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
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { getAgentName } from '../../utils/teammate.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { getRuntimeBoardTaskExecutionStore } from '../boardTaskActivity/RuntimeBoardTaskExecutionStore.js'
import type { BoardTaskLocator, BoardTaskPhase } from '../boardTaskActivity/contract.js'
import {
  getGitCommittedPathEntries,
  getGitStatusPathEntries,
  type GitChangePathEntry,
  type GitChangeRelation,
} from './GitChangePathProvider.js'
import { acquireTaskWriterLock } from './TaskChangeWriterLock.js'
import {
  TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV,
  TASK_CHANGE_LEDGER_PROJECT_DIR_ENV,
  TASK_CHANGE_WORKTREE_BRANCH_ENV,
  TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV,
  TASK_CHANGE_WORKTREE_PATH_ENV,
} from './env.js'

const TASK_CHANGE_JOURNAL_SCHEMA_VERSION = 1
const TASK_CHANGE_SUMMARY_BUNDLE_SCHEMA_VERSION = 2
const TASK_CHANGE_FRESHNESS_SCHEMA_VERSION = 2
const TASK_CHANGE_LEDGER_DIRNAME = '.board-task-changes'
const TASK_CHANGE_FRESHNESS_DIRNAME = '.board-task-change-freshness'
const TASK_CHANGE_FILE_SUFFIX = '.json'
const MAX_TEXT_BLOB_BYTES = 1024 * 1024
const MAX_SHELL_SNAPSHOT_FILES = 80
const MAX_GIT_PATH_ENTRIES = 500
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 2000
const JOURNAL_STAMP_TAIL_BYTES = 4096
const TASK_WRITER_LOCK_WAIT_BUDGET_MS = 2000
const DEFERRED_SHELL_SNAPSHOT_SCHEMA_VERSION = 1
const DEFERRED_SHELL_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFERRED_SHELL_SNAPSHOT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const MAX_DEFERRED_SHELL_SNAPSHOT_CLEANUP_FILES = 100
const DEFERRED_SHELL_SNAPSHOT_RECOVERY_WARNING =
  'Task change ledger recovered a deferred shell snapshot from disk after in-memory state was unavailable.'
const DEFERRED_SHELL_SNAPSHOT_MEMORY_ONLY_WARNING =
  'Task change ledger could not persist deferred shell snapshot; recovery is memory-only.'

export type TaskChangeConfidence = 'exact' | 'high' | 'medium' | 'low' | 'ambiguous'
export type TaskChangeOperation = 'create' | 'modify' | 'delete'
export type TaskChangeSource =
  | 'file_edit'
  | 'file_write'
  | 'notebook_edit'
  | 'bash_simulated_sed'
  | 'shell_snapshot'
  | 'powershell_snapshot'
  | 'post_tool_hook_snapshot'
  | 'opencode_toolpart_write'
  | 'opencode_toolpart_edit'
export type TaskChangeToolStatus = 'succeeded' | 'failed' | 'killed' | 'backgrounded'

export type ResolvedTaskScope = {
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
  schemaVersion: typeof TASK_CHANGE_JOURNAL_SCHEMA_VERSION
  eventId: string
  taskId: string
  taskRef: string
  taskRefKind: BoardTaskLocator['refKind']
  phase: BoardTaskPhase
  executionSeq: number
  sessionId: string
  agentId?: string
  memberName?: string
  toolUseId: string
  source: TaskChangeSource
  operation: TaskChangeOperation
  confidence: TaskChangeConfidence
  workspaceRoot: string
  worktreePath?: string
  worktreeBranch?: string
  baseWorkspaceRoot?: string
  dirtyLeaderWarning?: string
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
  sourceRuntime?: 'opencode'
  sourceProvider?: 'opencode'
  sourceSessionId?: string
  sourcePartId?: string
  sourceMessageId?: string
  parentUserMessageId?: string
  attributionMethod?: 'delivery-ledger-taskrefs'
  sourceImportKey?: string
  importedAt?: string
  importBatchId?: string
  importSchemaVersion?: 1
}

type TaskChangeNoticeV1 = {
  schemaVersion: typeof TASK_CHANGE_JOURNAL_SCHEMA_VERSION
  noticeId: string
  taskId: string
  taskRef: string
  taskRefKind: BoardTaskLocator['refKind']
  phase: BoardTaskPhase
  executionSeq: number
  sessionId: string
  agentId?: string
  memberName?: string
  toolUseId: string
  timestamp: string
  severity: 'warning'
  message: string
  code?: 'multi-scope-skipped' | 'journal-recovered' | 'writer-lock-stolen'
}

type JournalFileStamp = {
  bytes: number
  mtimeMs: number
  tailSha256: string | null
}

type TaskChangeJournalStamp = {
  events?: JournalFileStamp
  notices?: JournalFileStamp
}

type TaskChangeContributorSummaryV2 = {
  actorKey: string
  agentId?: string
  memberName?: string
  eventCount: number
  noticeCount: number
  touchedFileCount: number
  visibleFileCount: number
  toolUseCount: number
  cumulativeLinesAdded: number
  cumulativeLinesRemoved: number
  firstTimestamp: string
  lastTimestamp: string
}

type TaskChangeSummaryScopeV2 = {
  confidence: {
    tier: 1 | 2 | 3 | 4
    label: 'high' | 'medium' | 'low' | 'fallback'
    reason: string
  }
  primaryActorKey?: string
  primaryAgentId?: string
  primaryMemberName?: string
  memberName: string
  agentIds: string[]
  memberNames?: string[]
  startTimestamp: string
  endTimestamp: string
  toolUseIds: string[]
  toolUseCount: number
  toolUseIdsTruncated?: boolean
  phaseSet: Array<'work' | 'review'>
  executionSeqRange?: { start: number; end: number }
  confidenceBreakdown?: {
    capture: 'exact' | 'high' | 'medium' | 'low'
    attribution: 'high' | 'medium' | 'low' | 'ambiguous'
    reviewability: 'full-text' | 'mixed' | 'metadata-only'
  }
  visibleFileCount: number
  contributors: TaskChangeContributorSummaryV2[]
  worktreePaths?: string[]
  worktreeBranches?: string[]
  baseWorkspaceRoots?: string[]
  dirtyLeaderWarnings?: string[]
}

type TaskChangeSummaryFileV2 = {
  changeKey: string
  filePath: string
  relativePath: string
  displayPath?: string
  linesAdded: number
  linesRemoved: number
  diffStatKnown: boolean
  eventCount: number
  firstTimestamp: string
  lastTimestamp: string
  latestOperation: TaskChangeOperation
  createdInTask: boolean
  deletedInTask: boolean
  baselineExists?: boolean
  finalExists?: boolean
  latestBeforeHash: string | null
  latestAfterHash: string | null
  latestBeforeState?: ContentStateRef
  latestAfterState?: ContentStateRef
  contentAvailability: 'full-text' | 'hash-only' | 'metadata-only'
  reviewability: 'full-text' | 'partial-text' | 'metadata-only'
  relation?: TaskChangeRelation
  worktreePath?: string
  worktreeBranch?: string
  baseWorkspaceRoot?: string
  dirtyLeaderWarning?: string
  primaryActorKey?: string
  agentIds: string[]
  memberNames?: string[]
  executionSeqRange?: { start: number; end: number }
  warnings?: string[]
}

type TaskChangeSummaryBundleV2 = {
  schemaVersion: typeof TASK_CHANGE_SUMMARY_BUNDLE_SCHEMA_VERSION
  source: 'task-change-ledger'
  bundleKind: 'summary'
  taskId: string
  generatedAt: string
  journalStamp: TaskChangeJournalStamp
  integrity: 'ok' | 'recovered' | 'partial'
  eventCount: number
  noticeCount: number
  scope: TaskChangeSummaryScopeV2
  files: TaskChangeSummaryFileV2[]
  totalLinesAdded: number
  totalLinesRemoved: number
  diffStatCompleteness: 'complete' | 'partial'
  totalFiles: number
  confidence: 'high' | 'medium' | 'low'
  warningCount: number
  warnings: string[]
}

type TaskChangeFreshnessSignalV2 = {
  schemaVersion: typeof TASK_CHANGE_FRESHNESS_SCHEMA_VERSION
  source: 'task-change-ledger'
  taskId: string
  updatedAt: string
  journalStamp: TaskChangeJournalStamp
  eventCount: number
  noticeCount: number
  integrity: 'ok' | 'recovered' | 'partial'
  bundleSchemaVersion: typeof TASK_CHANGE_SUMMARY_BUNDLE_SCHEMA_VERSION
  bundleKind: 'summary'
}

type JournalReadResult<T> = {
  entries: T[]
  recovered: boolean
}

export type ExactFileChange = {
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

export type ImportedOpenCodeFileChange = ExactFileChange & {
  source: Extract<TaskChangeSource, 'opencode_toolpart_write' | 'opencode_toolpart_edit'>
  toolUseId: string
  timestamp: string
  sourceImportKey: string
  sourceRuntime?: 'opencode'
  sourceSessionId?: string
  sourcePartId?: string
  sourceMessageId?: string
  parentUserMessageId?: string
  attributionMethod?: TaskChangeEventV1['attributionMethod']
  importBatchId?: string
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

type SerializedShellSnapshot = Omit<
  ShellSnapshot,
  'beforeFiles' | 'beforeStatusPaths' | 'beforeStatusEntries'
> & {
  beforeFiles: Array<[string, ShellSnapshotFile]>
  beforeStatusPaths: string[]
  beforeStatusEntries: Array<[string, GitChangePathEntry]>
}

type SerializedFinishShellSnapshotOptions = Omit<
  FinishShellSnapshotOptions,
  'excludedFilePaths'
> & {
  excludedFilePaths?: string[]
}

type PersistedDeferredShellSnapshotV1 = {
  schemaVersion: typeof DEFERRED_SHELL_SNAPSHOT_SCHEMA_VERSION
  backgroundTaskId: string
  createdAt: string
  expiresAt: string
  snapshot: SerializedShellSnapshot
  options?: SerializedFinishShellSnapshotOptions
}

type DeferredShellSnapshotPointerV1 = {
  schemaVersion: typeof DEFERRED_SHELL_SNAPSHOT_SCHEMA_VERSION
  backgroundTaskId: string
  gitRoot: string
  projectDir?: string
  projectRecordPath: string
  createdAt: string
  expiresAt: string
}

type PendingDeferredShellSnapshot = {
  snapshot: ShellSnapshot
  options?: FinishShellSnapshotOptions
  projectRecordPath?: string
  globalPointerPath?: string
}

const pendingShellSnapshots = new Map<string, PendingDeferredShellSnapshot>()
const taskWriteQueues = new Map<string, Promise<void>>()
let lastDeferredShellSnapshotCleanupAt = 0
const MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH = 120

function isWindowsReservedArtifactSegment(segment: string): boolean {
  const stem = segment.split('.')[0]?.toUpperCase() ?? ''
  return (
    !segment ||
    stem === 'CON' ||
    stem === 'PRN' ||
    stem === 'AUX' ||
    stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  )
}

function encodeTaskId(taskId: string): string {
  const encoded = encodeURIComponent(taskId)
  return isWindowsReservedArtifactSegment(encoded) ||
    encoded.length > MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH
    ? `task-id-${sha256(taskId).slice(0, 32)}`
    : encoded
}

function getLedgerProjectDir(): string {
  const override = process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV]
  if (override && isAbsolute(override)) {
    return override
  }
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

function getLedgerDir(projectDir = getLedgerProjectDir()): string {
  return join(projectDir, TASK_CHANGE_LEDGER_DIRNAME)
}

function getDeferredShellSnapshotProjectRecordPath(projectDir: string, backgroundTaskId: string): string {
  return join(
    getLedgerDir(projectDir),
    'pending-shell-snapshots',
    `${encodeTaskId(backgroundTaskId)}.json`,
  )
}

function getDeferredShellSnapshotGlobalPointerDir(): string {
  return join(getClaudeConfigHomeDir(), 'task-change-ledger', 'pending-shell-snapshots')
}

function getDeferredShellSnapshotGlobalPointerPath(backgroundTaskId: string): string {
  return join(
    getDeferredShellSnapshotGlobalPointerDir(),
    `${encodeTaskId(backgroundTaskId)}.json`,
  )
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

function getLockRootDir(projectDir = getLedgerProjectDir()): string {
  return join(getLedgerDir(projectDir), 'locks')
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

function normalizeLedgerPathForKey(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/')
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function isTaskChangeLedgerInternalRelativePath(relativePath: string): boolean {
  return (
    relativePath === TASK_CHANGE_LEDGER_DIRNAME ||
    relativePath.startsWith(`${TASK_CHANGE_LEDGER_DIRNAME}/`) ||
    relativePath === TASK_CHANGE_FRESHNESS_DIRNAME ||
    relativePath.startsWith(`${TASK_CHANGE_FRESHNESS_DIRNAME}/`)
  )
}

function buildChangeKey(params: {
  filePath: string
  operation: TaskChangeOperation
  relation?: TaskChangeRelation
  worktreePath?: string
}): string {
  if (params.relation?.kind === 'rename') {
    return buildRelationChangeKey(params.relation, params.worktreePath)
  }
  if (params.relation?.kind === 'copy') {
    return buildRelationChangeKey(params.relation, params.worktreePath)
  }
  const normalizedPath = normalizeLedgerPathForKey(params.filePath)
  if (params.operation === 'create') {
    return `create:${normalizedPath}`
  }
  if (params.operation === 'delete') {
    return `delete:${normalizedPath}`
  }
  return `path:${normalizedPath}`
}

function buildRelationChangeKey(
  relation: TaskChangeRelation,
  worktreePath?: string,
): string {
  const pathPart = `${normalizeLedgerPathForKey(relation.oldPath)}->${normalizeLedgerPathForKey(relation.newPath)}`
  return worktreePath
    ? `${relation.kind}:${normalizeLedgerPathForKey(worktreePath)}:${pathPart}`
    : `${relation.kind}:${pathPart}`
}

function buildActorKey(input: { agentId?: string; memberName?: string; sessionId: string }): string {
  if (input.memberName?.trim()) {
    return `member:${input.memberName.trim()}`
  }
  if (input.agentId) {
    return `agent:${input.agentId}`
  }
  return `session:${input.sessionId}`
}

function resolveLedgerMemberName(agentId?: AgentId): string | undefined {
  const explicitAgentName = getAgentName()?.trim()
  if (explicitAgentName) {
    return explicitAgentName
  }
  if (!agentId) {
    return undefined
  }
  const deterministicTeammateIdMatch = /^([^@\s]+)@[^@\s]+$/.exec(agentId)
  return deterministicTeammateIdMatch?.[1]?.trim() || undefined
}

function isSameOrDescendantPath(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function getLedgerWorktreeMetadata(workspaceRoot: string): {
  worktreePath?: string
  worktreeBranch?: string
  baseWorkspaceRoot?: string
  dirtyLeaderWarning?: string
} {
  const context = getTeammateContext()
  const worktreePath =
    context?.worktreePath ?? process.env[TASK_CHANGE_WORKTREE_PATH_ENV]
  if (!worktreePath) {
    return {}
  }
  if (!isSameOrDescendantPath(workspaceRoot, worktreePath)) {
    return {}
  }
  const worktreeBranch =
    context?.worktreeBranch ?? process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV]
  const baseWorkspaceRoot =
    context?.baseWorkspaceRoot ??
    process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV]
  const dirtyLeaderWarning =
    context?.dirtyLeaderWarning ??
    process.env[TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV]
  return {
    worktreePath,
    ...(worktreeBranch ? { worktreeBranch } : {}),
    ...(baseWorkspaceRoot ? { baseWorkspaceRoot } : {}),
    ...(dirtyLeaderWarning ? { dirtyLeaderWarning } : {}),
  }
}

function normalizeFilePath(filePath: string, workspaceRoot: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath)
}

function displayRelativePath(filePath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, filePath)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel.replace(/\\/g, '/')
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

function serializeShellSnapshot(snapshot: ShellSnapshot): SerializedShellSnapshot {
  return {
    ...snapshot,
    beforeFiles: [...snapshot.beforeFiles.entries()],
    beforeStatusPaths: [...snapshot.beforeStatusPaths],
    beforeStatusEntries: [...snapshot.beforeStatusEntries.entries()],
  }
}

function deserializeShellSnapshot(snapshot: SerializedShellSnapshot): ShellSnapshot {
  const beforeFiles = Array.isArray(snapshot.beforeFiles)
    ? snapshot.beforeFiles.filter(
        (entry): entry is [string, ShellSnapshotFile] =>
          Array.isArray(entry) && typeof entry[0] === 'string',
      )
    : []
  const beforeStatusPaths = Array.isArray(snapshot.beforeStatusPaths)
    ? snapshot.beforeStatusPaths.filter((entry): entry is string => typeof entry === 'string')
    : []
  const beforeStatusEntries = Array.isArray(snapshot.beforeStatusEntries)
    ? snapshot.beforeStatusEntries.filter(
        (entry): entry is [string, GitChangePathEntry] =>
          Array.isArray(entry) && typeof entry[0] === 'string',
      )
    : []
  return {
    ...snapshot,
    beforeFiles: new Map(beforeFiles),
    beforeStatusPaths: new Set(beforeStatusPaths),
    beforeStatusEntries: new Map(beforeStatusEntries),
  }
}

function serializeFinishShellSnapshotOptions(
  options?: FinishShellSnapshotOptions,
): SerializedFinishShellSnapshotOptions | undefined {
  if (!options) {
    return undefined
  }
  return {
    ...(options.source ? { source: options.source } : {}),
    ...(options.confidence ? { confidence: options.confidence } : {}),
    ...(options.excludedFilePaths
      ? { excludedFilePaths: [...options.excludedFilePaths] }
      : {}),
  }
}

function deserializeFinishShellSnapshotOptions(
  options?: SerializedFinishShellSnapshotOptions,
): FinishShellSnapshotOptions | undefined {
  if (!options) {
    return undefined
  }
  return {
    ...(options.source ? { source: options.source } : {}),
    ...(options.confidence ? { confidence: options.confidence } : {}),
    ...(Array.isArray(options.excludedFilePaths)
      ? { excludedFilePaths: options.excludedFilePaths }
      : {}),
  }
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isExpiredIsoTimestamp(expiresAt: unknown): boolean {
  if (typeof expiresAt !== 'string') {
    return true
  }
  const timestamp = Date.parse(expiresAt)
  return !Number.isFinite(timestamp) || timestamp <= Date.now()
}

function isDeferredShellSnapshotPointer(
  value: Record<string, unknown> | null,
  backgroundTaskId?: string,
): value is DeferredShellSnapshotPointerV1 {
  return (
    value?.schemaVersion === DEFERRED_SHELL_SNAPSHOT_SCHEMA_VERSION &&
    typeof value.backgroundTaskId === 'string' &&
    (backgroundTaskId === undefined || value.backgroundTaskId === backgroundTaskId) &&
    typeof value.gitRoot === 'string' &&
    (value.projectDir === undefined || typeof value.projectDir === 'string') &&
    typeof value.projectRecordPath === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string'
  )
}

function isPersistedDeferredShellSnapshot(
  value: Record<string, unknown> | null,
  backgroundTaskId: string,
): value is PersistedDeferredShellSnapshotV1 {
  return (
    value?.schemaVersion === DEFERRED_SHELL_SNAPSHOT_SCHEMA_VERSION &&
    value.backgroundTaskId === backgroundTaskId &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    !!value.snapshot &&
    typeof value.snapshot === 'object' &&
    !Array.isArray(value.snapshot)
  )
}

async function removeDeferredShellSnapshotArtifacts(params: {
  projectRecordPath?: string
  globalPointerPath?: string
}): Promise<void> {
  await Promise.all(
    [params.projectRecordPath, params.globalPointerPath].map(async filePath => {
      if (!filePath) {
        return
      }
      try {
        await rm(filePath, { force: true })
      } catch (error) {
        logError(error)
      }
    }),
  )
}

function getExpectedProjectRecordPathFromPointer(
  pointer: DeferredShellSnapshotPointerV1,
): string {
  return getDeferredShellSnapshotProjectRecordPath(
    pointer.projectDir ?? pointer.gitRoot,
    pointer.backgroundTaskId,
  )
}

async function removeDeferredShellSnapshotPointerAndExpectedRecord(
  pointer: DeferredShellSnapshotPointerV1,
  globalPointerPath: string,
): Promise<void> {
  const expectedProjectRecordPath = getExpectedProjectRecordPathFromPointer(pointer)
  await removeDeferredShellSnapshotArtifacts({
    projectRecordPath:
      pointer.projectRecordPath === expectedProjectRecordPath
        ? expectedProjectRecordPath
        : undefined,
    globalPointerPath,
  })
}

async function isActiveDeferredShellSnapshotPointer(
  pointer: DeferredShellSnapshotPointerV1,
  globalPointerPath: string,
): Promise<boolean> {
  const expectedProjectRecordPath = getExpectedProjectRecordPathFromPointer(pointer)
  if (
    pointer.projectRecordPath !== expectedProjectRecordPath ||
    isExpiredIsoTimestamp(pointer.expiresAt)
  ) {
    await removeDeferredShellSnapshotPointerAndExpectedRecord(pointer, globalPointerPath)
    return false
  }

  try {
    const parsedRecord = parseJsonObject(await readFile(expectedProjectRecordPath, 'utf8'))
    if (
      !isPersistedDeferredShellSnapshot(parsedRecord, pointer.backgroundTaskId) ||
      isExpiredIsoTimestamp(parsedRecord.expiresAt)
    ) {
      await removeDeferredShellSnapshotPointerAndExpectedRecord(pointer, globalPointerPath)
      return false
    }
    return true
  } catch {
    await removeDeferredShellSnapshotPointerAndExpectedRecord(pointer, globalPointerPath)
    return false
  }
}

async function cleanupExpiredDeferredShellSnapshots(force = false): Promise<void> {
  const now = Date.now()
  if (
    !force &&
    now - lastDeferredShellSnapshotCleanupAt <
      DEFERRED_SHELL_SNAPSHOT_CLEANUP_INTERVAL_MS
  ) {
    return
  }
  lastDeferredShellSnapshotCleanupAt = now

  let entries: Awaited<ReturnType<typeof readdir>>
  const pointerDir = getDeferredShellSnapshotGlobalPointerDir()
  try {
    entries = await readdir(pointerDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries.slice(0, MAX_DEFERRED_SHELL_SNAPSHOT_CLEANUP_FILES)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    const globalPointerPath = join(pointerDir, entry.name)
    try {
      const parsedPointer = parseJsonObject(await readFile(globalPointerPath, 'utf8'))
      if (!isDeferredShellSnapshotPointer(parsedPointer)) {
        await removeDeferredShellSnapshotArtifacts({ globalPointerPath })
        continue
      }
      await isActiveDeferredShellSnapshotPointer(parsedPointer, globalPointerPath)
    } catch {
      await removeDeferredShellSnapshotArtifacts({ globalPointerPath })
    }
  }
}

async function assertNoActiveDeferredShellSnapshotPointer(
  backgroundTaskId: string,
): Promise<void> {
  const globalPointerPath = getDeferredShellSnapshotGlobalPointerPath(backgroundTaskId)
  let parsedPointer: Record<string, unknown> | null
  try {
    parsedPointer = parseJsonObject(await readFile(globalPointerPath, 'utf8'))
  } catch {
    return
  }
  if (!isDeferredShellSnapshotPointer(parsedPointer, backgroundTaskId)) {
    await removeDeferredShellSnapshotArtifacts({ globalPointerPath })
    return
  }
  if (await isActiveDeferredShellSnapshotPointer(parsedPointer, globalPointerPath)) {
    throw new Error(
      `Deferred shell snapshot already exists for background task ${backgroundTaskId}`,
    )
  }
}

async function persistDeferredShellSnapshot(
  backgroundTaskId: string,
  snapshot: ShellSnapshot,
  options?: FinishShellSnapshotOptions,
): Promise<{ projectRecordPath: string; globalPointerPath: string }> {
  const projectDir = getLedgerProjectDir()
  const projectRecordPath = getDeferredShellSnapshotProjectRecordPath(
    projectDir,
    backgroundTaskId,
  )
  const globalPointerPath = getDeferredShellSnapshotGlobalPointerPath(backgroundTaskId)
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + DEFERRED_SHELL_SNAPSHOT_TTL_MS).toISOString()
  const serializedOptions = serializeFinishShellSnapshotOptions(options)
  const record: PersistedDeferredShellSnapshotV1 = {
    schemaVersion: DEFERRED_SHELL_SNAPSHOT_SCHEMA_VERSION,
    backgroundTaskId,
    createdAt,
    expiresAt,
    snapshot: serializeShellSnapshot(snapshot),
    ...(serializedOptions ? { options: serializedOptions } : {}),
  }
  const pointer: DeferredShellSnapshotPointerV1 = {
    schemaVersion: DEFERRED_SHELL_SNAPSHOT_SCHEMA_VERSION,
    backgroundTaskId,
    gitRoot: snapshot.gitRoot,
    projectDir,
    projectRecordPath,
    createdAt,
    expiresAt,
  }

  let wroteProjectRecord = false
  try {
    await assertNoActiveDeferredShellSnapshotPointer(backgroundTaskId)
    await writeAtomic(projectRecordPath, `${JSON.stringify(record)}\n`)
    wroteProjectRecord = true
    await writeAtomic(globalPointerPath, `${JSON.stringify(pointer)}\n`)
    return { projectRecordPath, globalPointerPath }
  } catch (error) {
    if (wroteProjectRecord) {
      await removeDeferredShellSnapshotArtifacts({ projectRecordPath })
    }
    throw error
  }
}

async function readPersistedDeferredShellSnapshot(
  backgroundTaskId: string,
): Promise<{
  snapshot: ShellSnapshot
  options?: FinishShellSnapshotOptions
  projectRecordPath: string
  globalPointerPath: string
} | null> {
  const globalPointerPath = getDeferredShellSnapshotGlobalPointerPath(backgroundTaskId)
  let pointer: DeferredShellSnapshotPointerV1
  try {
    const parsedPointer = parseJsonObject(await readFile(globalPointerPath, 'utf8'))
    if (!isDeferredShellSnapshotPointer(parsedPointer, backgroundTaskId)) {
      await removeDeferredShellSnapshotArtifacts({ globalPointerPath })
      return null
    }
    pointer = parsedPointer
  } catch {
    return null
  }

  const expectedProjectRecordPath = getDeferredShellSnapshotProjectRecordPath(
    pointer.projectDir ?? pointer.gitRoot,
    backgroundTaskId,
  )
  if (
    pointer.projectRecordPath !== expectedProjectRecordPath ||
    isExpiredIsoTimestamp(pointer.expiresAt)
  ) {
    await removeDeferredShellSnapshotArtifacts({
      projectRecordPath:
        pointer.projectRecordPath === expectedProjectRecordPath
          ? expectedProjectRecordPath
          : undefined,
      globalPointerPath,
    })
    return null
  }

  try {
    const parsedRecord = parseJsonObject(await readFile(expectedProjectRecordPath, 'utf8'))
    if (
      !isPersistedDeferredShellSnapshot(parsedRecord, backgroundTaskId) ||
      isExpiredIsoTimestamp(parsedRecord.expiresAt)
    ) {
      await removeDeferredShellSnapshotArtifacts({
        projectRecordPath: expectedProjectRecordPath,
        globalPointerPath,
      })
      return null
    }
    return {
      snapshot: deserializeShellSnapshot(parsedRecord.snapshot),
      options: deserializeFinishShellSnapshotOptions(parsedRecord.options),
      projectRecordPath: expectedProjectRecordPath,
      globalPointerPath,
    }
  } catch {
    await removeDeferredShellSnapshotArtifacts({
      projectRecordPath: expectedProjectRecordPath,
      globalPointerPath,
    })
    return null
  }
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
  if (looksBinary(content)) {
    return null
  }
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
    ...(looksBinary(content) ? { unavailableReason: 'binary file' } : {}),
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
  if (
    byteLength(before) > MAX_TEXT_BLOB_BYTES ||
    byteLength(after) > MAX_TEXT_BLOB_BYTES ||
    looksBinary(before) ||
    looksBinary(after)
  ) {
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

function canUseSnippetLineStats(change: ExactFileChange): boolean {
  return (
    (change.beforeContent === null || !looksBinary(change.beforeContent)) &&
    (change.afterContent === null || !looksBinary(change.afterContent)) &&
    (change.beforeState?.unavailableReason === undefined || change.beforeState.exists === false) &&
    (change.afterState?.unavailableReason === undefined || change.afterState.exists === false)
  )
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

async function readJournalFileStamp(filePath: string): Promise<JournalFileStamp | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      return undefined
    }
    const tailLength = Math.min(fileStat.size, JOURNAL_STAMP_TAIL_BYTES)
    const tail = Buffer.alloc(tailLength)
    if (tailLength > 0) {
      await handle.read(tail, 0, tailLength, fileStat.size - tailLength)
    }
    return {
      bytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      tailSha256: tailLength > 0 ? sha256(tail) : null,
    }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function computeTaskJournalStamp(
  taskId: string,
  projectDir: string,
): Promise<TaskChangeJournalStamp> {
  const [events, notices] = await Promise.all([
    readJournalFileStamp(getEventsPath(taskId, projectDir)),
    readJournalFileStamp(getNoticesPath(taskId, projectDir)),
  ])
  return {
    ...(events ? { events } : {}),
    ...(notices ? { notices } : {}),
  }
}

function journalStampsEqual(
  left: TaskChangeJournalStamp,
  right: TaskChangeJournalStamp,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function readJournalEntries<T extends { taskId: string; schemaVersion: number }>(params: {
  filePath: string
  taskId: string
  schemaVersion: number
  idField: 'eventId' | 'noticeId'
}): Promise<JournalReadResult<T>> {
  let raw: string
  try {
    raw = await readFile(params.filePath, 'utf8')
  } catch {
    return { entries: [], recovered: false }
  }

  const entries: T[] = []
  const seenIds = new Set<string>()
  let recovered = false
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const parsed = JSON.parse(line) as T & Record<string, unknown>
      const id = parsed?.[params.idField]
      if (
        parsed?.schemaVersion !== params.schemaVersion ||
        typeof id !== 'string' ||
        parsed.taskId !== params.taskId
      ) {
        recovered = true
        continue
      }
      if (seenIds.has(id)) {
        recovered = true
        continue
      }
      seenIds.add(id)
      entries.push(parsed)
    } catch {
      recovered = true
    }
  }
  return { entries, recovered }
}

async function readTaskEvents(
  taskId: string,
  projectDir: string,
): Promise<JournalReadResult<TaskChangeEventV1>> {
  return readJournalEntries<TaskChangeEventV1>({
    filePath: getEventsPath(taskId, projectDir),
    taskId,
    schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
    idField: 'eventId',
  })
}

async function readTaskNotices(
  taskId: string,
  projectDir: string,
): Promise<JournalReadResult<TaskChangeNoticeV1>> {
  return readJournalEntries<TaskChangeNoticeV1>({
    filePath: getNoticesPath(taskId, projectDir),
    taskId,
    schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
    idField: 'noticeId',
  })
}

async function readContentTextFromRef(
  projectDir: string,
  ref: ContentRef | null,
): Promise<string | null> {
  if (!ref?.blobRef) {
    return null
  }
  try {
    return decodeTextBuffer(await readFile(join(getLedgerDir(projectDir), 'blobs', ref.blobRef)))
  } catch {
    return null
  }
}

function compareOptionalStrings(left: string | null, right: string | null): boolean | null {
  if (left === null || right === null) {
    return null
  }
  return left === right
}

function deriveSideText(
  side: 'before' | 'after',
  event: TaskChangeEventV1,
  fullText: string | null,
): string | null {
  if (fullText !== null) {
    return fullText
  }
  if (side === 'before' && event.operation === 'create') {
    return ''
  }
  if (side === 'after' && event.operation === 'delete') {
    return ''
  }
  return null
}

function statesEqual(
  baselineState: ContentStateRef | undefined,
  finalState: ContentStateRef | undefined,
  baselineText: string | null,
  finalText: string | null,
): boolean {
  const textComparison = compareOptionalStrings(baselineText, finalText)
  if (textComparison !== null) {
    return textComparison
  }
  if (
    baselineState?.exists !== undefined &&
    finalState?.exists !== undefined &&
    baselineState.exists !== finalState.exists
  ) {
    return false
  }
  if (baselineState?.sha256 && finalState?.sha256) {
    return baselineState.sha256 === finalState.sha256
  }
  if (
    baselineState?.exists !== undefined &&
    finalState?.exists !== undefined &&
    baselineState.exists === finalState.exists &&
    baselineState.exists === false
  ) {
    return true
  }
  return false
}

function confidenceLabelForEvents(events: TaskChangeEventV1[]): 'high' | 'medium' | 'low' {
  if (events.some(event => event.confidence === 'low' || event.confidence === 'ambiguous')) {
    return 'low'
  }
  if (events.some(event => event.confidence === 'medium')) {
    return 'medium'
  }
  return 'high'
}

function deriveCaptureConfidence(
  events: TaskChangeEventV1[],
): 'exact' | 'high' | 'medium' | 'low' {
  if (events.every(event => event.confidence === 'exact')) {
    return 'exact'
  }
  if (events.some(event => event.confidence === 'low' || event.confidence === 'ambiguous')) {
    return 'low'
  }
  if (events.some(event => event.confidence === 'medium')) {
    return 'medium'
  }
  return 'high'
}

async function rebuildBundle(taskId: string, projectDir: string): Promise<{
  bundle: TaskChangeSummaryBundleV2
  freshness: TaskChangeFreshnessSignalV2
}> {
  const [eventRead, noticeRead, journalStamp] = await Promise.all([
    readTaskEvents(taskId, projectDir),
    readTaskNotices(taskId, projectDir),
    computeTaskJournalStamp(taskId, projectDir),
  ])
  const events = eventRead.entries
  const notices = noticeRead.entries
  const recovered = eventRead.recovered || noticeRead.recovered
  const warnings = new Set<string>()

  type Accumulator = {
    groupKey: string
    filePath: string
    relativePath: string
    displayPath?: string
    relation?: TaskChangeRelation
    worktreePath?: string
    worktreeBranch?: string
    baseWorkspaceRoot?: string
    dirtyLeaderWarning?: string
    events: TaskChangeEventV1[]
    warnings: Set<string>
    agentIds: Set<string>
    memberNames: Set<string>
    actorCounts: Map<string, number>
    executionSeqMin: number
    executionSeqMax: number
  }

  const accumulators = new Map<string, Accumulator>()
  for (const event of events) {
    for (const warning of event.warnings ?? []) {
      warnings.add(warning)
    }
    if (event.toolStatus === 'failed') {
      warnings.add(`Tool ${event.toolUseId} failed after changing files.`)
    }
    if (event.toolStatus === 'killed') {
      warnings.add(`Background tool ${event.toolUseId} was killed after changing files.`)
    }
    const groupKey = event.relation
      ? buildRelationChangeKey(event.relation, event.worktreePath)
      : `path:${normalizeLedgerPathForKey(event.filePath)}`
    const existing = accumulators.get(groupKey) ?? {
      groupKey,
      filePath: event.relation?.newPath
        ? (isAbsolute(event.relation.newPath)
            ? event.relation.newPath
            : join(event.workspaceRoot, event.relation.newPath))
        : event.filePath,
      relativePath: event.relation?.newPath ?? event.relativePath,
      ...(event.relation?.newPath ? { displayPath: event.relation.newPath } : {}),
      ...(event.relation ? { relation: event.relation } : {}),
      ...(event.worktreePath ? { worktreePath: event.worktreePath } : {}),
      ...(event.worktreeBranch ? { worktreeBranch: event.worktreeBranch } : {}),
      ...(event.baseWorkspaceRoot ? { baseWorkspaceRoot: event.baseWorkspaceRoot } : {}),
      ...(event.dirtyLeaderWarning ? { dirtyLeaderWarning: event.dirtyLeaderWarning } : {}),
      events: [],
      warnings: new Set<string>(),
      agentIds: new Set<string>(),
      memberNames: new Set<string>(),
      actorCounts: new Map<string, number>(),
      executionSeqMin: event.executionSeq,
      executionSeqMax: event.executionSeq,
    }
    existing.events.push(event)
    event.agentId && existing.agentIds.add(event.agentId)
    event.memberName && existing.memberNames.add(event.memberName)
    const actorKey = buildActorKey({
      agentId: event.agentId,
      memberName: event.memberName,
      sessionId: event.sessionId,
    })
    existing.actorCounts.set(actorKey, (existing.actorCounts.get(actorKey) ?? 0) + 1)
    existing.executionSeqMin = Math.min(existing.executionSeqMin, event.executionSeq)
    existing.executionSeqMax = Math.max(existing.executionSeqMax, event.executionSeq)
    for (const warning of event.warnings ?? []) {
      existing.warnings.add(warning)
    }
    accumulators.set(groupKey, existing)
  }

  for (const notice of notices) {
    warnings.add(notice.message)
  }
  if (recovered) {
    warnings.add('Task change ledger recovered from malformed journal lines.')
  }

  const contributorTouched = new Map<string, Set<string>>()
  const contributorVisible = new Map<string, Set<string>>()
  const contributorSummaries = new Map<string, TaskChangeContributorSummaryV2>()
  const files: TaskChangeSummaryFileV2[] = []

  for (const accumulator of accumulators.values()) {
    const firstEvent = accumulator.events[0]
    const lastEvent = accumulator.events[accumulator.events.length - 1]
    const baselineState = firstEvent.beforeState ??
      (firstEvent.before
        ? contentStateFromContentRef(firstEvent.before)
        : firstEvent.operation === 'create'
          ? { exists: false }
          : undefined)
    const finalState = lastEvent.afterState ??
      (lastEvent.after
        ? contentStateFromContentRef(lastEvent.after)
        : lastEvent.operation === 'delete'
          ? { exists: false }
          : undefined)
    const [baselineRawText, finalRawText] = await Promise.all([
      readContentTextFromRef(projectDir, firstEvent.before),
      readContentTextFromRef(projectDir, lastEvent.after),
    ])
    const baselineText = deriveSideText('before', firstEvent, baselineRawText)
    const finalText = deriveSideText('after', lastEvent, finalRawText)
    const baselineHasReviewText =
      baselineRawText !== null ||
      (firstEvent.operation === 'create' && finalRawText !== null)
    const finalHasReviewText =
      finalRawText !== null ||
      (lastEvent.operation === 'delete' && baselineRawText !== null)
    const reviewability =
      baselineHasReviewText && finalHasReviewText
        ? 'full-text'
        : baselineHasReviewText || finalHasReviewText
          ? 'partial-text'
          : 'metadata-only'
    const contentAvailability =
      reviewability === 'full-text'
        ? 'full-text'
        : baselineState?.sha256 || finalState?.sha256
          ? 'hash-only'
          : 'metadata-only'
    const diffStatKnown = reviewability === 'full-text'
    const lineStats = diffStatKnown
      ? countLineChanges(baselineText, finalText)
      : { added: 0, removed: 0 }

    const visible = accumulator.relation
      ? accumulator.relation.kind === 'rename'
        ? normalizeLedgerPathForKey(accumulator.relation.oldPath) !==
          normalizeLedgerPathForKey(accumulator.relation.newPath)
        : finalState?.exists !== false
      : !statesEqual(baselineState, finalState, baselineText, finalText)

    const primaryActorKey = [...accumulator.actorCounts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1]
      }
      return left[0].localeCompare(right[0])
    })[0]?.[0]

    for (const event of accumulator.events) {
      const actorKey = buildActorKey({
        agentId: event.agentId,
        memberName: event.memberName,
        sessionId: event.sessionId,
      })
      const touched = contributorTouched.get(actorKey) ?? new Set<string>()
      touched.add(accumulator.groupKey)
      contributorTouched.set(actorKey, touched)

      const summary = contributorSummaries.get(actorKey) ?? {
        actorKey,
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.memberName ? { memberName: event.memberName } : {}),
        eventCount: 0,
        noticeCount: 0,
        touchedFileCount: 0,
        visibleFileCount: 0,
        toolUseCount: 0,
        cumulativeLinesAdded: 0,
        cumulativeLinesRemoved: 0,
        firstTimestamp: event.timestamp,
        lastTimestamp: event.timestamp,
      }
      const eventLineStats =
        event.linesAdded !== undefined && event.linesRemoved !== undefined
          ? { added: event.linesAdded, removed: event.linesRemoved }
          : countLineChanges(event.oldString ?? null, event.newString ?? null)
      summary.eventCount += 1
      summary.toolUseCount += 1
      summary.cumulativeLinesAdded += eventLineStats.added
      summary.cumulativeLinesRemoved += eventLineStats.removed
      summary.firstTimestamp =
        Date.parse(summary.firstTimestamp) <= Date.parse(event.timestamp)
          ? summary.firstTimestamp
          : event.timestamp
      summary.lastTimestamp =
        Date.parse(summary.lastTimestamp) >= Date.parse(event.timestamp)
          ? summary.lastTimestamp
          : event.timestamp
      contributorSummaries.set(actorKey, summary)
    }

    if (!visible) {
      continue
    }

    for (const actorKey of accumulator.actorCounts.keys()) {
      const visibleSet = contributorVisible.get(actorKey) ?? new Set<string>()
      visibleSet.add(accumulator.groupKey)
      contributorVisible.set(actorKey, visibleSet)
    }

    files.push({
      changeKey: buildChangeKey({
        filePath: accumulator.filePath,
        operation: lastEvent.operation,
        ...(accumulator.relation ? { relation: accumulator.relation } : {}),
        ...(accumulator.worktreePath ? { worktreePath: accumulator.worktreePath } : {}),
      }),
      filePath: accumulator.filePath,
      relativePath: accumulator.relativePath,
      ...(accumulator.displayPath ? { displayPath: accumulator.displayPath } : {}),
      linesAdded: lineStats.added,
      linesRemoved: lineStats.removed,
      diffStatKnown,
      eventCount: accumulator.events.length,
      firstTimestamp: firstEvent.timestamp,
      lastTimestamp: lastEvent.timestamp,
      latestOperation: lastEvent.operation,
      createdInTask: baselineState?.exists === false && finalState?.exists !== false,
      deletedInTask: baselineState?.exists !== false && finalState?.exists === false,
      ...(baselineState?.exists !== undefined ? { baselineExists: baselineState.exists } : {}),
      ...(finalState?.exists !== undefined ? { finalExists: finalState.exists } : {}),
      latestBeforeHash: firstEvent.before?.sha256 ?? baselineState?.sha256 ?? null,
      latestAfterHash: lastEvent.after?.sha256 ?? finalState?.sha256 ?? null,
      ...(baselineState ? { latestBeforeState: baselineState } : {}),
      ...(finalState ? { latestAfterState: finalState } : {}),
      contentAvailability,
      reviewability,
      ...(accumulator.relation ? { relation: accumulator.relation } : {}),
      ...(accumulator.worktreePath ? { worktreePath: accumulator.worktreePath } : {}),
      ...(accumulator.worktreeBranch ? { worktreeBranch: accumulator.worktreeBranch } : {}),
      ...(accumulator.baseWorkspaceRoot
        ? { baseWorkspaceRoot: accumulator.baseWorkspaceRoot }
        : {}),
      ...(accumulator.dirtyLeaderWarning
        ? { dirtyLeaderWarning: accumulator.dirtyLeaderWarning }
        : {}),
      ...(primaryActorKey ? { primaryActorKey } : {}),
      agentIds: [...accumulator.agentIds].sort(),
      ...(accumulator.memberNames.size > 0 ? { memberNames: [...accumulator.memberNames].sort() } : {}),
      executionSeqRange: {
        start: accumulator.executionSeqMin,
        end: accumulator.executionSeqMax,
      },
      ...(accumulator.warnings.size > 0 ? { warnings: [...accumulator.warnings] } : {}),
    })
  }

  for (const notice of notices) {
    const actorKey = buildActorKey({
      agentId: notice.agentId,
      memberName: notice.memberName,
      sessionId: notice.sessionId,
    })
    const summary = contributorSummaries.get(actorKey) ?? {
      actorKey,
      ...(notice.agentId ? { agentId: notice.agentId } : {}),
      ...(notice.memberName ? { memberName: notice.memberName } : {}),
      eventCount: 0,
      noticeCount: 0,
      touchedFileCount: 0,
      visibleFileCount: 0,
      toolUseCount: 0,
      cumulativeLinesAdded: 0,
      cumulativeLinesRemoved: 0,
      firstTimestamp: notice.timestamp,
      lastTimestamp: notice.timestamp,
    }
    summary.noticeCount += 1
    summary.firstTimestamp =
      Date.parse(summary.firstTimestamp) <= Date.parse(notice.timestamp)
        ? summary.firstTimestamp
        : notice.timestamp
    summary.lastTimestamp =
      Date.parse(summary.lastTimestamp) >= Date.parse(notice.timestamp)
        ? summary.lastTimestamp
        : notice.timestamp
    contributorSummaries.set(actorKey, summary)
  }

  const contributors = [...contributorSummaries.values()]
    .map(summary => ({
      ...summary,
      touchedFileCount: contributorTouched.get(summary.actorKey)?.size ?? 0,
      visibleFileCount: contributorVisible.get(summary.actorKey)?.size ?? 0,
    }))
    .sort((left, right) => {
      if (right.visibleFileCount !== left.visibleFileCount) {
        return right.visibleFileCount - left.visibleFileCount
      }
      if (right.eventCount !== left.eventCount) {
        return right.eventCount - left.eventCount
      }
      return left.actorKey.localeCompare(right.actorKey)
    })

  const uniqueToolUseIds = [...new Set([
    ...events.map(event => event.toolUseId),
    ...notices.map(notice => notice.toolUseId),
  ])]
  const captureConfidence = deriveCaptureConfidence(events)
  const bundleConfidence = confidenceLabelForEvents(events)
  const worktreePaths = [...new Set(events.flatMap(event => (event.worktreePath ? [event.worktreePath] : [])))].sort()
  const worktreeBranches = [...new Set(events.flatMap(event => (event.worktreeBranch ? [event.worktreeBranch] : [])))].sort()
  const baseWorkspaceRoots = [...new Set(events.flatMap(event => (event.baseWorkspaceRoot ? [event.baseWorkspaceRoot] : [])))].sort()
  const dirtyLeaderWarnings = [...new Set(events.flatMap(event => (event.dirtyLeaderWarning ? [event.dirtyLeaderWarning] : [])))].sort()
  const scope: TaskChangeSummaryScopeV2 = {
    confidence: {
      tier:
        bundleConfidence === 'high' ? 1 : bundleConfidence === 'medium' ? 2 : 3,
      label: bundleConfidence,
      reason: recovered
        ? 'Derived from task-change ledger with recovery from malformed journal lines'
        : 'Derived from task-change ledger',
    },
    ...(contributors[0]?.actorKey ? { primaryActorKey: contributors[0].actorKey } : {}),
    ...(contributors[0]?.agentId ? { primaryAgentId: contributors[0].agentId } : {}),
    ...(contributors[0]?.memberName ? { primaryMemberName: contributors[0].memberName } : {}),
    memberName:
      contributors[0]?.memberName ??
      contributors[0]?.agentId ??
      contributors[0]?.actorKey ??
      '',
    agentIds: [...new Set(events.flatMap(event => (event.agentId ? [event.agentId] : [])))].sort(),
    ...(events.some(event => !!event.memberName)
      ? {
          memberNames: [
            ...new Set(events.flatMap(event => (event.memberName ? [event.memberName] : []))),
          ].sort(),
        }
      : {}),
    startTimestamp: events[0]?.timestamp ?? notices[0]?.timestamp ?? new Date().toISOString(),
    endTimestamp:
      events[events.length - 1]?.timestamp ??
      notices[notices.length - 1]?.timestamp ??
      new Date().toISOString(),
    toolUseIds: uniqueToolUseIds.slice(0, 256),
    toolUseCount: uniqueToolUseIds.length,
    ...(uniqueToolUseIds.length > 256 ? { toolUseIdsTruncated: true } : {}),
    phaseSet: [...new Set(events.map(event => event.phase))].sort(),
    ...(events.length > 0
      ? {
          executionSeqRange: {
            start: Math.min(...events.map(event => event.executionSeq)),
            end: Math.max(...events.map(event => event.executionSeq)),
          },
        }
      : {}),
    confidenceBreakdown: {
      capture: captureConfidence,
      attribution: events.every(event => event.agentId) ? 'high' : 'medium',
      reviewability: files.every(file => file.reviewability === 'full-text')
        ? 'full-text'
        : files.some(file => file.reviewability === 'full-text' || file.reviewability === 'partial-text')
          ? 'mixed'
          : 'metadata-only',
    },
    visibleFileCount: files.length,
    contributors,
    ...(worktreePaths.length > 0 ? { worktreePaths } : {}),
    ...(worktreeBranches.length > 0 ? { worktreeBranches } : {}),
    ...(baseWorkspaceRoots.length > 0 ? { baseWorkspaceRoots } : {}),
    ...(dirtyLeaderWarnings.length > 0 ? { dirtyLeaderWarnings } : {}),
  }

  const bundle: TaskChangeSummaryBundleV2 = {
    schemaVersion: TASK_CHANGE_SUMMARY_BUNDLE_SCHEMA_VERSION,
    source: 'task-change-ledger',
    bundleKind: 'summary',
    taskId,
    generatedAt: new Date().toISOString(),
    journalStamp,
    integrity: recovered ? 'recovered' : 'ok',
    eventCount: events.length,
    noticeCount: notices.length,
    scope,
    files,
    totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
    totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
    diffStatCompleteness: files.every(file => file.diffStatKnown) ? 'complete' : 'partial',
    totalFiles: files.length,
    confidence: bundleConfidence,
    warningCount: warnings.size,
    warnings: [...warnings],
  }

  const freshness: TaskChangeFreshnessSignalV2 = {
    schemaVersion: TASK_CHANGE_FRESHNESS_SCHEMA_VERSION,
    source: 'task-change-ledger',
    taskId,
    updatedAt: bundle.generatedAt,
    journalStamp,
    eventCount: events.length,
    noticeCount: notices.length,
    integrity: bundle.integrity,
    bundleSchemaVersion: TASK_CHANGE_SUMMARY_BUNDLE_SCHEMA_VERSION,
    bundleKind: 'summary',
  }

  return { bundle, freshness }
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

async function writeDerivedArtifacts(taskId: string, projectDir: string): Promise<void> {
  const { bundle, freshness } = await rebuildBundle(taskId, projectDir)
  try {
    await writeAtomic(getBundlePath(taskId, projectDir), JSON.stringify(bundle))
    await writeAtomic(getFreshnessPath(taskId, projectDir), JSON.stringify(freshness))
  } catch (error) {
    const partialFreshness: TaskChangeFreshnessSignalV2 = {
      ...freshness,
      integrity: 'partial',
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeAtomic(getFreshnessPath(taskId, projectDir), JSON.stringify(partialFreshness))
    } catch (freshnessError) {
      logError(freshnessError)
    }
    throw error
  }
}

async function runTaskLedgerWrite(params: {
  scope: ResolvedTaskScope
  sessionId: string
  agentId?: AgentId
  toolUseId: string
  projectDir: string
  write: () => Promise<void>
}): Promise<void> {
  const lock = await acquireTaskWriterLock({
    lockRootDir: getLockRootDir(params.projectDir),
    taskId: params.scope.taskId,
    sessionId: params.sessionId,
    ownerId: randomUUID(),
    waitBudgetMs: TASK_WRITER_LOCK_WAIT_BUDGET_MS,
  })

  try {
    await params.write()
    if (lock.stoleStaleLock) {
      const noticeBase: Omit<TaskChangeNoticeV1, 'noticeId'> = {
        schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
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
        message: 'Task change ledger stole a stale writer lock before rebuilding the summary.',
        code: 'writer-lock-stolen',
      }
      await appendNotice(
        {
          ...noticeBase,
          noticeId: buildNoticeId(noticeBase),
        },
        params.projectDir,
      )
    }
    await writeDerivedArtifacts(params.scope.taskId, params.projectDir)
  } finally {
    await lock.release()
  }
}

async function persistNotice(params: {
  scope: ResolvedTaskScope
  sessionId: string
  agentId?: AgentId
  toolUseId: string
  message: string
}): Promise<void> {
  const projectDir = getLedgerProjectDir()
  const memberName = resolveLedgerMemberName(params.agentId)
  const noticeBase: Omit<TaskChangeNoticeV1, 'noticeId'> = {
    schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
    taskId: params.scope.taskId,
    taskRef: params.scope.task.ref,
    taskRefKind: params.scope.task.refKind,
    phase: params.scope.phase,
    executionSeq: params.scope.executionSeq,
    sessionId: params.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(memberName ? { memberName } : {}),
    toolUseId: params.toolUseId,
    timestamp: new Date().toISOString(),
    severity: 'warning',
    message: params.message,
    ...(params.message.includes('multiple task scopes were active')
      ? { code: 'multi-scope-skipped' as const }
      : {}),
  }
  const notice: TaskChangeNoticeV1 = {
    ...noticeBase,
    noticeId: buildNoticeId(noticeBase),
  }
  await enqueueTaskWrite(params.scope.taskId, async () => {
    await runTaskLedgerWrite({
      scope: params.scope,
      sessionId: params.sessionId,
      agentId: params.agentId,
      toolUseId: params.toolUseId,
      projectDir,
      write: async () => {
        await appendNotice(notice, projectDir)
      },
    })
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
  const memberName = resolveLedgerMemberName(params.agentId)
  const worktreeMetadata = getLedgerWorktreeMetadata(params.workspaceRoot)
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
    const lineStats = canUseSnippetLineStats(change)
      ? countLineChanges(
          change.oldString ?? change.beforeContent,
          change.newString ?? change.afterContent,
        )
      : { added: 0, removed: 0 }
    const eventBase: Omit<TaskChangeEventV1, 'eventId'> = {
      schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
      taskId: params.scope.taskId,
      taskRef: params.scope.task.ref,
      taskRefKind: params.scope.task.refKind,
      phase: params.scope.phase,
      executionSeq: params.scope.executionSeq,
      sessionId: params.sessionId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(memberName ? { memberName } : {}),
      toolUseId: params.toolUseId,
      source: change.source,
      operation,
      confidence: change.confidence,
      workspaceRoot: params.workspaceRoot,
      ...worktreeMetadata,
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
      ...(change.warnings?.length || worktreeMetadata.dirtyLeaderWarning
        ? {
            warnings: [
              ...(change.warnings ?? []),
              ...(worktreeMetadata.dirtyLeaderWarning
                ? [worktreeMetadata.dirtyLeaderWarning]
                : []),
            ],
          }
        : {}),
    }
    events.push({ ...eventBase, eventId: buildEventId(eventBase) })
  }

  if (events.length === 0) {
    return
  }

  await enqueueTaskWrite(params.scope.taskId, async () => {
    await runTaskLedgerWrite({
      scope: params.scope,
      sessionId: params.sessionId,
      agentId: params.agentId,
      toolUseId: params.toolUseId,
      projectDir,
      write: async () => {
        for (const event of events) {
          await appendEvent(event, projectDir)
        }
      },
    })
  })
}

function buildImportedEventId(sourceImportKey: string): string {
  return `opencode-import-${sha256(sourceImportKey).slice(0, 32)}`
}

async function readExistingSourceImportKeys(taskId: string, projectDir: string): Promise<Set<string>> {
  const existing = await readTaskEvents(taskId, projectDir)
  const keys = new Set<string>()
  for (const event of existing.entries) {
    if (event.sourceImportKey) {
      keys.add(event.sourceImportKey)
      continue
    }
    if (event.sourceRuntime && event.sourceSessionId && event.sourcePartId) {
      keys.add([
        event.sourceRuntime,
        event.sourceSessionId,
        event.sourcePartId,
        normalizeLedgerPathForKey(event.filePath),
      ].join('\0'))
    }
  }
  return keys
}

export async function importTaskChangeLedgerEvents(params: {
  projectDir?: string
  scope: ResolvedTaskScope
  sessionId: string
  agentId?: AgentId
  memberName?: string
  workspaceRoot: string
  toolStatus: TaskChangeToolStatus
  changes: ImportedOpenCodeFileChange[]
}): Promise<{
  importedFilePaths: string[]
  importedEventCount: number
  skippedDuplicateCount: number
  skippedUnsafeCount: number
  diagnostics: string[]
}> {
  const projectDir = params.projectDir && isAbsolute(params.projectDir)
    ? params.projectDir
    : getLedgerProjectDir()
  const diagnostics: string[] = []
  if (!isAbsolute(params.workspaceRoot)) {
    return {
      importedFilePaths: [],
      importedEventCount: 0,
      skippedDuplicateCount: 0,
      skippedUnsafeCount: params.changes.length,
      diagnostics: ['OpenCode ledger import skipped because workspaceRoot is not absolute.'],
    }
  }

  const existingSourceKeys = await readExistingSourceImportKeys(params.scope.taskId, projectDir)
  const importedFilePaths: string[] = []
  let skippedDuplicateCount = 0
  let skippedUnsafeCount = 0
  const events: TaskChangeEventV1[] = []
  const worktreeMetadata = getLedgerWorktreeMetadata(params.workspaceRoot)
  const importedAt = new Date().toISOString()

  for (const change of params.changes) {
    if (existingSourceKeys.has(change.sourceImportKey)) {
      skippedDuplicateCount += 1
      continue
    }
    const filePath = normalizeFilePath(change.filePath, params.workspaceRoot)
    if (!isSameOrDescendantPath(filePath, params.workspaceRoot)) {
      skippedUnsafeCount += 1
      diagnostics.push(`OpenCode ledger import skipped outside-workspace path ${filePath}.`)
      continue
    }
    if (change.beforeContent !== null && change.afterContent !== null) {
      if (sha256(change.beforeContent) === sha256(change.afterContent)) {
        skippedUnsafeCount += 1
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
    const lineStats = canUseSnippetLineStats(change)
      ? countLineChanges(
          change.oldString ?? change.beforeContent,
          change.newString ?? change.afterContent,
        )
      : { added: 0, removed: 0 }
    const eventBase: Omit<TaskChangeEventV1, 'eventId'> = {
      schemaVersion: TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
      taskId: params.scope.taskId,
      taskRef: params.scope.task.ref,
      taskRefKind: params.scope.task.refKind,
      phase: params.scope.phase,
      executionSeq: params.scope.executionSeq,
      sessionId: params.sessionId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.memberName ? { memberName: params.memberName } : {}),
      toolUseId: change.toolUseId,
      source: change.source,
      operation,
      confidence: change.confidence,
      workspaceRoot: params.workspaceRoot,
      ...worktreeMetadata,
      filePath,
      relativePath: displayRelativePath(filePath, params.workspaceRoot),
      timestamp: change.timestamp,
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
      ...(change.warnings?.length || worktreeMetadata.dirtyLeaderWarning
        ? {
            warnings: [
              ...(change.warnings ?? []),
              ...(worktreeMetadata.dirtyLeaderWarning
                ? [worktreeMetadata.dirtyLeaderWarning]
                : []),
            ],
          }
        : {}),
      sourceRuntime: 'opencode',
      sourceProvider: 'opencode',
      ...(change.sourceSessionId ? { sourceSessionId: change.sourceSessionId } : {}),
      ...(change.sourcePartId ? { sourcePartId: change.sourcePartId } : {}),
      ...(change.sourceMessageId ? { sourceMessageId: change.sourceMessageId } : {}),
      ...(change.parentUserMessageId ? { parentUserMessageId: change.parentUserMessageId } : {}),
      ...(change.attributionMethod ? { attributionMethod: change.attributionMethod } : {}),
      sourceImportKey: change.sourceImportKey,
      importedAt,
      ...(change.importBatchId ? { importBatchId: change.importBatchId } : {}),
      importSchemaVersion: 1,
    }
    events.push({
      ...eventBase,
      eventId: buildImportedEventId(change.sourceImportKey),
    })
    existingSourceKeys.add(change.sourceImportKey)
    importedFilePaths.push(filePath)
  }

  if (events.length > 0) {
    await enqueueTaskWrite(params.scope.taskId, async () => {
      await runTaskLedgerWrite({
        scope: params.scope,
        sessionId: params.sessionId,
        agentId: params.agentId,
        toolUseId: events[0]?.toolUseId ?? 'opencode-import',
        projectDir,
        write: async () => {
          for (const event of events) {
            await appendEvent(event, projectDir)
          }
        },
      })
    })
  }

  return {
    importedFilePaths,
    importedEventCount: events.length,
    skippedDuplicateCount,
    skippedUnsafeCount,
    diagnostics,
  }
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
        afterContent: null,
        afterState: contentStateFromShellSource(diskState),
        operation: operationForPostHookDiskState(change, diskState),
        confidence: change.confidence === 'exact' ? 'high' : change.confidence,
        oldString: undefined,
        newString: undefined,
        warnings: [
          ...(change.warnings ?? []),
          `PostToolUse hooks left final disk content unavailable for ${displayRelativePath(filePath, workspaceRoot)}: ${diskState.unavailableReason}.`,
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

function operationForPostHookDiskState(
  change: ExactFileChange,
  diskState: ShellSnapshotFile,
): TaskChangeOperation {
  if (diskState.exists === false) {
    return 'delete'
  }
  if (change.operation) {
    return change.operation
  }
  return change.beforeContent === null ? 'create' : 'modify'
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
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (code === 0 || code === 0xfffd || code < 9 || (code > 13 && code < 32)) {
      return true
    }
  }
  return false
}

function bufferLooksBinary(content: Buffer): boolean {
  for (const byte of content) {
    if (byte === 0 || byte < 9 || (byte > 13 && byte < 32)) {
      return true
    }
  }
  return !Buffer.from(content.toString('utf8'), 'utf8').equals(content)
}

function decodeTextBuffer(content: Buffer): string | null {
  return bufferLooksBinary(content) ? null : content.toString('utf8')
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
    const decoded = decodeTextBuffer(content)
    if (decoded === null) {
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
      content: decoded,
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
  const objectSpec = `${revision}:${relativePath.replace(/\\/g, '/')}`
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

  const result = await readGitBlobBuffer(
    gitRoot,
    objectId ? ['cat-file', '-p', objectId] : ['show', objectSpec],
  )
  if (result.code !== 0 || result.content === null) {
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
  const contentSha256 = sha256(result.content)
  const decoded = decodeTextBuffer(result.content)
  if (decoded === null) {
    return {
      content: null,
      exists: true,
      sha256: contentSha256,
      sizeBytes: Number.isFinite(size) ? size : undefined,
      unavailableReason: 'binary file',
      fingerprint: fingerprint ?? contentSha256,
    }
  }
  return {
    content: decoded,
    exists: true,
    sha256: contentSha256,
    sizeBytes: Number.isFinite(size) ? size : byteLength(decoded),
    fingerprint: fingerprint ?? contentSha256,
  }
}

async function readGitBlobBuffer(
  gitRoot: string,
  args: string[],
): Promise<{ content: Buffer | null; code: number }> {
  return new Promise(resolve => {
    const child = spawn('git', args, {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout>

    const settle = (content: Buffer | null, code: number) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ content, code })
    }

    timer = setTimeout(() => {
      child.kill('SIGTERM')
      settle(null, 1)
    }, GIT_TIMEOUT_MS)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      totalBytes += chunk.length
      if (totalBytes > MAX_TEXT_BLOB_BYTES) {
        child.kill('SIGTERM')
        settle(null, 1)
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => settle(null, 1))
    child.on('close', code => settle(Buffer.concat(chunks), code ?? 1))
  })
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
    const relativePath = relative(gitRoot, normalized).replace(/\\/g, '/')
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

export async function deferTaskChangeShellSnapshot(
  backgroundTaskId: string,
  snapshot: ShellSnapshot | null,
  options?: FinishShellSnapshotOptions,
): Promise<void> {
  if (!snapshot) {
    return
  }
  const pending: PendingDeferredShellSnapshot = {
    snapshot,
    ...(options ? { options } : {}),
  }
  pendingShellSnapshots.set(backgroundTaskId, pending)

  try {
    await cleanupExpiredDeferredShellSnapshots()
    const persisted = await persistDeferredShellSnapshot(
      backgroundTaskId,
      snapshot,
      options,
    )
    pending.projectRecordPath = persisted.projectRecordPath
    pending.globalPointerPath = persisted.globalPointerPath
  } catch (error) {
    logError(error)
    snapshot.warnings.push(DEFERRED_SHELL_SNAPSHOT_MEMORY_ONLY_WARNING)
  }
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
    for (const relativePath of [...allPaths]) {
      if (isTaskChangeLedgerInternalRelativePath(relativePath)) {
        allPaths.delete(relativePath)
      }
    }
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
  pendingShellSnapshots.delete(backgroundTaskId)

  const recovered = pending
    ? null
    : await readPersistedDeferredShellSnapshot(backgroundTaskId)
  const entry = pending ?? recovered
  if (!entry) {
    return
  }
  if (recovered) {
    recovered.snapshot.warnings.push(DEFERRED_SHELL_SNAPSHOT_RECOVERY_WARNING)
  }

  try {
    await finishTaskChangeShellSnapshot(entry.snapshot, toolStatus, entry.options)
  } finally {
    await removeDeferredShellSnapshotArtifacts({
      projectRecordPath: entry.projectRecordPath,
      globalPointerPath: entry.globalPointerPath,
    })
  }
}

export function clearDeferredTaskChangeShellSnapshotsForTests(): void {
  pendingShellSnapshots.clear()
  lastDeferredShellSnapshotCleanupAt = 0
}

export function buildTaskChangeLedgerDebugPath(taskId: string): string {
  return join(getLedgerDir(), 'bundles', `${encodeTaskId(taskId)}.json`)
}
