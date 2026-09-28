import { createHmac } from 'node:crypto'
import { constants, type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { HostedControlOwnerBinding } from './protocol.js'

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

async function openOwnedDirectory(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW)
}

export async function resolveHostedControlOwnerBinding(input: {
  claudeRoot: string
  legacyKey: string
}): Promise<{
  canonicalClaudeRoot: string
  canonicalTeamRoot: string
  rootIdentity: { claudeRoot: [number, number]; teamRoot: [number, number] }
}> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.legacyKey)) {
    throw new Error('Hosted control legacy key is not a safe path component')
  }
  const declaredTeamRoot = join(input.claudeRoot, 'teams', input.legacyKey)
  const [declaredRootStat, declaredTeamsStat, declaredTeamStat] = await Promise.all([
    lstat(input.claudeRoot),
    lstat(join(input.claudeRoot, 'teams')),
    lstat(declaredTeamRoot),
  ])
  if (!declaredRootStat.isDirectory() || declaredRootStat.isSymbolicLink() ||
      !declaredTeamsStat.isDirectory() || declaredTeamsStat.isSymbolicLink() ||
      !declaredTeamStat.isDirectory() || declaredTeamStat.isSymbolicLink()) {
    throw new Error('Hosted control owner paths must be real directories')
  }
  const claudeRoot = await realpath(input.claudeRoot)
  const teamRoot = await realpath(declaredTeamRoot)
  const teamRelative = relative(join(claudeRoot, 'teams'), teamRoot)
  if (teamRelative.startsWith('..') || teamRelative === '' || teamRelative.includes('/../')) {
    throw new Error('Hosted control team root escapes the owned Claude root')
  }

  let rootHandle: FileHandle | undefined
  let teamHandle: FileHandle | undefined
  try {
    rootHandle = await openOwnedDirectory(claudeRoot)
    teamHandle = await openOwnedDirectory(teamRoot)
    const [rootStat, teamStat] = await Promise.all([rootHandle.stat(), teamHandle.stat()])
    if (!rootStat.isDirectory() || !teamStat.isDirectory()) {
      throw new Error('Hosted control owner paths must be directories')
    }
    const uid = process.getuid?.()
    if (uid !== undefined && (rootStat.uid !== uid || teamStat.uid !== uid)) {
      throw new Error('Hosted control owner paths are not owned by this process user')
    }
    return {
      canonicalClaudeRoot: claudeRoot,
      canonicalTeamRoot: teamRoot,
      rootIdentity: { claudeRoot: [rootStat.dev, rootStat.ino], teamRoot: [teamStat.dev, teamStat.ino] },
    }
  } finally {
    await Promise.all([rootHandle?.close(), teamHandle?.close()])
  }
}

export async function validateHostedControlOwnerBinding(input: {
  claudeRoot: string
  legacyKey: string
  expectedRootIdentity?: { claudeRoot: [number, number]; teamRoot: [number, number] }
}): Promise<boolean> {
  try {
    const current = await resolveHostedControlOwnerBinding(input)
    return !input.expectedRootIdentity || JSON.stringify(current.rootIdentity) === JSON.stringify(input.expectedRootIdentity)
  } catch {
    return false
  }
}

export async function readHostedControlSecret(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW)
  try {
    const [stat, current, canonical] = await Promise.all([handle.stat(), lstat(path), realpath(path)])
    const uid = process.getuid?.()
    if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
      stat.dev !== current.dev || stat.ino !== current.ino || canonical !== path ||
      (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw new Error('Hosted control secret must be a private owner-only file')
    }
    const encoded = await handle.readFile('utf8')
    if (!/^[0-9a-f]{64}$/.test(encoded)) {
      throw new Error('Hosted control secret has an invalid length')
    }
    const final = await lstat(path)
    if (!final.isFile() || final.isSymbolicLink() || final.dev !== stat.dev || final.ino !== stat.ino) {
      throw new Error('Hosted control secret was substituted during admission')
    }
    return Buffer.from(encoded, 'hex')
  } finally {
    await handle.close()
  }
}

function domainProofInput(domain: string, direction: string, envelope: object): string {
  const unsigned = { ...(envelope as Record<string, unknown>) }
  delete unsigned.ownerProof
  return `${domain}\0${direction}\0${JSON.stringify(unsigned)}`
}

export function createHostedDomainProof(secret: Uint8Array, domain: string, direction: string, envelope: object): string { return createHmac('sha256', secret).update(domainProofInput(domain, direction, envelope)).digest('hex') }

/** The lifecycle v2 wire authenticates the exact pre-proof bytes, not a reserialized object. */
export function createHostedRawDomainProof(
  secret: Uint8Array,
  domain: string,
  direction: string,
  serializedUnsignedEnvelope: string,
): string {
  return createHmac('sha256', secret)
    .update(`${domain}\0${direction}\0${serializedUnsignedEnvelope}`)
    .digest('hex')
}

export type StrictHostedSignedJsonFrame = {
  value: Record<string, unknown>
  serializedUnsignedEnvelope: string
  ownerProof: string
}

/** Parse one proof-last JSON object while retaining the exact authenticated byte sequence. */
export function parseStrictHostedSignedJsonFrame(line: string): StrictHostedSignedJsonFrame {
  const parsed = parseStrictHostedProofLastJsonFrame(line, 'ownerProof')
  return { ...parsed, ownerProof: parsed.proof }
}

export function parseStrictHostedProofLastJsonFrame(
  line: string,
  proofField: 'ownerProof' | 'controllerProof',
): { value: Record<string, unknown>; serializedUnsignedEnvelope: string; proof: string } {
  if (line.length < 2 || line.includes('\n') || line.includes('\r')) {
    throw new TypeError('Invalid hosted signed JSON frame')
  }
  assertNoDuplicateJsonObjectKeys(line)
  const value = JSON.parse(line) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid hosted signed JSON frame')
  }
  const envelope = value as Record<string, unknown>
  const proof = envelope[proofField]
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) {
    throw new TypeError('Invalid hosted signed JSON proof')
  }
  const suffix = `,"${proofField}":"${proof}"}`
  if (!line.endsWith(suffix)) throw new TypeError('Hosted signed JSON proof must be final')
  const serializedUnsignedEnvelope = `${line.slice(0, -suffix.length)}}`
  assertNoDuplicateJsonObjectKeys(serializedUnsignedEnvelope)
  const unsigned = JSON.parse(serializedUnsignedEnvelope) as unknown
  if (!unsigned || typeof unsigned !== 'object' || Array.isArray(unsigned) ||
    Object.hasOwn(unsigned, proofField) ||
    Reflect.ownKeys(unsigned).length + 1 !== Reflect.ownKeys(envelope).length) {
    throw new TypeError('Invalid hosted signed JSON envelope')
  }
  // Authenticate one canonical spelling, rather than allowing equivalent JSON
  // encodings to become different durable commands with different signatures.
  if (JSON.stringify(unsigned) !== serializedUnsignedEnvelope || JSON.stringify(envelope) !== line) {
    throw new TypeError('Hosted signed JSON envelope must be canonical')
  }
  return { value: envelope, serializedUnsignedEnvelope, proof }
}

export function assertNoDuplicateJsonObjectKeys(source: string): void {
  let cursor = 0
  const fail = (): never => { throw new TypeError('Invalid hosted JSON frame') }
  const whitespace = (): void => {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
  }
  const stringToken = (): string => {
    if (source[cursor] !== '"') fail()
    const start = cursor++
    while (cursor < source.length) {
      const character = source[cursor++]
      if (character === '"') return JSON.parse(source.slice(start, cursor)) as string
      if (character === '\\') {
        if (cursor >= source.length) fail()
        const escape = source[cursor++]
        if (!'"\\/bfnrtu'.includes(escape ?? '')) fail()
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor, cursor + 4))) fail()
          cursor += 4
        }
      } else if ((character?.charCodeAt(0) ?? 0) < 0x20) fail()
    }
    return fail()
  }
  const value = (): void => {
    whitespace()
    if (source[cursor] === '{') {
      cursor += 1; whitespace()
      const keys = new Set<string>()
      if (source[cursor] === '}') { cursor += 1; return }
      for (;;) {
        whitespace()
        const key = stringToken()
        if (keys.has(key)) fail()
        keys.add(key); whitespace()
        if (source[cursor++] !== ':') fail()
        value(); whitespace()
        const delimiter = source[cursor++]
        if (delimiter === '}') return
        if (delimiter !== ',') fail()
      }
    }
    if (source[cursor] === '[') {
      cursor += 1; whitespace()
      if (source[cursor] === ']') { cursor += 1; return }
      for (;;) {
        value(); whitespace()
        const delimiter = source[cursor++]
        if (delimiter === ']') return
        if (delimiter !== ',') fail()
      }
    }
    if (source[cursor] === '"') { stringToken(); return }
    const start = cursor
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor]!)) cursor += 1
    if (cursor === start) fail()
    const primitive = source.slice(start, cursor)
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(primitive)) fail()
    const parsed = JSON.parse(primitive) as unknown
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail()
  }
  value(); whitespace()
  if (cursor !== source.length) fail()
}
