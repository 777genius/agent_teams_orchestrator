import {
  checkQuotaStatus,
  getRawUtilization,
  type RawUtilization,
  type RawWindowUtilization,
} from '../claudeAiLimits.js'
import type {
  RuntimeProviderSubscriptionRateLimitSnapshot,
  RuntimeProviderSubscriptionRateLimitWindow,
} from './types.js'
import { isAnthropicSubscriptionAuthMethod } from './anthropicStatus.js'

const FIVE_HOUR_WINDOW_MINS = 5 * 60
const WEEKLY_WINDOW_MINS = 7 * 24 * 60
const RUNTIME_STATUS_QUOTA_REFRESH_TTL_MS = 60_000

let lastRuntimeStatusQuotaRefreshAttemptMs: number | null = null

type RuntimeStatusQuotaRefreshOptions = {
  authMethod?: string | null
  maxAgeMs?: number
  nowMs?: number
  refresh?: () => Promise<void>
  getRawUtilizationSnapshot?: () => RawUtilization
}

function normalizeUsedPercent(utilization: number): number | null {
  if (!Number.isFinite(utilization)) {
    return null
  }

  const usedPercent = Math.max(0, Math.min(100, utilization * 100))
  return Math.round(usedPercent * 10) / 10
}

function normalizeResetTimestamp(resetsAt: number): number | null {
  return Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null
}

function buildWindow(
  rawWindow: RawWindowUtilization | undefined,
  windowDurationMins: number,
): RuntimeProviderSubscriptionRateLimitWindow | null {
  if (!rawWindow) {
    return null
  }

  const usedPercent = normalizeUsedPercent(rawWindow.utilization)
  if (usedPercent === null) {
    return null
  }

  return {
    usedPercent,
    windowDurationMins,
    resetsAt: normalizeResetTimestamp(rawWindow.resets_at),
  }
}

export function buildAnthropicSubscriptionRateLimitSnapshot(
  rawUtilization: RawUtilization,
): RuntimeProviderSubscriptionRateLimitSnapshot | null {
  const primary = buildWindow(rawUtilization.five_hour, FIVE_HOUR_WINDOW_MINS)
  const secondary = buildWindow(rawUtilization.seven_day, WEEKLY_WINDOW_MINS)

  return primary || secondary ? { primary, secondary } : null
}

export async function getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus(
  options: RuntimeStatusQuotaRefreshOptions = {},
): Promise<RuntimeProviderSubscriptionRateLimitSnapshot | null> {
  if (
    options.authMethod !== undefined
    && !isAnthropicSubscriptionAuthMethod(options.authMethod)
  ) {
    return null
  }

  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? RUNTIME_STATUS_QUOTA_REFRESH_TTL_MS
  const shouldRefresh =
    lastRuntimeStatusQuotaRefreshAttemptMs === null
    || nowMs - lastRuntimeStatusQuotaRefreshAttemptMs >= maxAgeMs

  if (shouldRefresh) {
    lastRuntimeStatusQuotaRefreshAttemptMs = nowMs
    await (options.refresh ?? (() => checkQuotaStatus({ allowNonInteractive: true })))()
  }

  return buildAnthropicSubscriptionRateLimitSnapshot(
    (options.getRawUtilizationSnapshot ?? getRawUtilization)(),
  )
}

export function __resetAnthropicSubscriptionRateLimitRefreshForTests(): void {
  lastRuntimeStatusQuotaRefreshAttemptMs = null
}
