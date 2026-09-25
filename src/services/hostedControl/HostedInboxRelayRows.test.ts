import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { selectDeliverableInboxRows } from './HostedInboxRelayRows.js'

// The same bytes live in agent-teams-ai docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '0a331b8a9503e8057b6ed4b6dbab3488e3fb2d0e948ae3563a0d76fb8a30a6b6'

type Golden = {
  format: string
  cases: Array<{
    name: string
    recipient: string
    rows: Array<Record<string, unknown>>
    expected: Array<{ messageId: string; replyRecipient: string }>
  }>
}

describe('selectDeliverableInboxRows', () => {
  test('selects, orders and addresses rows exactly like the desktop OpenCode inbox relay', () => {
    const raw = readFileSync(new URL('../../../docs/opencode-inbox-relay-selection-golden.json', import.meta.url))
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256)
    const golden = JSON.parse(raw.toString('utf8')) as Golden
    expect(golden.format).toBe('agent-teams.opencode-inbox-relay-selection-golden/v1')
    expect(golden.cases.length).toBeGreaterThan(0)
    for (const entry of golden.cases) {
      expect({
        name: entry.name,
        selected: selectDeliverableInboxRows(entry.rows, entry.recipient)
          .map(row => ({ messageId: row.sourceMessageId, replyRecipient: row.replyRecipient })),
      }).toEqual({ name: entry.name, selected: entry.expected })
    }
  })
})
