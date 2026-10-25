import { describe, expect, test } from 'bun:test'
import { openCodeV2ReleaseContract } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { OPENCODE_V2_RELEASE_DELIVERY, openCodeV2ReleaseDelivery, releaseOpenCodeV2Contract } from './release-delivery.js'

describe('OpenCode V2 release delivery', () => {
  test('the committed setting decides unless the build overrides it explicitly', () => {
    expect(openCodeV2ReleaseDelivery({})).toBe(OPENCODE_V2_RELEASE_DELIVERY)
    expect(openCodeV2ReleaseDelivery({ RUNTIME_OPENCODE_V2: ' ' })).toBe(OPENCODE_V2_RELEASE_DELIVERY)
    expect(openCodeV2ReleaseDelivery({ RUNTIME_OPENCODE_V2: 'off' })).toBe('off')
    expect(openCodeV2ReleaseDelivery({ RUNTIME_OPENCODE_V2: 'bundled' })).toBe('bundled')
    for (const value of ['0', 'false', 'OFF', 'none']) expect(() => openCodeV2ReleaseDelivery({ RUNTIME_OPENCODE_V2: value })).toThrow()
  })

  test('a release without V2 keeps the range and every platform but qualifies no version', () => {
    const bundled = openCodeV2ReleaseContract()
    expect(releaseOpenCodeV2Contract('bundled')).toEqual(bundled)
    const off = releaseOpenCodeV2Contract('off')
    expect(off.range).toEqual(bundled.range)
    expect(Object.keys(off.qualified).sort()).toEqual(Object.keys(bundled.qualified).sort())
    expect(Object.values(off.qualified).every(versions => versions.length === 0)).toBe(true)
  })
})
