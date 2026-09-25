import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  buildOpenCodeRuntimeMessageText,
  classifyOpenCodeDeliveryReplyContract,
  type OpenCodeRuntimeMessageTextInput,
} from './OpenCodeRuntimeMessageText.js'

// The same bytes live in agent-teams-ai docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '06a45a0dd5e67898749a46e7f04ad04907d010413c038a18b6e55ff689e6794c'

type Golden = {
  format: string
  cases: Array<{ name: string; input: OpenCodeRuntimeMessageTextInput; expectedText: string }>
}

function readGolden(): { raw: Buffer; golden: Golden } {
  const raw = readFileSync(new URL('../../../docs/opencode-runtime-message-text-golden.json', import.meta.url))
  return { raw, golden: JSON.parse(raw.toString('utf8')) as Golden }
}

describe('buildOpenCodeRuntimeMessageText', () => {
  test('uses the shared cross-repository golden vector', () => {
    const { raw, golden } = readGolden()
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256)
    expect(golden.format).toBe('agent-teams.opencode-runtime-message-text-golden/v1')
    expect(golden.cases.length).toBeGreaterThan(0)
  })

  test('produces byte-identical text to the Product builder for every golden case', () => {
    for (const entry of readGolden().golden.cases) {
      expect({ name: entry.name, text: buildOpenCodeRuntimeMessageText(entry.input) })
        .toEqual({ name: entry.name, text: entry.expectedText })
    }
  })

  test('classifies the sender into the same reply contract as Product', () => {
    expect(classifyOpenCodeDeliveryReplyContract(undefined)).toBe('user_reply')
    expect(classifyOpenCodeDeliveryReplyContract(' User ')).toBe('user_reply')
    expect(classifyOpenCodeDeliveryReplyContract('SYSTEM')).toBe('informational')
    expect(classifyOpenCodeDeliveryReplyContract('Team-Lead')).toBe('lead_reply')
    expect(classifyOpenCodeDeliveryReplyContract('orchestrator')).toBe('lead_reply')
    expect(classifyOpenCodeDeliveryReplyContract('teamlead')).toBe('teammate_report')
    expect(classifyOpenCodeDeliveryReplyContract('alice')).toBe('teammate_report')
  })
})
