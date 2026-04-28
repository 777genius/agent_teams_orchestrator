import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildManagedConfig } from './OpenCodeProfileManager.js'

const liveSnapshotTest =
  process.env.OPENCODE_LEDGER_LIVE_E2E === '1' &&
  process.env.OPENCODE_LEDGER_SNAPSHOT_PROBE === '1'
    ? test
    : test.skip

const LIVE_MODEL = process.env.OPENCODE_LEDGER_LIVE_MODEL ?? 'opencode/big-pickle'
const SNAPSHOT_FILE = 'opencode-snapshot-probe.ts'

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

function parseSnapshotHash(stdout: string): string | null {
  const candidate = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0 && line !== 'undefined' && !line.toLowerCase().includes('error'))
  return candidate ?? null
}

describe('OpenCode snapshot evidence live probe', () => {
  liveSnapshotTest('captures a usable debug snapshot hash after a real file-changing OpenCode run', async () => {
    const env = childEnv()
    const workspaceRoot = path.join(tempDir, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(path.join(workspaceRoot, 'README.md'), 'snapshot probe\n', 'utf8')

    const version = runOpenCode(['--version'], env, workspaceRoot, 15_000)
    expect(version.status, `stdout:\n${version.stdout}\nstderr:\n${version.stderr}`).toBe(0)

    const help = runOpenCode(['debug', 'snapshot', '--help'], env, workspaceRoot, 15_000)
    expect(help.status, `stdout:\n${help.stdout}\nstderr:\n${help.stderr}`).toBe(0)
    expect(`${help.stdout}\n${help.stderr}`).toContain('track')

    const preTrack = runOpenCode(['debug', 'snapshot', 'track'], env, workspaceRoot, 30_000)
    expect(preTrack.status, `stdout:\n${preTrack.stdout}\nstderr:\n${preTrack.stderr}`).toBe(0)

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
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const postTrack = runOpenCode(['debug', 'snapshot', 'track'], env, workspaceRoot, 30_000)
    expect(postTrack.status, `stdout:\n${postTrack.stdout}\nstderr:\n${postTrack.stderr}`).toBe(0)
    const postHash = parseSnapshotHash(postTrack.stdout)
    expect(postHash, `stdout:\n${postTrack.stdout}\nstderr:\n${postTrack.stderr}`).toBeTruthy()

    const patch = runOpenCode(['debug', 'snapshot', 'patch', postHash!], env, workspaceRoot, 30_000)
    expect(patch.status, `stdout:\n${patch.stdout}\nstderr:\n${patch.stderr}`).toBe(0)
    expect(`${patch.stdout}\n${patch.stderr}`).toContain(SNAPSHOT_FILE)

    const diff = runOpenCode(['debug', 'snapshot', 'diff', postHash!], env, workspaceRoot, 30_000)
    expect(diff.status, `stdout:\n${diff.stdout}\nstderr:\n${diff.stderr}`).toBe(0)
    expect(`${diff.stdout}\n${diff.stderr}`).toContain(SNAPSHOT_FILE)
  }, 240_000)
})
