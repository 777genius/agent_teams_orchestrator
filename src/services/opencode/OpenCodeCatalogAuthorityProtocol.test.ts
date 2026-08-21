import { describe, expect, test } from 'bun:test'

import {
  decodeAuthorityReply,
  OPENCODE_CATALOG_AUTHORITY_VERSION,
  OPENCODE_CATALOG_MAX_ENVELOPE_BYTES,
  OPENCODE_CATALOG_MAX_WIRE_BYTES,
} from './OpenCodeCatalogAuthorityProtocol.js'

describe('catalog authority protocol bounds', () => {
  test('accepts a correlated v44307 reply', () => {
    expect(decodeAuthorityReply(JSON.stringify({
      version: OPENCODE_CATALOG_AUTHORITY_VERSION,
      id: 'request-1',
      ok: true,
      value: { generation: 1 },
    }), 'request-1').value).toEqual({ generation: 1 })
  })

  test('wire allowance includes worst-case nested JSON escaping', () => {
    expect(OPENCODE_CATALOG_MAX_WIRE_BYTES)
      .toBe(OPENCODE_CATALOG_MAX_ENVELOPE_BYTES * 2 + 262_144)
  })

  test('rejects a multibyte reply by encoded bytes rather than JS character count', () => {
    const oversized = 'é'.repeat(Math.floor(OPENCODE_CATALOG_MAX_WIRE_BYTES / 2) + 1)
    expect(() => decodeAuthorityReply(oversized, 'request-1')).toThrow('reply too large')
  })
})
