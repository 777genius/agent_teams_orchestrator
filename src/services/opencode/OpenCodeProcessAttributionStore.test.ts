import { runInNewContext } from 'node:vm'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, test } from 'bun:test'

import { OpenCodeCursorNativeFailureProbe } from './OpenCodeCursorNativeFailureProbe.js'
import { buildCursorAgentResourceExhaustedPreloadScript } from './OpenCodeCursorResourceExhaustedPatch.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { buildCursorAgentPreloadRequireOption } from './OpenCodeProfileManager.js'
import {
  PROCESS_ATTRIBUTION_DIRECTORY_ENV,
  PROCESS_ATTRIBUTION_ID_ENV,
  PROCESS_ATTRIBUTION_KIND_ENV,
  PROCESS_ATTRIBUTION_MAX_RECORD_AGE_MS,
  PROCESS_ATTRIBUTION_MAX_RELEASED_OWNERS,
  PROCESS_ATTRIBUTION_MAX_START_TIME_TOLERANCE_MS,
  PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS,
  buildCursorAgentAttributionPreloadScript,
  buildProcessAttributionSpawnEnv,
  mintProcessAttributionId,
  processAttributionAgentDirectoryPath,
  processAttributionHostRecordPath,
  pruneStaleAttributionRecords,
  readAttributionRecords,
  resolveHostStartTimeFormat,
  resolveProcessAttributionDirectory,
  retireHostAttributionRecords,
  writeHostAttributionRecord,
} from './OpenCodeProcessAttributionStore.js'

import type { ChildProcess, SpawnOptions } from 'node:child_process'

const APP_INSTANCE_ID_ENV = 'CLAUDE_TEAM_APP_INSTANCE_ID'
const APP_PROFILE_SCOPE_ENV = 'CLAUDE_TEAM_APP_PROFILE_SCOPE'
/**
 * The preload clears the attribution environment once it has written, so a
 * fixture that wants to inspect the store needs a copy of the location under
 * names the preload does not touch.
 */
const FIXTURE_DIRECTORY_ENV = 'ATTRIBUTION_FIXTURE_DIR'
const FIXTURE_ID_ENV = 'ATTRIBUTION_FIXTURE_ID'

const tempDirs: string[] = []

/**
 * The host record reads the desktop identity from this process's environment,
 * so a test that wants a particular identity has to stand in for the app.
 */
async function withDesktopIdentityEnv<TResult>(
  values: Record<string, string>,
  run: () => Promise<TResult>,
): Promise<TResult> {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function createStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opencode-attribution-'))
  tempDirs.push(directory)
  return directory
}

async function writeAgentRecordFile(
  directory: string,
  attributionId: string,
  fileName: string,
  record: unknown,
): Promise<string> {
  const recordDirectory = processAttributionAgentDirectoryPath(directory, attributionId)
  await mkdir(recordDirectory, { recursive: true })
  const filePath = path.join(recordDirectory, fileName)
  await writeFile(
    filePath,
    typeof record === 'string' ? record : JSON.stringify(record),
    'utf8',
  )
  return filePath
}

function buildAgentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'cursor-agent',
    attributionId: 'a'.repeat(32),
    pid: 4321,
    parentPid: 4320,
    startedAtMs: 1_757_500_000_123,
    startTimeToleranceMs: PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS,
    nativeStartToken: null,
    workspacePath: 'D:\\work\\app - backup',
    cwd: 'D:\\work\\app - backup',
    appInstanceId: 'app-instance',
    appProfileScope: 'scope-a',
    runtimeVersion: '0.0.95',
    writtenAtMs: 1_757_500_000_180,
    exitedAtMs: null,
    ...overrides,
  }
}

async function exists(filePath: string): Promise<boolean> {
  return await access(filePath).then(() => true, () => false)
}

/** Read back one agent record file written with the given field overrides. */
async function readOneAgentRecord(overrides: Record<string, unknown>): Promise<{
  records: Array<Record<string, unknown>>
  corrupt: number
}> {
  const directory = await createStoreDirectory()
  const attributionId = mintProcessAttributionId()
  await writeAgentRecordFile(
    directory,
    attributionId,
    '1-1.json',
    buildAgentRecord({ attributionId, ...overrides }),
  )
  const loaded = await readAttributionRecords(directory)
  return {
    records: loaded.agents.map(agent => agent.record as unknown as Record<string, unknown>),
    corrupt: loaded.corruptPaths.length,
  }
}

const FIXTURE_REPORT_SOURCE = [
  "const fs = require('node:fs')",
  "const nodePath = require('node:path')",
  `const recordDirectory = nodePath.join(process.env.${FIXTURE_DIRECTORY_ENV}, 'v1', 'agents', process.env.${FIXTURE_ID_ENV})`,
  'function listRecords() {',
  '  try {',
  '    return fs.readdirSync(recordDirectory).map(function (name) {',
  '      return {',
  '        name: name,',
  "        record: JSON.parse(fs.readFileSync(nodePath.join(recordDirectory, name), 'utf8')),",
  '      }',
  '    })',
  '  } catch (error) {',
  '    return []',
  '  }',
  '}',
  'function observedEnv() {',
  '  return {',
  `    directory: process.env.${PROCESS_ATTRIBUTION_DIRECTORY_ENV} || null,`,
  `    id: process.env.${PROCESS_ATTRIBUTION_ID_ENV} || null,`,
  `    kind: process.env.${PROCESS_ATTRIBUTION_KIND_ENV} || null,`,
  '    nodeOptions: process.env.NODE_OPTIONS || null,',
  '  }',
  '}',
].join('\n')

type PreloadFixtureRun = {
  stdout: string
  directory: string
  attributionId: string
  pid: number
}

/**
 * Run the generated preload inside a real node process, the way the shim does.
 * Only a real process has a real argv, a real pid and a real exit, and the
 * descendant guard is about what a second real process inherits.
 */
async function runPreloadFixture(input: {
  entrySource: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  extraFiles?: Record<string, string>
  withResourceExhaustedBlock?: boolean
}): Promise<PreloadFixtureRun> {
  const workDirectory = await createStoreDirectory()
  const directory = path.join(workDirectory, 'process-attribution')
  const attributionId = mintProcessAttributionId()
  const preloadPath = path.join(workDirectory, 'cursor-agent-preload.cjs')
  const entryPath = path.join(workDirectory, 'index.js')
  const preloadSource = input.withResourceExhaustedBlock
    ? [
      buildCursorAgentAttributionPreloadScript(),
      buildCursorAgentResourceExhaustedPreloadScript(),
    ].join('\n')
    : buildCursorAgentAttributionPreloadScript()
  await Promise.all([
    writeFile(preloadPath, preloadSource, 'utf8'),
    writeFile(entryPath, input.entrySource, 'utf8'),
    ...Object.entries(input.extraFiles ?? {}).map(([name, source]) =>
      writeFile(path.join(workDirectory, name), source, 'utf8')),
  ])

  const child = spawn('node', [entryPath, ...(input.args ?? [])], {
    cwd: workDirectory,
    env: {
      ...process.env,
      NODE_OPTIONS: buildCursorAgentPreloadRequireOption(preloadPath),
      AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS: '',
      [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: directory,
      [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
      [PROCESS_ATTRIBUTION_KIND_ENV]: 'cursor-agent',
      [FIXTURE_DIRECTORY_ENV]: directory,
      [FIXTURE_ID_ENV]: attributionId,
      ...input.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = child.pid ?? -1
  const stdout = await new Promise<string>((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.stderr?.on('data', chunk => { err += String(chunk) })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(out)
      else reject(new Error(`node exited with ${code}: ${err}`))
    })
  })
  return { stdout, directory, attributionId, pid }
}

function createFakeProbeChild(pid = 4321): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcess
}

describe('OpenCodeProcessAttributionStore', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })))
  })

  test('resolves the designated directory and falls back to the runtime data directory', () => {
    const designated = path.join(path.sep, 'designated', 'process-attribution')
    expect(resolveProcessAttributionDirectory({
      [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: designated,
    })).toBe(path.normalize(designated))

    const fallbackEnv = { HOME: path.join(path.sep, 'home', 'tester') }
    const fallback = path.join(
      resolveClaudeMultimodelPaths(fallbackEnv).data,
      'opencode',
      'process-attribution',
    )
    expect(resolveProcessAttributionDirectory(fallbackEnv)).toBe(fallback)
    // A relative value cannot be joined against an unknown working directory.
    expect(resolveProcessAttributionDirectory({
      ...fallbackEnv,
      [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: 'relative/attribution',
    })).toBe(fallback)
  })

  test('builds a spawn environment for an agent tree and for the readiness probe', () => {
    const attributionId = mintProcessAttributionId()
    expect(attributionId).toMatch(/^[0-9a-f]{32}$/)

    const directory = path.join(path.sep, 'designated')
    expect(buildProcessAttributionSpawnEnv({ directory, attributionId })).toMatchObject({
      [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: directory,
      [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
      [PROCESS_ATTRIBUTION_KIND_ENV]: 'cursor-agent',
    })
    // The one cursor-agent the runtime spawns itself is never a team's tree.
    expect(buildProcessAttributionSpawnEnv({
      directory,
      attributionId,
      kind: 'readiness-probe',
    })).toMatchObject({
      [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: directory,
      [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
      [PROCESS_ATTRIBUTION_KIND_ENV]: 'readiness-probe',
    })
    expect(buildProcessAttributionSpawnEnv({ directory: null, attributionId })).toEqual({})
    expect(buildProcessAttributionSpawnEnv({ directory, attributionId: 'not-an-id' })).toEqual({})
  })

  test('gives the readiness probe tree a readiness-probe identity of its own', async () => {
    const directory = path.join(path.sep, 'designated', 'process-attribution')
    const env = {
      [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: directory,
      CURSOR_AGENT_EXECUTABLE: path.join(path.sep, 'managed', 'cursor-agent'),
    }
    const child = createFakeProbeChild()
    let spawnedOptions: SpawnOptions | undefined
    const probe = new OpenCodeCursorNativeFailureProbe({
      delayMs: 0,
      timeoutMs: 1_000,
      forceKillDelayMs: 0,
      spawnProcess: (_command, _args, options) => {
        spawnedOptions = options
        queueMicrotask(() => { child.emit('close', 0) })
        return child
      },
      killProcess: () => undefined,
    })

    await probe.probe({
      selectedModel: 'cursor-acp/auto',
      projectPath: path.join(path.sep, 'sandbox', 'project'),
      env,
    })

    expect(spawnedOptions?.env?.[PROCESS_ATTRIBUTION_KIND_ENV]).toBe('readiness-probe')
    expect(spawnedOptions?.env?.[PROCESS_ATTRIBUTION_ID_ENV]).toMatch(/^[0-9a-f]{32}$/)
    expect(spawnedOptions?.env?.[PROCESS_ATTRIBUTION_DIRECTORY_ENV])
      .toBe(resolveProcessAttributionDirectory(env))
    // The probe still runs with the managed profile environment it was given.
    expect(spawnedOptions?.env?.CURSOR_AGENT_EXECUTABLE).toBe(env.CURSOR_AGENT_EXECUTABLE)
  })

  test('round trips a host record and the agent records filed under the same id', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    await withDesktopIdentityEnv(
      { [APP_INSTANCE_ID_ENV]: 'app-1', [APP_PROFILE_SCOPE_ENV]: 'scope-a' },
      () => writeHostAttributionRecord({
        directory,
        attributionId,
        hostPid: 999,
        hostStartedAtNative: 8_712_334,
        projectPath: '/work/app',
        owners: [{
          teamId: 'team-1',
          laneId: 'primary',
          memberName: 'alice',
          runId: 'run-1',
          sessionId: 'session-1',
          createdAt: '2026-09-10T10:00:00.000Z',
          updatedAt: '2026-09-10T10:05:00.000Z',
        }],
        now: () => new Date('2026-09-10T10:05:00.000Z'),
      }),
    )
    await writeAgentRecordFile(
      directory,
      attributionId,
      '4321-1757500000123.json',
      buildAgentRecord({ attributionId }),
    )

    const records = await readAttributionRecords(directory)
    expect(records.corruptPaths).toEqual([])
    expect(records.hosts).toHaveLength(1)
    expect(records.hosts[0]?.record).toEqual({
      schemaVersion: 1,
      attributionId,
      hostPid: 999,
      hostStartedAtNative: 8_712_334,
      hostStartTimeFormat: resolveHostStartTimeFormat(),
      projectPath: '/work/app',
      appInstanceId: 'app-1',
      appProfileScope: 'scope-a',
      runtimeVersion: null,
      owners: [{
        teamId: 'team-1',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
        sessionId: 'session-1',
        createdAt: '2026-09-10T10:00:00.000Z',
        updatedAt: '2026-09-10T10:05:00.000Z',
      }],
      releasedOwners: [],
      updatedAt: '2026-09-10T10:05:00.000Z',
    })
    expect(records.agents).toHaveLength(1)
    expect(records.agents[0]?.record).toMatchObject({
      kind: 'cursor-agent',
      attributionId,
      pid: 4321,
      parentPid: 4320,
      workspacePath: 'D:\\work\\app - backup',
      startTimeToleranceMs: PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS,
    })

    // Retiring the host with its one agent dead takes everything with it.
    expect(await retireHostAttributionRecords(directory, attributionId, {
      isProcessAlive: () => false,
    })).toEqual({ hostRetired: true, prunedAgents: 1, liveAgents: 0 })
    expect(await readAttributionRecords(directory)).toMatchObject({ hosts: [], agents: [] })
    expect(await exists(processAttributionAgentDirectoryPath(directory, attributionId))).toBe(false)
  })

  test('ignores records written by a schema version it does not understand', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    const hostPath = processAttributionHostRecordPath(directory, attributionId)
    await mkdir(path.dirname(hostPath), { recursive: true })
    await writeFile(
      hostPath,
      JSON.stringify({ schemaVersion: 2, attributionId, hostPid: 999 }),
      'utf8',
    )
    const futurePath = await writeAgentRecordFile(
      directory,
      attributionId,
      '4321-1757500000123.json',
      buildAgentRecord({ attributionId, schemaVersion: 2 }),
    )

    const records = await readAttributionRecords(directory)
    expect(records.hosts).toEqual([])
    expect(records.agents).toEqual([])
    expect(records.corruptPaths).toEqual([])

    // A future writer owns its own files: an unreadable version is never guessed
    // at and never deleted.
    await pruneStaleAttributionRecords(directory, { isProcessAlive: () => false })
    expect(await readFile(futurePath, 'utf8')).toContain('"schemaVersion":2')
  })

  test('prunes dead pids and corrupt files but keeps every live process', async () => {
    const directory = await createStoreDirectory()
    const liveHostId = mintProcessAttributionId()
    const deadHostId = mintProcessAttributionId()
    const nowMs = Date.parse('2026-09-10T12:00:00.000Z')

    await writeHostAttributionRecord({
      directory,
      attributionId: liveHostId,
      hostPid: 111,
      hostStartedAtNative: 5_000,
      projectPath: '/work/live',
      owners: [],
      now: () => new Date(nowMs),
    })
    await writeHostAttributionRecord({
      directory,
      attributionId: deadHostId,
      hostPid: 222,
      hostStartedAtNative: 6_000,
      projectPath: '/work/dead',
      owners: [],
      now: () => new Date(nowMs),
    })
    await writeAgentRecordFile(directory, liveHostId, '333-1.json',
      buildAgentRecord({ attributionId: liveHostId, pid: 333, writtenAtMs: nowMs }))
    await writeAgentRecordFile(directory, liveHostId, '444-1.json',
      buildAgentRecord({ attributionId: liveHostId, pid: 444, writtenAtMs: nowMs }))
    await writeAgentRecordFile(directory, deadHostId, '666-1.json',
      buildAgentRecord({ attributionId: deadHostId, pid: 666, writtenAtMs: nowMs }))
    const corruptPath = await writeAgentRecordFile(
      directory, liveHostId, '777-1.json', '{ not json',
    )

    const alivePids = new Set([111, 333, 666])
    const result = await pruneStaleAttributionRecords(directory, {
      now: () => nowMs,
      isProcessAlive: pid => alivePids.has(pid),
      readProcessStartTimeMs: async pid => (pid === 111 ? 5_000 : null),
    })

    // The dead host 222 keeps its record: agent 666 under it is still running,
    // and the record is what names the team that tree was started for.
    expect(result).toEqual({ prunedHosts: 0, prunedAgents: 1, prunedCorrupt: 1 })
    const remaining = await readAttributionRecords(directory)
    expect(remaining.hosts.map(host => host.record.attributionId).sort())
      .toEqual([deadHostId, liveHostId].sort())
    expect(remaining.agents.map(agent => agent.record.pid).sort()).toEqual([333, 666])
    expect(await exists(corruptPath)).toBe(false)
  })

  test.each(['matching', 'unreadable'] as const)('keeps a dead host and the live agent under it until the last agent is gone (%s birth)', async identity => {
    const directory = await createStoreDirectory()
    const hostId = mintProcessAttributionId()
    const startedAtMs = 1_757_500_000_123
    await writeHostAttributionRecord({
      directory,
      attributionId: hostId,
      hostPid: 222,
      hostStartedAtNative: 6_000,
      projectPath: '/work/orphaned',
      owners: [],
    })
    const agentPath = await writeAgentRecordFile(directory, hostId, '666-1.json',
      buildAgentRecord({ attributionId: hostId, pid: 666, startedAtMs, writtenAtMs: Date.now() }))

    // A host that died leaving live agent trees behind is exactly the orphan the
    // desktop sweep exists to find, so its evidence - the agent record and the
    // host record that names the team - has to survive the sweep.
    const result = await pruneStaleAttributionRecords(directory, {
      isProcessAlive: pid => pid === 666,
      // The process is synthetic; its birth must not come from a real PID 666.
      readProcessStartTimeMs: async () => identity === 'matching' ? startedAtMs : null,
    })

    expect(result).toMatchObject({ prunedHosts: 0, prunedAgents: 0 })
    expect(await exists(processAttributionHostRecordPath(directory, hostId))).toBe(true)
    expect(await exists(agentPath)).toBe(true)
    const remaining = await readAttributionRecords(directory)
    expect(remaining.hosts.map(host => host.record.hostPid)).toEqual([222])
    expect(remaining.agents.map(agent => agent.record.pid)).toEqual([666])

    // Once the last agent is gone there is nothing left for the record to name.
    expect(await pruneStaleAttributionRecords(directory, {
      isProcessAlive: () => false,
    })).toMatchObject({ prunedHosts: 1, prunedAgents: 1 })
    expect(await readAttributionRecords(directory)).toMatchObject({ hosts: [], agents: [] })
    expect(await exists(processAttributionAgentDirectoryPath(directory, hostId))).toBe(false)
  })

  test('keeps a record past the age horizon while its process is alive', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    const nowMs = Date.parse('2026-09-10T12:00:00.000Z')
    const longAgoMs = nowMs - PROCESS_ATTRIBUTION_MAX_RECORD_AGE_MS - 24 * 60 * 60 * 1000
    await writeHostAttributionRecord({
      directory,
      attributionId,
      hostPid: 111,
      hostStartedAtNative: null,
      projectPath: '/work/long-lived',
      owners: [],
      now: () => new Date(longAgoMs),
    })
    await writeAgentRecordFile(directory, attributionId, '333-1.json',
      buildAgentRecord({ attributionId, pid: 333, writtenAtMs: longAgoMs }))
    await writeAgentRecordFile(directory, attributionId, '444-1.json',
      buildAgentRecord({ attributionId, pid: 444, writtenAtMs: longAgoMs }))

    const result = await pruneStaleAttributionRecords(directory, {
      now: () => nowMs,
      isProcessAlive: pid => pid !== 444,
      readProcessStartTimeMs: async () => null,
    })

    // The horizon is a backstop for records nobody can judge, never a reason to
    // delete evidence about a process that is still running.
    expect(result).toMatchObject({ prunedHosts: 0, prunedAgents: 1 })
    const remaining = await readAttributionRecords(directory)
    expect(remaining.hosts).toHaveLength(1)
    expect(remaining.agents.map(agent => agent.record.pid)).toEqual([333])
  })

  test('applies the age horizon when liveness cannot be probed at all', async () => {
    const directory = await createStoreDirectory()
    const freshHostId = mintProcessAttributionId()
    const staleHostId = mintProcessAttributionId()
    const nowMs = Date.parse('2026-09-10T12:00:00.000Z')
    const expiredMs = nowMs - PROCESS_ATTRIBUTION_MAX_RECORD_AGE_MS - 1
    await writeHostAttributionRecord({
      directory,
      attributionId: freshHostId,
      hostPid: 111,
      hostStartedAtNative: 5_000,
      projectPath: '/work/fresh',
      owners: [],
      now: () => new Date(nowMs),
    })
    await writeHostAttributionRecord({
      directory,
      attributionId: staleHostId,
      hostPid: 222,
      hostStartedAtNative: 6_000,
      projectPath: '/work/stale',
      owners: [],
      now: () => new Date(expiredMs),
    })
    await writeAgentRecordFile(directory, freshHostId, '333-1.json',
      buildAgentRecord({ attributionId: freshHostId, pid: 333, writtenAtMs: nowMs }))
    await writeAgentRecordFile(directory, staleHostId, '444-1.json',
      buildAgentRecord({ attributionId: staleHostId, pid: 444, writtenAtMs: expiredMs }))

    const result = await pruneStaleAttributionRecords(directory, {
      now: () => nowMs,
      isProcessAlive: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
    })

    expect(result).toMatchObject({ prunedHosts: 1, prunedAgents: 1 })
    const remaining = await readAttributionRecords(directory)
    expect(remaining.hosts.map(host => host.record.attributionId)).toEqual([freshHostId])
    expect(remaining.agents.map(agent => agent.record.pid)).toEqual([333])
  })

  test('removes the empty agent directory a readiness probe leaves behind', async () => {
    const directory = await createStoreDirectory()
    const emptyId = mintProcessAttributionId()
    const occupiedId = mintProcessAttributionId()
    await mkdir(processAttributionAgentDirectoryPath(directory, emptyId), { recursive: true })
    await writeAgentRecordFile(directory, occupiedId, '333-1.json',
      buildAgentRecord({ attributionId: occupiedId, pid: 333, writtenAtMs: Date.now() }))

    const result = await pruneStaleAttributionRecords(directory, {
      isProcessAlive: () => true,
    })

    expect(result).toMatchObject({ prunedAgents: 0, prunedCorrupt: 0 })
    expect(await exists(processAttributionAgentDirectoryPath(directory, emptyId))).toBe(false)
    // A directory that still holds a record is not empty and must survive.
    expect(await readdir(processAttributionAgentDirectoryPath(directory, occupiedId)))
      .toHaveLength(1)

    // A store that was never written to is not an error either.
    expect(await pruneStaleAttributionRecords(path.join(directory, 'missing')))
      .toEqual({ prunedHosts: 0, prunedAgents: 0, prunedCorrupt: 0 })
  })

  test('prunes a host whose pid was reused by a different process', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    await writeHostAttributionRecord({
      directory,
      attributionId,
      hostPid: 111,
      hostStartedAtNative: 5_000,
      projectPath: '/work/live',
      owners: [],
    })
    const agentPath = await writeAgentRecordFile(directory, attributionId, '333-1.json',
      buildAgentRecord({ attributionId, pid: 333, writtenAtMs: Date.now() }))

    // The host's pid is alive but belongs to a different process now; the
    // agent's pid is simply gone.
    const result = await pruneStaleAttributionRecords(directory, {
      isProcessAlive: pid => pid === 111,
      readProcessStartTimeMs: async () => 9_999,
    })

    expect(result).toMatchObject({ prunedHosts: 1, prunedAgents: 1 })
    expect(await exists(agentPath)).toBe(false)
    expect(await readAttributionRecords(directory)).toMatchObject({ hosts: [], agents: [] })
  })

  test('prunes an agent whose pid was reused by a different process', async () => {
    const format = resolveHostStartTimeFormat()
    if (format === 'unknown') return
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    const startedAtMs = 1_757_500_000_123
    // The identity the preload records and the identity the OS reports have to
    // be compared in the same unit: /proc start ticks on Linux, epoch
    // milliseconds within the record's tolerance everywhere else.
    const recorded = format === 'linux-ticks'
      ? { startedAtMs, nativeStartToken: 'proc:8843211' }
      : { startedAtMs, nativeStartToken: null }
    const same = format === 'linux-ticks' ? 8_843_211 : startedAtMs + 1_500
    const other = format === 'linux-ticks' ? 8_843_999 : startedAtMs + 60_000
    const samePath = await writeAgentRecordFile(directory, attributionId, '333-1.json',
      buildAgentRecord({ attributionId, pid: 333, writtenAtMs: Date.now(), ...recorded }))
    const otherPath = await writeAgentRecordFile(directory, attributionId, '444-1.json',
      buildAgentRecord({ attributionId, pid: 444, writtenAtMs: Date.now(), ...recorded }))
    const unreadablePath = await writeAgentRecordFile(directory, attributionId, '555-1.json',
      buildAgentRecord({ attributionId, pid: 555, writtenAtMs: Date.now(), ...recorded }))

    const result = await pruneStaleAttributionRecords(directory, {
      isProcessAlive: () => true,
      readProcessStartTimeMs: async pid => (pid === 333 ? same : pid === 444 ? other : null),
    })

    // Only a differing identity is proof of reuse; an unreadable one is not.
    expect(result).toMatchObject({ prunedAgents: 1 })
    expect(await exists(samePath)).toBe(true)
    expect(await exists(otherPath)).toBe(false)
    expect(await exists(unreadablePath)).toBe(true)
  })

  test('prunes an agent that reported its own exit', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    const exitedPath = await writeAgentRecordFile(directory, attributionId, '333-1.json',
      buildAgentRecord({ attributionId, pid: 333, writtenAtMs: Date.now(), exitedAtMs: Date.now() }))
    const livePath = await writeAgentRecordFile(directory, attributionId, '444-1.json',
      buildAgentRecord({ attributionId, pid: 444, writtenAtMs: Date.now() }))

    // The exit handler rewrites the record only when it could not unlink it, so
    // the process is gone whatever its pid says now.
    const result = await pruneStaleAttributionRecords(directory, {
      isProcessAlive: () => true,
      readProcessStartTimeMs: async () => null,
    })

    expect(result).toMatchObject({ prunedAgents: 1 })
    expect(await exists(exitedPath)).toBe(false)
    expect(await exists(livePath)).toBe(true)
  })

  test('retires a host only once its last agent tree is gone', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    const otherId = mintProcessAttributionId()
    await writeHostAttributionRecord({
      directory,
      attributionId,
      hostPid: 111,
      hostStartedAtNative: 5_000,
      projectPath: '/work/retired',
      owners: [{
        teamId: 'team-1',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
        sessionId: 'session-1',
        createdAt: '2026-09-10T10:00:00.000Z',
        updatedAt: '2026-09-10T10:05:00.000Z',
      }],
    })
    const livePath = await writeAgentRecordFile(directory, attributionId, '333-1.json',
      buildAgentRecord({ attributionId, pid: 333, writtenAtMs: Date.now() }))
    const deadPath = await writeAgentRecordFile(directory, attributionId, '444-1.json',
      buildAgentRecord({ attributionId, pid: 444, writtenAtMs: Date.now() }))
    const corruptPath = await writeAgentRecordFile(directory, attributionId, '555-1.json', '{ no')
    const otherPath = await writeAgentRecordFile(directory, otherId, '666-1.json',
      buildAgentRecord({ attributionId: otherId, pid: 666, writtenAtMs: Date.now() }))

    // The host is gone; agent 333 is not. Its record and the host record that
    // names team-1 both stay, and only the dead and unreadable files go.
    expect(await retireHostAttributionRecords(directory, attributionId, {
      isProcessAlive: pid => pid === 333,
      readProcessStartTimeMs: async () => null,
    })).toEqual({ hostRetired: false, prunedAgents: 2, liveAgents: 1 })
    expect(await exists(livePath)).toBe(true)
    expect(await exists(deadPath)).toBe(false)
    expect(await exists(corruptPath)).toBe(false)
    const kept = await readAttributionRecords(directory)
    expect(kept.hosts.map(host => host.record.owners.map(owner => owner.teamId)))
      .toEqual([['team-1']])
    // Another host's records are not this retirement's business.
    expect(await exists(otherPath)).toBe(true)

    expect(await retireHostAttributionRecords(directory, attributionId, {
      isProcessAlive: () => false,
    })).toEqual({ hostRetired: true, prunedAgents: 1, liveAgents: 0 })
    expect(await exists(processAttributionHostRecordPath(directory, attributionId))).toBe(false)
    expect(await exists(processAttributionAgentDirectoryPath(directory, attributionId))).toBe(false)
    expect(await exists(otherPath)).toBe(true)
  })

  test('moves a released lease to the released owners and keeps it with the record', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    const owner = (teamId: string) => ({
      teamId,
      laneId: 'primary',
      memberName: 'alice',
      runId: `run-${teamId}`,
      sessionId: `session-${teamId}`,
      createdAt: '2026-09-10T10:00:00.000Z',
      updatedAt: '2026-09-10T10:05:00.000Z',
    })
    const write = (owners: ReturnType<typeof owner>[], at: string) =>
      writeHostAttributionRecord({
        directory,
        attributionId,
        hostPid: 111,
        hostStartedAtNative: 5_000,
        projectPath: '/work/app',
        owners,
        now: () => new Date(at),
      })
    const readHost = async () => (await readAttributionRecords(directory)).hosts[0]?.record

    await write([owner('team-1'), owner('team-2')], '2026-09-10T10:05:00.000Z')
    expect((await readHost())?.releasedOwners).toEqual([])

    // team-1 stops: its lease goes, and the record remembers when.
    await write([owner('team-2')], '2026-09-10T10:20:00.000Z')
    expect((await readHost())?.owners.map(entry => entry.teamId)).toEqual(['team-2'])
    expect((await readHost())?.releasedOwners).toEqual([
      { ...owner('team-1'), releasedAt: '2026-09-10T10:20:00.000Z' },
    ])

    // The last lease goes too; both releases stay, oldest first.
    await write([], '2026-09-10T10:30:00.000Z')
    expect((await readHost())?.owners).toEqual([])
    expect((await readHost())?.releasedOwners.map(entry => [entry.teamId, entry.releasedAt]))
      .toEqual([
        ['team-1', '2026-09-10T10:20:00.000Z'],
        ['team-2', '2026-09-10T10:30:00.000Z'],
      ])

    // A record written by a runtime that knew no released owners reads as none.
    const hostPath = processAttributionHostRecordPath(directory, attributionId)
    const legacy = JSON.parse(await readFile(hostPath, 'utf8')) as Record<string, unknown>
    delete legacy.releasedOwners
    await writeFile(hostPath, JSON.stringify(legacy), 'utf8')
    expect((await readHost())?.releasedOwners).toEqual([])

    // The list is bounded to the newest releases.
    const many = Array.from({ length: PROCESS_ATTRIBUTION_MAX_RELEASED_OWNERS + 5 }, (_, index) =>
      owner(`team-${index}`))
    await write(many, '2026-09-10T11:00:00.000Z')
    await write([], '2026-09-10T11:01:00.000Z')
    const released = (await readHost())?.releasedOwners ?? []
    expect(released).toHaveLength(PROCESS_ATTRIBUTION_MAX_RELEASED_OWNERS)
    expect(released[released.length - 1]?.teamId)
      .toBe(`team-${PROCESS_ATTRIBUTION_MAX_RELEASED_OWNERS + 4}`)
  })

  test('keeps a live host whose start time cannot be read', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    await writeHostAttributionRecord({
      directory,
      attributionId,
      hostPid: 111,
      hostStartedAtNative: 5_000,
      projectPath: '/work/live',
      owners: [],
    })

    const result = await pruneStaleAttributionRecords(directory, {
      isProcessAlive: () => true,
      readProcessStartTimeMs: async () => null,
    })

    expect(result).toMatchObject({ prunedHosts: 0 })
    expect((await readAttributionRecords(directory)).hosts).toHaveLength(1)
  })

  test('returns every record it finds and leaves the install filter to the consumer', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    await writeAgentRecordFile(directory, attributionId, '1-1.json',
      buildAgentRecord({ attributionId, pid: 1, appProfileScope: 'scope-a' }))
    await writeAgentRecordFile(directory, attributionId, '2-1.json',
      buildAgentRecord({ attributionId, pid: 2, appProfileScope: 'scope-b' }))

    // The runtime prunes this store on behalf of every install that shares it,
    // so it has to see every record; only the consumer knows which install it
    // speaks for, and the record carries the scope for it to filter on.
    const records = await readAttributionRecords(directory)
    expect(records.agents.map(agent => agent.record.pid).sort()).toEqual([1, 2])
    expect(records.agents.map(agent => agent.record.appProfileScope).sort())
      .toEqual(['scope-a', 'scope-b'])
  })

  test('rejects an agent record filed under a foreign attribution id', async () => {
    const directory = await createStoreDirectory()
    const attributionId = mintProcessAttributionId()
    const filePath = await writeAgentRecordFile(directory, attributionId, '1-1.json',
      buildAgentRecord({ attributionId: mintProcessAttributionId(), pid: 1 }))

    const records = await readAttributionRecords(directory)
    expect(records.agents).toEqual([])
    expect(records.corruptPaths).toEqual([filePath])
  })

  test('reads an empty store without throwing', async () => {
    const directory = await createStoreDirectory()
    expect(await readAttributionRecords(path.join(directory, 'missing'))).toEqual({
      hosts: [],
      agents: [],
      corruptPaths: [],
    })
  })

  test('clamps a recorded start time tolerance to the fence this build trusts', async () => {
    const cases: Array<[unknown, number]> = [
      // Absent or unusable: the reader's own default, never the file's choice.
      [undefined, PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS],
      ['2000', PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS],
      [Number.NaN, PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS],
      [Number.POSITIVE_INFINITY, PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS],
      [-1, PROCESS_ATTRIBUTION_START_TIME_TOLERANCE_MS],
      // In range, the recorded value is honoured.
      [0, 0],
      [5_000, 5_000],
      [
        PROCESS_ATTRIBUTION_MAX_START_TIME_TOLERANCE_MS,
        PROCESS_ATTRIBUTION_MAX_START_TIME_TOLERANCE_MS,
      ],
      // A record must not be able to widen its own pid-reuse fence.
      [60_000, PROCESS_ATTRIBUTION_MAX_START_TIME_TOLERANCE_MS],
      [Number.MAX_SAFE_INTEGER, PROCESS_ATTRIBUTION_MAX_START_TIME_TOLERANCE_MS],
    ]

    for (const [value, expected] of cases) {
      const outcome = await readOneAgentRecord({ startTimeToleranceMs: value })
      expect(outcome.corrupt).toBe(0)
      expect(outcome.records).toHaveLength(1)
      expect([value, outcome.records[0]?.startTimeToleranceMs]).toEqual([value, expected])
    }
  })

  test('refuses an agent record without a usable pid or start time', async () => {
    for (const overrides of [
      { pid: 0 },
      { pid: -1 },
      { pid: 1.5 },
      { pid: '4321' },
      { startedAtMs: 0 },
      { startedAtMs: -1 },
      { startedAtMs: null },
    ]) {
      const outcome = await readOneAgentRecord(overrides)
      expect([overrides, outcome.records.length, outcome.corrupt]).toEqual([overrides, 0, 1])
    }

    // Negative control: the smallest values a real process can produce.
    const accepted = await readOneAgentRecord({ pid: 1, startedAtMs: 1 })
    expect(accepted.corrupt).toBe(0)
    expect(accepted.records[0]).toMatchObject({ pid: 1, startedAtMs: 1 })
  })

  test('records the agent process and clears the environment for its descendants', async () => {
    const workspacePath = path.join(os.tmpdir(), 'app - backup -- copy')
    const run = await runPreloadFixture({
      args: ['--print', '--workspace', workspacePath, '--model', 'auto'],
      extraFiles: {
        // A node descendant of a wrapper inherits NODE_OPTIONS and this
        // environment, and can carry an agent-shaped argv of its own.
        'descendant.js': [
          FIXTURE_REPORT_SOURCE,
          'process.stdout.write(JSON.stringify({',
          '  pid: process.pid,',
          '  records: listRecords(),',
          '  env: observedEnv(),',
          '}))',
        ].join('\n'),
      },
      entrySource: [
        FIXTURE_REPORT_SOURCE,
        "const child = require('node:child_process').execFileSync(",
        '  process.execPath,',
        "  [nodePath.join(__dirname, 'descendant.js'), '--workspace', process.argv[3]],",
        "  { encoding: 'utf8' },",
        ')',
        'process.stdout.write(JSON.stringify({',
        '  pid: process.pid,',
        '  records: listRecords(),',
        '  child: JSON.parse(child),',
        '}))',
      ].join('\n'),
    })

    const observed = JSON.parse(run.stdout) as {
      pid: number
      records: Array<{ name: string; record: Record<string, unknown> }>
      child: {
        pid: number
        records: unknown[]
        env: {
          directory: string | null
          id: string | null
          kind: string | null
          nodeOptions: string | null
        }
      }
    }

    expect(observed.pid).toBe(run.pid)
    expect(observed.child.pid).not.toBe(observed.pid)
    // Exactly one record, written by the process that carried the invocation.
    expect(observed.records).toHaveLength(1)
    expect(observed.records[0]?.record).toMatchObject({
      schemaVersion: 1,
      kind: 'cursor-agent',
      attributionId: run.attributionId,
      pid: run.pid,
      parentPid: process.pid,
      workspacePath,
      exitedAtMs: null,
    })
    expect(observed.records[0]?.name)
      .toBe(`${run.pid}-${observed.records[0]?.record.startedAtMs}.json`)
    // The descendant did run the preload: it was stopped by a cleared
    // environment, not by never having been asked to record anything.
    expect(observed.child.env.nodeOptions).toContain('cursor-agent-preload')
    expect(observed.child.env).toMatchObject({ directory: null, id: null, kind: null })
    expect(observed.child.records).toHaveLength(1)

    // A normal exit takes the record with it.
    expect(await readAttributionRecords(run.directory)).toMatchObject({ agents: [] })
  })

  test('writes no record for a process that does not carry the agent invocation', async () => {
    const reportSource = [
      FIXTURE_REPORT_SOURCE,
      'process.stdout.write(JSON.stringify({ records: listRecords(), env: observedEnv() }))',
    ].join('\n')
    const wrapper = await runPreloadFixture({
      args: ['--print', '--model', 'auto'],
      entrySource: reportSource,
    })
    const observed = JSON.parse(wrapper.stdout) as {
      records: unknown[]
      env: { directory: string | null; id: string | null; kind: string | null }
    }

    expect(observed.records).toEqual([])
    // The guard returns before the write, so the environment is still intact for
    // the descendant that really is the agent.
    expect(observed.env).toMatchObject({
      directory: wrapper.directory,
      id: wrapper.attributionId,
      kind: 'cursor-agent',
    })
    expect(await readAttributionRecords(wrapper.directory)).toMatchObject({ agents: [] })

    // Only the spelling both spawners actually pass is an agent invocation.
    const joined = await runPreloadFixture({
      args: [`--workspace=${os.tmpdir()}`],
      entrySource: reportSource,
    })
    expect((JSON.parse(joined.stdout) as { records: unknown[] }).records).toEqual([])
  })

  test('restores NODE_OPTIONS for the agent it has just recorded', async () => {
    const run = await runPreloadFixture({
      args: ['--workspace', os.tmpdir()],
      withResourceExhaustedBlock: true,
      env: { AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS: '--no-warnings' },
      entrySource: [
        FIXTURE_REPORT_SOURCE,
        'process.stdout.write(JSON.stringify({ records: listRecords(), env: observedEnv() }))',
      ].join('\n'),
    })
    const observed = JSON.parse(run.stdout) as {
      records: unknown[]
      env: { directory: string | null; nodeOptions: string | null }
    }

    expect(observed.records).toHaveLength(1)
    expect(observed.env.nodeOptions).toBe('--no-warnings')
    expect(observed.env.directory).toBeNull()
  })

  test('does not resurrect a record that was removed before the process exited', async () => {
    const run = await runPreloadFixture({
      args: ['--workspace', os.tmpdir()],
      entrySource: [
        FIXTURE_REPORT_SOURCE,
        'const before = listRecords()',
        'for (const entry of before) {',
        '  fs.unlinkSync(nodePath.join(recordDirectory, entry.name))',
        '}',
        'process.stdout.write(JSON.stringify({ removed: before.map(entry => entry.name) }))',
      ].join('\n'),
    })

    expect((JSON.parse(run.stdout) as { removed: string[] }).removed).toHaveLength(1)
    // An unlink that already happened is the expected exit, not a failure to
    // report with a rewritten record.
    expect(await readdir(processAttributionAgentDirectoryPath(run.directory, run.attributionId)))
      .toEqual([])
    expect(await readAttributionRecords(run.directory)).toMatchObject({ agents: [] })
  })
})

test.each(['darwin', 'win32'] as const)('preload records native epoch identity on %s without invoking a real helper', platform => {
  const records: Array<{ nativeStartToken: string }> = []
  const calls: string[] = []
  runInNewContext(buildCursorAgentAttributionPreloadScript(), {
    process: { platform, pid: 123, ppid: 122, uptime: () => 1, cwd: () => '/fixture',
      argv: ['node', 'agent', '--workspace', '/fixture'], on: () => {},
      env: { [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: '/fixture/records',
        [PROCESS_ATTRIBUTION_ID_ENV]: 'a'.repeat(32) } },
    require: (name: string) => {
      if (name === 'node:path') return path
      if (name === 'node:fs') return { mkdirSync: () => {}, renameSync: () => {},
        writeFileSync: (_file: string, text: string) => { records.push(JSON.parse(text)) } }
      if (name === 'node:child_process') return { execFileSync: (command: string) => {
        calls.push(command); return '2026-09-12T12:00:00.000Z'
      } }
      throw new Error('Unexpected fixture module')
    },
  })
  expect(records).toHaveLength(1)
  expect(records[0]!.nativeStartToken).toBe(`epoch:${Date.parse('2026-09-12T12:00:00.000Z')}`)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.endsWith(platform === 'win32' ? 'powershell.exe' : 'ps')).toBe(true)
})
