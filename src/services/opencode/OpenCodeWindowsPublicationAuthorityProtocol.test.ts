import { describe, expect, test } from 'bun:test'
import { decodeOpenCodeWindowsPublicationReply, validOpenCodePublicationLeaf,
  validOpenCodePublicationRoot } from './OpenCodeWindowsPublicationAuthorityProtocol.js'

describe('OpenCodeWindowsPublicationAuthorityProtocol', () => {
  test('accepts bounded correlated replies and rejects unsafe leaves', () => {
    expect(decodeOpenCodeWindowsPublicationReply('{"version":1,"id":"a","ok":true,"value":{}}', 'a')).toEqual({})
    for (const leaf of ['', '.', '..', 'a/b', 'a\\b', 'line\nbreak', 'trailing.', 'trailing ',
      'auth.json:secret', 'CON', 'nul.txt', 'COM1.log']) expect(validOpenCodePublicationLeaf(leaf)).toBe(false)
    expect(validOpenCodePublicationLeaf('passive-status.sqlite3')).toBe(true)
    for (const root of ['C:\\safe:stream', '\\\\?\\C:\\safe', '\\\\.\\C:\\safe',
      'C:\\safe\\..\\escape', 'C:\\safe\\.\\child', 'C:\\NUL\\child',
      'C:\\safe\\\\child']) expect(validOpenCodePublicationRoot(root)).toBe(false)
    expect(validOpenCodePublicationRoot('C:\\safe\\child')).toBe(true)
  })
  test('malformed and native failures are fixed and redacted', () => {
    for (const wire of ['not json', '{"version":2,"id":"secret-path","ok":true}',
      '{"version":1,"id":"a","ok":false,"error":"credential-sentinel"}',
      '{"version":1,"id":"a","ok":true,"value":{},"unexpected":"credential-sentinel"}',
      '{"version":1,"id":"a","ok":false,"error":7}']) {
      expect(() => decodeOpenCodeWindowsPublicationReply(wire, 'a')).toThrow('failed [redacted]')
      try { decodeOpenCodeWindowsPublicationReply(wire, 'a') } catch (error) {
        expect(String(error)).not.toContain('credential-sentinel'); expect(String(error)).not.toContain('secret-path')
      }
    }
  })
})
