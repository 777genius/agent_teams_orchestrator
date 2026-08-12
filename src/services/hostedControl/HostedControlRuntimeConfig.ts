import { constants, lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'
import type {
  HostedControlOwnerBinding,
  HostedControlStableAuthority,
} from './protocol.js'

export type HostedControlRuntimeConfig = {
  socketPath: string
  secretFile: string
  claudeRoot: string
  deploymentId: string
  bootId: string
  restoreGeneration: number
  workspaceId: string
  teamId: string
  legacyKey: string
  mountGeneration: number
  declaredRootHash: string
  ownerAuthority: string
  ownerGeneration: number
  ownerSessionId: string
}

const CONFIG_KEYS: ReadonlyArray<keyof HostedControlRuntimeConfig> = [
  'socketPath',
  'secretFile',
  'claudeRoot',
  'deploymentId',
  'bootId',
  'restoreGeneration',
  'workspaceId',
  'teamId',
  'legacyKey',
  'mountGeneration',
  'declaredRootHash',
  'ownerAuthority',
  'ownerGeneration',
  'ownerSessionId',
]

export async function loadHostedControlRuntimeConfig(
  configPath: string,
): Promise<HostedControlRuntimeConfig> {
  if (!isAbsolute(configPath)) throw new Error('Hosted control config path must be absolute')
  const handle = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let text: string
  try {
    const [stat, current, canonical] = await Promise.all([
      handle.stat(),
      lstat(configPath),
      realpath(configPath),
    ])
    if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
      stat.dev !== current.dev || stat.ino !== current.ino || canonical !== configPath ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
      throw new Error('Hosted control config must be a canonical private owner-only file')
    }
    if (stat.size < 2 || stat.size > 64 * 1024) {
      throw new Error('Hosted control config size is invalid')
    }
    text = await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
  const raw = record(JSON.parse(text), 'config')
  exactKeys(raw, CONFIG_KEYS, 'config')
  const socketPath = socketPathValue(raw.socketPath)
  const secretFile = absolutePath(raw.secretFile, 'secretFile')
  const claudeRoot = absolutePath(raw.claudeRoot, 'claudeRoot')
  if (socketPath === secretFile || socketPath === claudeRoot || secretFile === claudeRoot) {
    throw new Error('Hosted control paths must be distinct')
  }
  await assertCanonicalPrivateFile(secretFile, 'secret')
  await assertCanonicalOwnedDirectory(claudeRoot, 'claudeRoot')
  await assertCanonicalOwnedDirectory(dirname(socketPath), 'socket parent')
  return {
    socketPath,
    secretFile,
    claudeRoot,
    deploymentId: patternString(raw.deploymentId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'deploymentId'),
    bootId: patternString(raw.bootId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'bootId'),
    restoreGeneration: nonNegativeInteger(raw.restoreGeneration, 'restoreGeneration'),
    workspaceId: patternString(raw.workspaceId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'workspaceId'),
    teamId: patternString(raw.teamId, /^team_[0-9a-f]{32}$/, 'teamId'),
    legacyKey: patternString(raw.legacyKey, /^[A-Za-z0-9_-]{1,128}$/, 'legacyKey'),
    mountGeneration: positiveInteger(raw.mountGeneration, 'mountGeneration'),
    declaredRootHash: patternString(raw.declaredRootHash, /^[0-9a-f]{64}$/, 'declaredRootHash'),
    ownerAuthority: patternString(raw.ownerAuthority, /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'ownerAuthority'),
    ownerGeneration: positiveInteger(raw.ownerGeneration, 'ownerGeneration'),
    ownerSessionId: patternString(raw.ownerSessionId, /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'ownerSessionId'),
  }
}

async function assertCanonicalOwnedDirectory(path: string, field: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
  try {
    const [stat, current, canonical] = await Promise.all([handle.stat(), lstat(path), realpath(path)])
    if (!stat.isDirectory() || !current.isDirectory() || current.isSymbolicLink() ||
      stat.dev !== current.dev || stat.ino !== current.ino || canonical !== path ||
      (stat.mode & 0o022) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
      throw new Error(`Hosted control ${field} must be a canonical owner-controlled directory`)
    }
  } finally { await handle.close() }
}

async function assertCanonicalPrivateFile(path: string, field: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const [stat, current, canonical] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path),
    ])
    if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
      stat.dev !== current.dev || stat.ino !== current.ino || canonical !== path ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
      throw new Error(`Hosted control ${field} must be a canonical private owner-only file`)
    }
  } finally {
    await handle.close()
  }
}

export function hostedControlAuthorityFromConfig(
  config: HostedControlRuntimeConfig,
): HostedControlStableAuthority {
  return {
    deploymentId: config.deploymentId,
    bootId: config.bootId,
    restoreGeneration: config.restoreGeneration,
    workspaceId: config.workspaceId,
    mountBinding: {
      mountGeneration: config.mountGeneration,
      declaredRootHash: config.declaredRootHash,
    },
    teamId: config.teamId,
  }
}

export function hostedControlOwnerIdentityFromConfig(
  config: HostedControlRuntimeConfig,
): Omit<HostedControlOwnerBinding, 'socketIdentity'> {
  return {
    ownerAuthority: config.ownerAuthority,
    ownerGeneration: config.ownerGeneration,
    ownerSessionId: config.ownerSessionId,
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid hosted control ${field}`)
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`Invalid hosted control ${field} keys`)
  }
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid hosted control ${field}`)
  return value
}
function patternString(value: unknown, pattern: RegExp, field: string): string {
  const parsed = string(value, field)
  if (!pattern.test(parsed)) throw new Error(`Invalid hosted control ${field}`)
  return parsed
}
function absolutePath(value: unknown, field: string): string {
  const parsed = string(value, field)
  if (!isAbsolute(parsed) || parsed.includes('\0')) throw new Error(`Invalid hosted control ${field}`)
  return parsed
}
function socketPathValue(value: unknown): string {
  const parsed = absolutePath(value, 'socketPath')
  if (normalize(parsed) !== parsed || Buffer.byteLength(parsed, 'utf8') > 103) {
    throw new Error('Invalid hosted control socketPath')
  }
  return parsed
}
function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid hosted control ${field}`)
  return value as number
}
function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field)
  if (parsed === 0) throw new Error(`Invalid hosted control ${field}`)
  return parsed
}
