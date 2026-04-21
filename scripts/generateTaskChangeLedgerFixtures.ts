import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, extname, join } from 'path'

import { setCwdState, setOriginalCwd, switchSession } from '../src/bootstrap/state.js'
import { BASH_TOOL_NAME } from '../src/tools/BashTool/toolName.js'
import { FILE_WRITE_TOOL_NAME } from '../src/tools/FileWriteTool/prompt.js'
import {
  captureTaskChangeToolResult,
  finishTaskChangeShellSnapshot,
  maybeBeginTaskChangeShellSnapshot,
} from '../src/services/taskChangeLedger/TaskChangeLedgerService.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../src/utils/teammate.js'
import {
  getRuntimeBoardTaskExecutionStore,
} from '../src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.js'
import type { BoardTaskLocator, BoardTaskPhase } from '../src/services/boardTaskActivity/contract.js'

const PROJECT_ROOT_TOKEN = '__PROJECT_ROOT__'
const DEFAULT_OUTPUT_DIR = join(
  process.cwd(),
  '..',
  'claude_team_task_change_ledger',
  'test',
  'fixtures',
  'team',
  'task-change-ledger',
)

let repoDir = ''
let sessionId = 'fixture-session'

type FixtureManifest = {
  schemaVersion: 1
  name: string
  taskId: string
  description: string
  projectRootToken: string
  expected: {
    totalFiles: number
    warnings: string[]
    relativePaths: string[]
    relationKinds: Array<'rename' | 'copy'>
  }
}

type FixtureScenarioResult = {
  taskId: string
  description: string
  extraRelativePaths?: string[]
  mutateOutput?: (projectDir: string, taskId: string) => Promise<void>
}

function runGit(args: string[], cwd = repoDir): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result.stdout.trim()
}

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'task-change-ledger-fixture-'))
  runGit(['init'], dir)
  runGit(['config', 'user.email', 'tests@example.com'], dir)
  runGit(['config', 'user.name', 'Task Change Ledger Fixtures'], dir)
  return runGit(['rev-parse', '--show-toplevel'], dir)
}

async function commitAll(message: string): Promise<void> {
  runGit(['add', '.'])
  runGit(['commit', '-m', message])
}

async function writeRepoFile(relativePath: string, content: string | Buffer): Promise<string> {
  const filePath = join(repoDir, relativePath)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
  return filePath
}

function setRepoContext(dir: string): void {
  repoDir = dir
  sessionId = `fixture-${Math.random().toString(36).slice(2)}`
  setOriginalCwd(dir)
  setCwdState(dir)
  switchSession(sessionId as never, dir)
  setDynamicTeamContext({
    agentId: 'alice@test',
    agentName: 'alice',
    teamName: 'ledger-fixture-team',
    planModeRequired: false,
  })
}

function openScope(taskId: string, phase: BoardTaskPhase = 'work', agentId = 'alice@test'): void {
  const locator: BoardTaskLocator = {
    ref: taskId,
    refKind: 'canonical',
    canonicalId: taskId,
  }
  getRuntimeBoardTaskExecutionStore().applyTransitions(sessionId, agentId, [
    { type: 'open', phase, task: locator },
  ])
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, 'utf8')
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

async function readJsonlIfExists<T>(filePath: string): Promise<T[]> {
  try {
    return await readJsonl<T>(filePath)
  } catch {
    return []
  }
}

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
  return isWindowsReservedArtifactSegment(encoded)
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded
}

function bundlePath(taskId: string, baseDir = repoDir): string {
  return join(baseDir, '.board-task-changes', 'bundles', `${encodeTaskId(taskId)}.json`)
}

function eventsPath(taskId: string, baseDir = repoDir): string {
  return join(baseDir, '.board-task-changes', 'events', `${encodeTaskId(taskId)}.jsonl`)
}

function noticesPath(taskId: string, baseDir = repoDir): string {
  return join(baseDir, '.board-task-changes', 'notices', `${encodeTaskId(taskId)}.jsonl`)
}

function freshnessPath(taskId: string, baseDir = repoDir): string {
  return join(baseDir, '.board-task-change-freshness', `${encodeTaskId(taskId)}.json`)
}

async function collectWorkspacePaths(taskId: string, extraRelativePaths: string[] = []): Promise<Set<string>> {
  const bundle = await readJson<{
    files?: Array<{
      relativePath?: string
      relation?: { oldPath: string; newPath: string }
    }>
  }>(bundlePath(taskId))
  const events = await readJsonlIfExists<
    Array<{
      relativePath?: string
      relation?: { oldPath: string; newPath: string }
    }>[number]
  >(eventsPath(taskId))

  const relativePaths = new Set<string>(extraRelativePaths)
  for (const file of bundle.files ?? []) {
    file.relativePath && relativePaths.add(file.relativePath)
    file.relation?.oldPath && relativePaths.add(file.relation.oldPath)
    file.relation?.newPath && relativePaths.add(file.relation.newPath)
  }
  for (const event of events) {
    event.relativePath && relativePaths.add(event.relativePath)
    event.relation?.oldPath && relativePaths.add(event.relation.oldPath)
    event.relation?.newPath && relativePaths.add(event.relation.newPath)
  }
  return relativePaths
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  try {
    const sourceStat = await stat(sourcePath)
    if (!sourceStat.isFile()) {
      return
    }
  } catch {
    return
  }
  await mkdir(dirname(targetPath), { recursive: true })
  await cp(sourcePath, targetPath)
}

async function rewriteProjectRootTokens(rootDir: string): Promise<void> {
  const escapedRepoDir = JSON.stringify(repoDir).slice(1, -1)
  const entries = await readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      await rewriteProjectRootTokens(entryPath)
      continue
    }
    if (!['.json', '.jsonl'].includes(extname(entry.name))) {
      continue
    }
    const raw = await readFile(entryPath, 'utf8')
    await writeFile(
      entryPath,
      raw.split(repoDir).join(PROJECT_ROOT_TOKEN).split(escapedRepoDir).join(PROJECT_ROOT_TOKEN),
      'utf8',
    )
  }
}

async function materializeFixtureProject(params: {
  outputDir: string
  taskId: string
  extraRelativePaths?: string[]
}): Promise<string> {
  const projectOutDir = join(params.outputDir, 'project')
  await mkdir(projectOutDir, { recursive: true })
  await cp(join(repoDir, '.board-task-changes'), join(projectOutDir, '.board-task-changes'), {
    recursive: true,
  })
  try {
    await cp(
      join(repoDir, '.board-task-change-freshness'),
      join(projectOutDir, '.board-task-change-freshness'),
      { recursive: true },
    )
  } catch {}

  const workspacePaths = await collectWorkspacePaths(params.taskId, params.extraRelativePaths)
  for (const relativePath of workspacePaths) {
    await copyIfExists(join(repoDir, relativePath), join(projectOutDir, relativePath))
  }
  await rewriteProjectRootTokens(projectOutDir)
  return projectOutDir
}

async function writeManifest(outputDir: string, params: FixtureScenarioResult, name: string): Promise<void> {
  const bundle = await readJson<{
    totalFiles: number
    warnings: string[]
    files: Array<{
      relativePath: string
      relation?: { kind: 'rename' | 'copy' }
    }>
  }>(bundlePath(params.taskId, join(outputDir, 'project')))

  const manifest: FixtureManifest = {
    schemaVersion: 1,
    name,
    taskId: params.taskId,
    description: params.description,
    projectRootToken: PROJECT_ROOT_TOKEN,
    expected: {
      totalFiles: bundle.totalFiles,
      warnings: bundle.warnings,
      relativePaths: bundle.files.map(file => file.relativePath),
      relationKinds: bundle.files
        .map(file => file.relation?.kind)
        .filter((kind): kind is 'rename' | 'copy' => kind === 'rename' || kind === 'copy'),
    },
  }
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function buildFixture(
  outputRootDir: string,
  name: string,
  runScenario: () => Promise<FixtureScenarioResult>,
): Promise<void> {
  const fixtureOutputDir = join(outputRootDir, name)
  repoDir = await createGitRepo()
  setRepoContext(repoDir)
  try {
    const result = await runScenario()
    const projectDir = await materializeFixtureProject({
      outputDir: fixtureOutputDir,
      taskId: result.taskId,
      extraRelativePaths: result.extraRelativePaths,
    })
    if (result.mutateOutput) {
      await result.mutateOutput(projectDir, result.taskId)
    }
    await writeManifest(fixtureOutputDir, result, name)
  } finally {
    clearDynamicTeamContext()
    getRuntimeBoardTaskExecutionStore().clearForTests()
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true })
    }
  }
}

async function buildV2SummaryFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-v2-summary'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  await captureTaskChangeToolResult({
    toolName: FILE_WRITE_TOOL_NAME,
    resultData: {
      filePath: 'src/summary.ts',
      content: 'export const summary = 1;\n',
      type: 'create',
    },
    toolUseId: 'tool-summary',
    sessionId,
    agentId,
  })
  return {
    taskId,
    description: 'Simple bundle v2 summary fixture generated from an exact file write.',
  }
}

async function buildNoticesOnlyFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-notices-only'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  openScope('fixture-notices-only-other', 'review', agentId)
  await captureTaskChangeToolResult({
    toolName: FILE_WRITE_TOOL_NAME,
    resultData: {
      filePath: 'src/ignored.ts',
      content: 'export const ignored = true;\n',
      type: 'create',
    },
    toolUseId: 'tool-notices-only',
    sessionId,
    agentId,
  })
  return {
    taskId,
    description: 'Warning-only ledger fixture with ambiguous multi-scope attribution and no file events.',
  }
}

async function buildRenameFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-rename'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  await writeRepoFile('src/old.ts', 'export const renamed = true;\n')
  await commitAll('initial commit')

  const snapshot = await maybeBeginTaskChangeShellSnapshot({
    toolName: 'PowerShell',
    input: { command: 'Rename-Item src/old.ts src/new.ts' },
    includeNonBashTool: true,
    toolUseId: 'tool-rename',
    sessionId,
    agentId,
  })
  runGit(['mv', 'src/old.ts', 'src/new.ts'])
  await finishTaskChangeShellSnapshot(snapshot, 'succeeded', {
    source: 'powershell_snapshot',
  })

  return {
    taskId,
    description: 'Rename relation fixture generated from a committed rename shell snapshot.',
    extraRelativePaths: ['src/new.ts'],
  }
}

async function buildCopyFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-copy'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  await writeRepoFile('src/base.ts', 'export const copied = true;\n')
  await commitAll('initial commit')

  const snapshot = await maybeBeginTaskChangeShellSnapshot({
    toolName: BASH_TOOL_NAME,
    input: { command: 'cp src/base.ts src/copy.ts && git add src/copy.ts && git commit' },
    toolUseId: 'tool-copy',
    sessionId,
    agentId,
  })
  await writeRepoFile('src/copy.ts', 'export const copied = true;\n')
  runGit(['add', 'src/copy.ts'])
  await commitAll('copy file')
  await finishTaskChangeShellSnapshot(snapshot, 'succeeded')

  return {
    taskId,
    description: 'Copy relation fixture generated from a committed copy detected via git diff.',
    extraRelativePaths: ['src/base.ts', 'src/copy.ts'],
  }
}

async function buildBinaryFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-binary'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  await writeRepoFile('fixtures/blob.bin', Buffer.from([0, 1, 2, 3]))
  await commitAll('initial binary commit')

  const snapshot = await maybeBeginTaskChangeShellSnapshot({
    toolName: BASH_TOOL_NAME,
    input: { command: 'mutate binary file' },
    toolUseId: 'tool-binary',
    sessionId,
    agentId,
  })
  await writeRepoFile('fixtures/blob.bin', Buffer.from([4, 5, 6, 7]))
  await finishTaskChangeShellSnapshot(snapshot, 'succeeded')

  return {
    taskId,
    description: 'Metadata-only binary fixture generated from a shell snapshot mutation.',
    extraRelativePaths: ['fixtures/blob.bin'],
  }
}

async function buildMissingBlobFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-missing-blob'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  await writeRepoFile('src/missing.ts', 'export const missing = 1;\n')
  await commitAll('initial commit')

  const snapshot = await maybeBeginTaskChangeShellSnapshot({
    toolName: BASH_TOOL_NAME,
    input: { command: 'edit src/missing.ts' },
    toolUseId: 'tool-missing-blob',
    sessionId,
    agentId,
  })
  await writeRepoFile('src/missing.ts', 'export const missing = 2;\n')
  await finishTaskChangeShellSnapshot(snapshot, 'succeeded')

  return {
    taskId,
    description: 'Fixture with a missing pre-change text blob to validate metadata-only downgrade paths.',
    extraRelativePaths: ['src/missing.ts'],
    mutateOutput: async (projectDir, targetTaskId) => {
      const events = await readJsonl<Array<{ before?: { blobRef?: string | null } }[number]>>(
        eventsPath(targetTaskId, projectDir),
      )
      const beforeBlobRef = events[0]?.before?.blobRef
      if (beforeBlobRef) {
        await unlink(join(projectDir, '.board-task-changes', 'blobs', beforeBlobRef)).catch(() => undefined)
      }
    },
  }
}

async function buildRecoveredJournalFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-recovered-journal'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  await captureTaskChangeToolResult({
    toolName: FILE_WRITE_TOOL_NAME,
    resultData: {
      filePath: 'src/ok.ts',
      content: 'export const ok = true;\n',
      type: 'create',
    },
    toolUseId: 'tool-recovered-initial',
    sessionId,
    agentId,
  })
  await writeFile(eventsPath(taskId), '\n{"bad-json"', { flag: 'a' })
  await captureTaskChangeToolResult({
    toolName: FILE_WRITE_TOOL_NAME,
    resultData: {
      filePath: 'src/recovered.ts',
      content: 'export const recovered = true;\n',
      type: 'create',
    },
    toolUseId: 'tool-recovered-trigger',
    sessionId,
    agentId,
  })

  return {
    taskId,
    description: 'Recovered journal fixture generated after replaying malformed journal lines.',
    extraRelativePaths: ['src/ok.ts', 'src/recovered.ts'],
  }
}

async function buildGenerationMismatchFixture(): Promise<FixtureScenarioResult> {
  const taskId = 'fixture-generation-mismatch'
  const agentId = 'alice@test'
  openScope(taskId, 'work', agentId)
  await captureTaskChangeToolResult({
    toolName: FILE_WRITE_TOOL_NAME,
    resultData: {
      filePath: 'src/mismatch.ts',
      content: 'export const mismatch = 1;\n',
      type: 'create',
    },
    toolUseId: 'tool-generation-mismatch',
    sessionId,
    agentId,
  })

  return {
    taskId,
    description: 'Fixture with intentionally mismatched freshness metadata to force journal fallback.',
    extraRelativePaths: ['src/mismatch.ts'],
    mutateOutput: async (projectDir, targetTaskId) => {
      const freshness = await readJson<Record<string, unknown>>(freshnessPath(targetTaskId, projectDir))
      const journalStamp = freshness.journalStamp as Record<string, unknown> | undefined
      const events = (journalStamp?.events as Record<string, unknown> | undefined) ?? {}
      await writeFile(
        freshnessPath(targetTaskId, projectDir),
        `${JSON.stringify(
          {
            ...freshness,
            journalStamp: {
              ...(journalStamp ?? {}),
              events: {
                ...events,
                tailSha256: 'mismatched-tail-sha256',
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    },
  }
}

async function main(): Promise<void> {
  const outputRootDir = process.argv[2] ? join(process.argv[2]) : DEFAULT_OUTPUT_DIR
  await rm(outputRootDir, { recursive: true, force: true })
  await mkdir(outputRootDir, { recursive: true })

  const fixtures: Array<[string, () => Promise<FixtureScenarioResult>]> = [
    ['v2-summary', buildV2SummaryFixture],
    ['notices-only', buildNoticesOnlyFixture],
    ['rename', buildRenameFixture],
    ['copy', buildCopyFixture],
    ['binary', buildBinaryFixture],
    ['missing-blob', buildMissingBlobFixture],
    ['recovered-journal', buildRecoveredJournalFixture],
    ['generation-mismatch', buildGenerationMismatchFixture],
  ]

  for (const [name, build] of fixtures) {
    await buildFixture(outputRootDir, name, build)
  }

  console.log(`Generated ${fixtures.length} task-change-ledger fixtures into ${outputRootDir}`)
}

void main().catch(async error => {
  clearDynamicTeamContext()
  getRuntimeBoardTaskExecutionStore().clearForTests()
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.error(error)
  process.exitCode = 1
})
