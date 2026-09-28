import { describe, expect, test } from 'bun:test'

import { HOSTED_LEAD_INBOX_POLL_ENV, shouldTeamLeadPollInbox } from './hostedLeadInboxPoll.js'

const cases = [false, true].flatMap(hasActiveTeammates =>
  [false, true].flatMap(hasTeamContext =>
    [false, true].map(inputClosed => ({ hasActiveTeammates, hasTeamContext, inputClosed }))))

describe('shouldTeamLeadPollInbox', () => {
  test('without the hosted gate the desktop rule is unchanged', () => {
    for (const input of cases) {
      expect(shouldTeamLeadPollInbox({ ...input, env: {} })).toBe(input.hasActiveTeammates)
      expect(shouldTeamLeadPollInbox({ ...input, env: { [HOSTED_LEAD_INBOX_POLL_ENV]: '0' } }))
        .toBe(input.hasActiveTeammates)
    }
  })

  test('the hosted gate keeps a solo lead reading its inbox only while stdin is open', () => {
    const env = { [HOSTED_LEAD_INBOX_POLL_ENV]: '1' }
    for (const input of cases) {
      expect(shouldTeamLeadPollInbox({ ...input, env })).toBe(
        input.hasActiveTeammates || (input.hasTeamContext && !input.inputClosed),
      )
    }
  })
})
