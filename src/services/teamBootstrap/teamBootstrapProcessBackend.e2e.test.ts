import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  __handleSpawnNativeProcessForTests,
  type SpawnTeammateConfig,
} from '../../tools/shared/spawnMultiAgent.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from '../../utils/config.js'
import { normalizePathForConfigKey } from '../../utils/path.js'
import { isProcessAlive, killProcessTree } from '../../utils/processKill.js'
import { TEAMMATE_COMMAND_ENV_VAR, TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { killProcessBackendRuntime } from '../../utils/swarm/processBackend.js'
import {
  getTeammateRuntimePaths,
  readTeammateRuntimeEvents,
} from '../../utils/swarm/teammateRuntimeEvents.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
  type TeamFile,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import {
  __setTeamBootstrapRunnerDepsForTests,
  runTeamBootstrap,
} from './teamBootstrapRunner.js'

const BOOTSTRAP_PROMPT = 'process backend e2e bootstrap prompt'

const FAKE_TEAMMATE_RUNTIME_SCRIPT = String.raw`
import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const args = process.argv.slice(2)
const getArg = flag => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const sanitizeName = value =>
  String(value || 'default')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase()

const teamName = getArg('--team-name')
const agentName = getArg('--agent-name')
const agentId = getArg('--agent-id')
const teammateRuntime = getArg('--teammate-runtime')
const eventsPath = process.env.CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH
const configDir = process.env.CLAUDE_CONFIG_DIR
const expectedPrompt = process.env.FAKE_TEAMMATE_EXPECTED_PROMPT || ''
const markerPath = process.env.FAKE_TEAMMATE_SPAWN_MARKER
const mode = process.env.FAKE_TEAMMATE_MODE || 'success'

async function writeEvent(type, detail) {
  if (!eventsPath) return
  await mkdir(dirname(eventsPath), { recursive: true })
  await appendFile(
    eventsPath,
    JSON.stringify({
      version: 1,
      type,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      teamName,
      agentName,
      agentId,
      cwd: process.cwd(),
      detail,
    }) + '\n',
  )
}

async function readMailboxMessages(agent) {
  const inboxPath = join(
    configDir,
    'teams',
    sanitizeName(teamName),
    'inboxes',
    agent + '.json',
  )
  const raw = await readFile(inboxPath, 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

async function waitForBootstrapPrompt() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const messages = await readMailboxMessages(agentName)
      const matched = messages.find(
        message =>
          message &&
          message.from === 'team-lead' &&
          String(message.text || '').includes(expectedPrompt),
      )
      if (matched) return matched
    } catch {}
    await sleep(25)
  }
  throw new Error('timed out waiting for bootstrap prompt')
}

async function writeLeaderConfirmation() {
  const inboxPath = join(
    configDir,
    'teams',
    sanitizeName(teamName),
    'inboxes',
    'team-lead.json',
  )
  await mkdir(dirname(inboxPath), { recursive: true })
  let messages = []
  try {
    const parsed = JSON.parse(await readFile(inboxPath, 'utf8'))
    messages = Array.isArray(parsed) ? parsed : []
  } catch {}
  const now = new Date().toISOString()
  const confirmationFrom =
    mode === 'member-name-confirmation' ? agentName : agentId
  messages.push({
    from: confirmationFrom,
    text: JSON.stringify({
      type: 'idle_notification',
      from: confirmationFrom,
      timestamp: now,
      idleReason: 'available',
    }),
    timestamp: now,
    read: false,
  })
  await writeFile(inboxPath, JSON.stringify(messages, null, 2))
}

try {
  if (markerPath) {
    await writeFile(markerPath, 'spawned:' + process.pid)
  }
  await writeEvent('cli_started', 'teammateRuntime=' + teammateRuntime)

  if (mode === 'exit-before-ready') {
    console.error('fatal fake crash before runtime_ready')
    process.exit(42)
  }

  if (teammateRuntime !== 'headless') {
    await writeEvent('failed', 'missing headless teammate runtime flag')
    process.exit(2)
  }

  console.log('fake stdout: ' + agentId + ' cwd=' + process.cwd())
  console.error('fake stderr: ' + agentId + ' cwd=' + process.cwd())

  if (mode === 'pipe-flood') {
    console.log('pipe flood stdout start')
    console.error('pipe flood stderr start')
    const chunk = 'x'.repeat(8192)
    for (let index = 0; index < 64; index++) {
      console.log('stdout-flood-' + index + ':' + chunk)
      console.error('stderr-flood-' + index + ':' + chunk)
    }
    console.log('pipe flood stdout end')
    console.error('pipe flood stderr end')
  }

  if (mode === 'stdin-sensitive') {
    process.stdin.setEncoding('utf8')
    process.stdin.on('end', async () => {
      await writeEvent('failed', 'stdin ended')
      process.exit(77)
    })
    process.stdin.resume()
  }

  let child
  if (mode === 'hold-child') {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (child.pid) {
      await writeEvent('heartbeat', 'child_pid=' + child.pid)
    }
    child.unref()
  }

  await writeEvent('runtime_ready', 'headless flag accepted')

  const promptMessage = await waitForBootstrapPrompt()
  await writeEvent('inbox_poller_ready', 'initial poll observed bootstrap prompt')
  await writeEvent(
    'bootstrap_submitted',
    'messageId=' + String(promptMessage.messageId || 'missing'),
  )
  await writeLeaderConfirmation()
  await writeEvent('bootstrap_confirmed', 'leader idle notification written')
  if (mode === 'hold-child') {
    await writeEvent('heartbeat', 'holding parent open')
    await sleep(60_000)
    process.exit(0)
  }
  if (mode === 'stdin-sensitive') {
    await writeEvent('heartbeat', 'stdin pipe held open')
    await sleep(60_000)
    process.exit(0)
  }
  await sleep(1_000)
  process.exit(0)
} catch (error) {
  const detail = error && error.stack ? error.stack : String(error)
  console.error(detail)
  await writeEvent('failed', detail)
  process.exit(1)
}
`

type EnvSnapshot = Record<string, string | undefined>

let tempDirs: string[] = []
let runtimePids: number[] = []
let envSnapshot: EnvSnapshot
let originalCwdState: string
let originalOriginalCwd: string
let originalGlobalConfig: GlobalConfig

beforeEach(() => {
  envSnapshot = snapshotEnv([
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES',
    TEAMMATE_COMMAND_ENV_VAR,
    'FAKE_TEAMMATE_EXPECTED_PROMPT',
    'FAKE_TEAMMATE_MODE',
    'FAKE_TEAMMATE_SPAWN_MARKER',
  ])
  originalCwdState = getCwdState()
  originalOriginalCwd = getOriginalCwd()
  originalGlobalConfig = structuredClone(getGlobalConfig())
})

afterEach(async () => {
  __setTeamBootstrapRunnerDepsForTests(null)
  for (const pid of runtimePids) {
    if (isProcessAlive(pid)) {
      killProcessTree(pid, 'SIGTERM')
    }
  }
  runtimePids = []
  await Promise.all(
    tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
  restoreEnv(envSnapshot)
  setCwdState(originalCwdState)
  setOriginalCwd(originalOriginalCwd)
  saveGlobalConfig(current => ({
    ...current,
    projects: originalGlobalConfig.projects,
    teammateMode: originalGlobalConfig.teammateMode,
  }))
})

describe('supervised process teammate backend e2e', () => {
  it('launches a headless child process and accepts member-name bootstrap confirmation', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'member-name-confirmation',
    })
    const spawnResults: Array<{ backendType?: string; agentId?: string }> = []
    const completed: Array<{
      status: string
      registeredMembers: string[]
      failedMembers: Array<{ name: string; reason: string }>
    }> = []
    let failedReason = ''

    __setTeamBootstrapRunnerDepsForTests({
      spawnTeammate: (input, context) =>
        __handleSpawnNativeProcessForTests(input, context),
    })

    const result = await runTeamBootstrap({
      request: {
        version: 1,
        runId: 'process-e2e-run-1',
        requestHash: 'process-e2e-hash-1',
        mode: 'launch',
        teamName: fixture.teamName,
        cwd: fixture.projectRealpath,
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: BOOTSTRAP_PROMPT,
            cwd: fixture.projectRealpath,
          },
        ],
        bootstrapTimeoutMs: 10_000,
        continueOnPartialFailure: false,
        permissionSeedTools: [],
        emitStructuredEvents: true,
        policy: {
          persistentTeam: true,
          registerForSessionCleanup: false,
          writeConversationSummaryMessage: false,
        },
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
        },
      },
      context: fixture.context,
      emit: {
        started: async () => {},
        phaseChanged: async () => {},
        teamCreated: async () => {},
        memberSpawnStarted: async () => {},
        memberSpawnResult: async event => {
          spawnResults.push({
            backendType: event.backendType,
            agentId: event.agentId,
          })
        },
        completed: async event => {
          completed.push(event)
        },
        failed: async reason => {
          failedReason = reason
        },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.summary.terminalStatus).toBe('completed')
    expect(result.summary.registeredMembers).toEqual(['alice'])
    expect(result.summary.failedMembers).toEqual([])
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      status: 'completed',
      registeredMembers: ['alice'],
      failedMembers: [],
    })
    expect(failedReason).toBe('')
    expect(spawnResults).toEqual([
      {
        backendType: 'process',
        agentId: `alice@${fixture.teamName}`,
      },
    ])

    const teamFile = await readTeamFileAsync(fixture.teamName)
    const alice = teamFile?.members.find(member => member.name === 'alice')
    expect(alice).toMatchObject({
      agentId: `alice@${fixture.teamName}`,
      backendType: 'process',
      cwd: fixture.projectRealpath,
    })
    expect(typeof alice?.runtimePid).toBe('number')
    if (alice?.runtimePid) {
      runtimePids.push(alice.runtimePid)
    }

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    await waitForFileText(runtimePaths.stdoutPath, 'fake stdout: alice@')
    await waitForFileText(runtimePaths.stderrPath, 'fake stderr: alice@')

    const events = await waitForEvents(runtimePaths.eventsPath, [
      'process_spawned',
      'stdout_attached',
      'cli_started',
      'runtime_ready',
      'inbox_poller_ready',
      'bootstrap_submitted',
      'bootstrap_confirmed',
    ])
    const eventTypes = events.map(event => event.type)
    expect(eventTypes.indexOf('process_spawned')).toBeLessThan(
      eventTypes.indexOf('runtime_ready'),
    )
    expect(eventTypes.indexOf('runtime_ready')).toBeLessThan(
      eventTypes.indexOf('bootstrap_submitted'),
    )
    expect(
      events.find(event => event.type === 'cli_started')?.detail,
    ).toContain('teammateRuntime=headless')
    expect(
      events.find(event => event.type === 'runtime_ready')?.pid,
    ).toBe(alice?.runtimePid)

    if (alice?.runtimePid) {
      await waitForCondition(() => !isProcessAlive(alice.runtimePid!), 5_000)
      runtimePids = runtimePids.filter(pid => pid !== alice.runtimePid)
    }
  })

  it('fails before spawn when workspace trust is missing', async () => {
    const fixture = await createFixture({ trusted: false })

    let thrown: Error | null = null
    try {
      await __handleSpawnNativeProcessForTests(
        {
          name: 'alice',
          prompt: BOOTSTRAP_PROMPT,
          team_name: fixture.teamName,
          cwd: fixture.projectRealpath,
        },
        fixture.context,
      )
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toContain('workspace trust is not accepted')
    expect(await pathExists(fixture.markerPath)).toBe(false)
  })

  it('surfaces immediate process crashes with stderr tail and failure event', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'exit-before-ready',
    })

    let thrown: Error | null = null
    try {
      await __handleSpawnNativeProcessForTests(
        {
          name: 'alice',
          prompt: BOOTSTRAP_PROMPT,
          team_name: fixture.teamName,
          cwd: fixture.projectRealpath,
        },
        fixture.context,
      )
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toContain('exited immediately with code 42')
    expect(thrown?.message).toContain('fatal fake crash before runtime_ready')
    expect(await pathExists(fixture.markerPath)).toBe(true)

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    await waitForFileText(runtimePaths.stderrPath, 'fatal fake crash before runtime_ready')
    const events = await readTeammateRuntimeEvents(runtimePaths.eventsPath)
    expect(events.map(event => event.type)).toContain('failed')
  })

  it('drains noisy stdout and stderr pipes without blocking readiness on Windows-style paths', async () => {
    const fixture = await createFixture({ trusted: true, mode: 'pipe-flood' })

    const result = await __handleSpawnNativeProcessForTests(
      {
        name: 'alice',
        prompt: BOOTSTRAP_PROMPT,
        team_name: fixture.teamName,
        cwd: fixture.projectRealpath,
      },
      fixture.context,
    )

    expect(result.data.backend_type).toBe('process')
    expect(typeof result.data.runtime_pid).toBe('number')
    runtimePids.push(result.data.runtime_pid!)

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const stdout = await waitForFileText(
      runtimePaths.stdoutPath,
      'pipe flood stdout end',
    )
    const stderr = await waitForFileText(
      runtimePaths.stderrPath,
      'pipe flood stderr end',
    )
    expect(stdout).toContain('stdout-flood-63')
    expect(stderr).toContain('stderr-flood-63')
    expect((await stat(runtimePaths.stdoutPath)).size).toBeGreaterThan(512_000)
    expect((await stat(runtimePaths.stderrPath)).size).toBeGreaterThan(512_000)

    const events = await waitForEvents(runtimePaths.eventsPath, [
      'runtime_ready',
      'inbox_poller_ready',
      'bootstrap_submitted',
      'bootstrap_confirmed',
    ])
    expect(events.map(event => event.type)).toContain('bootstrap_confirmed')

    await waitForCondition(() => !isProcessAlive(result.data.runtime_pid!), 5_000)
    runtimePids = runtimePids.filter(pid => pid !== result.data.runtime_pid)
  })

  it('keeps stdin open so headless non-TTY teammate runtimes stay alive after bootstrap', async () => {
    const fixture = await createFixture({ trusted: true, mode: 'stdin-sensitive' })

    const result = await __handleSpawnNativeProcessForTests(
      {
        name: 'alice',
        prompt: BOOTSTRAP_PROMPT,
        team_name: fixture.teamName,
        cwd: fixture.projectRealpath,
      },
      fixture.context,
    )

    const runtimePid = result.data.runtime_pid!
    runtimePids.push(runtimePid)
    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const events = await waitForEvents(
      runtimePaths.eventsPath,
      ['runtime_ready', 'bootstrap_submitted', 'bootstrap_confirmed', 'heartbeat'],
      10_000,
    )
    expect(events.find(event => event.type === 'failed')?.detail).not.toBe(
      'stdin ended',
    )
    expect(isProcessAlive(runtimePid)).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(isProcessAlive(runtimePid)).toBe(true)

    killProcessTree(runtimePid, 'SIGTERM')
    await waitForCondition(() => !isProcessAlive(runtimePid), 7_500)
    runtimePids = runtimePids.filter(pid => pid !== runtimePid)
  })

  it('fails preflight before spawn when the target cwd disappeared', async () => {
    const fixture = await createFixture({ trusted: true })
    await rm(fixture.projectRealpath, { recursive: true, force: true })

    let thrown: Error | null = null
    try {
      await __handleSpawnNativeProcessForTests(
        {
          name: 'alice',
          prompt: BOOTSTRAP_PROMPT,
          team_name: fixture.teamName,
          cwd: fixture.projectRealpath,
        },
        fixture.context,
      )
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toContain('cwd')
    expect(thrown?.message).toContain('is unavailable')
    expect(await pathExists(fixture.markerPath)).toBe(false)
  })

  it('kills the full Windows process tree for a confirmed headless teammate', async () => {
    if (process.platform !== 'win32') {
      return
    }
    const fixture = await createFixture({ trusted: true, mode: 'hold-child' })

    const result = await __handleSpawnNativeProcessForTests(
      {
        name: 'alice',
        prompt: BOOTSTRAP_PROMPT,
        team_name: fixture.teamName,
        cwd: fixture.projectRealpath,
      },
      fixture.context,
    )

    const runtimePid = result.data.runtime_pid!
    runtimePids.push(runtimePid)
    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const events = await waitForEvents(
      runtimePaths.eventsPath,
      ['heartbeat', 'bootstrap_confirmed'],
      10_000,
    )
    const childPid = readChildPid(events)
    expect(childPid).toBeGreaterThan(0)
    runtimePids.push(childPid)
    expect(isProcessAlive(runtimePid)).toBe(true)
    expect(isProcessAlive(childPid)).toBe(true)

    await expect(
      killProcessBackendRuntime(`process:${runtimePid}`, {
        expectedAgentId: `alice@${fixture.teamName}`,
        teamName: fixture.teamName,
      }),
    ).resolves.toBe(true)

    await waitForCondition(() => !isProcessAlive(runtimePid), 7_500)
    await waitForCondition(() => !isProcessAlive(childPid), 7_500)
    runtimePids = runtimePids.filter(
      pid => pid !== runtimePid && pid !== childPid,
    )
  })
})

function snapshotEnv(keys: string[]): EnvSnapshot {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]))
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function createFixture(options: {
  trusted: boolean
  mode?:
    | 'success'
    | 'exit-before-ready'
    | 'pipe-flood'
    | 'hold-child'
    | 'stdin-sensitive'
    | 'member-name-confirmation'
}): Promise<{
  teamName: string
  projectRealpath: string
  context: ToolUseContext
  markerPath: string
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'headless-runtime-e2e-'))
  tempDirs.push(tempRoot)
  const configDir = join(tempRoot, 'claude config')
  const projectDir = join(tempRoot, 'проект с пробелом')
  await mkdir(configDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  const projectRealpath = await realpath(projectDir)
  const scriptPath = join(tempRoot, 'fake teammate runtime.mjs')
  const markerPath = join(tempRoot, 'spawned-marker.txt')
  await writeFile(scriptPath, FAKE_TEAMMATE_RUNTIME_SCRIPT)

  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '1'
  process.env[TEAMMATE_COMMAND_ENV_VAR] =
    `${quoteShellArg(process.execPath)} ${quoteShellArg(scriptPath)}`
  process.env.FAKE_TEAMMATE_EXPECTED_PROMPT = BOOTSTRAP_PROMPT
  process.env.FAKE_TEAMMATE_MODE = options.mode ?? 'success'
  process.env.FAKE_TEAMMATE_SPAWN_MARKER = markerPath

  setCwdState(projectRealpath)
  setOriginalCwd(projectRealpath)
  const projectKey = normalizePathForConfigKey(projectRealpath)
  saveGlobalConfig(current => ({
    ...current,
    teammateMode: 'auto',
    projects: options.trusted
      ? {
          ...(current.projects ?? {}),
          [projectKey]: {
            ...(current.projects?.[projectKey] ?? {}),
            hasTrustDialogAccepted: true,
          },
        }
      : {},
  }))

  const teamName = `headless-e2e-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  await writeTeamFileAsync(teamName, createTeamFile(teamName, projectRealpath))
  const { context } = createToolContext(teamName)
  return { teamName, projectRealpath, context, markerPath }
}

function readChildPid(events: Awaited<ReturnType<typeof readTeammateRuntimeEvents>>): number {
  const event = events.find(
    candidate =>
      candidate.type === 'heartbeat' &&
      typeof candidate.detail === 'string' &&
      candidate.detail.startsWith('child_pid='),
  )
  return Number.parseInt(String(event?.detail ?? '').slice('child_pid='.length), 10)
}

function createTeamFile(teamName: string, cwd: string): TeamFile {
  const now = Date.now()
  return {
    name: teamName,
    createdAt: now,
    leadAgentId: TEAM_LEAD_NAME,
    leadSessionId: 'leader-session',
    members: [
      {
        agentId: TEAM_LEAD_NAME,
        name: TEAM_LEAD_NAME,
        joinedAt: now,
        tmuxPaneId: 'leader',
        cwd,
        subscriptions: [],
      },
    ],
  }
}

function createToolContext(teamName: string): { context: ToolUseContext } {
  let appState = {
    ...getDefaultAppState(),
    teamContext: {
      teamName,
      teamFilePath: getTeamFilePath(teamName),
      leadAgentId: TEAM_LEAD_NAME,
      teammates: {},
      isLeader: true,
    },
  } as AppState

  return {
    context: {
      toolUseId: 'process-backend-e2e-tool-use',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState) as AppState
      },
    } as ToolUseContext,
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function waitForFileText(
  path: string,
  expected: string,
  timeoutMs = 5_000,
): Promise<string> {
  let latest = ''
  await waitForCondition(async () => {
    try {
      latest = await readFile(path, 'utf8')
    } catch {
      latest = ''
    }
    return latest.includes(expected)
  }, timeoutMs)
  return latest
}

async function waitForEvents(
  eventsPath: string,
  expectedTypes: string[],
  timeoutMs = 5_000,
) {
  let events = await readTeammateRuntimeEvents(eventsPath)
  await waitForCondition(async () => {
    events = await readTeammateRuntimeEvents(eventsPath)
    return expectedTypes.every(type =>
      events.some(event => event.type === type),
    )
  }, timeoutMs)
  return events
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out after ${timeoutMs}ms`)
}
