import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyOpenCodeReadGeneration } from '../../src/services/opencode/compatibility/OpenCodeGenerationPolicy.ts'
import { privateOpenCodeReadEnvironment } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.ts'
import { resolveDirectWindowsLauncher, spawnSyncPortableCli } from '../../src/utils/portableCli.ts'
import { runProviderSmoke } from './windows-runtime-opencode-provider-json.mjs'

test('Windows smoke fixture version admits the supported V1 profile path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-fixture-version-'))
  try {
    const fixture = path.join(root, 'fake-opencode.cjs')
    copyFileSync(fileURLToPath(new URL('./windows-runtime-opencode-fixture.cjs', import.meta.url)), fixture)
    const result = spawnSync(process.execPath, [fixture, '--version'], {
      cwd: root, env: privateOpenCodeReadEnvironment(root), encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(classifyOpenCodeReadGeneration(result.stdout), { generation: 'v1', version: '1.18.34' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('emitted provider smoke uses the recognized direct npm Node shim before private PATH', () => {
  let recognized = false
  let version: SpawnSyncReturns<Buffer | string> | undefined
  runProviderSmoke('fixture-runtime-never-executed.exe', { cases: [] }, () => {}, {
    spawn: (_binary: string, _args?: unknown, options?: SpawnSyncOptions) => {
      assert.ok(options?.env, 'smoke invocation must supply its isolated environment')
      if (!version) {
        const launcher = options.env!.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH!
        const root = path.dirname(launcher)
        const originalPlatform = process.platform
        let direct: ReturnType<typeof resolveDirectWindowsLauncher>
        try {
          Object.defineProperty(process, 'platform', { value: 'win32' })
          direct = resolveDirectWindowsLauncher(launcher)
        } finally { Object.defineProperty(process, 'platform', { value: originalPlatform }) }
        assert.ok(direct, 'provider JSON smoke must bypass the arbitrary CMD fallback')
        assert.deepEqual(direct, { command: 'node', argsPrefix: [path.join(root, 'fake-opencode.cjs')] })
        recognized = true
        if (originalPlatform === 'win32') {
          // Exercise the real launcher with the provider smoke's trusted SDK
          // environment. Private-child version admission is a separate gate.
          assert.ok(options.env.PATH?.split(path.delimiter).includes(path.dirname(process.execPath)))
          version = spawnSyncPortableCli(launcher, ['--version'], {
            cwd: root, env: options.env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
          })
        }
      }
      throw new Error('This contract executes only the emitted fixture launcher')
    },
    cleanup: (_report, root) => { rmSync(root, { recursive: true, force: true }) },
  })
  assert.equal(recognized, true, 'existing smoke hook must expose the recognized emitted launcher')
  if (process.platform === 'win32') {
    assert.ok(version, 'Windows must execute the actual portable launcher')
    assert.equal(version.status, 0, String(version.stderr))
    assert.deepEqual(classifyOpenCodeReadGeneration(String(version.stdout)), { generation: 'v1', version: '1.18.34' })
  }
})
