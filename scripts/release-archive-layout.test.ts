import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  assertRuntimeArchiveLayout,
  runtimeArchiveLayout,
  type RuntimeReleasePlatform,
} from './release-archive-layout.js'

const platforms: RuntimeReleasePlatform[] = [
  'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64',
]

describe('runtime release archive layout contract', () => {
  test.each(platforms)('%s contains the adjacent allocation worker', platform => {
    const layout = runtimeArchiveLayout(platform)
    expect(layout.entries).toEqual([
      'runtime/',
      `runtime/${layout.binaryName}`,
      `runtime/${layout.workerName}`,
      'runtime/VERSION',
      'runtime/COMMIT_SHA',
    ])
    expect(() => assertRuntimeArchiveLayout(platform, layout.entries)).not.toThrow()
    expect(() => assertRuntimeArchiveLayout(
      platform,
      layout.entries.filter(entry => entry !== `runtime/${layout.workerName}`),
    )).toThrow(/Invalid .* archive layout/)
  })

  test('every release assembly path copies and verifies the worker contract', async () => {
    const workflow = await readFile('.github/workflows/release-runtime.yml', 'utf8')
    expect(workflow.match(/Copy allocation worker|copy allocation worker/gi)?.length).toBe(3)
    expect(workflow).toContain('Verify deterministic archive layout')
    expect(workflow).toContain('release-archive-layout.ts')
  })
})
