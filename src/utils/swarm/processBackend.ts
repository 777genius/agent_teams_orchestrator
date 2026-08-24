import { parseArguments } from '../argumentSubstitution.js'
import {
  isProcessAlive,
  getProcessTreeContainmentCapability,
  killProcessTreeAndWait,
  readProcessCommandLine,
  readProcessStartTimeMs,
  type ProcessKillAndWaitDependencies,
} from '../processKill.js'

export type ProcessBackendIdentity = {
  pid: number
  startedAtMs: number
  agentId: string
  teamName: string
  ownerToken: string
  runId: string
  osIdentity: string
}

export type ProcessBackendDependencies = {
  isProcessAlive?: (pid: number) => boolean
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>
  readProcessCommandLine?: (pid: number) => Promise<string | null>
  killProcessTreeAndWait?: typeof killProcessTreeAndWait
  processKillDependencies?: ProcessKillAndWaitDependencies
}

export type ProcessBackendRuntimeState =
  | 'confirmed'
  | 'gone'
  | 'changed'
  | 'legacy_unverifiable'

export function parseProcessBackendPid(value: string | undefined): number | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const match = trimmed.match(/^process:(\d+)$/) ?? trimmed.match(/^(\d+)$/)
  if (!match) return null

  const pid = Number.parseInt(match[1]!, 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

export function buildProcessBackendPaneId(pid: number): string {
  return `process:${pid}`
}

function commandHasFlagValue(
  command: string,
  flag: string,
  expectedValue: string,
): boolean {
  const tokens = parseArguments(command)
  return tokens.some(
    (token, index) =>
      (token === flag && tokens[index + 1] === expectedValue) ||
      token === `${flag}=${expectedValue}`,
  )
}

export function isProcessBackendCommandForTeammate(
  command: string,
  teammateId: string,
  teamName: string,
  ownerToken?: string,
  runId?: string,
): boolean {
  return (
    commandHasFlagValue(command, '--agent-id', teammateId) &&
    commandHasFlagValue(command, '--team-name', teamName) &&
    (ownerToken === undefined ||
      commandHasFlagValue(command, '--process-owner-token', ownerToken)) &&
    (runId === undefined || commandHasFlagValue(command, '--parent-session-id', runId))
  )
}

type ProcessBackendIdentityState = 'confirmed' | 'gone' | 'changed' | 'unverified'

async function inspectProcessBackendIdentity(
  expected: ProcessBackendIdentity,
  dependencies: ProcessBackendDependencies,
): Promise<ProcessBackendIdentityState> {
  const alive = dependencies.isProcessAlive ?? isProcessAlive
  const readStartedAt = dependencies.readProcessStartTimeMs ?? readProcessStartTimeMs
  const readCommand = dependencies.readProcessCommandLine ?? readProcessCommandLine

  if (!alive(expected.pid)) return 'gone'
  const startedAtBefore = await readStartedAt(expected.pid).catch(() => null)
  if (startedAtBefore === null) return alive(expected.pid) ? 'unverified' : 'gone'
  if (startedAtBefore !== expected.startedAtMs) return 'changed'

  // Windows' root is the Job supervisor, so its command does not expose the
  // child's semantic argv. The unguessable persisted Job name is the stronger
  // kernel ownership identity. Unix still verifies semantic argv as defense in
  // depth before using the exact process group.
  if (!expected.osIdentity.startsWith('win32-job:')) {
    const command = await readCommand(expected.pid).catch(() => null)
    if (!command) return alive(expected.pid) ? 'unverified' : 'gone'
    if (!isProcessBackendCommandForTeammate(command, expected.agentId, expected.teamName, expected.ownerToken, expected.runId)) {
      return 'changed'
    }
  }

  // Fence PID reuse during the slower command-line lookup.
  const startedAtAfter = await readStartedAt(expected.pid).catch(() => null)
  if (startedAtAfter === null) return alive(expected.pid) ? 'unverified' : 'gone'
  return startedAtAfter === expected.startedAtMs ? 'confirmed' : 'changed'
}

export async function isProcessBackendRuntimeAlive(
  pid: number,
  teammateId: string,
  teamName: string,
  options: {
    expectedStartedAtMs?: number | null
    expectedOwnerToken?: string | null
    expectedRunId?: string | null
    expectedOsIdentity?: string | null
    dependencies?: ProcessBackendDependencies
  } = {},
): Promise<boolean> {
  return (await getProcessBackendRuntimeState(pid, teammateId, teamName, options)) === 'confirmed'
}

export async function getProcessBackendRuntimeState(
  pid: number,
  teammateId: string,
  teamName: string,
  options: {
    expectedStartedAtMs?: number | null
    expectedOwnerToken?: string | null
    expectedRunId?: string | null
    expectedOsIdentity?: string | null
    dependencies?: ProcessBackendDependencies
  } = {},
): Promise<ProcessBackendRuntimeState> {
  const ownerToken = options.expectedOwnerToken?.trim()
  const runId = options.expectedRunId?.trim()
  const osIdentity = options.expectedOsIdentity?.trim() ?? `unix-pgid:${pid}`
  if (
    !Number.isFinite(options.expectedStartedAtMs) ||
    options.expectedStartedAtMs === null ||
    !ownerToken ||
    !runId
  ) {
    return (options.dependencies?.isProcessAlive ?? isProcessAlive)(pid)
      ? 'legacy_unverifiable'
      : 'gone'
  }
  const expectedStartedAtMs = options.expectedStartedAtMs as number
  const state = await inspectProcessBackendIdentity(
      {
        pid,
        startedAtMs: expectedStartedAtMs,
        agentId: teammateId,
        teamName,
        ownerToken,
        runId,
        osIdentity,
      },
      options.dependencies ?? {},
    )
  if (state === 'gone') {
    // Root exit alone never proves a process tree empty. Windows callers that
    // need completion must go through killProcessBackendRuntime so the named
    // Job itself is terminated and queried.
    return 'legacy_unverifiable'
  }
  return state === 'unverified' ? 'legacy_unverifiable' : state
}

function dependenciesPlatform(dependencies: ProcessBackendDependencies | undefined): NodeJS.Platform {
  return dependencies?.processKillDependencies?.platform ?? process.platform
}

export async function killProcessBackendRuntime(
  paneId: string | undefined,
  options: {
    signal?: NodeJS.Signals
    expectedAgentId?: string
    teamName?: string
    expectedStartedAtMs?: number | null
    expectedOwnerToken?: string | null
    expectedRunId?: string | null
    expectedOsIdentity?: string | null
    dependencies?: ProcessBackendDependencies
  } = {},
): Promise<boolean> {
  const pid = parseProcessBackendPid(paneId)
  const ownerToken = options.expectedOwnerToken?.trim()
  const runId = options.expectedRunId?.trim()
  const osIdentity = options.expectedOsIdentity?.trim() ?? `unix-pgid:${pid}`
  if (
    !pid ||
    !options.expectedAgentId ||
    !options.teamName ||
    !Number.isFinite(options.expectedStartedAtMs) ||
    options.expectedStartedAtMs === null ||
    !ownerToken ||
    !runId
  ) {
    return false
  }
  const expectedStartedAtMs = options.expectedStartedAtMs as number

  const dependencies = options.dependencies ?? {}
  const expected: ProcessBackendIdentity = {
    pid,
    startedAtMs: expectedStartedAtMs,
    agentId: options.expectedAgentId,
    teamName: options.teamName,
    ownerToken,
    runId,
    osIdentity,
  }
  const identity = await inspectProcessBackendIdentity(expected, dependencies)
  if (identity === 'gone') {
    if (getProcessTreeContainmentCapability(
      expected.osIdentity,
      dependenciesPlatform(dependencies),
    ) !== 'exact') return false
    return (dependencies.killProcessTreeAndWait ?? killProcessTreeAndWait)(
      pid,
      options.signal ?? 'SIGTERM',
      {
        expectedStartedAtMs: expected.startedAtMs,
        expectedOsIdentity: expected.osIdentity,
        dependencies: {
          isProcessAlive: dependencies.isProcessAlive,
          readProcessStartTimeMs: dependencies.readProcessStartTimeMs,
          ...dependencies.processKillDependencies,
        },
      },
    )
  }
  if (identity !== 'confirmed') return false

  return (dependencies.killProcessTreeAndWait ?? killProcessTreeAndWait)(
    pid,
    options.signal ?? 'SIGTERM',
    {
      expectedStartedAtMs: expected.startedAtMs,
      expectedOsIdentity: expected.osIdentity,
      verifyExpectedIdentity: async () =>
        (await inspectProcessBackendIdentity(expected, dependencies)) === 'confirmed',
      dependencies: {
        isProcessAlive: dependencies.isProcessAlive,
        readProcessStartTimeMs: dependencies.readProcessStartTimeMs,
        ...dependencies.processKillDependencies,
      },
    },
  )
}
