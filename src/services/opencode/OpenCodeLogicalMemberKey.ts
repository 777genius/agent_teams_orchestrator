import { createHash } from 'node:crypto'

import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'

export type OpenCodeLogicalMemberIdentity = Readonly<{
  teamId: string
  laneId: string
  projectIdentity: string
  memberName: string
}>

/**
 * Canonical identity shared by the durable launch claim and its session-store
 * projection. Opaque caller identities deliberately are not authority here:
 * two otherwise valid envelopes naming the same logical member must collide.
 */
export function normalizeOpenCodeLogicalMemberIdentity(
  input: OpenCodeLogicalMemberIdentity,
): OpenCodeLogicalMemberIdentity {
  const teamId = normalizeComponent(input.teamId, 'teamId')
  const laneId = normalizeComponent(input.laneId || 'primary', 'laneId')
  const memberName = normalizeComponent(input.memberName, 'memberName').toLowerCase()
  const projectIdentity = normalizeOpenCodeProjectIdentity(
    normalizeComponent(input.projectIdentity, 'projectIdentity'),
  )
  return Object.freeze({ teamId, laneId, projectIdentity, memberName })
}

export function openCodeLogicalMemberKey(input: OpenCodeLogicalMemberIdentity): string {
  const normalized = normalizeOpenCodeLogicalMemberIdentity(input)
  return createHash('sha256').update(JSON.stringify({
    domain: 'agent-teams/opencode-logical-member/v1',
    ...normalized,
  })).digest('hex')
}

export function assertOpenCodeLogicalMemberIdentity(
  input: OpenCodeLogicalMemberIdentity,
  expectedKey: string,
): OpenCodeLogicalMemberIdentity {
  const normalized = normalizeOpenCodeLogicalMemberIdentity(input)
  if (openCodeLogicalMemberKey(normalized) !== expectedKey) {
    throw new Error('OpenCode logical member identity mismatch')
  }
  return normalized
}

function normalizeComponent(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`invalid OpenCode logical member ${field}`)
  }
  return normalized
}
