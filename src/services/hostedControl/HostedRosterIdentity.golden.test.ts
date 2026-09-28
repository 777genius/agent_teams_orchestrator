import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostedRosterMemberId } from '../../utils/hostedRosterMemberId.js'
import { HostedTeamRecipientRoster } from './HostedTeamRecipientRoster.js'

// The same bytes live in agent-teams-ai docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '643eae7aea140911b732b048bb0d7db239ef689c57aa04fca39e7fd0e90d738c'

type Member = { name: string; memberId?: string; joinedAt?: number; agentId?: string; removedAt?: number }
type Golden = {
  format: string
  teamId: string
  formula: Array<{ rawMemberName: string; memberId: string }>
  roster: {
    membersMetaJson: string
    activeMembers: Array<{ name: string; memberId: string }>
    activeRecipients: string[]
    inactiveNames: string[]
  }
  promotion: { legacyKey: string; membersMetaJson: string }
}

const raw = readFileSync(new URL('../../../docs/hosted-roster-identity-golden.json', import.meta.url))
const golden = JSON.parse(raw.toString('utf8')) as Golden

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function members(json: string): Member[] {
  return (JSON.parse(json) as { members: Member[] }).members
}

describe('hosted roster identity cross-repository golden', () => {
  test('uses the shared Product-generated vector', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256)
    expect(golden.format).toBe('agent-teams.hosted-roster-identity-golden/v1')
  })

  test('derives the Product member ID for every raw member name', () => {
    for (const entry of golden.formula) {
      expect(hostedRosterMemberId(golden.teamId, { name: entry.rawMemberName })).toBe(entry.memberId)
    }
  })

  test('derives the Product active owners from the same members.meta.json records', () => {
    const active = members(golden.roster.membersMetaJson)
      .filter(member => member.removedAt === undefined && member.name.toLowerCase() !== 'user')
      .map(member => ({ name: member.name, memberId: hostedRosterMemberId(golden.teamId, member) }))
    expect(active).toEqual(golden.roster.activeMembers)
  })

  test('sees the same current teammates as message recipients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-roster-golden-')); roots.push(root)
    await writeFile(join(root, 'members.meta.json'), golden.roster.membersMetaJson)
    const roster = new HostedTeamRecipientRoster(root)
    for (const name of golden.roster.activeRecipients) expect({ name, active: await roster.isActiveRecipient(name) }).toEqual({ name, active: true })
    for (const name of golden.roster.inactiveNames) expect({ name, active: await roster.isActiveRecipient(name) }).toEqual({ name, active: false })
  })

  test('reads the explicit member ID Product publishes at promotion as the one it would derive', async () => {
    const promoted = members(golden.promotion.membersMetaJson)
    expect(promoted.length).toBeGreaterThan(1)
    for (const { memberId, ...member } of promoted) {
      expect(member.agentId).toBe(`${member.name}@${golden.promotion.legacyKey}`)
      expect(hostedRosterMemberId(golden.teamId, member)).toBe(memberId!)
    }
    const root = await mkdtemp(join(tmpdir(), 'hosted-roster-golden-')); roots.push(root)
    await writeFile(join(root, 'members.meta.json'), golden.promotion.membersMetaJson)
    const roster = new HostedTeamRecipientRoster(root)
    expect(await Promise.all(promoted.map(member => roster.isActiveRecipient(member.name))))
      .toEqual(promoted.map(member => member.name !== 'team-lead'))
  })
})
