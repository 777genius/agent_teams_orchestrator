import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { isProcessAlive, readProcessStartTimeMs } from '../../utils/processKill.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'

/**
 * Positive attribution for the process trees this runtime causes to exist.
 *
 * The runtime does not spawn cursor-agent: `opencode serve` does, from inside a
 * third-party plugin. What the runtime owns on every platform is the executable
 * that runs, so the spawned process records itself from the generated preload.
 * Inside that process `process.pid` is exact and `process.argv` is a real array,
 * which a joined command line can no longer be split back into.
 *
 * Identity needs two files joined by one id: the agent knows its own workspace
 * but not the team, and the host that spawns it is keyed by project and profile
 * scope only, with a multi-valued lease set for team/lane/run.
 */

export const PROCESS_ATTRIBUTION_DIRECTORY_ENV = 'AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR'
export const PROCESS_ATTRIBUTION_ID_ENV = 'AGENT_TEAMS_PROCESS_ATTRIBUTION_ID'
export const PROCESS_ATTRIBUTION_KIND_ENV = 'AGENT_TEAMS_PROCESS_ATTRIBUTION_KIND'
export const PROCESS_ATTRIBUTION_RUNTIME_VERSION_ENV =
  'AGENT_TEAMS_PROCESS_ATTRIBUTION_RUNTIME_VERSION'

const APP_INSTANCE_ID_ENV = 'CLAUDE_TEAM_APP_INSTANCE_ID'
const APP_PROFILE_SCOPE_ENV = 'CLAUDE_TEAM_APP_PROFILE_SCOPE'

export const PROCESS_ATTRIBUTION_SCHEMA_VERSION = 1
// The writer reads its own bootstrap clock; every reader reads an OS start time
// that is floored to whole seconds on POSIX. Comparisons need that much slack.
export const PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS = 2_000
/**
 * A record must not be able to widen its own pid-reuse fence: a reader that
 * compares `max(record.startTimeToleranceMs, 2000)` would accept any process
 * started within the recorded window, so the parsed value is clamped here and
 * the constant is exported for every reader to mirror.
 */
export const PROCESS_ATTRIBUTION_MAX_START_TIME_TOLERANCE_MS = 10_000
export const PROCESS_ATTRIBUTION_MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PROCESS_ATTRIBUTION_ID_PATTERN = /^[0-9a-f]{32}$/

export type CursorAgentAttributionKind = 'cursor-agent' | 'readiness-probe'

export type CursorAgentAttributionRecord = {
  schemaVersion: typeof PROCESS_ATTRIBUTION_SCHEMA_VERSION
  kind: CursorAgentAttributionKind
  attributionId: string
  pid: number
  parentPid: number | null
  /** Unix epoch milliseconds, UTC, produced by the recorded process itself. */
  startedAtMs: number
  startTimeToleranceMs: number
  /** Linux only, in the shape a /proc walk can compare without a clock. */
  nativeStartToken: string | null
  /** The exact `--workspace` argv element, never a re-parsed command line. */
  workspacePath: string | null
  cwd: string | null
  appInstanceId: string | null
  appProfileScope: string | null
  runtimeVersion: string | null
  writtenAtMs: number
  exitedAtMs: number | null
}

export type OpenCodeHostAttributionOwner = {
  teamId: string
  laneId: string
  memberName: string
  runId: string | null
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

export type OpenCodeHostStartTimeFormat = 'linux-ticks' | 'epoch-ms' | 'unknown'

export type OpenCodeHostAttributionRecord = {
  schemaVersion: typeof PROCESS_ATTRIBUTION_SCHEMA_VERSION
  attributionId: string
  hostPid: number
  /**
   * Opaque to every reader but this platform: Linux reports clock ticks since
   * boot, Windows and macOS report epoch milliseconds. The format is named so a
   * reader can refuse instead of guessing.
   */
  hostStartedAtNative: number | null
  hostStartTimeFormat: OpenCodeHostStartTimeFormat
  projectPath: string
  appInstanceId: string | null
  appProfileScope: string | null
  runtimeVersion: string | null
  owners: OpenCodeHostAttributionOwner[]
  updatedAt: string
}

export type LoadedAttributionRecord<TRecord> = {
  filePath: string
  record: TRecord
}

export type AttributionRecords = {
  hosts: Array<LoadedAttributionRecord<OpenCodeHostAttributionRecord>>
  agents: Array<LoadedAttributionRecord<CursorAgentAttributionRecord>>
  /** Unparseable or structurally invalid files, safe to unlink. */
  corruptPaths: string[]
}

export function resolveProcessAttributionDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env[PROCESS_ATTRIBUTION_DIRECTORY_ENV]?.trim()
  if (configured && path.isAbsolute(configured)) {
    return path.normalize(configured)
  }
  return path.join(resolveClaudeMultimodelPaths(env).data, 'opencode', 'process-attribution')
}

export function mintProcessAttributionId(): string {
  return randomBytes(16).toString('hex')
}

export function isProcessAttributionId(value: unknown): value is string {
  return typeof value === 'string' && PROCESS_ATTRIBUTION_ID_PATTERN.test(value)
}

export function resolveHostStartTimeFormat(
  platform: NodeJS.Platform = process.platform,
): OpenCodeHostStartTimeFormat {
  if (platform === 'linux') return 'linux-ticks'
  if (platform === 'win32' || platform === 'darwin') return 'epoch-ms'
  return 'unknown'
}

export function processAttributionHostRecordPath(
  directory: string,
  attributionId: string,
): string {
  return path.join(directory, 'v1', 'hosts', `${attributionId}.json`)
}

export function processAttributionAgentDirectoryPath(
  directory: string,
  attributionId: string,
): string {
  return path.join(directory, 'v1', 'agents', attributionId)
}

/**
 * The environment a spawned tree needs to record itself. The directory is
 * resolved by the runtime, never by the preload: only the runtime knows the
 * fallback location when the desktop app designates none.
 */
export function buildProcessAttributionSpawnEnv(input: {
  directory: string | null
  attributionId: string
  kind?: CursorAgentAttributionKind
}): NodeJS.ProcessEnv {
  if (!input.directory || !isProcessAttributionId(input.attributionId)) {
    return {}
  }
  const runtimeVersion = resolveRuntimeVersion()
  return {
    [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: input.directory,
    [PROCESS_ATTRIBUTION_ID_ENV]: input.attributionId,
    [PROCESS_ATTRIBUTION_KIND_ENV]: input.kind ?? 'cursor-agent',
    ...(runtimeVersion ? { [PROCESS_ATTRIBUTION_RUNTIME_VERSION_ENV]: runtimeVersion } : {}),
  }
}

function resolveRuntimeVersion(): string | null {
  // The runtime's package version, which the build script inlines; MACRO.VERSION
  // is the Claude Code compatibility version and would name the wrong thing.
  // The bundler substitutes the member expression, not the bare identifier, so a
  // `typeof MACRO` guard is false in the bundle and true nowhere: reading the
  // member directly is the only form that carries the value.
  try {
    return MACRO.RUNTIME_VERSION || null
  } catch {
    // Unbundled source (tests, `bun run dev`) has no MACRO at all.
    return null
  }
}

export async function writeHostAttributionRecord(input: {
  directory: string
  attributionId: string
  hostPid: number
  hostStartedAtNative?: number | null
  projectPath: string
  owners: readonly OpenCodeHostAttributionOwner[]
  now?: () => Date
}): Promise<void> {
  if (!isProcessAttributionId(input.attributionId) || !Number.isSafeInteger(input.hostPid)) {
    return
  }
  const env = process.env
  const record: OpenCodeHostAttributionRecord = {
    schemaVersion: PROCESS_ATTRIBUTION_SCHEMA_VERSION,
    attributionId: input.attributionId,
    hostPid: input.hostPid,
    hostStartedAtNative: Number.isFinite(input.hostStartedAtNative)
      ? (input.hostStartedAtNative as number)
      : null,
    hostStartTimeFormat: resolveHostStartTimeFormat(),
    projectPath: input.projectPath,
    appInstanceId: env[APP_INSTANCE_ID_ENV]?.trim() || null,
    appProfileScope: env[APP_PROFILE_SCOPE_ENV]?.trim() || null,
    runtimeVersion: resolveRuntimeVersion(),
    owners: input.owners.map(owner => ({ ...owner })),
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
  }
  await writeFileAtomic(
    processAttributionHostRecordPath(input.directory, input.attributionId),
    JSON.stringify(record),
    { mode: 0o600 },
  )
}

/** Remove a host record and every agent record filed under the same id. */
export async function deleteHostAttributionRecords(
  directory: string,
  attributionId: string,
): Promise<void> {
  if (!isProcessAttributionId(attributionId)) {
    return
  }
  await unlink(processAttributionHostRecordPath(directory, attributionId)).catch(() => undefined)
  await rm(processAttributionAgentDirectoryPath(directory, attributionId), {
    recursive: true,
    force: true,
  }).catch(() => undefined)
}

function asRecordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asOptionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

type ParseOutcome<TRecord> =
  | { state: 'ok'; record: TRecord }
  | { state: 'corrupt' }
  | { state: 'unsupported' }

function parseSchemaVersion(source: Record<string, unknown> | null): 'ok' | 'corrupt' | 'unsupported' {
  if (!source) return 'corrupt'
  const schemaVersion = source.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) return 'corrupt'
  return schemaVersion === PROCESS_ATTRIBUTION_SCHEMA_VERSION ? 'ok' : 'unsupported'
}

/**
 * The tolerance is a fence against pid reuse, and the file it comes from is
 * written by a process this build does not control. A value it could choose
 * freely would let the record widen its own fence, so an absent or invalid one
 * falls back to the default and every other one is capped.
 */
function clampStartTimeToleranceMs(value: unknown): number {
  const tolerance = asOptionalFiniteNumber(value)
  if (tolerance === null || tolerance < 0) {
    return PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS
  }
  return Math.min(tolerance, PROCESS_ATTRIBUTION_MAX_START_TIME_TOLERANCE_MS)
}

function parseAgentAttributionRecord(
  value: unknown,
): ParseOutcome<CursorAgentAttributionRecord> {
  const source = asRecordObject(value)
  const version = parseSchemaVersion(source)
  if (version !== 'ok' || !source) {
    return { state: version === 'unsupported' ? 'unsupported' : 'corrupt' }
  }
  const kind = source.kind
  const pid = source.pid
  const startedAtMs = source.startedAtMs
  const writtenAtMs = source.writtenAtMs
  if (
    !isProcessAttributionId(source.attributionId) ||
    (kind !== 'cursor-agent' && kind !== 'readiness-probe') ||
    typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 ||
    typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs <= 0 ||
    typeof writtenAtMs !== 'number' || !Number.isFinite(writtenAtMs)
  ) {
    return { state: 'corrupt' }
  }
  return {
    state: 'ok',
    record: {
      schemaVersion: PROCESS_ATTRIBUTION_SCHEMA_VERSION,
      kind,
      attributionId: source.attributionId,
      pid,
      parentPid: asOptionalFiniteNumber(source.parentPid),
      startedAtMs,
      startTimeToleranceMs: clampStartTimeToleranceMs(source.startTimeToleranceMs),
      nativeStartToken: asOptionalString(source.nativeStartToken),
      workspacePath: asOptionalString(source.workspacePath),
      cwd: asOptionalString(source.cwd),
      appInstanceId: asOptionalString(source.appInstanceId),
      appProfileScope: asOptionalString(source.appProfileScope),
      runtimeVersion: asOptionalString(source.runtimeVersion),
      writtenAtMs,
      exitedAtMs: asOptionalFiniteNumber(source.exitedAtMs),
    },
  }
}

function parseHostAttributionOwners(value: unknown): OpenCodeHostAttributionOwner[] {
  if (!Array.isArray(value)) return []
  const owners: OpenCodeHostAttributionOwner[] = []
  for (const entry of value) {
    const owner = asRecordObject(entry)
    if (
      !owner ||
      typeof owner.teamId !== 'string' ||
      typeof owner.laneId !== 'string' ||
      typeof owner.memberName !== 'string' ||
      typeof owner.createdAt !== 'string' ||
      typeof owner.updatedAt !== 'string'
    ) {
      continue
    }
    owners.push({
      teamId: owner.teamId,
      laneId: owner.laneId,
      memberName: owner.memberName,
      runId: asOptionalString(owner.runId),
      sessionId: asOptionalString(owner.sessionId),
      createdAt: owner.createdAt,
      updatedAt: owner.updatedAt,
    })
  }
  return owners
}

function parseHostAttributionRecord(value: unknown): ParseOutcome<OpenCodeHostAttributionRecord> {
  const source = asRecordObject(value)
  const version = parseSchemaVersion(source)
  if (version !== 'ok' || !source) {
    return { state: version === 'unsupported' ? 'unsupported' : 'corrupt' }
  }
  const hostPid = source.hostPid
  const format = source.hostStartTimeFormat
  if (
    !isProcessAttributionId(source.attributionId) ||
    typeof hostPid !== 'number' || !Number.isSafeInteger(hostPid) || hostPid <= 0 ||
    typeof source.projectPath !== 'string' ||
    (format !== 'linux-ticks' && format !== 'epoch-ms' && format !== 'unknown') ||
    typeof source.updatedAt !== 'string'
  ) {
    return { state: 'corrupt' }
  }
  return {
    state: 'ok',
    record: {
      schemaVersion: PROCESS_ATTRIBUTION_SCHEMA_VERSION,
      attributionId: source.attributionId,
      hostPid,
      hostStartedAtNative: asOptionalFiniteNumber(source.hostStartedAtNative),
      hostStartTimeFormat: format,
      projectPath: source.projectPath,
      appInstanceId: asOptionalString(source.appInstanceId),
      appProfileScope: asOptionalString(source.appProfileScope),
      runtimeVersion: asOptionalString(source.runtimeVersion),
      owners: parseHostAttributionOwners(source.owners),
      updatedAt: source.updatedAt,
    },
  }
}

async function listJsonFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(directoryPath, entry.name))
}

async function loadRecordFile<TRecord>(
  filePath: string,
  parse: (value: unknown) => ParseOutcome<TRecord>,
): Promise<ParseOutcome<TRecord>> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    // A record that vanished between listing and reading is not evidence.
    return { state: 'unsupported' }
  }
  try {
    return parse(JSON.parse(raw))
  } catch {
    return { state: 'corrupt' }
  }
}

/**
 * Read every record under a directory. Never throws: a missing, unreadable or
 * partially written store must degrade to "no evidence", never to an error that
 * a caller could mistake for proof.
 */
export async function readAttributionRecords(directory: string): Promise<AttributionRecords> {
  const result: AttributionRecords = { hosts: [], agents: [], corruptPaths: [] }

  for (const filePath of await listJsonFiles(path.join(directory, 'v1', 'hosts'))) {
    const outcome = await loadRecordFile(filePath, parseHostAttributionRecord)
    if (outcome.state === 'corrupt') {
      result.corruptPaths.push(filePath)
      continue
    }
    if (outcome.state !== 'ok') continue
    result.hosts.push({ filePath, record: outcome.record })
  }

  const agentsRoot = path.join(directory, 'v1', 'agents')
  const agentDirectories = await readdir(agentsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of agentDirectories) {
    if (!entry.isDirectory() || !isProcessAttributionId(entry.name)) continue
    for (const filePath of await listJsonFiles(path.join(agentsRoot, entry.name))) {
      const outcome = await loadRecordFile(filePath, parseAgentAttributionRecord)
      if (outcome.state === 'corrupt') {
        result.corruptPaths.push(filePath)
        continue
      }
      if (outcome.state !== 'ok') continue
      if (outcome.record.attributionId !== entry.name) {
        result.corruptPaths.push(filePath)
        continue
      }
      result.agents.push({ filePath, record: outcome.record })
    }
  }

  return result
}

export type PruneAttributionRecordsResult = {
  prunedHosts: number
  prunedAgents: number
  prunedCorrupt: number
}

type ProcessLiveness = 'alive' | 'dead' | 'unknown'

/**
 * A record is identity, never liveness: it survives a crash or a SIGKILL. The
 * runtime therefore reaps its own store, and every reader has to validate what
 * it finds. An unknown schema version is left alone - it belongs to a writer
 * this build does not understand.
 *
 * Every record is judged by its own process. A dead host does not condemn the
 * agents filed under it: a host that died leaving live cursor-agent trees is
 * precisely the orphan the desktop sweep exists to find, and deleting its proof
 * would blind that sweep. The age horizon is a backstop for records whose
 * process cannot be judged at all, never a reason to delete evidence about a
 * process that is still running.
 */
export async function pruneStaleAttributionRecords(
  directory: string,
  options: {
    now?: () => number
    isProcessAlive?: (pid: number) => boolean
    readProcessStartTimeMs?: (pid: number) => Promise<number | null>
    maxRecordAgeMs?: number
  } = {},
): Promise<PruneAttributionRecordsResult> {
  const nowMs = (options.now ?? Date.now)()
  const alive = options.isProcessAlive ?? isProcessAlive
  const readStartTime =
    options.readProcessStartTimeMs ?? ((pid: number) => readProcessStartTimeMs(pid))
  const maxAgeMs = options.maxRecordAgeMs ?? PROCESS_ATTRIBUTION_MAX_RECORD_AGE_MS
  const records = await readAttributionRecords(directory)
  const result: PruneAttributionRecordsResult = {
    prunedHosts: 0,
    prunedAgents: 0,
    prunedCorrupt: 0,
  }

  const probeLiveness = (pid: number): ProcessLiveness => {
    try {
      return alive(pid) ? 'alive' : 'dead'
    } catch {
      return 'unknown'
    }
  }
  const expiredAt = (writtenAtMs: number): boolean =>
    !Number.isFinite(writtenAtMs) || nowMs - writtenAtMs > maxAgeMs

  for (const corruptPath of records.corruptPaths) {
    await unlink(corruptPath).catch(() => undefined)
    result.prunedCorrupt += 1
  }

  for (const host of records.hosts) {
    const liveness = probeLiveness(host.record.hostPid)
    let stale = liveness === 'dead'
      || (liveness === 'unknown' && expiredAt(Date.parse(host.record.updatedAt)))
    if (
      !stale &&
      liveness === 'alive' &&
      host.record.hostStartedAtNative !== null &&
      host.record.hostStartTimeFormat === resolveHostStartTimeFormat()
    ) {
      const startedAtNative = await readStartTime(host.record.hostPid).catch(() => null)
      // An unreadable start time is not proof of reuse; only a differing one is.
      stale = startedAtNative !== null && startedAtNative !== host.record.hostStartedAtNative
    }
    if (!stale) continue
    // Only this host's own file. The agent records under the same id belong to
    // processes with their own pids, judged on their own below.
    await unlink(host.filePath).catch(() => undefined)
    result.prunedHosts += 1
  }

  for (const agent of records.agents) {
    const liveness = probeLiveness(agent.record.pid)
    if (liveness === 'alive') continue
    if (liveness === 'unknown' && !expiredAt(agent.record.writtenAtMs)) continue
    await unlink(agent.filePath).catch(() => undefined)
    result.prunedAgents += 1
  }

  await removeEmptyAgentDirectories(directory)

  return result
}

/**
 * Every readiness probe mints an id of its own and never writes a host record,
 * so without this the store grows one empty directory per probe forever.
 */
async function removeEmptyAgentDirectories(directory: string): Promise<void> {
  const agentsRoot = path.join(directory, 'v1', 'agents')
  const entries = await readdir(agentsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // ENOTEMPTY (a record still filed here) and ENOENT (already gone) are both
    // the expected outcome, not a failure.
    await rmdir(path.join(agentsRoot, entry.name)).catch(() => undefined)
  }
}

/**
 * CommonJS preload source for the generated cursor-agent shim. It runs inside
 * the real agent process before its entry module is loaded, so the record is in
 * place before the child can do any work.
 *
 * It must never throw into the host process: a preload failure would take the
 * agent down with it, and no record is a smaller loss than no agent.
 */
export function buildCursorAgentAttributionPreloadScript(): string {
  return [
    ';(function agentTeamsProcessAttribution() {',
    '  try {',
    `    const directory = process.env[${JSON.stringify(PROCESS_ATTRIBUTION_DIRECTORY_ENV)}]`,
    `    const attributionId = process.env[${JSON.stringify(PROCESS_ATTRIBUTION_ID_ENV)}]`,
    '    if (!directory || !attributionId) return',
    `    if (!${PROCESS_ATTRIBUTION_ID_PATTERN.toString()}.test(attributionId)) return`,
    "    const fs = require('node:fs')",
    "    const nodePath = require('node:path')",
    '    if (!nodePath.isAbsolute(directory)) return',
    `    const kind = process.env[${JSON.stringify(PROCESS_ATTRIBUTION_KIND_ENV)}] === 'readiness-probe'`,
    "      ? 'readiness-probe' : 'cursor-agent'",
    '    const argv = process.argv.slice(2)',
    '    let workspacePath = null',
    '    for (let index = 0; index < argv.length; index += 1) {',
    // Both spawners pass the value as its own argv element: the plugin
    // (@rama_nigg/open-cursor src/plugin.ts, scripts/cursor-agent-runner.mjs)
    // and the readiness probe. A second accepted spelling would only widen
    // what is allowed to claim to be the agent, with no caller behind it.
    "      if (argv[index] === '--workspace') {",
    '        workspacePath = index + 1 < argv.length ? argv[index + 1] : null',
    '        break',
    '      }',
    '    }',
    '    // cursor-agent can be a native or .cmd wrapper rather than the node',
    '    // process this preload loads into, and every node descendant of such a',
    '    // wrapper inherits NODE_OPTIONS and this environment. Only the process',
    '    // that carries the agent invocation may claim to be the agent; the',
    '    // plugin and the readiness probe both always pass --workspace.',
    '    if (workspacePath === null) return',
    '    const startedAtMs = Math.floor(Date.now() - process.uptime() * 1000)',
    '    let nativeStartToken = null',
    "    if (process.platform === 'linux') {",
    '      try {',
    "        const stat = fs.readFileSync('/proc/self/stat', 'utf8')",
    "        const close = stat.lastIndexOf(')')",
    '        const ticks = close < 0',
    '          ? NaN',
    '          : Number(stat.slice(close + 1).trim().split(/\\s+/)[19])',
    '        if (Number.isSafeInteger(ticks) && ticks >= 0) {',
    "          nativeStartToken = 'proc:' + ticks",
    '        }',
    '      } catch (error) { /* identity is optional evidence */ }',
    '    }',
    '    const record = {',
    `      schemaVersion: ${PROCESS_ATTRIBUTION_SCHEMA_VERSION},`,
    '      kind: kind,',
    '      attributionId: attributionId,',
    '      pid: process.pid,',
    "      parentPid: typeof process.ppid === 'number' ? process.ppid : null,",
    '      startedAtMs: startedAtMs,',
    `      startTimeToleranceMs: ${PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS},`,
    '      nativeStartToken: nativeStartToken,',
    '      workspacePath: workspacePath,',
    '      cwd: process.cwd(),',
    `      appInstanceId: process.env[${JSON.stringify(APP_INSTANCE_ID_ENV)}] || null,`,
    `      appProfileScope: process.env[${JSON.stringify(APP_PROFILE_SCOPE_ENV)}] || null,`,
    `      runtimeVersion: process.env[${JSON.stringify(PROCESS_ATTRIBUTION_RUNTIME_VERSION_ENV)}] || null,`,
    '      writtenAtMs: Date.now(),',
    '      exitedAtMs: null,',
    '    }',
    "    const recordDirectory = nodePath.join(directory, 'v1', 'agents', attributionId)",
    "    const recordPath = nodePath.join(recordDirectory, process.pid + '-' + startedAtMs + '.json')",
    "    const temporaryPath = recordPath + '.tmp'",
    '    fs.mkdirSync(recordDirectory, { recursive: true })',
    "    fs.writeFileSync(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })",
    '    fs.renameSync(temporaryPath, recordPath)',
    '    // This process is the agent, so nothing it spawns is. Clearing the',
    '    // environment stops a descendant from filing a second record under the',
    '    // same id, the way the classification block clears NODE_OPTIONS.',
    `    delete process.env[${JSON.stringify(PROCESS_ATTRIBUTION_DIRECTORY_ENV)}]`,
    `    delete process.env[${JSON.stringify(PROCESS_ATTRIBUTION_ID_ENV)}]`,
    `    delete process.env[${JSON.stringify(PROCESS_ATTRIBUTION_KIND_ENV)}]`,
    "    process.on('exit', function agentTeamsProcessAttributionExit() {",
    '      try {',
    '        fs.unlinkSync(recordPath)',
    '      } catch (error) {',
    "        if (error && error.code === 'ENOENT') return",
    '        try {',
    '          record.exitedAtMs = Date.now()',
    "          fs.writeFileSync(recordPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })",
    '        } catch (writeError) { /* the reader validates liveness anyway */ }',
    '      }',
    '    })',
    '  } catch (error) {',
    '    // Attribution is evidence, never a precondition for running the agent.',
    '  }',
    '})()',
    '',
  ].join('\n')
}
