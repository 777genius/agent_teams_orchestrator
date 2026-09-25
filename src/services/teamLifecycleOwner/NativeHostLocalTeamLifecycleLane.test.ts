import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isProcessAlive } from '../../utils/processKill.js'
import { DurableTeamLifecycleExecution } from './DurableTeamLifecycleExecution.js'
import { NativeHostLocalLaneError } from './NativeHostLocalLanePlan.js'
import {
  createProductionNativeProcessPort,
  sweepNativeTeamProcesses,
  type NativeHostLocalProcessPort,
} from './NativeHostLocalLaneProcesses.js'
import {
  NATIVE_LANE_RUNTIME_RECORD_FILE,
  nativeLaneTeamRuntimeKey,
  NativeHostLocalTeamLifecycleLane,
  type NativeHostLocalLaneDependencies,
} from './NativeHostLocalTeamLifecycleLane.js'
import type { TeamLifecycleLaneEffectPort } from './OpenCodeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchLane, TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'fakeNativeLead.ts')
const TOKEN = `sk-ant-oat01-${'a'.repeat(48)}`
const nativeLane: TeamLifecycleLaunchLane = {
  laneId: 'lane_native',
  kind: 'native',
  provider: 'anthropic',
  members: [
    { name: 'team-lead', prompt: 'Lead the hosted team.', model: 'claude-opus-4-6', effort: 'high' },
    { name: 'worker', prompt: 'Implement the assigned tasks.' },
  ],
}
const supportedOnHost = process.platform === 'linux' || process.platform === 'darwin'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined)
})

type Harness = Awaited<ReturnType<typeof createHarness>>

async function createHarness() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'native-lane-')))
  const team = `hosted-team-${randomBytes(4).toString('hex')}`
  const claudeRoot = join(base, 'claude')
  const teamRoot = join(claudeRoot, 'teams', team)
  const workspaceRoot = join(base, 'workspace')
  const tokenFile = join(base, 'operator', 'claude-oauth-token')
  const privateParent = join(base, 'host-private')
  await mkdir(privateParent, { mode: 0o700 })
  await mkdir(teamRoot, { recursive: true, mode: 0o700 })
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(join(base, 'operator'), { mode: 0o700 })
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  const spawned: Array<{ args: readonly string[]; env: Record<string, string> }> = []
  const children: ChildProcess[] = []
  const dependencies: NativeHostLocalLaneDependencies = {
    preflight: async () => undefined,
    ensureWorkspaceTrust: async () => undefined,
    hostEnv: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: 'host-api-key-must-not-leak',
      OPENAI_API_KEY: 'host-openai-key-must-not-leak',
      CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token-must-not-leak',
      CLAUDE_CONFIG_DIR: '/host/claude-config-must-not-leak',
      GITHUB_TOKEN: 'host-github-token-must-not-leak',
    },
    spawnLead: (command: string, args: readonly string[], options: SpawnOptions) => {
      spawned.push({ args, env: options.env as Record<string, string> })
      const child = spawn(command, [...args], options)
      children.push(child)
      return child
    },
  }
  const createLane = (overrides: NativeHostLocalLaneDependencies = {}) => new NativeHostLocalTeamLifecycleLane(
    { claudeRoot, teamRoot, legacyKey: team },
    {
      ownerCommand: { command: process.execPath, args: [FIXTURE] },
      anthropic: { oauthTokenFile: tokenFile },
      resolveMcpServer: async () => ({ command: '/usr/bin/env', args: ['agent-teams-mcp'] }),
      privateRuntimeParent: privateParent,
    },
    { ...dependencies, ...overrides },
  )
  const runtimeRoot = join(privateParent, `agent-teams-native-lane-${process.getuid!()}`, nativeLaneTeamRuntimeKey(teamRoot))
  const harness = { base, team, runtimeRoot, claudeRoot, teamRoot, workspaceRoot, tokenFile, spawned, children, createLane }
  cleanups.push(async () => {
    await createLane().stop(input('run_cleanup')).catch(() => undefined)
    for (const child of children) child.kill('SIGKILL')
    await rm(base, { recursive: true, force: true })
  })
  return harness

  function input(runId: string) {
    return { planTeamId: 'team_hosted', workspaceRoot, toolApprovalMode: 'auto' as const, lane: nativeLane, runId }
  }
}

function laneInput(harness: Harness, runId: string, lane: TeamLifecycleLaunchLane = nativeLane) {
  return {
    planTeamId: 'team_hosted',
    workspaceRoot: harness.workspaceRoot,
    toolApprovalMode: 'auto' as const,
    lane,
    runId,
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    value = await read()
  }
  return value
}

async function teammatePids(teamRoot: string): Promise<number[]> {
  const config = JSON.parse(await readFile(join(teamRoot, 'config.json'), 'utf8')) as {
    members: Array<{ runtimePid: number }>
  }
  return config.members.map(member => member.runtimePid)
}

async function livePidsForTeam(team: string): Promise<number[]> {
  const listed = await createProductionNativeProcessPort().listProcesses()
  return (listed ?? []).filter(entry => entry.command.includes(`--team-name ${team}`)).map(entry => entry.pid)
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

describe.skipIf(!supportedOnHost)('NativeHostLocalTeamLifecycleLane process lifecycle', () => {
  test('launches the lead, reports bootstrap completion, and stops the whole team', async () => {
    const harness = await createHarness()
    const lane = harness.createLane()
    const run = laneInput(harness, 'run_first')

    expect(await lane.launch(run)).toEqual({ phase: 'launching', recoverable: false })
    const record = JSON.parse(await readFile(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE), 'utf8'))
    expect(record.runId).toBe('run_first')
    // Launch material the lead executes from never lives in the Product-shared Claude root.
    expect(record.runtimeDir).toBe(join(harness.runtimeRoot, 'run_first'))
    expect(record.runtimeDir.startsWith(harness.claudeRoot)).toBe(false)
    expect(isProcessAlive(record.pid)).toBe(true)
    expect((await lstat(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE))).mode & 0o777).toBe(0o600)

    expect(await eventually(() => lane.inspect(run), observed => observed.phase === 'running'))
      .toEqual({ phase: 'running', recoverable: false })
    const [teammatePid] = await teammatePids(harness.teamRoot)
    expect(isProcessAlive(teammatePid!)).toBe(true)
    expect(harness.spawned[0]!.args).toEqual(expect.arrayContaining([
      '--team-bootstrap-spec', join(record.runtimeDir, 'bootstrap-spec.json'),
      '--model', 'claude-opus-4-6', '--effort', 'high', '--dangerously-skip-permissions',
    ]))
    const spec = JSON.parse(await readFile(join(record.runtimeDir, 'bootstrap-spec.json'), 'utf8'))
    expect(spec.members).toEqual([{
      name: 'worker', workflow: 'Implement the assigned tasks.', cwd: harness.workspaceRoot, provider: 'anthropic',
    }])
    expect(await readFile(join(record.runtimeDir, 'lead-prompt.txt'), 'utf8')).toBe('Lead the hosted team.')

    expect(await lane.stop(run)).toEqual({ phase: 'idle', recoverable: false })
    expect(isProcessAlive(record.pid)).toBe(false)
    expect(isProcessAlive(teammatePid!)).toBe(false)
    expect(await livePidsForTeam(harness.team)).toEqual([])
    expect(await exists(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE))).toBe(false)
    expect(await exists(record.runtimeDir)).toBe(false)
    expect(await lane.inspect(run)).toEqual({ phase: 'idle', recoverable: false })
  }, 30_000)

  test('a hosted draft placeholder makes the bootstrap create the team in place', async () => {
    const harness = await createHarness()
    await writeFile(join(harness.teamRoot, 'config.json'),
      `${JSON.stringify({ name: harness.team, pendingCreate: true }, null, 2)}\n`)
    const lane = harness.createLane()
    await lane.launch(laneInput(harness, 'run_draft'))
    const record = JSON.parse(await readFile(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE), 'utf8'))
    const spec = JSON.parse(await readFile(join(record.runtimeDir, 'bootstrap-spec.json'), 'utf8'))
    expect(spec.mode).toBe('create')
    expect(spec.team.name).toBe(harness.team)
    await lane.stop(laneInput(harness, 'run_draft'))
  }, 30_000)

  test('builds the lead env from an allowlist and only the configured credential', async () => {
    const harness = await createHarness()
    const lane = harness.createLane()
    await lane.launch(laneInput(harness, 'run_env'))
    const env = harness.spawned[0]!.env
    expect(Object.keys(env).sort()).toEqual([
      'AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE', 'CLAUDE_CODE_ENTRY_PROVIDER', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CONFIG_DIR', 'CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP',
      'CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES', 'CLAUDE_TEAM_HOSTED_LEAD_INBOX_POLL', 'HOME', 'PATH',
    ])
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
    expect(env.CLAUDE_CONFIG_DIR).toBe(harness.claudeRoot)
    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic')
    expect(Object.values(env).some(value => value.includes('must-not-leak'))).toBe(false)
    // The credential never reaches the shared Claude root through lane-written files.
    const record = JSON.parse(await readFile(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE), 'utf8'))
    for (const file of ['bootstrap-spec.json', 'lead-prompt.txt', 'mcp-config.json']) {
      expect(await readFile(join(record.runtimeDir, file), 'utf8')).not.toContain(TOKEN)
    }
    expect(await readFile(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE), 'utf8')).not.toContain(TOKEN)
  }, 30_000)

  test('stopping mid-bootstrap also reaps teammates the frozen lead already started', async () => {
    const harness = await createHarness()
    const lane = harness.createLane()
    const run = laneInput(harness, 'run_mid_bootstrap')
    await lane.launch(run)
    // Let the fake lead publish its teammate claim and start the teammate process.
    await eventually(() => exists(join(harness.teamRoot, 'config.json')), Boolean)
    expect(await lane.stop(run)).toEqual({ phase: 'idle', recoverable: false })
    expect(await livePidsForTeam(harness.team)).toEqual([])
  }, 30_000)

  test('a restarted owner reports the orphan as recoverable and sweeps it before a new launch', async () => {
    const harness = await createHarness()
    const crashedOwner = harness.createLane()
    const firstRun = laneInput(harness, 'run_crashed')
    await crashedOwner.launch(firstRun)
    await eventually(() => crashedOwner.inspect(firstRun), observed => observed.phase === 'running')
    const orphanLead = JSON.parse(await readFile(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE), 'utf8')).pid
    const [orphanTeammate] = await teammatePids(harness.teamRoot)

    const restartedOwner = harness.createLane()
    expect(await restartedOwner.inspect(firstRun)).toEqual({ phase: 'failed', recoverable: true })
    await expect(restartedOwner.launch(firstRun)).rejects.toMatchObject({ code: 'native_lane_run_not_owned' })

    const nextRun = laneInput(harness, 'run_next')
    expect(await restartedOwner.launch(nextRun)).toEqual({ phase: 'launching', recoverable: false })
    expect(isProcessAlive(orphanLead)).toBe(false)
    expect(isProcessAlive(orphanTeammate!)).toBe(false)
    expect(await eventually(() => restartedOwner.inspect(nextRun), observed => observed.phase === 'running'))
      .toEqual({ phase: 'running', recoverable: false })
    expect(await restartedOwner.recover(nextRun)).toEqual({ phase: 'idle', recoverable: false })
  }, 30_000)

  test('a lead that exits turns the run into a recoverable failure', async () => {
    const harness = await createHarness()
    const lane = harness.createLane()
    const run = laneInput(harness, 'run_exit')
    await lane.launch(run)
    await eventually(() => lane.inspect(run), observed => observed.phase === 'running')
    const child = harness.children[0]!
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
    expect(await lane.inspect(run)).toEqual({ phase: 'failed', recoverable: true })
    expect(await lane.recover(run)).toEqual({ phase: 'idle', recoverable: false })
  }, 30_000)
})

describe('NativeHostLocalTeamLifecycleLane admission and typed failures', () => {
  test('rejects a provider preflight failure before any process or record exists', async () => {
    const harness = await createHarness()
    const lane = harness.createLane({
      preflight: async () => { throw new NativeHostLocalLaneError('native_lane_provider_not_authenticated') },
      platform: 'linux',
      processes: emptyProcessPort(),
    })
    await expect(lane.launch(laneInput(harness, 'run_auth'))).rejects.toMatchObject({
      code: 'native_lane_provider_not_authenticated',
    })
    expect(harness.spawned).toHaveLength(0)
    expect(await exists(join(harness.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE))).toBe(false)
  })

  test('refuses a Claude token stored inside the shared Claude root', async () => {
    const harness = await createHarness()
    const insideRoot = join(harness.claudeRoot, '.oauth-token')
    await writeFile(insideRoot, TOKEN, { mode: 0o600 })
    const lane = new NativeHostLocalTeamLifecycleLane(
      { claudeRoot: harness.claudeRoot, teamRoot: harness.teamRoot, legacyKey: harness.team },
      {
        ownerCommand: { command: process.execPath, args: [FIXTURE] },
        anthropic: { oauthTokenFile: insideRoot },
        resolveMcpServer: async () => ({ command: '/usr/bin/env', args: [] }),
        privateRuntimeParent: join(harness.base, 'host-private'),
      },
      { preflight: async () => undefined, platform: 'linux', processes: emptyProcessPort() },
    )
    await expect(lane.launch(laneInput(harness, 'run_token'))).rejects.toMatchObject({
      code: 'native_lane_credentials_unavailable',
    })
  })

  test('refuses a Codex home or binary that resolves into the shared Claude root', async () => {
    const harness = await createHarness()
    const outside = join(harness.base, 'operator', 'codex')
    await writeFile(outside, '#!/bin/sh\n', { mode: 0o700 })
    const insideHome = join(harness.claudeRoot, 'codex-home')
    await mkdir(insideHome)
    const codexLane = { ...nativeLane, provider: 'codex' as const }
    const lane = new NativeHostLocalTeamLifecycleLane(
      { claudeRoot: harness.claudeRoot, teamRoot: harness.teamRoot, legacyKey: harness.team },
      {
        ownerCommand: { command: process.execPath, args: [FIXTURE] },
        codex: { codexHome: insideHome, codexCliPath: outside },
        resolveMcpServer: async () => ({ command: '/usr/bin/env', args: [] }),
        privateRuntimeParent: join(harness.base, 'host-private'),
      },
      { preflight: async () => undefined, platform: 'linux', processes: emptyProcessPort() },
    )
    await expect(lane.launch(laneInput(harness, 'run_codex', codexLane))).rejects.toMatchObject({
      code: 'native_lane_credentials_unavailable',
    })
  })

  test('refuses a token file readable by group or others', async () => {
    const harness = await createHarness()
    await chmod(harness.tokenFile, 0o640)
    const lane = harness.createLane({ platform: 'linux', processes: emptyProcessPort() })
    await expect(lane.launch(laneInput(harness, 'run_mode'))).rejects.toMatchObject({
      code: 'native_lane_credentials_unavailable',
    })
    expect(harness.spawned).toHaveLength(0)
  })

  test('fails closed when an orphan lead cannot be bound to an exact process identity', async () => {
    const harness = await createHarness()
    const orphanCommand = `bun lead --team-bootstrap-spec ${harness.runtimeRoot}/run_old/bootstrap-spec.json`
    const lane = harness.createLane({
      platform: 'linux',
      processes: {
        ...emptyProcessPort(),
        listProcesses: async () => [{ pid: 424242, command: orphanCommand }],
        readCommand: async () => orphanCommand,
        readStartedAt: async () => 7,
        captureIdentity: async () => null,
      },
    })
    await expect(lane.launch(laneInput(harness, 'run_blocked'))).rejects.toMatchObject({
      code: 'native_lane_orphan_sweep_unconfirmed',
    })
    expect(harness.spawned).toHaveLength(0)
    await expect(lane.stop(laneInput(harness, 'run_blocked'))).rejects.toMatchObject({
      code: 'native_lane_stop_unconfirmed',
    })
  })

  test('admits only a single-provider native plan with team-lead', async () => {
    const harness = await createHarness()
    const lane = harness.createLane({ platform: 'linux' })
    const plan = (lanes: TeamLifecycleLaunchLane[], toolApprovalMode: 'auto' | 'manual' = 'auto'): TeamLifecycleLaunchPlan => ({
      schemaVersion: 2, workspaceId: 'workspace_1', teamId: 'team_1', workspaceRoot: harness.workspaceRoot,
      toolApprovalMode, lanes,
    })
    const openCodeLane: TeamLifecycleLaunchLane = {
      laneId: 'lane_opencode', kind: 'opencode', provider: 'opencode', selectedModel: 'opencode/test',
      members: [{ name: 'helper', prompt: 'Help.' }],
    }
    expect(lane.supports()).toBe(true)
    expect(lane.supportsPlan(plan([nativeLane]))).toBe(true)
    expect(lane.supportsPlan(plan([nativeLane, openCodeLane]))).toBe(false)
    expect(lane.supportsPlan(plan([nativeLane], 'manual'))).toBe(false)
    expect(lane.supportsPlan(plan([{ ...nativeLane, provider: 'codex' }]))).toBe(false)
    expect(lane.supportsPlan(plan([{ ...nativeLane, provider: 'gemini' }]))).toBe(false)
    expect(lane.supportsPlan(plan([{ ...nativeLane, members: [{ name: 'worker', prompt: 'Work.' }] }]))).toBe(false)
    expect(harness.createLane({ platform: 'win32' }).supports()).toBe(false)

    // The durable owner consults plan admission, so a mixed plan is never launched.
    const openCodeAdapter: TeamLifecycleLaneEffectPort = {
      kind: 'opencode',
      supports: () => true,
      inspect: async () => ({ phase: 'idle', recoverable: false }),
      launch: async () => ({ phase: 'running', recoverable: false }),
      cancel: async () => ({ phase: 'idle', recoverable: false }),
      stop: async () => ({ phase: 'idle', recoverable: false }),
      recover: async () => ({ phase: 'idle', recoverable: false }),
    }
    const execution = new DurableTeamLifecycleExecution(join(harness.teamRoot, 'execution.json'), [lane, openCodeAdapter])
    expect(execution.supports(plan([nativeLane]), 'launch')).toBe(true)
    expect(execution.supports(plan([nativeLane, openCodeLane]), 'launch')).toBe(false)
    expect(execution.supports(plan([openCodeLane]), 'launch')).toBe(true)
  })
})

describe('sweepNativeTeamProcesses team config trust', () => {
  test('a hosted draft placeholder records no teammates, a malformed member list fails closed', async () => {
    const harness = await createHarness()
    const sweep = () => sweepNativeTeamProcesses({
      port: emptyProcessPort(), teamRoot: harness.teamRoot, teamName: harness.team,
      leadSpecPrefix: `${harness.runtimeRoot}/`,
    })
    const config = join(harness.teamRoot, 'config.json')
    await writeFile(config, `${JSON.stringify({ name: harness.team, pendingCreate: true }, null, 2)}\n`)
    expect(await sweep()).toBe(true)
    await writeFile(config, JSON.stringify({ name: harness.team, members: 'corrupt' }))
    expect(await sweep()).toBe(false)
    await writeFile(config, JSON.stringify({ name: 'another-team', members: [] }))
    expect(await sweep()).toBe(false)
  })
})

function emptyProcessPort(): NativeHostLocalProcessPort {
  return {
    listProcesses: async () => [],
    readCommand: async () => null,
    readStartedAt: async () => null,
    captureIdentity: async () => null,
    terminateTree: async () => undefined,
    isAlive: () => false,
    isGroupEmpty: async () => true,
  }
}
