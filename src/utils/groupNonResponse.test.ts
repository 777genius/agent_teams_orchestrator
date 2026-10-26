import { expect, test } from 'bun:test'
import { isGroupNonResponseText } from './groupNonResponse.js'

test('reserved trailing control token cancels the entire peer fallback without interpreting its prose', () => {
  for (const text of ['[[AGENT_TEAMS_NO_REPLY]]', 'Reading instructions first.\n\n[[AGENT_TEAMS_NO_REPLY]]',
    'Сначала проверю каталог. [[AGENT_TEAMS_NO_REPLY]]', 'result is 42 [[AGENT_TEAMS_NO_REPLY]]   '])
    expect(isGroupNonResponseText(text)).toBe(true)
  for (const text of ['No reply needed; result is 42.', '"[[AGENT_TEAMS_NO_REPLY]]"', '`[[AGENT_TEAMS_NO_REPLY]]`',
    '\\[[AGENT_TEAMS_NO_REPLY]]', '> [[AGENT_TEAMS_NO_REPLY]]', '  >> [[AGENT_TEAMS_NO_REPLY]]', 'Answer: 42\n> [[AGENT_TEAMS_NO_REPLY]]', '[[AGENT_TEAMS_NO_REPLY]] result is 42.', 'x[[AGENT_TEAMS_NO_REPLY]]', '[[AGENT_TEAMS_NO_RE'])
    expect(isGroupNonResponseText(text)).toBe(false)
})
