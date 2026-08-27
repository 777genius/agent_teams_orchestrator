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

  test('both native VFS sources durably publish a first journal before exposing it to SQLite', async () => {
    const [main, posix, windows] = await Promise.all([
      readFile('native/opencode-catalog-authority/src/main.rs', 'utf8'),
      readFile('native/opencode-catalog-authority/src/posix_vfs.rs', 'utf8'),
      readFile('native/opencode-catalog-authority/src/windows_vfs.rs', 'utf8'),
    ])
    expect(main).toContain('#[cfg(windows)]\nmod windows_vfs;')
    for (const source of [posix, windows]) {
      const created = source.indexOf('if created {')
      const before = source.indexOf('fault("journal-before-directory-sync")', created)
      const sync = source.indexOf('sync_directory', before) >= 0
        ? source.indexOf('sync_directory', before)
        : source.indexOf('fsync(root_fd()', before)
      const after = source.indexOf('fault("journal-after-directory-sync")', sync)
      expect(created).toBeGreaterThan(-1); expect(before).toBeGreaterThan(created)
      expect(sync).toBeGreaterThan(before); expect(after).toBeGreaterThan(sync)
    }
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
