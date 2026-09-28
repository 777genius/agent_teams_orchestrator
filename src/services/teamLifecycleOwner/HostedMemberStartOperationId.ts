import { createHash } from 'node:crypto'

const RUN_ID = /^run_[0-9a-f]{32}$/
const MEMBER_ID = /^member_[0-9a-f]{32}$/
const SHA256 = /^[0-9a-f]{64}$/
const DOMAIN = 'agent-teams.hosted-opencode-member-start/v1\0'

/** Stable across renewed admissions and owner generations for one frozen member plan. */
export function hostedMemberStartOperationId(runId: string, memberId: string, planSha256: string): string {
  if (!RUN_ID.test(runId) || !MEMBER_ID.test(memberId) || !SHA256.test(planSha256)) {
    throw new Error('Hosted member Start identity invalid')
  }
  return `start_${createHash('sha256').update(DOMAIN + JSON.stringify([runId, memberId, planSha256]), 'utf8').digest('hex')}`
}
