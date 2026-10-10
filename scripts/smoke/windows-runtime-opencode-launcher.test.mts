import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyOpenCodeReadGeneration } from '../../src/services/opencode/compatibility/OpenCodeGenerationPolicy.ts'
import { privateOpenCodeReadEnvironment } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.ts'
import { spawnSyncPortableCli } from '../../src/utils/portableCli.ts'
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

test('emitted Windows smoke launcher resolves Node under the compiled runtime private PATH', {
  skip: process.platform !== 'win32',
}, () => {
  let version: SpawnSyncReturns<Buffer | string> | undefined
  runProviderSmoke('fixture-runtime-never-executed.exe', { cases: [] }, () => {}, {
    spawn: (_binary: string, _args?: unknown, options?: SpawnSyncOptions) => {
      assert.ok(options?.env, 'smoke invocation must supply its isolated environment')
      if (!version) {
        const launcher = options.env!.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH!
        const root = path.dirname(launcher)
        const env = privateOpenCodeReadEnvironment(root)
        // The compiled process lives beside runtime.exe, outside Node's toolcache.
        env.PATH = [path.join(root, 'runtime-bin'), path.join(env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';')
        assert.equal(env.PATH.split(';').includes(path.dirname(process.execPath)), false)
        for (const directory of env.PATH.split(';')) assert.equal(existsSync(path.join(directory, 'cursor-agent.exe')), false)
        version = spawnSyncPortableCli(launcher, ['--version'], {
          cwd: root, env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
        })
      }
      throw new Error('This contract executes only the emitted fixture launcher')
    },
    cleanup: (_report, root) => { rmSync(root, { recursive: true, force: true }) },
  })
  assert.ok(version, 'existing smoke hook must expose the emitted launcher')
  assert.equal(version.status, 0, String(version.stderr))
  assert.deepEqual(classifyOpenCodeReadGeneration(String(version.stdout)), { generation: 'v1', version: '1.18.34' })
})
