import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  assertRuntimeArchiveLayout,
  assertRuntimeNativeChecksums,
  runtimeArchiveLayout,
  type RuntimeReleasePlatform,
} from './release-archive-layout.js'

const platforms: RuntimeReleasePlatform[] = [
  'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64',
]

describe('runtime release archive layout contract', () => {
  test.each(platforms)('%s contains the adjacent native authority and verified launcher', platform => {
    const layout = runtimeArchiveLayout(platform)
    expect(layout.entries).toEqual([
      'runtime/',
      `runtime/${layout.binaryName}`,
      `runtime/${layout.authorityName}`,
      `runtime/${layout.launcherName}`,
      'runtime/NATIVE_SHA256SUMS',
      'runtime/VERSION',
      'runtime/COMMIT_SHA',
    ])
    expect(() => assertRuntimeArchiveLayout(platform, layout.entries)).not.toThrow()
    expect(() => assertRuntimeArchiveLayout(
      platform,
      layout.entries.filter(entry => entry !== `runtime/${layout.authorityName}`),
    )).toThrow(/Invalid .* archive layout/)
    expect(() => assertRuntimeArchiveLayout(
      platform,
      layout.entries.filter(entry => entry !== `runtime/${layout.launcherName}`),
    )).toThrow(/Invalid .* archive layout/)
  })

  test('every release assembly path copies and verifies the worker contract', async () => {
    const workflow = await readFile('.github/workflows/release-runtime.yml', 'utf8')
    expect(workflow.match(/Copy native catalog artifacts/gi)?.length).toBe(2)
    expect(workflow).toContain('NATIVE_SHA256SUMS')
    expect(workflow).toContain('Verify deterministic archive layout')
    expect(workflow).toContain('release-archive-layout.ts')
  })

  test.each(platforms)('%s rejects missing, renamed, and hash-mismatched native artifacts', platform => {
    const layout = runtimeArchiveLayout(platform)
    const files = { [layout.authorityName]: new TextEncoder().encode('authority'),
      [layout.launcherName]: new TextEncoder().encode('launcher') }
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const sums = Object.entries(files).map(([name, bytes]) =>
      `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n')
    expect(() => assertRuntimeNativeChecksums(platform, sums, files)).not.toThrow()
    expect(() => assertRuntimeNativeChecksums(platform, sums, {
      ...files, [layout.authorityName]: new TextEncoder().encode('swapped'),
    })).toThrow(/artifact hash/)
    expect(() => assertRuntimeNativeChecksums(platform,
      sums.replace(layout.launcherName, `renamed-${layout.launcherName}`), files)).toThrow(/checksum names/)
  })
})
