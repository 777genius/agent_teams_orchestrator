export const OPEN_CODE_PASSIVE_LEGACY_MANIFEST = 'committed.json'
export const OPEN_CODE_PASSIVE_TRANSACTION_MARKER = 'immutable-v2.marker'
export const OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT = '{"schemaVersion":2}\n'
export const OPEN_CODE_PASSIVE_TRANSACTION_MARKER_MAX_BYTES = 64
export const OPEN_CODE_PASSIVE_SCOPES = 'scopes'
export const OPEN_CODE_PASSIVE_GENERATIONS = 'generations'
export const OPEN_CODE_PASSIVE_COMMITS = 'commits'
export const OPEN_CODE_PASSIVE_GENERATION_PROJECT = 'project.snapshot.json'
export const OPEN_CODE_PASSIVE_GENERATION_BINARY = 'binary.snapshot.json'
export const OPEN_CODE_PASSIVE_COMMIT_MAX_BYTES = 4 * 1024

export type OpenCodePassiveSnapshotCommitV2 = Readonly<{
  schemaVersion: 2
  scope: `sha256:${string}`
  generation: string
  domainGeneration: number
}>

export const OPEN_CODE_PASSIVE_GENERATION_PATTERN = /^(?:[0-9]{16}\.)?[0-9a-f]{8}-[0-9a-f-]{27,}$/
export const OPEN_CODE_PASSIVE_SCOPE_DIGEST_PATTERN = /^[0-9a-f]{64}$/
export const OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN = /^[0-9]{16}\.(?:[0-9]{16}\.)?[0-9a-f]{8}-[0-9a-f-]{27,}\.json$/
export const OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN = /^\.[0-9]{16}\.(?:[0-9]{16}\.)?[0-9a-f]{8}-[0-9a-f-]{27,}\.json\.immutable\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f-]{27,}$/

export const OPEN_CODE_PASSIVE_RETAIN_GENERATIONS = 32
/** Greater than the enforced one-minute passive reader deadline. */
export const OPEN_CODE_PASSIVE_READER_GRACE_MS = 2 * 60_000

export function openCodePassiveGenerationSequence(name: string): number | null {
  const match = /^([0-9]{16})\./.exec(name)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function openCodePassiveCommitName(domainGeneration: number, generation: string): string {
  if (!Number.isSafeInteger(domainGeneration) || domainGeneration < 0
    || !OPEN_CODE_PASSIVE_GENERATION_PATTERN.test(generation)) throw new TypeError('Invalid passive commit')
  return `${String(domainGeneration).padStart(16, '0')}.${generation}.json`
}

export function decodeOpenCodePassiveSnapshotCommit(text: string): OpenCodePassiveSnapshotCommitV2 | null {
  try {
    const value = JSON.parse(text) as Partial<OpenCodePassiveSnapshotCommitV2>
    if (value.schemaVersion !== 2 || typeof value.scope !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(value.scope)
      || typeof value.generation !== 'string' || !OPEN_CODE_PASSIVE_GENERATION_PATTERN.test(value.generation)
      || !Number.isSafeInteger(value.domainGeneration) || (value.domainGeneration ?? -1) < 0) return null
    const sequence = openCodePassiveGenerationSequence(value.generation)
    if (sequence !== null && sequence !== value.domainGeneration) return null
    return value as OpenCodePassiveSnapshotCommitV2
  } catch { return null }
}

export function encodeOpenCodePassiveSnapshotCommit(value: OpenCodePassiveSnapshotCommitV2): string {
  return `${JSON.stringify(value)}\n`
}
