import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import { isBinaryContent } from '../../constants/files.js'
import { gitExe } from '../../utils/git.js'
import { killProcessTree } from '../../utils/processKill.js'
import { formatOpenCodeDiagnosticText } from './OpenCodeChangeEvidence.js'
import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'

type FileState = {
  exists: boolean
  sha256?: string
  sizeBytes?: number
  unavailableReason?: string
}

export type OpenCodeSnapshotGitStoreInput = {
  profileRootKey: string
  projectId: string
  worktree: string
  directory: string
  fromSnapshot: string
  toSnapshot: string
  touchedRelativePaths: string[]
  limits: {
    maxFiles: number
    maxBytesPerTextFile: number
    maxTotalBytes: number
    timeoutMs: number
  }
}

export type OpenCodeSnapshotGitStoreFile = {
  relativePath: string
  operation: 'create' | 'modify' | 'delete'
  beforeContent?: string
  afterContent?: string
  beforeState: FileState
  afterState: FileState
  additions: number
  deletions: number
  binary: boolean
  proofId: string
  warnings?: string[]
}

export type OpenCodeSnapshotGitStoreResult =
  | {
      supported: true
      files: OpenCodeSnapshotGitStoreFile[]
      diagnostics: string[]
    }
  | {
      supported: false
      code:
        | 'snapshot-invalid-input'
        | 'snapshot-profile-data-dir-unavailable'
        | 'snapshot-gitdir-missing'
        | 'snapshot-diff-read-failed'
      diagnostics: string[]
    }

export type RawSnapshotDiffEntry = {
  status: string
  oldMode: string
  newMode: string
  oldObjectId: string
  newObjectId: string
  relativePath: string
}

type NumstatEntry = {
  additions: number
  deletions: number
  binary: boolean
}

type GitRunResult = {
  code: number
  stdout: Buffer
  stderr: string
  diagnostics: string[]
}

type BlobMeta = {
  objectId: string
  type: string
  sizeBytes: number
}

type BlobContent =
  | {
      exists: true
      objectId: string
      sizeBytes: number
      sha256?: string
      content?: string
      unavailableReason?: string
      binary?: boolean
    }
  | {
      exists: false
      objectId: string
      unavailableReason: string
    }

const ABSENT_OBJECT_ID = '0000000000000000000000000000000000000000'
const RAW_HEADER_RE = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/
const RAW_HEADER_HEX_OBJECT_RE = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/
const FULL_OBJECT_ID_RE = /^[0-9a-f]{40}$/
const REGULAR_FILE_MODES = new Set(['100644', '100755'])
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function isInsideDirectory(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function decodeUtf8(bytes: Buffer, diagnostics: string[], label: string): string | null {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    diagnostics.push(`${label}: invalid UTF-8 bytes skipped.`)
    return null
  }
}

function splitNul(buffer: Buffer): Buffer[] {
  const records: Buffer[] = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      records.push(buffer.subarray(start, index))
      start = index + 1
    }
  }
  if (start < buffer.length) {
    records.push(buffer.subarray(start))
  } else if (buffer.length > 0 && buffer[buffer.length - 1] === 0) {
    records.push(Buffer.alloc(0))
  }
  return records
}

function hasWindowsReservedSegment(relativePath: string): boolean {
  return relativePath.split('/').some(segment => {
    const base = segment.split('.')[0]?.toUpperCase()
    return (
      base === 'CON' ||
      base === 'PRN' ||
      base === 'AUX' ||
      base === 'NUL' ||
      /^COM[1-9]$/.test(base ?? '') ||
      /^LPT[1-9]$/.test(base ?? '')
    )
  })
}

export function normalizeOpenCodeSnapshotRelativePath(value: string): string | null {
  if (!value || value.includes('\0')) {
    return null
  }
  const normalized = value.replace(/\\/g, '/')
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.endsWith('/') ||
    normalized.includes('//')
  ) {
    return null
  }
  const segments = normalized.split('/')
  if (
    segments.some(segment => segment === '' || segment === '.' || segment === '..') ||
    hasWindowsReservedSegment(normalized)
  ) {
    return null
  }
  return normalized
}

function buildTouchedPathSet(paths: string[], diagnostics: string[]): Set<string> | null {
  const result = new Set<string>()
  const canonicalByLower = new Map<string, string>()
  for (const candidate of paths) {
    const normalized = normalizeOpenCodeSnapshotRelativePath(candidate)
    if (!normalized) {
      diagnostics.push(`snapshot-invalid-touched-path: ${formatOpenCodeDiagnosticText(candidate)} is not a safe relative path.`)
      continue
    }
    const lower = normalized.toLowerCase()
    const existing = canonicalByLower.get(lower)
    if (existing && existing !== normalized) {
      diagnostics.push(`snapshot-case-collision: touched paths ${formatOpenCodeDiagnosticText(existing)} and ${formatOpenCodeDiagnosticText(normalized)} collide on case-insensitive filesystems.`)
      return null
    }
    canonicalByLower.set(lower, normalized)
    result.add(normalized)
  }
  return result
}

function resolveOperation(entry: RawSnapshotDiffEntry): 'create' | 'modify' | 'delete' {
  if (entry.status.startsWith('A')) {
    return 'create'
  }
  if (entry.status.startsWith('D')) {
    return 'delete'
  }
  return 'modify'
}

function modeUnavailableReason(mode: string): string | null {
  if (mode === '000000' || REGULAR_FILE_MODES.has(mode)) {
    return null
  }
  if (mode === '120000') {
    return 'snapshot-symlink-mode'
  }
  if (mode === '160000') {
    return 'snapshot-gitlink-mode'
  }
  return 'snapshot-unsupported-file-mode'
}

function absentState(): FileState {
  return { exists: false, sizeBytes: 0 }
}

function stateFromBlob(blob: BlobContent | null, mode: string): FileState {
  if (mode === '000000') {
    return absentState()
  }
  const modeReason = modeUnavailableReason(mode)
  if (modeReason) {
    return { exists: true, unavailableReason: modeReason }
  }
  if (!blob || !blob.exists) {
    return {
      exists: true,
      unavailableReason: blob?.unavailableReason ?? 'snapshot-blob-unavailable',
    }
  }
  return {
    exists: true,
    sha256: blob.sha256,
    sizeBytes: blob.sizeBytes,
    ...(blob.unavailableReason ? { unavailableReason: blob.unavailableReason } : {}),
  }
}

function textFromBlob(blob: BlobContent | null, mode: string): string | undefined {
  if (modeUnavailableReason(mode)) {
    return undefined
  }
  return blob?.exists && typeof blob.content === 'string' ? blob.content : undefined
}

export function parseOpenCodeSnapshotRawDiffZ(buffer: Buffer, diagnostics: string[] = []): RawSnapshotDiffEntry[] {
  const records = splitNul(buffer)
  if (records.length > 0 && records[records.length - 1]?.length === 0) {
    records.pop()
  } else if (buffer.length > 0) {
    diagnostics.push('snapshot-raw-diff-partial-record: raw diff output ended without a trailing NUL.')
  }

  const entries: RawSnapshotDiffEntry[] = []
  for (let index = 0; index < records.length;) {
    const headerBytes = records[index++]
    const pathBytes = records[index++]
    if (!headerBytes || !pathBytes) {
      diagnostics.push('snapshot-raw-diff-malformed: raw diff record was incomplete.')
      break
    }
    const header = decodeUtf8(headerBytes, diagnostics, 'snapshot-raw-diff-header')
    const decodedPath = decodeUtf8(pathBytes, diagnostics, 'snapshot-raw-diff-path')
    if (!header || decodedPath === null) {
      continue
    }
    const match = RAW_HEADER_RE.exec(header)
    if (!match) {
      const hexObjectMatch = RAW_HEADER_HEX_OBJECT_RE.exec(header)
      if (
        hexObjectMatch &&
        ((hexObjectMatch[3]?.length ?? 0) > 40 || (hexObjectMatch[4]?.length ?? 0) > 40)
      ) {
        diagnostics.push('snapshot-object-id-algorithm-unsupported: raw diff object ids are not 40-character SHA-1 ids.')
        continue
      }
      diagnostics.push(`snapshot-raw-diff-malformed: unsupported raw diff header ${header}.`)
      continue
    }
    const normalizedPath = normalizeOpenCodeSnapshotRelativePath(decodedPath)
    if (!normalizedPath) {
      diagnostics.push(`snapshot-raw-diff-unsafe-path: ${formatOpenCodeDiagnosticText(decodedPath)} is not a safe relative path.`)
      continue
    }
    const status = match[5]
    if (status.startsWith('R') || status.startsWith('C')) {
      diagnostics.push(`snapshot-raw-diff-unsupported-relation: ${status} for ${formatOpenCodeDiagnosticText(normalizedPath)} is not supported.`)
      continue
    }
    entries.push({
      oldMode: match[1],
      newMode: match[2],
      oldObjectId: match[3],
      newObjectId: match[4],
      status,
      relativePath: normalizedPath,
    })
  }
  return entries
}

export function parseOpenCodeSnapshotNumstatZ(buffer: Buffer, diagnostics: string[] = []): Map<string, NumstatEntry> {
  const records = splitNul(buffer)
  if (records.length > 0 && records[records.length - 1]?.length === 0) {
    records.pop()
  } else if (buffer.length > 0) {
    diagnostics.push('snapshot-numstat-partial-record: numstat output ended without a trailing NUL.')
  }

  const result = new Map<string, NumstatEntry>()
  for (const record of records) {
    const decoded = decodeUtf8(record, diagnostics, 'snapshot-numstat-record')
    if (decoded === null) {
      continue
    }
    const firstTab = decoded.indexOf('\t')
    const secondTab = firstTab >= 0 ? decoded.indexOf('\t', firstTab + 1) : -1
    if (firstTab < 0 || secondTab < 0) {
      diagnostics.push(`snapshot-numstat-malformed: unsupported numstat record ${decoded}.`)
      continue
    }
    const additionsRaw = decoded.slice(0, firstTab)
    const deletionsRaw = decoded.slice(firstTab + 1, secondTab)
    const relativePathRaw = decoded.slice(secondTab + 1)
    const relativePath = normalizeOpenCodeSnapshotRelativePath(relativePathRaw)
    if (!relativePath) {
      diagnostics.push(`snapshot-numstat-unsafe-path: ${formatOpenCodeDiagnosticText(relativePathRaw)} is not a safe relative path.`)
      continue
    }
    const binary = additionsRaw === '-' || deletionsRaw === '-'
    result.set(relativePath, {
      additions: binary ? 0 : Number(additionsRaw) || 0,
      deletions: binary ? 0 : Number(deletionsRaw) || 0,
      binary,
    })
  }
  return result
}

export function validateOpenCodeSnapshotGitStoreArgs(args: string[]): string | null {
  let index = 0
  while (index < args.length) {
    const arg = args[index]
    if (arg === '-c') {
      index += 2
      continue
    }
    if (arg === '--git-dir' || arg === '--work-tree') {
      index += 2
      continue
    }
    if (!arg || arg.startsWith('-')) {
      return `snapshot-git-command-unsupported: unsupported git global option ${arg ?? '<empty>'}.`
    }
    if (arg === 'diff') {
      return args.includes('--no-ext-diff')
        ? null
        : 'snapshot-git-command-unsupported: snapshot git diff must include --no-ext-diff.'
    }
    if (arg === 'cat-file') {
      return args.includes('--batch') || args.includes('--batch-check')
        ? null
        : 'snapshot-git-command-unsupported: snapshot git cat-file must use batch mode.'
    }
    return `snapshot-git-command-unsupported: git ${arg} is not allowed for read-only OpenCode snapshot evidence.`
  }
  return 'snapshot-git-command-unsupported: git command was missing.'
}

async function runGit(args: string[], input: {
  cwd: string
  stdin?: string
  timeoutMs: number
  maxBytes: number
}): Promise<GitRunResult> {
  const gitArgs = shortenGitPathArgs(args, input.cwd)
  const allowlistError = validateOpenCodeSnapshotGitStoreArgs(gitArgs)
  if (allowlistError) {
    return {
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: '',
      diagnostics: [allowlistError],
    }
  }
  return new Promise(resolve => {
    const child = spawn(gitExe(), gitArgs, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const diagnostics: string[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let stopping = false
    let timer: ReturnType<typeof setTimeout>
    let stopFallbackTimer: ReturnType<typeof setTimeout> | null = null

    const settle = (code: number) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (stopFallbackTimer) {
        clearTimeout(stopFallbackTimer)
        stopFallbackTimer = null
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        diagnostics,
      })
    }

    const stopAndSettle = (code: number) => {
      if (settled || stopping) {
        return
      }
      stopping = true
      clearTimeout(timer)
      killProcessTree(child.pid, 'SIGTERM')
      stopFallbackTimer = setTimeout(() => settle(code), 2_500)
    }

    timer = setTimeout(() => {
      diagnostics.push(`snapshot-git-timeout: git ${gitArgs.join(' ')} timed out after ${input.timeoutMs}ms.`)
      stopAndSettle(1)
    }, input.timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      const remaining = input.maxBytes - stdoutBytes
      if (remaining <= 0) {
        diagnostics.push(`snapshot-git-output-cap: git ${gitArgs.join(' ')} exceeded ${input.maxBytes} stdout bytes.`)
        stopAndSettle(1)
        return
      }
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining))
        stdoutBytes += remaining
        diagnostics.push(`snapshot-git-output-cap: git ${gitArgs.join(' ')} exceeded ${input.maxBytes} stdout bytes.`)
        stopAndSettle(1)
        return
      }
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.length
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 8192) {
        return
      }
      const remaining = 8192 - stderrBytes
      stderrChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      stderrBytes += Math.min(chunk.length, remaining)
    })

    child.on('error', error => {
      if (stopping) {
        return
      }
      diagnostics.push(`snapshot-git-spawn-failed: ${error instanceof Error ? error.message : String(error)}`)
      settle(1)
    })
    child.on('close', code => {
      if (stopping) {
        settle(1)
        return
      }
      settle(code ?? 1)
    })

    if (typeof input.stdin === 'string') {
      child.stdin.end(input.stdin)
    } else {
      child.stdin.end()
    }
  })
}

function gitStoreArgs(gitDir: string, worktree: string, args: string[]): string[] {
  return [
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.longpaths=true',
    '-c',
    'core.symlinks=true',
    '-c',
    'core.quotepath=false',
    '--git-dir',
    gitDir,
    '--work-tree',
    worktree,
    ...args,
  ]
}

function shortenGitPathArgs(args: string[], cwd: string): string[] {
  const result = [...args]
  for (let index = 0; index < result.length - 1; index += 1) {
    if (result[index] !== '--git-dir' && result[index] !== '--work-tree') {
      continue
    }
    const value = result[index + 1]
    if (!value || !path.isAbsolute(value)) {
      continue
    }
    const relative = path.relative(cwd, value)
    if (relative && relative.length < value.length) {
      result[index + 1] = relative.replace(/\\/g, '/')
    }
  }
  return result
}

function isRealObjectId(value: string): boolean {
  return FULL_OBJECT_ID_RE.test(value) && value !== ABSENT_OBJECT_ID
}

function uniqueObjectIds(entries: RawSnapshotDiffEntry[], touchedPaths: Set<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of entries) {
    if (!touchedPaths.has(entry.relativePath)) {
      continue
    }
    for (const objectId of [entry.oldObjectId, entry.newObjectId]) {
      if (isRealObjectId(objectId) && !seen.has(objectId)) {
        seen.add(objectId)
        result.push(objectId)
      }
    }
  }
  return result
}

function parseBatchCheck(stdout: Buffer, requested: string[], diagnostics: string[]): Map<string, BlobMeta> {
  const result = new Map<string, BlobMeta>()
  const lines = stdout.toString('utf8').split('\n').filter(Boolean)
  const requestedSet = new Set(requested)
  for (const line of lines) {
    const match = /^([0-9a-f]{40}) ([^\s]+) ([0-9]+)$/.exec(line)
    if (!match) {
      diagnostics.push(`snapshot-cat-file-batch-check-malformed: ${line}`)
      continue
    }
    if (!requestedSet.has(match[1])) {
      diagnostics.push(`snapshot-cat-file-unrequested-object: ${match[1]}`)
      continue
    }
    result.set(match[1], {
      objectId: match[1],
      type: match[2],
      sizeBytes: Number(match[3]),
    })
  }
  return result
}

function parseBatch(stdout: Buffer, requested: string[], diagnostics: string[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>()
  const requestedSet = new Set(requested)
  let offset = 0
  while (offset < stdout.length) {
    const newline = stdout.indexOf(10, offset)
    if (newline < 0) {
      diagnostics.push('snapshot-cat-file-batch-malformed: missing object header newline.')
      break
    }
    const header = stdout.subarray(offset, newline).toString('utf8')
    offset = newline + 1
    const match = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(header)
    if (!match) {
      diagnostics.push(`snapshot-cat-file-batch-malformed: ${header}`)
      break
    }
    const objectId = match[1]
    const sizeBytes = Number(match[2])
    const end = offset + sizeBytes
    if (end > stdout.length) {
      diagnostics.push(`snapshot-cat-file-batch-malformed: object ${objectId} truncated.`)
      break
    }
    const content = stdout.subarray(offset, end)
    offset = end
    if (stdout[offset] === 10) {
      offset += 1
    }
    if (!requestedSet.has(objectId)) {
      diagnostics.push(`snapshot-cat-file-unrequested-object: ${objectId}`)
      continue
    }
    result.set(objectId, Buffer.from(content))
  }
  return result
}

function blobContentFromBuffer(objectId: string, sizeBytes: number, buffer: Buffer): BlobContent {
  const contentSha256 = sha256(buffer)
  if (isBinaryContent(buffer)) {
    return {
      exists: true,
      objectId,
      sizeBytes,
      sha256: contentSha256,
      unavailableReason: 'snapshot-content-binary',
      binary: true,
    }
  }
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    return {
      exists: true,
      objectId,
      sizeBytes,
      sha256: contentSha256,
      unavailableReason: 'snapshot-content-non-utf8',
    }
  }
  return {
    exists: true,
    objectId,
    sizeBytes,
    sha256: contentSha256,
    content: text,
  }
}

class SnapshotGitStoreInputError extends Error {}

export class OpenCodeSnapshotGitStoreReader {
  constructor(
    private readonly options: {
      offlineSessionReader?: Pick<OpenCodeOfflineSessionReader, 'resolveDbPath'>
    } = {},
  ) {}

  resolveProfileDataDir(profileRootKey: string): string | null {
    const dbPath = (this.options.offlineSessionReader ?? new OpenCodeOfflineSessionReader()).resolveDbPath(profileRootKey)
    return dbPath ? path.dirname(dbPath) : null
  }

  resolveSnapshotGitDir(input: Pick<OpenCodeSnapshotGitStoreInput, 'profileRootKey' | 'projectId' | 'worktree'>): string | null {
    if (!input.projectId || input.projectId.includes('\0') || input.projectId.split(/[\\/]/).some(segment => segment === '..' || segment === '')) {
      return null
    }
    const profileDataDir = this.resolveProfileDataDir(input.profileRootKey)
    if (!profileDataDir) {
      return null
    }
    const snapshotRoot = path.join(profileDataDir, 'snapshot')
    const gitDir = path.resolve(snapshotRoot, input.projectId, sha1(input.worktree))
    return isInsideDirectory(gitDir, snapshotRoot) ? gitDir : null
  }

  async read(input: OpenCodeSnapshotGitStoreInput): Promise<OpenCodeSnapshotGitStoreResult> {
    const diagnostics: string[] = []
    try {
      this.validateInput(input)
    } catch (error) {
      return {
        supported: false,
        code: 'snapshot-invalid-input',
        diagnostics: [error instanceof Error ? error.message : String(error)],
      }
    }

    const touchedPaths = buildTouchedPathSet(input.touchedRelativePaths, diagnostics)
    if (!touchedPaths) {
      return {
        supported: false,
        code: 'snapshot-invalid-input',
        diagnostics,
      }
    }
    if (touchedPaths.size === 0) {
      return { supported: true, files: [], diagnostics }
    }

    const gitDir = this.resolveSnapshotGitDir(input)
    if (!gitDir) {
      return {
        supported: false,
        code: 'snapshot-profile-data-dir-unavailable',
        diagnostics: ['snapshot-profile-data-dir-unavailable: OpenCode profile data dir could not be resolved safely.'],
      }
    }
    try {
      const gitDirStat = await stat(gitDir)
      if (!gitDirStat.isDirectory()) {
        return {
          supported: false,
          code: 'snapshot-gitdir-missing',
          diagnostics: [`snapshot-gitdir-missing: ${gitDir} is not a directory.`],
        }
      }
    } catch {
      return {
        supported: false,
        code: 'snapshot-gitdir-missing',
        diagnostics: [`snapshot-gitdir-missing: ${gitDir} does not exist.`],
      }
    }

    const rawResult = await runGit(
      gitStoreArgs(gitDir, input.worktree, [
        'diff',
        '--no-ext-diff',
        '--raw',
        '-z',
        '--abbrev=40',
        '--no-renames',
        input.fromSnapshot,
        input.toSnapshot,
        '--',
        '.',
      ]),
      {
        cwd: input.directory,
        timeoutMs: input.limits.timeoutMs,
        maxBytes: input.limits.maxTotalBytes,
      },
    )
    diagnostics.push(...rawResult.diagnostics)
    if (rawResult.code !== 0) {
      return {
        supported: false,
        code: 'snapshot-diff-read-failed',
        diagnostics: [
          ...diagnostics,
          `snapshot-diff-read-failed: git raw diff exited ${rawResult.code}${rawResult.stderr ? ` - ${rawResult.stderr}` : ''}`,
        ],
      }
    }

    const rawEntries = parseOpenCodeSnapshotRawDiffZ(rawResult.stdout, diagnostics)
    const rawMatchedPaths = new Set(
      rawEntries.filter(entry => touchedPaths.has(entry.relativePath)).map(entry => entry.relativePath),
    )
    const matchingEntries = rawEntries.filter(entry => touchedPaths.has(entry.relativePath))
    if (matchingEntries.length > input.limits.maxFiles) {
      diagnostics.push(`snapshot-file-cap: captured first ${input.limits.maxFiles} snapshot files; remaining files skipped.`)
      matchingEntries.length = input.limits.maxFiles
    }
    for (const entry of rawEntries) {
      if (!touchedPaths.has(entry.relativePath)) {
        diagnostics.push(`snapshot-path-not-touched: ${formatOpenCodeDiagnosticText(entry.relativePath)} was present in snapshot diff but not in toolpart touched paths.`)
      }
    }
    for (const touchedPath of touchedPaths) {
      if (!rawMatchedPaths.has(touchedPath)) {
        diagnostics.push(`snapshot-touched-path-not-in-diff: ${formatOpenCodeDiagnosticText(touchedPath)} was requested but absent from the scoped snapshot diff.`)
      }
    }

    const numstat = await this.readNumstat(input, gitDir, diagnostics)
    const blobs = await this.readBlobs(input, gitDir, matchingEntries, touchedPaths, diagnostics)

    return {
      supported: true,
      files: matchingEntries.map(entry => this.buildFile(entry, numstat.get(entry.relativePath), blobs)),
      diagnostics,
    }
  }

  private validateInput(input: OpenCodeSnapshotGitStoreInput): void {
    if (!FULL_OBJECT_ID_RE.test(input.fromSnapshot) || !FULL_OBJECT_ID_RE.test(input.toSnapshot)) {
      throw new SnapshotGitStoreInputError('snapshot-invalid-input: snapshot ids must be full 40-character hex object ids.')
    }
    if (!path.isAbsolute(input.worktree) || !path.isAbsolute(input.directory)) {
      throw new SnapshotGitStoreInputError('snapshot-invalid-input: worktree and directory must be absolute paths.')
    }
    if (!isInsideDirectory(path.resolve(input.directory), path.resolve(input.worktree))) {
      throw new SnapshotGitStoreInputError('snapshot-invalid-input: directory must be the worktree or a descendant of it.')
    }
    if (
      input.limits.maxFiles <= 0 ||
      input.limits.maxBytesPerTextFile <= 0 ||
      input.limits.maxTotalBytes <= 0 ||
      input.limits.timeoutMs <= 0
    ) {
      throw new SnapshotGitStoreInputError('snapshot-invalid-input: snapshot git-store limits must be positive.')
    }
  }

  private async readNumstat(
    input: OpenCodeSnapshotGitStoreInput,
    gitDir: string,
    diagnostics: string[],
  ): Promise<Map<string, NumstatEntry>> {
    const result = await runGit(
      gitStoreArgs(gitDir, input.worktree, [
        'diff',
        '--no-ext-diff',
        '--numstat',
        '-z',
        '--no-renames',
        input.fromSnapshot,
        input.toSnapshot,
        '--',
        '.',
      ]),
      {
        cwd: input.directory,
        timeoutMs: input.limits.timeoutMs,
        maxBytes: input.limits.maxTotalBytes,
      },
    )
    diagnostics.push(...result.diagnostics)
    if (result.code !== 0) {
      diagnostics.push(`snapshot-numstat-read-failed: git numstat exited ${result.code}${result.stderr ? ` - ${result.stderr}` : ''}`)
      return new Map()
    }
    return parseOpenCodeSnapshotNumstatZ(result.stdout, diagnostics)
  }

  private async readBlobs(
    input: OpenCodeSnapshotGitStoreInput,
    gitDir: string,
    entries: RawSnapshotDiffEntry[],
    touchedPaths: Set<string>,
    diagnostics: string[],
  ): Promise<Map<string, BlobContent>> {
    const objectIds = uniqueObjectIds(entries, touchedPaths)
    if (objectIds.length === 0) {
      return new Map()
    }
    const batchCheck = await runGit(
      gitStoreArgs(gitDir, input.worktree, ['cat-file', '--batch-check']),
      {
        cwd: input.directory,
        stdin: `${objectIds.join('\n')}\n`,
        timeoutMs: input.limits.timeoutMs,
        maxBytes: Math.min(input.limits.maxTotalBytes, Math.max(8192, objectIds.length * 96)),
      },
    )
    diagnostics.push(...batchCheck.diagnostics)
    if (batchCheck.code !== 0) {
      diagnostics.push(`snapshot-cat-file-batch-check-failed: git cat-file exited ${batchCheck.code}${batchCheck.stderr ? ` - ${batchCheck.stderr}` : ''}`)
      return new Map(objectIds.map(objectId => [objectId, {
        exists: false,
        objectId,
        unavailableReason: 'snapshot-cat-file-unavailable',
      } satisfies BlobContent]))
    }
    const metadata = parseBatchCheck(batchCheck.stdout, objectIds, diagnostics)
    const blobs = new Map<string, BlobContent>()
    const fetchable: string[] = []
    let totalBytes = 0
    for (const objectId of objectIds) {
      const meta = metadata.get(objectId)
      if (!meta) {
        blobs.set(objectId, {
          exists: false,
          objectId,
          unavailableReason: 'snapshot-cat-file-missing-object',
        })
        continue
      }
      if (meta.type !== 'blob') {
        blobs.set(objectId, {
          exists: true,
          objectId,
          sizeBytes: meta.sizeBytes,
          unavailableReason: 'snapshot-cat-file-non-blob',
        })
        continue
      }
      if (meta.sizeBytes > input.limits.maxBytesPerTextFile) {
        blobs.set(objectId, {
          exists: true,
          objectId,
          sizeBytes: meta.sizeBytes,
          unavailableReason: 'snapshot-content-too-large',
        })
        continue
      }
      if (totalBytes + meta.sizeBytes > input.limits.maxTotalBytes) {
        blobs.set(objectId, {
          exists: true,
          objectId,
          sizeBytes: meta.sizeBytes,
          unavailableReason: 'snapshot-total-byte-cap-exceeded',
        })
        continue
      }
      totalBytes += meta.sizeBytes
      fetchable.push(objectId)
    }

    if (fetchable.length === 0) {
      return blobs
    }
    const batch = await runGit(
      gitStoreArgs(gitDir, input.worktree, ['cat-file', '--batch']),
      {
        cwd: input.directory,
        stdin: `${fetchable.join('\n')}\n`,
        timeoutMs: input.limits.timeoutMs,
        maxBytes: Math.min(input.limits.maxTotalBytes, totalBytes + fetchable.length * 96 + 1024),
      },
    )
    diagnostics.push(...batch.diagnostics)
    if (batch.code !== 0) {
      diagnostics.push(`snapshot-cat-file-batch-failed: git cat-file exited ${batch.code}${batch.stderr ? ` - ${batch.stderr}` : ''}`)
      for (const objectId of fetchable) {
        blobs.set(objectId, {
          exists: false,
          objectId,
          unavailableReason: 'snapshot-cat-file-unavailable',
        })
      }
      return blobs
    }
    const buffers = parseBatch(batch.stdout, fetchable, diagnostics)
    for (const objectId of fetchable) {
      const meta = metadata.get(objectId)
      const buffer = buffers.get(objectId)
      if (!meta || !buffer) {
        blobs.set(objectId, {
          exists: false,
          objectId,
          unavailableReason: 'snapshot-cat-file-missing-content',
        })
        continue
      }
      blobs.set(objectId, blobContentFromBuffer(objectId, meta.sizeBytes, buffer))
    }
    return blobs
  }

  private buildFile(
    entry: RawSnapshotDiffEntry,
    numstat: NumstatEntry | undefined,
    blobs: Map<string, BlobContent>,
  ): OpenCodeSnapshotGitStoreFile {
    const beforeBlob = isRealObjectId(entry.oldObjectId) ? blobs.get(entry.oldObjectId) ?? null : null
    const afterBlob = isRealObjectId(entry.newObjectId) ? blobs.get(entry.newObjectId) ?? null : null
    const warnings: string[] = []
    if (entry.status.startsWith('T')) {
      warnings.push('snapshot-typechange-metadata-only')
    }
    if (entry.oldObjectId === entry.newObjectId && entry.oldMode !== entry.newMode) {
      warnings.push('snapshot-mode-only-change')
    }
    for (const mode of [entry.oldMode, entry.newMode]) {
      const reason = modeUnavailableReason(mode)
      if (reason) {
        warnings.push(reason)
      }
    }
    const beforeState = stateFromBlob(beforeBlob, entry.oldMode)
    const afterState = stateFromBlob(afterBlob, entry.newMode)
    const isMetadataOnly = warnings.length > 0 || !!beforeState.unavailableReason || !!afterState.unavailableReason
    return {
      relativePath: entry.relativePath,
      operation: resolveOperation(entry),
      ...(isMetadataOnly ? {} : { beforeContent: textFromBlob(beforeBlob, entry.oldMode) }),
      ...(isMetadataOnly ? {} : { afterContent: textFromBlob(afterBlob, entry.newMode) }),
      beforeState,
      afterState,
      additions: numstat?.additions ?? 0,
      deletions: numstat?.deletions ?? 0,
      binary: !!numstat?.binary || beforeBlob?.binary === true || afterBlob?.binary === true,
      proofId: `opencode-snapshot:${entry.oldObjectId}:${entry.newObjectId}:${entry.relativePath}`,
      ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    }
  }
}
