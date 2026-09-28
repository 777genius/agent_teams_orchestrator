import { createHash } from 'node:crypto'

/** Roster record fields that decide a hosted task-board member identity. */
export type HostedRosterMemberIdentity = {
  name: unknown
  memberId?: unknown
  joinedAt?: unknown
  agentId?: unknown
}

/**
 * The hosted task-board member ID, as Product's hostedTaskBoardRosterAuthority
 * derives it: an explicit roster memberId wins; otherwise name plus joinedAt,
 * then agentId, then the name. docs/hosted-roster-identity-golden.json pins it
 * across both repositories.
 */
export function hostedRosterMemberId(teamId: string | null, member: HostedRosterMemberIdentity): string | null {
  if (typeof member.memberId === 'string' && /^member_[0-9a-f]{32}$/.test(member.memberId)) return member.memberId
  if (!teamId || typeof member.name !== 'string' || member.name.length === 0) return null
  const immutableIdentity = Number.isSafeInteger(member.joinedAt) && (member.joinedAt as number) >= 0
    ? `${member.name}\0${member.joinedAt as number}`
    : typeof member.agentId === 'string' && member.agentId.length > 0
      ? member.agentId
      : member.name
  return `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: immutableIdentity })).digest('hex').slice(0, 32)}`
}
