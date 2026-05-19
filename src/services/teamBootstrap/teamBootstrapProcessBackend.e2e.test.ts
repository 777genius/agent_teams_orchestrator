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
const WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS = 3_000
const WINDOWS_TEMP_RM_ATTEMPTS = 10
const WINDOWS_TEMP_RM_DELAY_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForRuntimePidsToExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (pids.every(pid => !isProcessAlive(pid))) {
      return
    }
    await sleep(WINDOWS_TEMP_RM_DELAY_MS)
  }
}

async function removeTempDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= WINDOWS_TEMP_RM_ATTEMPTS; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (
        attempt === WINDOWS_TEMP_RM_ATTEMPTS ||
        (error as NodeJS.ErrnoException).code !== 'EBUSY'
      ) {
        throw error
      }
      await sleep(WINDOWS_TEMP_RM_DELAY_MS)
    }
  }
}

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
const teammateRuntimeEnv = process.env.CLAUDE_CODE_TEAMMATE_RUNTIME
const eventsPath = process.env.CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH
const configDir = process.env.CLAUDE_CONFIG_DIR
const expectedPrompt = process.env.FAKE_TEAMMATE_EXPECTED_PROMPT || ''
const markerPath = process.env.FAKE_TEAMMATE_SPAWN_MARKER
const mode = process.env.FAKE_TEAMMATE_MODE || 'success'
const runtimeReadyDelayMs = Number(
  process.env.FAKE_TEAMMATE_RUNTIME_READY_DELAY_MS || '0',
)
const inboxReadyDelayMs = Number(
  process.env.FAKE_TEAMMATE_INBOX_READY_DELAY_MS || '0',
)

async function writeEvent(type, detail, extra = {}) {
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
      ...extra,
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
  await writeEvent(
    'cli_started',
    'teammateRuntime=' + teammateRuntime + ';env=' + teammateRuntimeEnv,
  )

  if (mode === 'exit-before-ready') {
    console.error('fatal fake crash before runtime_ready')
    process.exit(42)
  }

  if (teammateRuntime !== 'headless') {
    await writeEvent('failed', 'missing headless teammate runtime flag')
    process.exit(2)
  }
  if (teammateRuntimeEnv !== 'headless') {
    await writeEvent('failed', 'missing headless teammate runtime env')
    process.exit(3)
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

  if (mode === 'delay-runtime-ready' && runtimeReadyDelayMs > 0) {
    await sleep(runtimeReadyDelayMs)
  }

  await writeEvent('runtime_ready', 'headless flag accepted')

  const promptMessage = await waitForBootstrapPrompt()
  const bootstrapMirror = promptMessage.messageId
    ? { bootstrapMirrorId: String(promptMessage.messageId) }
    : {}

  if (mode === 'skip-inbox-poller-ready') {
    await writeEvent(
      'bootstrap_prompt_observed',
      'bootstrap prompt observed before inbox poller readiness',
      bootstrapMirror,
    )
    await sleep(60_000)
    process.exit(0)
  }

  if (mode === 'exit-after-mailbox-before-inbox-ready') {
    console.error('fatal fake exit after mailbox bootstrap write')
    process.exit(43)
  }

  if (mode === 'delay-inbox-poller-ready' && inboxReadyDelayMs > 0) {
    await sleep(inboxReadyDelayMs)
  }

  await writeEvent(
    'inbox_poller_ready',
    'initial poll observed bootstrap prompt',
    bootstrapMirror,
  )
  await writeEvent('bootstrap_prompt_observed', 'bootstrap prompt observed', bootstrapMirror)
  await writeEvent(
    'bootstrap_submit_attempted',
    'submitting bootstrap prompt',
    bootstrapMirror,
  )
  if (mode === 'skip-bootstrap-submit-after-inbox-ready') {
    await sleep(60_000)
    process.exit(0)
  }
  if (mode === 'exit-after-bootstrap-submit-attempt') {
    console.error('fatal fake exit after bootstrap submit attempt')
    await sleep(750)
    process.exit(44)
  }
  if (mode === 'submit-rejected-terminal') {
    await writeEvent(
      'bootstrap_submit_rejected',
      'fatal submit rejection',
      {
        ...bootstrapMirror,
        retryable: false,
      },
    )
    await sleep(60_000)
    process.exit(0)
  }
  if (mode === 'accepted-without-uuid') {
    await writeEvent(
      'bootstrap_submit_accepted_without_uuid',
      'accepted but missing message id',
      { ...bootstrapMirror, retryable: false },
    )
    await sleep(60_000)
    process.exit(0)
  }
  if (mode === 'submit-rejected-then-accepted') {
    await writeEvent('bootstrap_submit_rejected', 'cooldown before retry', {
      ...bootstrapMirror,
      retryable: true,
      attempt: 1,
    })
    await sleep(50)
    await writeEvent('bootstrap_submit_attempted', 'retrying bootstrap prompt', {
      ...bootstrapMirror,
      attempt: 2,
    })
  }
  if (mode === 'corrupt-event-before-submit' && eventsPath) {
    await appendFile(eventsPath, '{"type":\n')
  }
  await writeEvent(
    'bootstrap_submitted',
    'messageId=' + String(promptMessage.messageId || 'missing'),
    bootstrapMirror,
  )
  await writeLeaderConfirmation()
  await writeEvent('bootstrap_confirmed', 'leader idle notification written', bootstrapMirror)
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
    'FAKE_TEAMMATE_RUNTIME_READY_DELAY_MS',
    'FAKE_TEAMMATE_INBOX_READY_DELAY_MS',
    'CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS',
    'CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS',
  ])
  originalCwdState = getCwdState()
  originalOriginalCwd = getOriginalCwd()
  originalGlobalConfig = structuredClone(getGlobalConfig())
})

afterEach(async () => {
  __setTeamBootstrapRunnerDepsForTests(null)
  const pidsToCleanup = [...runtimePids]
  for (const pid of runtimePids) {
    if (isProcessAlive(pid)) {
      killProcessTree(pid, 'SIGTERM')
    }
  }
  await waitForRuntimePidsToExit(pidsToCleanup)
  runtimePids = []
  await Promise.all(
    tempDirs.map(dir => removeTempDirWithRetry(dir)),
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

    const bootstrapResult = await runTeamBootstrap({
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

    if (!bootstrapResult.ok) {
      throw new Error(bootstrapResult.error)
    }
    expect(bootstrapResult.ok).toBe(true)
    expect(bootstrapResult.summary.terminalStatus).toBe('completed')
    expect(bootstrapResult.summary.registeredMembers).toEqual(['alice'])
    expect(bootstrapResult.summary.failedMembers).toEqual([])
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
      'mailbox_bootstrap_written',
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
      events.find(event => event.type === 'cli_started')?.detail,
    ).toContain('env=headless')
    expect(
      events.find(event => event.type === 'runtime_ready')?.pid,
    ).toBe(alice?.runtimePid)
    const mailboxWritten = events.find(
      event => event.type === 'mailbox_bootstrap_written',
    )
    const submitted = events.find(event => event.type === 'bootstrap_submitted')
    const confirmed = events.find(event => event.type === 'bootstrap_confirmed')
    expect(submitted?.bootstrapMirrorId).toBe(mailboxWritten?.bootstrapMirrorId)
    expect(submitted?.bootstrapMirrorId).toBeTruthy()
    expect(confirmed?.bootstrapMirrorId).toBe(mailboxWritten?.bootstrapMirrorId)

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

  it('keeps retryable bootstrap submit rejection pending until a later submit succeeds', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'submit-rejected-then-accepted',
    })

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
    const events = await waitForEvents(runtimePaths.eventsPath, [
      'bootstrap_submit_rejected',
      'bootstrap_submitted',
      'bootstrap_confirmed',
    ])
    const rejected = events.find(event => event.type === 'bootstrap_submit_rejected')
    expect(rejected?.retryable).toBe(true)
    expect(events.map(event => event.type)).toContain('bootstrap_submitted')

    await waitForCondition(() => !isProcessAlive(result.data.runtime_pid!), 5_000)
    runtimePids = runtimePids.filter(pid => pid !== result.data.runtime_pid)
  })

  it('treats non-retryable bootstrap submit rejection as a terminal spawn failure', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'submit-rejected-terminal',
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

    expect(thrown?.message).toContain('fatal submit rejection')

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const events = await readTeammateRuntimeEvents(runtimePaths.eventsPath)
    const rejected = events.find(event => event.type === 'bootstrap_submit_rejected')
    expect(rejected?.retryable).toBe(false)
  })

  it('treats accepted bootstrap submit without a message id as terminal', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'accepted-without-uuid',
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

    expect(thrown?.message).toContain('accepted but missing message id')

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const events = await readTeammateRuntimeEvents(runtimePaths.eventsPath)
    expect(events.map(event => event.type)).toContain(
      'bootstrap_submit_accepted_without_uuid',
    )
  })

  it('ignores malformed runtime event lines while waiting for bootstrap submit proof', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'corrupt-event-before-submit',
    })

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
    const events = await waitForEvents(runtimePaths.eventsPath, [
      'bootstrap_submitted',
      'bootstrap_confirmed',
    ])
    expect(events.map(event => event.type)).toContain('bootstrap_submitted')

    await waitForCondition(() => !isProcessAlive(result.data.runtime_pid!), 5_000)
    runtimePids = runtimePids.filter(pid => pid !== result.data.runtime_pid)
  })

  it('accepts slow runtime_ready when the process startup timeout is raised', async () => {
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS = '1000'
    process.env.FAKE_TEAMMATE_RUNTIME_READY_DELAY_MS = '120'
    const fixture = await createFixture({
      trusted: true,
      mode: 'delay-runtime-ready',
    })

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
    const events = await waitForEvents(runtimePaths.eventsPath, [
      'runtime_ready',
      'inbox_poller_ready',
      'bootstrap_submitted',
      'bootstrap_confirmed',
    ])
    const eventTypes = events.map(event => event.type)
    expect(eventTypes.indexOf('runtime_ready')).toBeLessThan(
      eventTypes.indexOf('mailbox_bootstrap_written'),
    )
    expect(eventTypes.indexOf('mailbox_bootstrap_written')).toBeLessThan(
      eventTypes.indexOf('bootstrap_submitted'),
    )

    await waitForCondition(() => !isProcessAlive(result.data.runtime_pid!), 5_000)
    runtimePids = runtimePids.filter(pid => pid !== result.data.runtime_pid)
  })

  it('accepts slow inbox_poller_ready after verified mailbox bootstrap write', async () => {
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS = '1000'
    process.env.FAKE_TEAMMATE_INBOX_READY_DELAY_MS = '150'
    const fixture = await createFixture({
      trusted: true,
      mode: 'delay-inbox-poller-ready',
    })

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
    const events = await waitForEvents(runtimePaths.eventsPath, [
      'mailbox_bootstrap_written',
      'inbox_poller_ready',
      'bootstrap_submitted',
      'bootstrap_confirmed',
    ])
    const eventTypes = events.map(event => event.type)
    expect(eventTypes.indexOf('mailbox_bootstrap_written')).toBeLessThan(
      eventTypes.indexOf('inbox_poller_ready'),
    )
    expect(eventTypes.indexOf('inbox_poller_ready')).toBeLessThan(
      eventTypes.indexOf('bootstrap_submitted'),
    )
    const mailboxWritten = events.find(
      event => event.type === 'mailbox_bootstrap_written',
    )
    const inboxReady = events.find(event => event.type === 'inbox_poller_ready')
    expect(inboxReady?.bootstrapMirrorId).toBe(mailboxWritten?.bootstrapMirrorId)

    await waitForCondition(() => !isProcessAlive(result.data.runtime_pid!), 5_000)
    runtimePids = runtimePids.filter(pid => pid !== result.data.runtime_pid)
  })

  it('fails clearly when mailbox bootstrap is written but inbox polling never becomes ready', async () => {
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS = '80'
    const fixture = await createFixture({
      trusted: true,
      mode: 'skip-inbox-poller-ready',
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

    expect(thrown?.message).toContain('did not become inbox_poller_ready')
    expect(thrown?.message).toContain('timed out waiting for inbox_poller_ready')

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const events = await waitForEvents(
      runtimePaths.eventsPath,
      ['runtime_ready', 'mailbox_bootstrap_written', 'failed'],
      2_000,
    )
    const eventTypes = events.map(event => event.type)
    expect(eventTypes).toContain('bootstrap_prompt_observed')
    expect(eventTypes).not.toContain('inbox_poller_ready')
    const failed = events.find(event => event.type === 'failed')
    expect(failed?.detail).toContain('timed out waiting for inbox_poller_ready')
  })

  it('fails clearly when the runtime exits after mailbox bootstrap write before inbox polling readiness', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'exit-after-mailbox-before-inbox-ready',
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

    expect(thrown?.message).toContain('did not become inbox_poller_ready')
    expect(thrown?.message).toContain('teammate process exited before inbox_poller_ready')

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    await waitForFileText(
      runtimePaths.stderrPath,
      'fatal fake exit after mailbox bootstrap write',
    )
    const events = await waitForEvents(
      runtimePaths.eventsPath,
      ['runtime_ready', 'mailbox_bootstrap_written', 'failed'],
      2_000,
    )
    const eventTypes = events.map(event => event.type)
    expect(eventTypes).not.toContain('inbox_poller_ready')
    expect(events.find(event => event.type === 'failed')?.detail).toContain(
      'teammate process exited before inbox_poller_ready',
    )
  })

  it('fails clearly when inbox polling starts but durable bootstrap submission never appears', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'skip-bootstrap-submit-after-inbox-ready',
    })

    let thrown: Error | null = null
    try {
      await __handleSpawnNativeProcessForTests(
        {
          name: 'alice',
          prompt: BOOTSTRAP_PROMPT,
          team_name: fixture.teamName,
          cwd: fixture.projectRealpath,
          bootstrapTimeoutMs: 1_600,
        },
        fixture.context,
      )
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toContain('did not submit bootstrap prompt')
    expect(thrown?.message).toContain('timed out waiting for bootstrap_submitted')
    expect(thrown?.message).toContain('last transport stage: bootstrap_submit_attempted')

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const events = await waitForEvents(
      runtimePaths.eventsPath,
      [
        'mailbox_bootstrap_written',
        'inbox_poller_ready',
        'bootstrap_prompt_observed',
        'bootstrap_submit_attempted',
        'failed',
      ],
      3_000,
    )
    const eventTypes = events.map(event => event.type)
    expect(eventTypes).not.toContain('bootstrap_submitted')
    const mailboxWritten = events.find(
      event => event.type === 'mailbox_bootstrap_written',
    )
    const attempted = events.find(
      event => event.type === 'bootstrap_submit_attempted',
    )
    expect(attempted?.bootstrapMirrorId).toBe(mailboxWritten?.bootstrapMirrorId)
    expect(events.find(event => event.type === 'failed')?.detail).toContain(
      'last transport stage: bootstrap_submit_attempted',
    )
  })

  it('fails clearly when the runtime exits after submit attempt before durable bootstrap submission', async () => {
    const fixture = await createFixture({
      trusted: true,
      mode: 'exit-after-bootstrap-submit-attempt',
    })

    let thrown: Error | null = null
    try {
      await __handleSpawnNativeProcessForTests(
        {
          name: 'alice',
          prompt: BOOTSTRAP_PROMPT,
          team_name: fixture.teamName,
          cwd: fixture.projectRealpath,
          bootstrapTimeoutMs: 2_000,
        },
        fixture.context,
      )
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toContain('did not submit bootstrap prompt')
    expect(thrown?.message).toContain('teammate process exited before bootstrap_submitted')
    expect(thrown?.message).toContain('fatal fake exit after bootstrap submit attempt')

    const runtimePaths = getTeammateRuntimePaths({
      teamName: fixture.teamName,
      agentName: 'alice',
    })
    const events = await waitForEvents(
      runtimePaths.eventsPath,
      [
        'mailbox_bootstrap_written',
        'inbox_poller_ready',
        'bootstrap_submit_attempted',
        'failed',
      ],
      3_000,
    )
    const eventTypes = events.map(event => event.type)
    expect(eventTypes).not.toContain('bootstrap_submitted')
    expect(events.find(event => event.type === 'failed')?.detail).toContain(
      'teammate process exited before bootstrap_submitted',
    )
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
    | 'delay-runtime-ready'
    | 'delay-inbox-poller-ready'
    | 'skip-inbox-poller-ready'
    | 'exit-after-mailbox-before-inbox-ready'
    | 'skip-bootstrap-submit-after-inbox-ready'
    | 'exit-after-bootstrap-submit-attempt'
    | 'submit-rejected-then-accepted'
    | 'submit-rejected-terminal'
    | 'accepted-without-uuid'
    | 'corrupt-event-before-submit'
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
