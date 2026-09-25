/** Why a lane effect ended the run in `failed`; persisted next to the durable phase. */
export type TeamLifecycleLaneFailure = {
  action: 'launch' | 'inspect' | 'stop' | 'teardown'
  /** Stable machine code: the error's own code, or a lifecycle classification. */
  code: string
  /** Redacted, single-line, bounded operator diagnostic. */
  message: string
}

export type TeamLifecycleLaneFailureReport = TeamLifecycleLaneFailure & {
  runId: string
  laneKinds: string[]
}

const ACTIONS: readonly string[] = ['launch', 'inspect', 'stop', 'teardown']
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/
const MAX_MESSAGE = 500
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[^\s"']+/gi,
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])-[A-Za-z0-9_-]{8,}/g,
  /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/g,
]

export function laneFailureFromError(
  action: TeamLifecycleLaneFailure['action'],
  error: unknown,
): TeamLifecycleLaneFailure {
  const code = (error as { code?: unknown } | null)?.code
  return {
    action,
    code: typeof code === 'string' && CODE.test(code) ? code : 'lane_exception',
    message: redactLaneFailureMessage(error instanceof Error ? error.message : String(error)),
  }
}

export function redactLaneFailureMessage(value: string): string {
  let message = value.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, (match, name?: string, separator?: string) =>
      typeof name === 'string' && typeof separator === 'string' ? `${name}${separator}[redacted]` : '[redacted]')
  }
  message = message.trim()
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 3)}...` : message || 'unknown'
}

export function decodeLaneFailure(value: unknown): TeamLifecycleLaneFailure {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!record || Object.keys(record).join(',') !== 'action,code,message' ||
    !ACTIONS.includes(String(record.action)) || typeof record.code !== 'string' ||
    !CODE.test(record.code) || typeof record.message !== 'string' ||
    record.message.length === 0 || record.message.length > MAX_MESSAGE) {
    throw new Error('Invalid team lifecycle failure')
  }
  return {
    action: record.action as TeamLifecycleLaneFailure['action'],
    code: record.code,
    message: record.message,
  }
}
