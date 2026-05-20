import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getCwdState,
  getOriginalCwd,
  resetStateForTests,
  setCwdState,
  setFlagMcpConfig,
  setIsInteractive,
  setOriginalCwd,
  setStrictMcpConfig,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from '../../utils/config.js'
import { normalizePathForConfigKey } from '../../utils/path.js'
import { isProcessAlive, killProcessTree } from '../../utils/processKill.js'
import { TEAMMATE_COMMAND_ENV_VAR, TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  readTeammateRuntimeEvents,
} from '../../utils/swarm/teammateRuntimeEvents.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'

const PROCESS_FALLBACK_PROMPT = 'process fallback route prompt'

const FAKE_PROCESS_FALLBACK_RUNTIME = String.raw`
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
const hasFlag = flag => args.includes(flag)
const teammateRuntimeEnv = process.env.CLAUDE_CODE_TEAMMATE_RUNTIME
const eventsPath = process.env.CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH
const configDir = process.env.CLAUDE_CONFIG_DIR
const expectedPrompt = process.env.FAKE_PROCESS_FALLBACK_EXPECTED_PROMPT || ''
const expectedMcpConfig = process.env.FAKE_PROCESS_FALLBACK_EXPECTED_MCP_CONFIG || ''
const expectedMcpSettingSources =
  process.env.FAKE_PROCESS_FALLBACK_EXPECTED_MCP_SETTING_SOURCES || ''
const expectedStrictMcpConfig =
  process.env.FAKE_PROCESS_FALLBACK_EXPECTED_STRICT_MCP_CONFIG || ''

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

async function waitForBootstrapPrompt() {
  const inboxPath = join(
    configDir,
    'teams',
    sanitizeName(teamName),
    'inboxes',
    agentName + '.json',
  )
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(inboxPath, 'utf8'))
      const matched = Array.isArray(parsed)
        ? parsed.find(
            message =>
              message &&
              message.from === 'team-lead' &&
              String(message.text || '').includes(expectedPrompt),
          )
        : null
      if (matched) {
        return matched
      }
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
  messages.push({
    from: agentId,
    text: JSON.stringify({
      type: 'idle_notification',
      from: agentId,
      timestamp: now,
      idleReason: 'available',
    }),
    timestamp: now,
    read: false,
  })
  await writeFile(inboxPath, JSON.stringify(messages, null, 2))
}

try {
  await writeEvent(
    'cli_started',
    'teammateRuntime=' + teammateRuntime +
      ';env=' + teammateRuntimeEnv +
      ';mcpConfig=' + (getArg('--mcp-config') || '') +
      ';mcpSettingSources=' + (getArg('--setting-sources') || '') +
      ';strictMcpConfig=' + hasFlag('--strict-mcp-config') +
      ';args=' + args.join('|'),
  )
  if (teammateRuntime !== 'headless') {
    await writeEvent('failed', 'missing headless runtime flag')
    process.exit(2)
  }
  if (teammateRuntimeEnv !== 'headless') {
    await writeEvent('failed', 'missing headless runtime env')
    process.exit(3)
  }
  if (expectedMcpConfig && getArg('--mcp-config') !== expectedMcpConfig) {
    console.error('wrong mcp config args=' + args.join('|'))
    await writeEvent('failed', 'wrong mcp config: ' + (getArg('--mcp-config') || ''))
    process.exit(4)
  }
  if (
    expectedMcpSettingSources &&
    getArg('--setting-sources') !== expectedMcpSettingSources
  ) {
    await writeEvent(
      'failed',
      'wrong mcp setting sources: ' + (getArg('--setting-sources') || ''),
    )
    process.exit(5)
  }
  if (
    expectedStrictMcpConfig === 'true' &&
    !hasFlag('--strict-mcp-config')
  ) {
    await writeEvent('failed', 'missing strict mcp config flag')
    process.exit(6)
  }
  if (
    expectedStrictMcpConfig === 'false' &&
    hasFlag('--strict-mcp-config')
  ) {
    await writeEvent('failed', 'unexpected strict mcp config flag')
    process.exit(7)
  }
  await writeEvent('runtime_ready', 'headless runtime accepted')
  const promptMessage = await waitForBootstrapPrompt()
  const bootstrapMirror = promptMessage.messageId
    ? { bootstrapMirrorId: String(promptMessage.messageId) }
    : {}
  await writeEvent('inbox_poller_ready', 'bootstrap prompt observed', bootstrapMirror)
  await writeEvent('bootstrap_submitted', 'fake runtime submitted bootstrap', bootstrapMirror)
  await writeLeaderConfirmation()
  await writeEvent('bootstrap_confirmed', 'leader idle notification written', bootstrapMirror)
  await sleep(5_000)
  process.exit(0)
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error))
  await writeEvent('failed', String(error && error.message ? error.message : error))
  process.exit(1)
}
`

type EnvSnapshot = Record<string, string | undefined>

describe('spawnTeammate process backend fallback routing', () => {
  let envSnapshot: EnvSnapshot
  let tempRoot: string
  let originalCwdState: string
  let originalOriginalCwd: string
  let originalGlobalConfig: GlobalConfig
  let runtimePids: number[] = []

  beforeEach(async () => {
    resetStateForTests()
    setIsInteractive(true)
    mock.restore()
    mock.clearAllMocks()
    envSnapshot = snapshotEnv([
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES',
      TEAMMATE_COMMAND_ENV_VAR,
      'FAKE_PROCESS_FALLBACK_EXPECTED_PROMPT',
      'CLAUDE_CODE_ENTRY_PROVIDER',
      'CLAUDE_CODE_USE_OPENAI',
      'CLAUDE_CODE_USE_GEMINI',
      'FAKE_PROCESS_FALLBACK_EXPECTED_MCP_CONFIG',
      'FAKE_PROCESS_FALLBACK_EXPECTED_MCP_SETTING_SOURCES',
      'FAKE_PROCESS_FALLBACK_EXPECTED_STRICT_MCP_CONFIG',
    ])
    originalCwdState = getCwdState()
    originalOriginalCwd = getOriginalCwd()
    originalGlobalConfig = structuredClone(getGlobalConfig())
    tempRoot = await mkdtemp(join(tmpdir(), 'spawn-process-fallback-test-'))
    runtimePids = []
  })

  afterEach(async () => {
    for (const pid of runtimePids) {
      if (isProcessAlive(pid)) {
        killProcessTree(pid, 'SIGTERM')
      }
    }
    runtimePids = []
    await sleep(1_000)
    resetStateForTests()
    mock.restore()
    mock.clearAllMocks()
    restoreEnv(envSnapshot)
    setCwdState(originalCwdState)
    setOriginalCwd(originalOriginalCwd)
    saveGlobalConfig(current => ({
      ...current,
      projects: originalGlobalConfig.projects,
      teammateMode: originalGlobalConfig.teammateMode,
    }))
    await rmWithRetry(tempRoot)
  })

  it(
    'routes auto separate-process teammates through native process backend when pane backend is unavailable without force env',
    async () => {
      const configDir = join(tempRoot, 'config dir')
      const projectDir = join(tempRoot, 'project dir')
      const scriptPath = join(tempRoot, 'fake process fallback runtime.mjs')
      await mkdir(configDir, { recursive: true })
      await mkdir(projectDir, { recursive: true })
      await writeFile(scriptPath, FAKE_PROCESS_FALLBACK_RUNTIME)
      const projectRealpath = await realpath(projectDir)
      const teamName = `process-fallback-${Date.now()}`
      const teamHelpersModulePath = new URL(
        '../../utils/swarm/teamHelpers.js',
        import.meta.url,
      ).href
      const actualTeamHelpers = (await import(
        new URL(
          `../../utils/swarm/teamHelpers.ts?processFallbackTeamHelpers=${Date.now()}`,
          import.meta.url,
        ).href
      )) as typeof import('../../utils/swarm/teamHelpers.js')
      mock.module(teamHelpersModulePath, () => actualTeamHelpers)
      mock.module('src/utils/swarm/teamHelpers.js', () => actualTeamHelpers)

      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES
      process.env[TEAMMATE_COMMAND_ENV_VAR] =
        `${quoteShellArg(process.execPath)} ${quoteShellArg(scriptPath)}`
      process.env.FAKE_PROCESS_FALLBACK_EXPECTED_PROMPT = PROCESS_FALLBACK_PROMPT
      const staleMcpConfigPath = join(configDir, 'stale inherited mcp.json')
      const freshMcpConfigPath = join(configDir, 'fresh member mcp.json')
      await writeFile(staleMcpConfigPath, '{"mcpServers":{}}')
      await writeFile(freshMcpConfigPath, '{"mcpServers":{}}')
      setFlagMcpConfig([staleMcpConfigPath])
      process.env.FAKE_PROCESS_FALLBACK_EXPECTED_MCP_CONFIG = freshMcpConfigPath
      process.env.FAKE_PROCESS_FALLBACK_EXPECTED_MCP_SETTING_SOURCES =
        'user,project,local'
      process.env.FAKE_PROCESS_FALLBACK_EXPECTED_STRICT_MCP_CONFIG = 'true'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
      delete process.env.CLAUDE_CODE_USE_OPENAI
      delete process.env.CLAUDE_CODE_USE_GEMINI

      setCwdState(projectRealpath)
      setOriginalCwd(projectRealpath)
      const projectKey = normalizePathForConfigKey(projectRealpath)
      saveGlobalConfig(current => ({
        ...current,
        teammateMode: 'auto',
        projects: {
          ...(current.projects ?? {}),
          [projectKey]: {
            ...(current.projects?.[projectKey] ?? {}),
            hasTrustDialogAccepted: true,
          },
        },
      }))
      await actualTeamHelpers.writeTeamFileAsync(
        teamName,
        createProcessFallbackTeamFile(teamName, projectRealpath),
      )
      expect(await actualTeamHelpers.readTeamFileAsync(teamName)).not.toBeNull()

      const spawnModulePath = new URL(
        `./spawnMultiAgent.ts?processFallbackRouteTest=${Date.now()}`,
        import.meta.url,
      ).href
      const { spawnTeammate, __setSpawnMultiAgentDepsForTests } =
        await import(spawnModulePath)
      __setSpawnMultiAgentDepsForTests({
        detectAndGetBackend: async () => {
          throw new Error('pane backend unavailable in route test')
        },
        getTeammateModeFromSnapshot: () => 'auto',
        isInProcessEnabled: () => false,
      })
      const { context } = createProcessFallbackToolContext(
        teamName,
        actualTeamHelpers.getTeamFilePath(teamName),
      )

      let result: Awaited<ReturnType<typeof spawnTeammate>>
      try {
        result = await spawnTeammate(
          {
            name: 'codexer',
            prompt: PROCESS_FALLBACK_PROMPT,
            team_name: teamName,
            cwd: projectRealpath,
            provider: 'codex',
            mcp_config: freshMcpConfigPath,
            mcp_setting_sources: 'user,project,local',
            strict_mcp_config: true,
          },
          context,
        )
      } finally {
        __setSpawnMultiAgentDepsForTests(null)
      }
      if (result.data.runtime_pid) {
        runtimePids.push(result.data.runtime_pid)
      }

      expect(process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES).toBeUndefined()
      expect(result.data.backend_type).toBe('process')
      expect(result.data.provider).toBe('codex')
      expect(String(result.data.tmux_pane_id).startsWith('process:')).toBe(true)

      const teamFile = await actualTeamHelpers.readTeamFileAsync(teamName)
      const teammate = teamFile?.members.find(member => member.name === 'codexer')
      expect(teammate).toMatchObject({
        backendType: 'process',
        provider: 'codex',
      })

      const events = await readTeammateRuntimeEvents(result.data.runtime_events_log!)
      const eventTypes = events.map(event => event.type)
      expect(eventTypes).toContain('process_spawned')
      expect(eventTypes).toContain('runtime_ready')
      expect(eventTypes).toContain('bootstrap_submitted')
      const mailboxWritten = events.find(
        event => event.type === 'mailbox_bootstrap_written',
      )
      const submitted = events.find(event => event.type === 'bootstrap_submitted')
      const confirmed = events.find(event => event.type === 'bootstrap_confirmed')
      expect(submitted?.bootstrapMirrorId).toBe(mailboxWritten?.bootstrapMirrorId)
      expect(submitted?.bootstrapMirrorId).toBeTruthy()
      expect(confirmed?.bootstrapMirrorId).toBe(mailboxWritten?.bootstrapMirrorId)
      expect(events.find(event => event.type === 'cli_started')?.detail).toContain(
        'env=headless',
      )
      expect(events.find(event => event.type === 'cli_started')?.detail).toContain(
        `mcpConfig=${freshMcpConfigPath}`,
      )
      expect(events.find(event => event.type === 'cli_started')?.detail).toContain(
        'mcpSettingSources=user,project,local',
      )
      expect(events.find(event => event.type === 'cli_started')?.detail).toContain(
        'strictMcpConfig=true',
      )
      expect(events.find(event => event.type === 'cli_started')?.detail).not.toContain(
        staleMcpConfigPath,
      )

      const localOnlyMcpConfigPath = join(configDir, 'local only member mcp.json')
      await writeFile(localOnlyMcpConfigPath, '{"mcpServers":{}}')
      setStrictMcpConfig(true)
      process.env.FAKE_PROCESS_FALLBACK_EXPECTED_MCP_CONFIG = localOnlyMcpConfigPath
      process.env.FAKE_PROCESS_FALLBACK_EXPECTED_MCP_SETTING_SOURCES = 'local'
      process.env.FAKE_PROCESS_FALLBACK_EXPECTED_STRICT_MCP_CONFIG = 'false'

      const localOnlyResult = await spawnTeammate(
        {
          name: 'localist',
          prompt: PROCESS_FALLBACK_PROMPT,
          team_name: teamName,
          cwd: projectRealpath,
          provider: 'codex',
          mcp_config: localOnlyMcpConfigPath,
          mcp_setting_sources: 'local',
          strict_mcp_config: false,
        },
        context,
      )
      if (localOnlyResult.data.runtime_pid) {
        runtimePids.push(localOnlyResult.data.runtime_pid)
      }
      expect(localOnlyResult.data.backend_type).toBe('process')

      const localOnlyEvents = await readTeammateRuntimeEvents(
        localOnlyResult.data.runtime_events_log!,
      )
      const localOnlyCliStarted = localOnlyEvents.find(
        event => event.type === 'cli_started',
      )?.detail
      expect(localOnlyCliStarted).toContain(`mcpConfig=${localOnlyMcpConfigPath}`)
      expect(localOnlyCliStarted).toContain('mcpSettingSources=local')
      expect(localOnlyCliStarted).toContain('strictMcpConfig=false')
      expect(localOnlyCliStarted).not.toContain(staleMcpConfigPath)
    },
    20000,
  )
})

function createProcessFallbackTeamFile(teamName: string, cwd: string): TeamFile {
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

function createProcessFallbackToolContext(
  teamName: string,
  teamFilePath: string,
): { context: ToolUseContext } {
  let appState = {
    ...getDefaultAppState(),
    teamContext: {
      teamName,
      teamFilePath,
      leadAgentId: TEAM_LEAD_NAME,
      teammates: {},
      isLeader: true,
    },
  } as AppState

  return {
    context: {
      toolUseId: 'process-fallback-route-tool-use',
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState) as AppState
      },
    } as ToolUseContext,
  }
}

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

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function rmWithRetry(path: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }
  throw lastError
}
