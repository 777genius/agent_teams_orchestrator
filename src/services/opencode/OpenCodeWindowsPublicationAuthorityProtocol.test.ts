import { describe, expect, test } from 'bun:test'
import { decodeOpenCodeWindowsPublicationReply, validOpenCodePublicationLeaf } from './OpenCodeWindowsPublicationAuthorityProtocol.js'

describe('OpenCodeWindowsPublicationAuthorityProtocol', () => {
  test('accepts bounded correlated replies and rejects unsafe leaves', () => {
    expect(decodeOpenCodeWindowsPublicationReply('{"version":1,"id":"a","ok":true,"value":{}}', 'a')).toEqual({})
    for (const leaf of ['', '.', '..', 'a/b', 'a\\b', 'trailing.', 'trailing ']) expect(validOpenCodePublicationLeaf(leaf)).toBe(false)
    expect(validOpenCodePublicationLeaf('passive-status.sqlite3')).toBe(true)
  })
  test('malformed and native failures are fixed and redacted', () => {
    for (const wire of ['not json', '{"version":2,"id":"secret-path","ok":true}',
      '{"version":1,"id":"a","ok":false,"error":"credential-sentinel"}']) {
      expect(() => decodeOpenCodeWindowsPublicationReply(wire, 'a')).toThrow('failed [redacted]')
      try { decodeOpenCodeWindowsPublicationReply(wire, 'a') } catch (error) {
        expect(String(error)).not.toContain('credential-sentinel'); expect(String(error)).not.toContain('secret-path')
      }
    }
  })
})
