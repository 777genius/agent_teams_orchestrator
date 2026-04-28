import { parseArguments } from '../argumentSubstitution.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { isProcessAlive, killProcessTree } from '../processKill.js'

export function parseProcessBackendPid(value: string | undefined): number | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }

  const match = trimmed.match(/^process:(\d+)$/) ?? trimmed.match(/^(\d+)$/)
  if (!match) {
    return null
  }

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
  const hasTokenMatch = tokens.some(
    (token, index) =>
      (token === flag && tokens[index + 1] === expectedValue) ||
      token === `${flag}=${expectedValue}`,
  )
  if (hasTokenMatch) {
    return true
  }

  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedValue = expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `${escapedFlag}(?:=|\\s+)["']?${escapedValue}["']?(?:\\s|$)`,
  ).test(command)
}

export function isProcessBackendCommandForTeammate(
  command: string,
  teammateId: string,
  teamName: string,
): boolean {
  return (
    commandHasFlagValue(command, '--agent-id', teammateId) &&
    commandHasFlagValue(command, '--team-name', teamName)
  )
}

const PROCESS_COMMAND_LOOKUP_TIMEOUT_MS = 3_000

async function getProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    const result = await execFileNoThrow(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      {
        timeout: PROCESS_COMMAND_LOOKUP_TIMEOUT_MS,
        useCwd: false,
        stdin: 'ignore',
      },
    )
    return result.code === 0 && result.stdout.trim()
      ? result.stdout.trim()
      : null
  }

  const result = await execFileNoThrow('ps', ['-p', String(pid), '-o', 'args='], {
    timeout: PROCESS_COMMAND_LOOKUP_TIMEOUT_MS,
    useCwd: false,
    stdin: 'ignore',
  })
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

export async function isProcessBackendRuntimeAlive(
  pid: number,
  teammateId: string,
  teamName: string,
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false
  }

  const command = await getProcessCommandLine(pid)
  if (!command) {
    return false
  }

  return isProcessBackendCommandForTeammate(command, teammateId, teamName)
}

export async function killProcessBackendRuntime(
  paneId: string | undefined,
  options: {
    signal?: NodeJS.Signals
    expectedAgentId?: string
    teamName?: string
  } = {},
): Promise<boolean> {
  const pid = parseProcessBackendPid(paneId)
  if (!pid) {
    return false
  }
  if (!isProcessAlive(pid)) {
    return false
  }

  const signal = options.signal ?? 'SIGTERM'
  const expectedAgentId = options.expectedAgentId
  const teamName = options.teamName
  if (!expectedAgentId || !teamName) {
    return false
  }

  const command = await getProcessCommandLine(pid)
  if (
    !command ||
    !isProcessBackendCommandForTeammate(command, expectedAgentId, teamName)
  ) {
    return false
  }

  killProcessTree(pid, signal)
  return true
}
