import { execFile } from 'node:child_process'

import { NativeHostLocalLaneError, type NativeHostLocalProvider } from './NativeHostLocalLanePlan.js'

const PREFLIGHT_TIMEOUT_MS = 60_000
const PREFLIGHT_MAX_BYTES = 8 * 1024 * 1024

export type NativeProviderPreflight = (input: {
  provider: NativeHostLocalProvider
  command: string
  commandArgs: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}) => Promise<void>

/**
 * Runs the pinned owner's own `runtime status` with the exact lead env. For
 * Codex that path resolves the configured binary and runs `codex login status`,
 * so launch fails with a typed error instead of a lead that never authenticates.
 */
export const runNativeProviderPreflight: NativeProviderPreflight = input => new Promise((resolve, reject) => {
  execFile(input.command, [
    ...input.commandArgs, 'runtime', 'status', '--json', '--summary', '--provider', input.provider,
  ], {
    cwd: input.cwd,
    env: { ...input.env },
    timeout: PREFLIGHT_TIMEOUT_MS,
    maxBuffer: PREFLIGHT_MAX_BYTES,
    windowsHide: true,
  }, (error, stdout) => {
    if (error) {
      reject(new NativeHostLocalLaneError('native_lane_provider_preflight_failed', 'Provider runtime status failed'))
      return
    }
    try {
      assertProviderReady(JSON.parse(stdout), input.provider)
      resolve()
    } catch (failure) {
      reject(failure instanceof NativeHostLocalLaneError
        ? failure
        : new NativeHostLocalLaneError('native_lane_provider_preflight_failed', 'Provider runtime status was unreadable'))
    }
  })
})

export function assertProviderReady(payload: unknown, provider: NativeHostLocalProvider): void {
  const providers = record(record(payload)?.providers)
  const status = record(providers?.[provider])
  if (!status) {
    throw new NativeHostLocalLaneError('native_lane_provider_preflight_failed', 'Provider runtime status is missing')
  }
  if (status.supported !== true) {
    throw new NativeHostLocalLaneError('native_lane_provider_preflight_failed', 'Provider is not supported')
  }
  // Codex reports teamLaunch=false while unauthenticated, so auth is classified first.
  if (status.authenticated !== true) {
    throw new NativeHostLocalLaneError('native_lane_provider_not_authenticated', 'Provider is not authenticated')
  }
  if (record(status.capabilities)?.teamLaunch !== true) {
    throw new NativeHostLocalLaneError('native_lane_provider_preflight_failed', 'Provider cannot launch teams')
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
