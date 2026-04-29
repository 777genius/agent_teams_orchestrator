import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { buildManagedConfig } from './OpenCodeProfileManager.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeSnapshotEvidenceProviderService } from './OpenCodeSnapshotEvidenceProvider.js'
import { OpenCodeSnapshotGitStoreReader } from './OpenCodeSnapshotGitStoreReader.js'

import type { OpenCodeSessionRecord } from './types.js'

const liveTest = process.env.OPENCODE_LEDGER_LIVE_E2E === '1'
  ? test
  : test.skip
const liveSnapshotBridgeTest =
  process.env.OPENCODE_LEDGER_LIVE_E2E === '1' &&
  process.env.OPENCODE_LEDGER_SNAPSHOT_PROBE === '1'
    ? test
    : test.skip

const LIVE_MODEL = process.env.OPENCODE_LEDGER_LIVE_MODEL ?? 'opencode/big-pickle'
const TEAM_NAME = 'live-opencode-ledger-smoke'
const TASK_ID = 'live-task-1'
const TASK_DISPLAY_ID = 'live12345'
const MEMBER_NAME = 'bob'
const LANE_ID = `secondary:opencode:${MEMBER_NAME}`
const SMOKE_FILE = 'live-opencode-ledger-smoke.ts'
const MULTI_ALPHA_FILE = 'live-multi-alpha.ts'
const MULTI_BETA_FILE = 'live-multi-beta.ts'
const MULTI_GAMMA_FILE = 'live-multi-gamma.ts'
const FALLBACK_FILE = 'live-metadata-fallback.ts'
const LIVE_CLI_FILE = 'live-cli-runtime.ts'

let tempDir = ''

class LiveOpenCodeOfflineSessionReader extends OpenCodeOfflineSessionReader {
  constructor(private readonly dbPath: string) {
    super()
  }

  override resolveDbPath(): string {
    return this.dbPath
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-ledger-live-e2e-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function childEnv(options: { snapshot?: boolean } = {}): NodeJS.ProcessEnv {
  const home = liveHome()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(tempDir, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config'),
    XDG_CACHE_HOME: path.join(tempDir, 'xdg-cache'),
    XDG_STATE_HOME: path.join(tempDir, 'xdg-state'),
  }
  if (options.snapshot === true) {
    const managedConfig = buildManagedConfig(null, { defaultModelId: LIVE_MODEL })
    managedConfig.snapshot = true
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(managedConfig)
    env.OPENCODE_DISABLE_CLAUDE_CODE = '1'
  }
  return env
}

function liveHome(): string {
  return path.join(tempDir, 'home')
}

function appDataDirForHome(home: string): string {
  const appName = 'claude-multimodel-nodejs'
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', appName)
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', appName, 'Data')
  }
  return path.join(home, '.local', 'share', appName)
}

function cliDevCommand(): { command: string; prefixArgs: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.execPath,
      prefixArgs: [path.join(process.cwd(), 'dist', 'local-cli-dev', 'cli.js')],
    }
  }
  return {
    command: path.join(process.cwd(), 'cli-dev'),
    prefixArgs: [],
  }
}

function runOpenCode(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000) {
  return spawnSync('opencode', args, {
    cwd: tempDir,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  })
}

function runGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  expect(result.status, `git ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
}

function parseDbPath(stdout: string): string {
  const dbPath = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.endsWith('opencode.db'))
  if (!dbPath) {
    throw new Error(`OpenCode db path output did not include opencode.db: ${stdout}`)
  }
  return dbPath
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function getString(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function findLiveToolpart(dbPath: string, workspaceRoot: string): {
  sessionId: string
  assistantMessageId: string
  parentUserMessageId: string
  partId: string
} {
  return findLiveToolpartForFiles(dbPath, workspaceRoot, [SMOKE_FILE])
}

function findLiveToolpartForFiles(dbPath: string, workspaceRoot: string, relativePaths: string[]): {
  sessionId: string
  assistantMessageId: string
  parentUserMessageId: string
  partId: string
} {
  const targetPaths = new Set(relativePaths.map(relativePath => path.join(workspaceRoot, relativePath)))
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db.query(
      'select id, message_id, session_id, data from part order by time_created asc, id asc',
    ).all() as Array<{ id: string; message_id: string; session_id: string; data: string }>
    for (const row of rows) {
      const data = parseRecord(row.data)
      if (data?.type !== 'tool') {
        continue
      }
      const tool = getString(data, 'tool')
      if (tool !== 'write' && tool !== 'edit' && tool !== 'apply_patch') {
        continue
      }
      const state = data.state && typeof data.state === 'object'
        ? data.state as Record<string, unknown>
        : null
      const input = state?.input && typeof state.input === 'object'
        ? state.input as Record<string, unknown>
        : null
      const filePath = getString(input, 'filePath')
      const patch = getString(input, 'patch')
      const resolvedFilePath = filePath
        ? path.resolve(path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath))
        : null
      const targetsSmokeFile =
        resolvedFilePath
          ? targetPaths.has(resolvedFilePath) || relativePaths.includes(filePath ?? '')
          : typeof patch === 'string' && relativePaths.some(relativePath => patch.includes(relativePath))
      if (!targetsSmokeFile) {
        continue
      }
      const message = db.query(
        'select data from message where id = ?',
      ).get(row.message_id) as { data: string } | null
      const messageData = parseRecord(message?.data ?? '')
      const parentUserMessageId =
        getString(messageData, 'parentID') ?? getString(messageData, 'parentId')
      if (!parentUserMessageId) {
        throw new Error(`OpenCode toolpart ${row.id} had no parent user message id.`)
      }
      return {
        sessionId: row.session_id,
        assistantMessageId: row.message_id,
        parentUserMessageId,
        partId: row.id,
      }
    }
  } finally {
    db.close()
  }
  throw new Error(`No live OpenCode write/edit/apply_patch toolpart found for ${relativePaths.join(', ')}.`)
}

function sessionRecord(input: {
  sessionId: string
  workspaceRoot: string
}): OpenCodeSessionRecord {
  return {
    teamId: TEAM_NAME,
    laneId: LANE_ID,
    memberName: MEMBER_NAME,
    providerId: 'opencode',
    selectedModel: LIVE_MODEL,
    projectPath: input.workspaceRoot,
    profileRootKey: 'live-opencode-profile',
    hostKey: 'live-opencode-host',
    resolvedBehaviorFingerprint: 'live',
    opencodeSessionId: input.sessionId,
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    projectBehaviorFingerprint: 'live',
    staleReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

async function writeDeliveryContext(input: {
  sessionId: string
  parentUserMessageId: string
}): Promise<{ deliveryContextPath: string; deliveryContextHash: string }> {
  const contextDir = await mkdtemp(path.join(tempDir, 'claude-team-opencode-ledger-context-'))
  await chmod(contextDir, 0o700).catch(() => undefined)
  const filePath = path.join(contextDir, 'delivery-context.json')
  const rawContext = `${JSON.stringify({
    schemaVersion: 1,
    teamName: TEAM_NAME,
    taskId: TASK_ID,
    records: [
      {
        memberName: MEMBER_NAME,
        laneId: LANE_ID,
        runtimeSessionId: input.sessionId,
        inboxMessageId: input.parentUserMessageId,
        deliveredUserMessageId: input.parentUserMessageId,
        observedAssistantMessageId: null,
        prePromptCursor: null,
        postPromptCursor: null,
        taskRefs: [
          { taskId: TASK_ID, displayId: TASK_DISPLAY_ID, teamName: TEAM_NAME },
        ],
      },
    ],
  }, null, 2)}\n`
  await writeFile(
    filePath,
    rawContext,
    { encoding: 'utf8', mode: 0o600 },
  )
  return {
    deliveryContextPath: filePath,
    deliveryContextHash: createHash('sha256').update(rawContext).digest('hex'),
  }
}

async function materializeLiveManagedProfile(input: {
  dbPath: string
  profileRootKey: string
}): Promise<string> {
  const profileDataDir = path.join(
    appDataDirForHome(liveHome()),
    'opencode',
    'profiles',
    input.profileRootKey,
    'data',
    'opencode',
  )
  await mkdir(path.dirname(profileDataDir), { recursive: true })
  await rm(profileDataDir, { recursive: true, force: true })
  await cp(path.dirname(input.dbPath), profileDataDir, { recursive: true, force: true })
  return profileDataDir
}

async function writeLiveSessionStoreRecord(input: {
  profileRootKey: string
  sessionId: string
  workspaceRoot: string
}): Promise<void> {
  const store = new OpenCodeSessionStore(
    path.join(appDataDirForHome(liveHome()), 'opencode', 'session-store.json'),
  )
  await store.upsert({
    ...sessionRecord({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
    }),
    profileRootKey: input.profileRootKey,
  })
}

function runCliBackfill(input: {
  env: NodeJS.ProcessEnv
  projectDir: string
  workspaceRoot: string
  deliveryContext: { deliveryContextPath: string; deliveryContextHash: string }
}) {
  const cliDev = cliDevCommand()
  return spawnSync(
    cliDev.command,
    [
      ...cliDev.prefixArgs,
      'runtime',
      'opencode-ledger-backfill',
      '--json',
      '--team',
      TEAM_NAME,
      '--task',
      TASK_ID,
      '--task-display-id',
      TASK_DISPLAY_ID,
      '--project-dir',
      input.projectDir,
      '--workspace-root',
      input.workspaceRoot,
      '--delivery-context',
      input.deliveryContext.deliveryContextPath,
      '--delivery-context-hash',
      input.deliveryContext.deliveryContextHash,
      '--attribution-mode',
      'strict-delivery',
    ],
    {
      cwd: process.cwd(),
      env: input.env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  )
}

async function readBundle(projectDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      path.join(projectDir, '.board-task-changes', 'bundles', `${encodeURIComponent(TASK_ID)}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>
}

async function readEvents(projectDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(
    path.join(projectDir, '.board-task-changes', 'events', `${encodeURIComponent(TASK_ID)}.jsonl`),
    'utf8',
  )
  return raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function liveSnapshotBridgeService(input: {
  dbPath: string
  sessionId: string
  workspaceRoot: string
}): OpenCodeLedgerBridgeService {
  const offlineReader = new LiveOpenCodeOfflineSessionReader(input.dbPath)
  return new OpenCodeLedgerBridgeService(
    { list: async () => [sessionRecord({ sessionId: input.sessionId, workspaceRoot: input.workspaceRoot })] },
    offlineReader,
    undefined,
    undefined,
    new OpenCodeSnapshotEvidenceProviderService(
      new OpenCodeSnapshotGitStoreReader({ offlineSessionReader: offlineReader }),
    ),
  )
}

describe('OpenCode Ledger Bridge live e2e', () => {
  liveTest('imports real OpenCode file-changing toolparts into task changes', async () => {
    const version = runOpenCode(['--version'], childEnv(), 15_000)
    expect(version.status).toBe(0)

    const env = childEnv()
    const workspaceRootPath = path.join(tempDir, 'workspace')
    const projectDir = path.join(tempDir, 'claude-project')
    await mkdir(workspaceRootPath, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const workspaceRoot = await realpath(workspaceRootPath)
    const smokePath = path.join(workspaceRoot, SMOKE_FILE)

    const dbPathResult = runOpenCode(['db', 'path'], env, 30_000)
    expect(dbPathResult.status).toBe(0)
    const dbPath = parseDbPath(dbPathResult.stdout)

    const prompt = [
      `You are running a live Agent Teams ledger smoke test.`,
      `Use the file write tool exactly once, not shell, bash, glob, or read.`,
      `Write this exact absolute file path: ${smokePath}`,
      `The write tool content must be exactly: export const liveSmoke = 2;`,
      `Do not create, delete, inspect, or modify any other files.`,
      `This run is correlated by the delivery ledger; do not add legacy taskRefs text markers.`,
    ].join('\n')

    const run = runOpenCode([
      'run',
      '--pure',
      '--dir',
      workspaceRoot,
      '--model',
      LIVE_MODEL,
      '--dangerously-skip-permissions',
      '--format',
      'json',
      prompt,
    ], env)
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const toolpart = findLiveToolpart(dbPath, workspaceRoot)
    const wrongProjectDir = path.join(tempDir, 'claude-project-wrong-delivery')
    await mkdir(wrongProjectDir, { recursive: true })
    const wrongDeliveryContext = await writeDeliveryContext({
      sessionId: toolpart.sessionId,
      parentUserMessageId: `${toolpart.parentUserMessageId}-wrong`,
    })
    const wrongDeliveryService = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord({ sessionId: toolpart.sessionId, workspaceRoot })] },
      new LiveOpenCodeOfflineSessionReader(dbPath),
    )
    const wrongDeliveryResult = await wrongDeliveryService.backfill({
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      taskDisplayId: TASK_DISPLAY_ID,
      memberName: MEMBER_NAME,
      laneId: LANE_ID,
      projectDir: wrongProjectDir,
      workspaceRoot,
      ...wrongDeliveryContext,
      attributionMode: 'strict-delivery',
    })
    expect(wrongDeliveryResult.outcome).toBe('no-attribution')
    expect(wrongDeliveryResult.importedEvents).toBe(0)

    const deliveryContext = await writeDeliveryContext({
      sessionId: toolpart.sessionId,
      parentUserMessageId: toolpart.parentUserMessageId,
    })

    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord({ sessionId: toolpart.sessionId, workspaceRoot })] },
      new LiveOpenCodeOfflineSessionReader(dbPath),
    )
    const result = await service.backfill({
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      taskDisplayId: TASK_DISPLAY_ID,
      memberName: MEMBER_NAME,
      laneId: LANE_ID,
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBeGreaterThanOrEqual(1)
    expect(result.diagnostics.join('\n')).not.toContain('unsupported-opencode-history-shape')

    const bundle = await readBundle(projectDir)
    expect(bundle).toMatchObject({
      source: 'task-change-ledger',
      taskId: TASK_ID,
      totalFiles: 1,
    })
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files[0]).toMatchObject({
      relativePath: SMOKE_FILE,
    })
    expect((files[0]?.eventCount as number) ?? 0).toBeGreaterThanOrEqual(1)
  }, 240_000)

  liveSnapshotBridgeTest('imports real OpenCode snapshot evidence into full-text task changes', async () => {
    const env = childEnv({ snapshot: true })
    const version = runOpenCode(['--version'], env, 15_000)
    expect(version.status, `stdout:\n${version.stdout}\nstderr:\n${version.stderr}`).toBe(0)

    const workspaceRootPath = path.join(tempDir, 'workspace-snapshot-bridge')
    const projectDir = path.join(tempDir, 'claude-project-snapshot-bridge')
    await mkdir(workspaceRootPath, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const workspaceRoot = await realpath(workspaceRootPath)
    runGit(['init'], workspaceRoot)
    runGit(['config', 'user.email', 'opencode-ledger-live@example.local'], workspaceRoot)
    runGit(['config', 'user.name', 'OpenCode Ledger Live'], workspaceRoot)
    await writeFile(path.join(workspaceRoot, SMOKE_FILE), 'export const liveSmoke = 1;\n', 'utf8')
    runGit(['add', SMOKE_FILE], workspaceRoot)
    runGit(['commit', '-m', 'seed live snapshot bridge workspace'], workspaceRoot)

    const dbPathResult = runOpenCode(['db', 'path'], env, 30_000)
    expect(dbPathResult.status, `stdout:\n${dbPathResult.stdout}\nstderr:\n${dbPathResult.stderr}`).toBe(0)
    const dbPath = parseDbPath(dbPathResult.stdout)

    const prompt = [
      `You are running a live Agent Teams snapshot ledger smoke test.`,
      `Use the file edit or write tool, not shell.`,
      `Change the existing ${SMOKE_FILE} file in the current workspace.`,
      `The final content must be exactly: export const liveSmoke = 2;`,
      `Do not create, delete, or modify any other files.`,
      `This run is correlated by the delivery ledger; do not add legacy taskRefs text markers.`,
    ].join('\n')

    const run = runOpenCode([
      'run',
      '--pure',
      '--dir',
      workspaceRoot,
      '--model',
      LIVE_MODEL,
      '--dangerously-skip-permissions',
      '--format',
      'json',
      prompt,
    ], env)
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const toolpart = findLiveToolpart(dbPath, workspaceRoot)
    const deliveryContext = await writeDeliveryContext({
      sessionId: toolpart.sessionId,
      parentUserMessageId: toolpart.parentUserMessageId,
    })

    const offlineReader = new LiveOpenCodeOfflineSessionReader(dbPath)
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord({ sessionId: toolpart.sessionId, workspaceRoot })] },
      offlineReader,
      undefined,
      undefined,
      new OpenCodeSnapshotEvidenceProviderService(
        new OpenCodeSnapshotGitStoreReader({ offlineSessionReader: offlineReader }),
      ),
    )
    const result = await service.backfill({
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      taskDisplayId: TASK_DISPLAY_ID,
      memberName: MEMBER_NAME,
      laneId: LANE_ID,
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBeGreaterThanOrEqual(1)
    expect(result.snapshotShapeFingerprint).toBe('opencode-snapshot-git-store-v2')
    expect(result.diagnostics.join('\n')).not.toContain('snapshot-gitdir-missing')
    expect(result.diagnostics.join('\n')).not.toContain('snapshot-diff-read-failed')

    const events = await readEvents(projectDir)
    const snapshotEvent = events.find(event =>
      event.relativePath === SMOKE_FILE &&
      event.snapshotSource === 'opencode' &&
      typeof event.snapshotId === 'string'
    )
    expect(snapshotEvent).toBeTruthy()
    expect(snapshotEvent?.operation).toBe('modify')
    expect(['opencode-snapshot', 'inverse-edit-chain', 'inverse-apply-patch-chain']).toContain(snapshotEvent?.evidenceProof)
    expect((snapshotEvent?.before as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    expect((snapshotEvent?.after as { sha256?: string } | undefined)?.sha256).toBeTruthy()

    const bundle = await readBundle(projectDir)
    expect(bundle).toMatchObject({
      source: 'task-change-ledger',
      taskId: TASK_ID,
      totalFiles: 1,
    })
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === SMOKE_FILE)).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (snapshotEvent?.before as { sha256?: string } | undefined)?.sha256,
      latestAfterHash: (snapshotEvent?.after as { sha256?: string } | undefined)?.sha256,
    })
  }, 240_000)

  liveSnapshotBridgeTest('imports real multi-file OpenCode snapshot evidence into full-text task changes', async () => {
    const env = childEnv({ snapshot: true })
    const version = runOpenCode(['--version'], env, 15_000)
    expect(version.status, `stdout:\n${version.stdout}\nstderr:\n${version.stderr}`).toBe(0)

    const workspaceRootPath = path.join(tempDir, 'workspace-snapshot-multi-file')
    const projectDir = path.join(tempDir, 'claude-project-snapshot-multi-file')
    await mkdir(workspaceRootPath, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const workspaceRoot = await realpath(workspaceRootPath)
    runGit(['init'], workspaceRoot)
    runGit(['config', 'user.email', 'opencode-ledger-live@example.local'], workspaceRoot)
    runGit(['config', 'user.name', 'OpenCode Ledger Live'], workspaceRoot)
    await writeFile(path.join(workspaceRoot, MULTI_ALPHA_FILE), 'export const alpha = 1;\n', 'utf8')
    await writeFile(path.join(workspaceRoot, MULTI_BETA_FILE), 'export const beta = 1;\n', 'utf8')
    runGit(['add', MULTI_ALPHA_FILE, MULTI_BETA_FILE], workspaceRoot)
    runGit(['commit', '-m', 'seed live multi-file snapshot workspace'], workspaceRoot)

    const dbPathResult = runOpenCode(['db', 'path'], env, 30_000)
    expect(dbPathResult.status, `stdout:\n${dbPathResult.stdout}\nstderr:\n${dbPathResult.stderr}`).toBe(0)
    const dbPath = parseDbPath(dbPathResult.stdout)

    const prompt = [
      `You are running a live Agent Teams multi-file snapshot ledger smoke test.`,
      `Use file write/edit tools, not shell.`,
      `Change ${MULTI_ALPHA_FILE} so the final content is exactly: export const alpha = 2;`,
      `Change ${MULTI_BETA_FILE} so the final content is exactly: export const beta = 2;`,
      `Create ${MULTI_GAMMA_FILE} with exactly: export const gamma = 3;`,
      `Do not create, delete, or modify any other files.`,
      `This run is correlated by the delivery ledger; do not add legacy taskRefs text markers.`,
    ].join('\n')

    const run = runOpenCode([
      'run',
      '--pure',
      '--dir',
      workspaceRoot,
      '--model',
      LIVE_MODEL,
      '--dangerously-skip-permissions',
      '--format',
      'json',
      prompt,
    ], env)
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const toolpart = findLiveToolpartForFiles(dbPath, workspaceRoot, [
      MULTI_ALPHA_FILE,
      MULTI_BETA_FILE,
      MULTI_GAMMA_FILE,
    ])
    const deliveryContext = await writeDeliveryContext({
      sessionId: toolpart.sessionId,
      parentUserMessageId: toolpart.parentUserMessageId,
    })

    const service = liveSnapshotBridgeService({
      dbPath,
      sessionId: toolpart.sessionId,
      workspaceRoot,
    })
    const result = await service.backfill({
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      taskDisplayId: TASK_DISPLAY_ID,
      memberName: MEMBER_NAME,
      laneId: LANE_ID,
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.snapshotShapeFingerprint).toBe('opencode-snapshot-git-store-v2')
    expect(result.importedEvents).toBeGreaterThanOrEqual(3)
    const bundle = await readBundle(projectDir)
    expect(bundle).toMatchObject({
      source: 'task-change-ledger',
      taskId: TASK_ID,
      totalFiles: 3,
    })
    const files = bundle.files as Array<Record<string, unknown>>
    const byPath = new Map(files.map(file => [file.relativePath, file]))
    for (const relativePath of [MULTI_ALPHA_FILE, MULTI_BETA_FILE, MULTI_GAMMA_FILE]) {
      expect(byPath.get(relativePath)).toMatchObject({
        reviewability: 'full-text',
        contentAvailability: 'full-text',
      })
    }
    expect(byPath.get(MULTI_ALPHA_FILE)).toMatchObject({ latestOperation: 'modify' })
    expect(byPath.get(MULTI_BETA_FILE)).toMatchObject({ latestOperation: 'modify' })
    expect(byPath.get(MULTI_GAMMA_FILE)).toMatchObject({ latestOperation: 'create' })

    const eventCountAfterFirstImport = (await readEvents(projectDir)).length
    const duplicateResult = await service.backfill({
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      taskDisplayId: TASK_DISPLAY_ID,
      memberName: MEMBER_NAME,
      laneId: LANE_ID,
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })
    expect(duplicateResult.outcome).toBe('duplicates-only')
    expect(duplicateResult.importedEvents).toBe(0)
    expect((await readEvents(projectDir)).length).toBe(eventCountAfterFirstImport)
  }, 240_000)

  liveSnapshotBridgeTest('public CLI imports real OpenCode snapshot changes from managed profile artifacts', async () => {
    const env = childEnv({ snapshot: true })
    const version = runOpenCode(['--version'], env, 15_000)
    expect(version.status, `stdout:\n${version.stdout}\nstderr:\n${version.stderr}`).toBe(0)

    const workspaceRootPath = path.join(tempDir, 'workspace-live-cli')
    const projectDir = path.join(tempDir, 'claude-project-live-cli')
    await mkdir(workspaceRootPath, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const workspaceRoot = await realpath(workspaceRootPath)
    runGit(['init'], workspaceRoot)
    runGit(['config', 'user.email', 'opencode-ledger-live@example.local'], workspaceRoot)
    runGit(['config', 'user.name', 'OpenCode Ledger Live'], workspaceRoot)
    const liveCliPath = path.join(workspaceRoot, LIVE_CLI_FILE)
    await writeFile(liveCliPath, 'export const cliRuntime = 1;\n', 'utf8')
    runGit(['add', LIVE_CLI_FILE], workspaceRoot)
    runGit(['commit', '-m', 'seed live cli runtime workspace'], workspaceRoot)

    const dbPathResult = runOpenCode(['db', 'path'], env, 30_000)
    expect(dbPathResult.status, `stdout:\n${dbPathResult.stdout}\nstderr:\n${dbPathResult.stderr}`).toBe(0)
    const dbPath = parseDbPath(dbPathResult.stdout)

    const prompt = [
      `You are running a live Agent Teams CLI ledger smoke test.`,
      `Use the file write tool exactly once, not shell, bash, glob, or read.`,
      `Overwrite this exact absolute file path: ${liveCliPath}`,
      `The write tool content must be exactly: export const cliRuntime = 2;`,
      `Do not create, delete, inspect, or modify any other files.`,
      `This run is correlated by the delivery ledger; do not add legacy taskRefs text markers.`,
    ].join('\n')

    const run = runOpenCode([
      'run',
      '--pure',
      '--dir',
      workspaceRoot,
      '--model',
      LIVE_MODEL,
      '--dangerously-skip-permissions',
      '--format',
      'json',
      prompt,
    ], env)
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const toolpart = findLiveToolpartForFiles(dbPath, workspaceRoot, [LIVE_CLI_FILE])
    const profileRootKey = 'live-cli-profile'
    await materializeLiveManagedProfile({ dbPath, profileRootKey })
    await writeLiveSessionStoreRecord({
      profileRootKey,
      sessionId: toolpart.sessionId,
      workspaceRoot,
    })

    const wrongProjectDir = path.join(tempDir, 'claude-project-live-cli-wrong-delivery')
    await mkdir(wrongProjectDir, { recursive: true })
    const wrongDeliveryContext = await writeDeliveryContext({
      sessionId: toolpart.sessionId,
      parentUserMessageId: `${toolpart.parentUserMessageId}-wrong`,
    })
    const wrongCli = runCliBackfill({
      env,
      projectDir: wrongProjectDir,
      workspaceRoot,
      deliveryContext: wrongDeliveryContext,
    })
    expect(wrongCli.status, `stdout:\n${wrongCli.stdout}\nstderr:\n${wrongCli.stderr}`).toBe(0)
    const wrongStdout = JSON.parse(wrongCli.stdout) as {
      result: { outcome: string; importedEvents: number }
    }
    expect(wrongStdout.result).toMatchObject({
      outcome: 'no-attribution',
      importedEvents: 0,
    })
    expect(await readBundle(wrongProjectDir).catch(() => null)).toBeNull()

    const deliveryContext = await writeDeliveryContext({
      sessionId: toolpart.sessionId,
      parentUserMessageId: toolpart.parentUserMessageId,
    })
    const cli = runCliBackfill({
      env,
      projectDir,
      workspaceRoot,
      deliveryContext,
    })
    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: {
        outcome: string
        importedEvents: number
        scannedSessions: number
        snapshotShapeFingerprint?: string
      }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
      scannedSessions: 1,
      snapshotShapeFingerprint: 'opencode-snapshot-git-store-v2',
    })
    expect(stdout.result.importedEvents).toBeGreaterThanOrEqual(1)

    const bundle = await readBundle(projectDir)
    expect(bundle).toMatchObject({
      source: 'task-change-ledger',
      taskId: TASK_ID,
      totalFiles: 1,
    })
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === LIVE_CLI_FILE)).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'full-text',
      contentAvailability: 'full-text',
    })

    const eventCountAfterFirstImport = (await readEvents(projectDir)).length
    const duplicateCli = runCliBackfill({
      env,
      projectDir,
      workspaceRoot,
      deliveryContext,
    })
    expect(duplicateCli.status, `stdout:\n${duplicateCli.stdout}\nstderr:\n${duplicateCli.stderr}`).toBe(0)
    const duplicateStdout = JSON.parse(duplicateCli.stdout) as {
      result: { outcome: string; importedEvents: number }
    }
    expect(duplicateStdout.result).toMatchObject({
      outcome: 'duplicates-only',
      importedEvents: 0,
    })
    expect((await readEvents(projectDir)).length).toBe(eventCountAfterFirstImport)
  }, 300_000)

  liveTest('imports real non-snapshot OpenCode existing-file edits as visible manual-review changes', async () => {
    const env = childEnv()
    const version = runOpenCode(['--version'], env, 15_000)
    expect(version.status).toBe(0)

    const workspaceRootPath = path.join(tempDir, 'workspace-metadata-fallback')
    const projectDir = path.join(tempDir, 'claude-project-metadata-fallback')
    await mkdir(workspaceRootPath, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const workspaceRoot = await realpath(workspaceRootPath)
    const fallbackPath = path.join(workspaceRoot, FALLBACK_FILE)
    await writeFile(fallbackPath, 'export const fallback = 1;\n', 'utf8')

    const dbPathResult = runOpenCode(['db', 'path'], env, 30_000)
    expect(dbPathResult.status).toBe(0)
    const dbPath = parseDbPath(dbPathResult.stdout)

    const prompt = [
      `You are running a live Agent Teams metadata fallback smoke test.`,
      `Use the file write tool exactly once, not shell, bash, glob, or read.`,
      `Overwrite this exact absolute file path: ${fallbackPath}`,
      `The write tool content must be exactly: export const fallback = 2;`,
      `Do not create, delete, inspect, or modify any other files.`,
      `This run is correlated by the delivery ledger; do not add legacy taskRefs text markers.`,
    ].join('\n')

    const run = runOpenCode([
      'run',
      '--pure',
      '--dir',
      workspaceRoot,
      '--model',
      LIVE_MODEL,
      '--dangerously-skip-permissions',
      '--format',
      'json',
      prompt,
    ], env)
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const toolpart = findLiveToolpartForFiles(dbPath, workspaceRoot, [FALLBACK_FILE])
    const deliveryContext = await writeDeliveryContext({
      sessionId: toolpart.sessionId,
      parentUserMessageId: toolpart.parentUserMessageId,
    })
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord({ sessionId: toolpart.sessionId, workspaceRoot })] },
      new LiveOpenCodeOfflineSessionReader(dbPath),
    )
    const result = await service.backfill({
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      taskDisplayId: TASK_DISPLAY_ID,
      memberName: MEMBER_NAME,
      laneId: LANE_ID,
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBeGreaterThanOrEqual(1)
    const bundle = await readBundle(projectDir)
    expect(bundle).toMatchObject({
      source: 'task-change-ledger',
      taskId: TASK_ID,
      totalFiles: 1,
    })
    const files = bundle.files as Array<Record<string, unknown>>
    const fallbackFile = files.find(file => file.relativePath === FALLBACK_FILE)
    expect(fallbackFile).toMatchObject({
      latestOperation: 'modify',
      contentAvailability: 'hash-only',
    })
    expect(['metadata-only', 'partial-text']).toContain(fallbackFile?.reviewability)
    expect((fallbackFile?.warnings as string[] | undefined)?.join('\n')).toContain('manual-only')
    const events = await readEvents(projectDir)
    const fallbackEvent = events.find(event => event.relativePath === FALLBACK_FILE)
    expect(fallbackEvent).toMatchObject({
      evidenceProof: 'metadata-only-fallback',
      beforeState: {
        exists: true,
      },
      afterState: {
        exists: true,
      },
    })

    const eventCountAfterFirstImport = events.length
    const duplicateResult = await service.backfill({
      teamName: TEAM_NAME,
      taskId: TASK_ID,
      taskDisplayId: TASK_DISPLAY_ID,
      memberName: MEMBER_NAME,
      laneId: LANE_ID,
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })
    expect(duplicateResult.outcome).toBe('duplicates-only')
    expect(duplicateResult.importedEvents).toBe(0)
    expect((await readEvents(projectDir)).length).toBe(eventCountAfterFirstImport)
  }, 240_000)
})
