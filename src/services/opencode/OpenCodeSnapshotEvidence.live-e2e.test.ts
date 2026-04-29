import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { buildManagedConfig } from './OpenCodeProfileManager.js'
import { OpenCodeSnapshotGitStoreReader } from './OpenCodeSnapshotGitStoreReader.js'

import type { OpenCodeSessionRecord } from './types.js'

const liveSnapshotTest =
  process.env.OPENCODE_LEDGER_LIVE_E2E === '1' &&
  process.env.OPENCODE_LEDGER_SNAPSHOT_PROBE === '1'
    ? test
    : test.skip

const LIVE_MODEL = process.env.OPENCODE_LEDGER_LIVE_MODEL ?? 'opencode/big-pickle'
const SNAPSHOT_FILE = 'opencode-snapshot-probe.ts'
const REQUIRE_LIVE_AUTH = process.env.OPENCODE_LEDGER_LIVE_E2E_REQUIRE_AUTH === '1'

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-snapshot-evidence-live-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function childEnv(): NodeJS.ProcessEnv {
  const home = path.join(tempDir, 'home')
  const managedConfig = buildManagedConfig(null, { defaultModelId: LIVE_MODEL })
  managedConfig.snapshot = true
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(tempDir, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config'),
    XDG_CACHE_HOME: path.join(tempDir, 'xdg-cache'),
    XDG_STATE_HOME: path.join(tempDir, 'xdg-state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
  }
}

function runOpenCode(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 180_000) {
  return spawnSync('opencode', args, {
    cwd,
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

function parseSnapshotHash(stdout: string): string | null {
  const candidate = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0 && line !== 'undefined' && !line.toLowerCase().includes('error'))
  return candidate ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

async function findFirstFile(root: string, fileName: string, maxEntries = 5000): Promise<string | null> {
  let visited = 0
  const stack = [root]
  while (stack.length > 0 && visited < maxEntries) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      visited += 1
      const nextPath = path.join(current, entry.name)
      if (entry.isFile() && entry.name === fileName) {
        return nextPath
      }
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.Trash')) {
        stack.push(nextPath)
      }
      if (visited >= maxEntries) {
        break
      }
    }
  }
  return null
}

class LiveOfflineSessionReader extends OpenCodeOfflineSessionReader {
  constructor(private readonly dbPath: string) {
    super()
  }

  override resolveDbPath(): string {
    return this.dbPath
  }
}

function buildLiveSessionRecord(input: {
  sessionId: string
  workspaceRoot: string
}): OpenCodeSessionRecord {
  return {
    teamId: 'live-snapshot-probe',
    laneId: 'primary',
    memberName: 'opencode-live',
    providerId: 'opencode',
    selectedModel: LIVE_MODEL,
    projectPath: input.workspaceRoot,
    profileRootKey: 'live-profile',
    hostKey: 'live-host',
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

function failOrWarn(message: string): void {
  if (REQUIRE_LIVE_AUTH) {
    throw new Error(message)
  }
  console.warn(message)
}

describe('OpenCode snapshot evidence live probe', () => {
  liveSnapshotTest('captures source-driven SQLite snapshot evidence after a real file-changing OpenCode run', async () => {
    const env = childEnv()
    const workspaceRootRaw = path.join(tempDir, 'workspace')
    await mkdir(workspaceRootRaw, { recursive: true })
    const workspaceRoot = await realpath(workspaceRootRaw)
    runGit(['init'], workspaceRoot)
    runGit(['config', 'user.email', 'opencode-snapshot-probe@example.local'], workspaceRoot)
    runGit(['config', 'user.name', 'OpenCode Snapshot Probe'], workspaceRoot)
    await writeFile(path.join(workspaceRoot, 'README.md'), 'snapshot probe\n', 'utf8')
    runGit(['add', 'README.md'], workspaceRoot)
    runGit(['commit', '-m', 'seed snapshot probe workspace'], workspaceRoot)

    const version = runOpenCode(['--version'], env, workspaceRoot, 15_000)
    if (version.status !== 0) {
      failOrWarn(`OpenCode binary unavailable for live snapshot probe.\nstdout:\n${version.stdout}\nstderr:\n${version.stderr}`)
      return
    }

    const help = runOpenCode(['debug', 'snapshot', '--help'], env, workspaceRoot, 15_000)
    expect(help.status, `stdout:\n${help.stdout}\nstderr:\n${help.stderr}`).toBe(0)
    expect(`${help.stdout}\n${help.stderr}`).toContain('track')

    const preTrack = runOpenCode(['debug', 'snapshot', 'track'], env, workspaceRoot, 30_000)
    expect(preTrack.status, `stdout:\n${preTrack.stdout}\nstderr:\n${preTrack.stderr}`).toBe(0)
    const preHash = parseSnapshotHash(preTrack.stdout)
    expect(preHash, `stdout:\n${preTrack.stdout}\nstderr:\n${preTrack.stderr}`).toBeTruthy()

    const prompt = [
      'You are running a live OpenCode snapshot probe.',
      `Use file write/edit tools, not shell, to create ${SNAPSHOT_FILE}.`,
      `The final content must be exactly: export const snapshotProbe = 2;`,
      'Do not create any other files.',
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
    ], env, workspaceRoot)
    if (run.status !== 0) {
      const output = `${run.stdout}\n${run.stderr}`
      if (/401|token refresh failed/i.test(output) && !REQUIRE_LIVE_AUTH) {
        failOrWarn(`OpenCode live snapshot probe skipped because auth refresh failed.\n${output}`)
        return
      }
      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)
    }

    const postTrack = runOpenCode(['debug', 'snapshot', 'track'], env, workspaceRoot, 30_000)
    expect(postTrack.status, `stdout:\n${postTrack.stdout}\nstderr:\n${postTrack.stderr}`).toBe(0)
    const postHash = parseSnapshotHash(postTrack.stdout)
    expect(postHash, `stdout:\n${postTrack.stdout}\nstderr:\n${postTrack.stderr}`).toBeTruthy()

    const patch = runOpenCode(['debug', 'snapshot', 'patch', preHash!], env, workspaceRoot, 30_000)
    expect(patch.status, `stdout:\n${patch.stdout}\nstderr:\n${patch.stderr}`).toBe(0)
    expect(`${patch.stdout}\n${patch.stderr}`).toContain(SNAPSHOT_FILE)

    const diff = runOpenCode(['debug', 'snapshot', 'diff', preHash!], env, workspaceRoot, 30_000)
    expect(diff.status, `stdout:\n${diff.stdout}\nstderr:\n${diff.stderr}`).toBe(0)
    expect(`${diff.stdout}\n${diff.stderr}`).toContain(SNAPSHOT_FILE)

    const dbPath = await findFirstFile(tempDir, 'opencode.db')
    expect(dbPath, `No opencode.db found under ${tempDir}`).toBeTruthy()
    const db = new Database(dbPath!)
    let sessionRow: { id: string; project_id: string | null; directory: string | null } | null = null
    try {
      sessionRow = db.query(
        'select id, project_id, directory from session order by id desc limit 1',
      ).get() as { id: string; project_id: string | null; directory: string | null } | null
    } finally {
      db.close()
    }
    expect(sessionRow?.id, 'OpenCode live DB did not contain a session row').toBeTruthy()

    const offlineReader = new LiveOfflineSessionReader(dbPath!)
    const record = buildLiveSessionRecord({
      sessionId: sessionRow!.id,
      workspaceRoot,
    })
    const offline = await offlineReader.readSession(record)
    expect(offline?.sessionIdentity?.snapshotEvidenceSupported).toBe(true)
    expect(offline?.snapshotWindows.length ?? 0).toBeGreaterThan(0)

    const matchingToolpart = offline!.rawParts.find(row => {
      const parsed = safeParseJson(row.data)
      const state = asRecord(parsed?.state)
      const input = asRecord(state?.input)
      const filePath = typeof input?.filePath === 'string' ? input.filePath : undefined
      return parsed?.type === 'tool' && typeof filePath === 'string' && filePath.endsWith(SNAPSHOT_FILE)
    })
    expect(matchingToolpart?.id, `OpenCode live DB did not contain a write/edit toolpart for ${SNAPSHOT_FILE}`).toBeTruthy()

    const evidence = await new OpenCodeSnapshotGitStoreReader({
      offlineSessionReader: offlineReader,
    }).read({
      profileRootKey: record.profileRootKey,
      projectId: offline!.sessionIdentity!.projectId!,
      worktree: offline!.sessionIdentity!.project!.worktree!,
      directory: offline!.sessionIdentity!.directory!,
      fromSnapshot: offline!.snapshotWindows[0]!.fromSnapshot,
      toSnapshot: offline!.snapshotWindows[offline!.snapshotWindows.length - 1]!.toSnapshot,
      touchedRelativePaths: [SNAPSHOT_FILE],
      limits: {
        maxFiles: 20,
        maxBytesPerTextFile: 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
        timeoutMs: 3000,
      },
    })
    expect(evidence.supported ? evidence.files : evidence.diagnostics).toBeTruthy()
    expect(evidence.supported).toBe(true)
    if (!evidence.supported) {
      return
    }
    const snapshotFile = evidence.files.find(file => file.relativePath === SNAPSHOT_FILE)
    expect(snapshotFile?.operation).toBe('create')
    expect(snapshotFile?.afterContent).toContain('snapshotProbe')
  }, 240_000)
})
