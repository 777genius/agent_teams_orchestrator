const DEFAULT_HEADLESS_TEAMMATE_MCP_CONFIG_TIMEOUT_MS = 5_000
const HEADLESS_TEAMMATE_MCP_CONFIG_TIMEOUT_ENV =
  'CLAUDE_TEAM_HEADLESS_MCP_CONFIG_TIMEOUT_MS'

export interface StartupMcpConfigResult {
  servers: Record<string, unknown>
}

export interface StartupMcpConfigResolution<T extends StartupMcpConfigResult> {
  result: T
  timedOut: boolean
  timeoutMs: number
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_HEADLESS_TEAMMATE_MCP_CONFIG_TIMEOUT_MS
  }
  return Math.floor(parsed)
}

export function getHeadlessTeammateMcpConfigTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseTimeoutMs(env[HEADLESS_TEAMMATE_MCP_CONFIG_TIMEOUT_ENV])
}

export async function resolveStartupMcpConfig<T extends StartupMcpConfigResult>(
  mcpConfigPromise: Promise<T>,
  options: {
    headlessTeammateRuntime: boolean
    timeoutMs?: number
  },
): Promise<StartupMcpConfigResolution<T>> {
  const timeoutMs =
    options.timeoutMs ?? getHeadlessTeammateMcpConfigTimeoutMs()
  if (!options.headlessTeammateRuntime || timeoutMs <= 0) {
    return {
      result: await mcpConfigPromise,
      timedOut: false,
      timeoutMs,
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<StartupMcpConfigResolution<T>>(resolve => {
    timeoutHandle = setTimeout(() => {
      resolve({
        result: { servers: {} } as T,
        timedOut: true,
        timeoutMs,
      })
    }, timeoutMs)
  })

  const resolved = mcpConfigPromise.then(result => ({
    result,
    timedOut: false,
    timeoutMs,
  }))

  const outcome = await Promise.race([resolved, timedOut])
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
  }
  if (outcome.timedOut) {
    mcpConfigPromise.catch(() => undefined)
  }
  return outcome
}
