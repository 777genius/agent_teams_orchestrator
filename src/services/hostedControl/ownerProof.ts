import { createHmac, timingSafeEqual } from 'node:crypto'
import { constants, type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  OWNER_PROOF_DOMAIN,
  type HostedControlOwnerBinding,
  type HostedControlProof,
} from './protocol.js'

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

async function openOwnedDirectory(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW)
}

export async function resolveHostedControlOwnerBinding(input: {
  claudeRoot: string
  legacyKey: string
}): Promise<{
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

function proofInput(direction: 'request' | 'response', envelope: object): string {
  return domainProofInput(OWNER_PROOF_DOMAIN, direction, envelope)
}
function domainProofInput(domain: string, direction: string, envelope: object): string {
  const unsigned = { ...(envelope as Record<string, unknown>) }
  delete unsigned.ownerProof
  return `${domain}\0${direction}\0${JSON.stringify(unsigned)}`
}

export function createHostedDomainProof(secret: Uint8Array, domain: string, direction: string, envelope: object): string { return createHmac('sha256', secret).update(domainProofInput(domain, direction, envelope)).digest('hex') }

export function createHostedControlProof(
  secret: Uint8Array,
  direction: 'request' | 'response',
  envelope: object,
): HostedControlProof {
  return createHmac('sha256', secret).update(proofInput(direction, envelope)).digest('hex')
}

export function verifyHostedControlProof(
  secret: Uint8Array,
  direction: 'request' | 'response',
  envelope: { ownerProof: HostedControlProof },
): boolean {
  const expected = createHostedControlProof(secret, direction, envelope)
  const actual = envelope.ownerProof
  if (actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}
