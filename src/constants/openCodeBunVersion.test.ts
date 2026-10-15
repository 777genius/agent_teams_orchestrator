import { expect, test } from 'bun:test'
import { openCodeBunVersion } from './openCodeBunVersion.js'
import { validatePackagedOpenCodeIdentity } from '../cli/packagedOpenCodeDelivery.js'
import pins from '../../scripts/runtime-bun-pins.json'

test('packaged runtime binds the platform to its exact pinned Bun', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const expected = platform === 'win32' ? '1.4.3' : '1.3.11'
    expect(openCodeBunVersion(platform)).toBe(expected)
    const identity = { schema: 1, platform, arch: 'x64', bunVersion: expected,
      bunSha256: 'a'.repeat(64), entrySha256: 'b'.repeat(64) } as const
    expect(validatePackagedOpenCodeIdentity(identity)).toEqual(identity)
    expect(() => validatePackagedOpenCodeIdentity({ ...identity,
      bunVersion: platform === 'win32' ? '1.3.11' : '1.4.3' })).toThrow()
  }
  for (const [target, asset] of Object.entries(pins.assets)) {
    expect(('version' in asset ? asset.version : pins.version)).toBe(openCodeBunVersion(target.split('-')[0]))
  }
})
