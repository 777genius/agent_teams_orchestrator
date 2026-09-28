import { constants, lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'

const MAX_ROSTER_FILE_BYTES = 256 * 1024
const MAX_ROSTER_MEMBERS = 512
const LEAD_AGENT_TYPES = new Set(['team-lead', 'lead', 'orchestrator'])

/** Same bound as hosted member names; the lead is addressed by omitting the recipient. */
export const HOSTED_MESSAGE_RECIPIENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/

export function isHostedMessageRecipientName(value: unknown): value is string {
  if (typeof value !== 'string' || !HOSTED_MESSAGE_RECIPIENT_PATTERN.test(value)) return false
  const lower = value.toLowerCase()
  return lower !== 'user' && lower !== TEAM_LEAD_NAME && !LEAD_AGENT_TYPES.has(lower)
}

/** Answers whether a name is a current, non-lead teammate of the hosted team. */
export interface HostedMessageRecipientRoster {
  isActiveRecipient(name: string): Promise<boolean>
}

/**
 * Reads the admitted team root on every call so a removal takes effect before
 * the next persist or inbox append. members.meta.json is authoritative when it
 * exists; config.json is the legacy roster. A malformed roster throws.
 */
export class HostedTeamRecipientRoster implements HostedMessageRecipientRoster {
  constructor(private readonly canonicalTeamRoot: string) {
    if (!isAbsolute(canonicalTeamRoot)) throw new TypeError('Hosted recipient roster requires an absolute team root')
  }

  async isActiveRecipient(name: string): Promise<boolean> {
    if (!isHostedMessageRecipientName(name)) return false
    const members = await this.#readMembers()
    return members.some(member =>
      member.name === name && member.removedAt === undefined && !isLeadRosterMember(member))
  }

  async #readMembers(): Promise<Array<Record<string, unknown>>> {
    const meta = await readPrivateRosterFile(join(this.canonicalTeamRoot, 'members.meta.json'))
    if (meta !== null) {
      const record = parseRecord(meta)
      if (record.version !== 1) throw new Error('Invalid hosted members metadata version')
      return parseMembers(record.members)
    }
    const config = await readPrivateRosterFile(join(this.canonicalTeamRoot, 'config.json'))
    return config === null ? [] : parseMembers(parseRecord(config).members)
  }
}

function isLeadRosterMember(member: Record<string, unknown>): boolean {
  const name = String(member.name).toLowerCase()
  return name === TEAM_LEAD_NAME || name === 'user' ||
    (typeof member.agentType === 'string' && LEAD_AGENT_TYPES.has(member.agentType.trim().toLowerCase()))
}

function parseRecord(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hosted roster file')
  return value as Record<string, unknown>
}

function parseMembers(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ROSTER_MEMBERS) throw new Error('Invalid hosted roster')
  return value.map(member => {
    if (!member || typeof member !== 'object' || Array.isArray(member) ||
      typeof (member as Record<string, unknown>).name !== 'string') throw new Error('Invalid hosted roster member')
    return member as Record<string, unknown>
  })
}

async function readPrivateRosterFile(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const [stat, linked] = await Promise.all([handle.stat(), lstat(path)])
    if (!stat.isFile() || !linked.isFile() || stat.dev !== linked.dev || stat.ino !== linked.ino ||
      stat.size > MAX_ROSTER_FILE_BYTES) throw new Error('Unsafe hosted roster file')
    const text = await handle.readFile('utf8')
    if (Buffer.byteLength(text) > MAX_ROSTER_FILE_BYTES) throw new Error('Hosted roster file exceeds size limit')
    return text
  } finally {
    await handle.close()
  }
}
