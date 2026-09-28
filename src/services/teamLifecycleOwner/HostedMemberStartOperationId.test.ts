import { describe, expect, test } from 'bun:test'

import { hostedMemberStartOperationId } from './HostedMemberStartOperationId.js'

const RUN = `run_${'b'.repeat(32)}`
const MEMBER = `member_${'f'.repeat(32)}`
const PLAN_SHA256 = 'd'.repeat(64)

describe('hosted member Start operation ID', () => {
  test('matches the frozen Product/Owner contract vector', () => {
    expect(hostedMemberStartOperationId(RUN, MEMBER, PLAN_SHA256)).toBe(
      'start_89fca1ff37e680c24c36381ab6a78ba1da0ee332c520cff5625c74720bd90459',
    )
  })

  test('changes for each effect scope component', () => {
    const original = hostedMemberStartOperationId(RUN, MEMBER, PLAN_SHA256)
    expect(hostedMemberStartOperationId(`run_${'a'.repeat(32)}`, MEMBER, PLAN_SHA256)).not.toBe(original)
    expect(hostedMemberStartOperationId(RUN, `member_${'e'.repeat(32)}`, PLAN_SHA256)).not.toBe(original)
    expect(hostedMemberStartOperationId(RUN, MEMBER, 'c'.repeat(64))).not.toBe(original)
  })

  test('rejects noncanonical selectors before deriving an effect ID', () => {
    for (const [runId, memberId, planSha256] of [
      ['run_legacy', MEMBER, PLAN_SHA256],
      [RUN.toUpperCase(), MEMBER, PLAN_SHA256],
      [RUN, 'member_legacy', PLAN_SHA256],
      [RUN, MEMBER.toUpperCase(), PLAN_SHA256],
      [RUN, MEMBER, PLAN_SHA256.toUpperCase()],
      [RUN, MEMBER, 'd'.repeat(63)],
    ]) {
      expect(() => hostedMemberStartOperationId(runId, memberId, planSha256)).toThrow('identity invalid')
    }
  })
})
