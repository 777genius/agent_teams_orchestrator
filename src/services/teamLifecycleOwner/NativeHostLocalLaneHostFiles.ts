import { constants } from 'node:fs'
import { access, lstat, mkdir, open, realpath, rm, stat, truncate } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import * as lockfile from '../../utils/lockfile.js'
import { normalizePathForConfigKey } from '../../utils/path.js'
import { fsyncFileAndParent } from '../hostedControl/HostedTaskMutationWal.js'
import { NativeHostLocalLaneError } from './NativeHostLocalLanePlan.js'

const RECORD_MAX_BYTES = 16 * 1024
const TOKEN_MAX_BYTES = 16 * 1024
const BOOTSTRAP_STATE_MAX_BYTES = 256 * 1024
const CLAUDE_GLOBAL_CONFIG_MAX_BYTES = 16 * 1024 * 1024
const CONFIG_LOCK_OPTIONS = {
  realpath: false,
  retries: { retries: 50, minTimeout: 10, maxTimeout: 200 },
} as const

/** Private lead identity; ownerToken names the hosted-control incarnation that owns stdin. */
export type NativeLaneRuntimeRecord = Readonly<{
  schemaVersion: 1
  runId: string
  laneId: string
  ownerToken: string
  runtimeDir: string
  specPath: string
  launchedAtMs: number
  deadlineAtMs: number
  pid: number | null
  startedAt: number | null
  osIdentity: string | null
}>

/** Reads a regular file owned by this uid with no group/other permission bits. */
async function readOwnerPrivateFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)])
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino ||
      (opened.mode & 0o077) !== 0 || opened.size > maxBytes ||
      (process.getuid?.() !== undefined && opened.uid !== process.getuid())) {
      throw new Error('Unsafe native lane private file')
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) throw new Error('Unsafe native lane private file')
    return bytes
  } finally {
    await handle.close()
  }
}

export async function readNativeLaneRecord(path: string): Promise<NativeLaneRuntimeRecord | null> {
  const bytes = await readOwnerPrivateFile(path, RECORD_MAX_BYTES)
  return bytes ? decodeRecord(JSON.parse(bytes.toString('utf8'))) : null
}

export async function writeNativeLaneRecord(path: string, record: NativeLaneRuntimeRecord): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(decodeRecord(record))}\n`, { mode: 0o600 })
  await fsyncFileAndParent(path)
}

export async function removeNativeLaneRecord(path: string): Promise<void> {
  await rm(path, { force: true })
}

function decodeRecord(value: unknown): NativeLaneRuntimeRecord {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const keys = ['schemaVersion', 'runId', 'laneId', 'ownerToken', 'runtimeDir', 'specPath',
    'launchedAtMs', 'deadlineAtMs', 'pid', 'startedAt', 'osIdentity']
  const positive = (field: unknown) => Number.isSafeInteger(field) && (field as number) > 0
  if (!record || Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key)) ||
    record.schemaVersion !== 1 ||
    typeof record.runId !== 'string' || !/^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(record.runId) ||
    typeof record.laneId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.laneId) ||
    typeof record.ownerToken !== 'string' || !/^[0-9a-f]{32}$/.test(record.ownerToken) ||
    typeof record.runtimeDir !== 'string' || !isAbsolute(record.runtimeDir) ||
    typeof record.specPath !== 'string' || !record.specPath.startsWith(`${record.runtimeDir}${sep}`) ||
    !positive(record.launchedAtMs) || !positive(record.deadlineAtMs) ||
    !(record.pid === null || positive(record.pid)) ||
    !(record.startedAt === null || Number.isSafeInteger(record.startedAt)) ||
    !(record.osIdentity === null || typeof record.osIdentity === 'string' && record.osIdentity.length <= 256)) {
    throw new Error('Invalid native lane runtime record')
  }
  return record as NativeLaneRuntimeRecord
}

/**
 * Host-private root for lead launch material (spec, prompt, MCP config, logs).
 * CLAUDE_DIR is shared with the Product container, so anything the lead
 * executes from must live outside it. The per-uid directory must already be
 * private to this uid; a pre-created foreign or symlinked one fails closed.
 */
export async function ensureNativeLanePrivateRoot(parent: string): Promise<string> {
  const uid = process.getuid?.()
  const root = join(await realpath(parent), `agent-teams-native-lane-${uid ?? 'user'}`)
  await mkdir(root, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const current = await lstat(root)
  if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o077) !== 0 ||
    (uid !== undefined && current.uid !== uid)) {
    throw new Error('Unsafe native lane private runtime root')
  }
  return root
}

export async function writeNativeLanePrivateFile(path: string, content: string): Promise<void> {
  await writeFileAtomic(path, content, { mode: 0o600 })
}

/**
 * Claude subscription token for the lead env only. It must live outside the
 * Claude root, which is shared with the internet-facing Product container.
 */
export async function readClaudeOAuthToken(tokenFile: string, claudeRoot: string): Promise<string> {
  const fail = (): never => {
    throw new NativeHostLocalLaneError('native_lane_credentials_unavailable', 'Claude OAuth token file is unavailable')
  }
  if (!isAbsolute(tokenFile) || tokenFile.includes('\0')) fail()
  const [canonicalToken, canonicalRoot] = await Promise.all([
    realpath(tokenFile).catch(fail),
    realpath(claudeRoot).catch(fail),
  ])
  const fromRoot = relative(canonicalRoot, canonicalToken)
  const outsideRoot = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
  if (!outsideRoot) fail()
  const bytes = await readOwnerPrivateFile(tokenFile, TOKEN_MAX_BYTES).catch(fail)
  const token = bytes?.toString('utf8').trim() ?? ''
  if (!/^[\x21-\x7e]{16,8192}$/.test(token)) fail()
  return token
}

/** The Codex binary and home are pinned by trusted configuration, never looked up in PATH. */
export async function verifyCodexConfiguration(input: { codexHome: string; codexCliPath: string }): Promise<void> {
  const fail = (): never => {
    throw new NativeHostLocalLaneError('native_lane_credentials_unavailable', 'Codex home or binary is unavailable')
  }
  if (!isAbsolute(input.codexHome) || !isAbsolute(input.codexCliPath)) fail()
  const [home, binary] = await Promise.all([stat(input.codexHome).catch(fail), stat(input.codexCliPath).catch(fail)])
  if (!home.isDirectory() || !binary.isFile()) fail()
  await access(input.codexCliPath, constants.X_OK).catch(fail)
}

/**
 * Headless Claude teammates refuse to start in an untrusted workspace. The
 * registered hosted workspace is trusted by admission, so the lane records it
 * with the same lock protocol Claude uses for its global config.
 */
export async function ensureClaudeWorkspaceTrust(claudeRoot: string, workspaceRoot: string): Promise<void> {
  const legacy = join(claudeRoot, '.config.json')
  const configPath = await lstat(legacy).then(() => legacy, () => join(claudeRoot, '.claude.json'))
  const key = normalizePathForConfigKey(workspaceRoot)
  const release = await lockfile.lock(configPath, { ...CONFIG_LOCK_OPTIONS, lockfilePath: `${configPath}.lock` })
  try {
    const bytes = await readBoundedFile(configPath, CLAUDE_GLOBAL_CONFIG_MAX_BYTES)
    const config = bytes ? JSON.parse(bytes) as Record<string, unknown> : {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Claude global config')
    const projects = config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? config.projects as Record<string, Record<string, unknown>>
      : {}
    if (projects[key]?.hasTrustDialogAccepted === true) return
    const next = {
      ...config,
      projects: { ...projects, [key]: { ...(projects[key] ?? {}), hasTrustDialogAccepted: true } },
    }
    await writeFileAtomic(configPath, JSON.stringify(next, null, 2), { mode: 0o600 })
  } finally {
    await release()
  }
}

export type NativeBootstrapPhaseObservation = 'missing' | 'in_progress' | 'completed' | 'failed'

/** Reads the lead's deterministic bootstrap state and binds it to this run. */
export async function readNativeBootstrapPhase(
  teamRoot: string,
  runId: string,
): Promise<NativeBootstrapPhaseObservation> {
  let raw: string | null
  try {
    raw = await readBoundedFile(join(teamRoot, 'bootstrap-state.json'), BOOTSTRAP_STATE_MAX_BYTES)
  } catch {
    return 'missing'
  }
  if (!raw) return 'missing'
  let state: Record<string, unknown>
  try {
    state = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Atomic writes make a torn read unlikely; treat it as not yet observable.
    return 'missing'
  }
  if (!state || state.version !== 1 || state.runId !== runId) return 'missing'
  if (state.phase === 'completed') return 'completed'
  if (state.phase === 'failed' || state.phase === 'canceled') return 'failed'
  return 'in_progress'
}

/** Null only for a missing file; anything that is not a bounded regular file throws. */
async function readBoundedFile(path: string, maxBytes: number): Promise<string | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maxBytes) throw new Error('Unsafe native lane input file')
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Keeps an O_APPEND log bounded. The lead writes with O_APPEND, so after an
 * in-place truncate its next write lands at the new end instead of leaving a
 * sparse file. Old output is dropped, never rotated into CLAUDE_DIR.
 */
export async function enforceNativeLaneLogLimit(path: string, maxBytes: number): Promise<void> {
  const current = await lstat(path).catch(() => null)
  if (current?.isFile() && current.size > maxBytes) await truncate(path, 0).catch(() => undefined)
}
