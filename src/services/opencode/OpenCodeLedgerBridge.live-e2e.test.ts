import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { buildManagedConfig } from './OpenCodeProfileManager.js'
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
  const home = path.join(tempDir, 'home')
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
      const targetsSmokeFile =
        filePath
          ? path.resolve(filePath) === path.join(workspaceRoot, SMOKE_FILE)
          : typeof patch === 'string' && patch.includes(SMOKE_FILE)
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
  throw new Error(`No live OpenCode write/edit/apply_patch toolpart found for ${SMOKE_FILE}.`)
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

    const dbPathResult = runOpenCode(['db', 'path'], env, 30_000)
    expect(dbPathResult.status).toBe(0)
    const dbPath = parseDbPath(dbPathResult.stdout)

    const prompt = [
      `You are running a live Agent Teams ledger smoke test.`,
      `Use the file write/edit tool, not shell.`,
      `Create ${SMOKE_FILE} in the current workspace with exactly: export const liveSmoke = 1;`,
      `Then edit ${SMOKE_FILE} so the content is exactly: export const liveSmoke = 2;`,
      `Do not create any other files.`,
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
})
