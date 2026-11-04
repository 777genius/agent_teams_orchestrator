import { expect, test } from 'bun:test'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { releaseOpenCodeV2Contract } from './release-delivery.js'
import { stageOpenCodeV2ReleaseFiles } from './delivery.js'

test('workflow smoke gate follows source qualification, including V2-off releases', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release-runtime.yml', import.meta.url), 'utf8')
  const expression = workflow.match(/qualified="\$\(bun --no-install -e '([^']+)'\)"/)![1]!
  for (const mode of ['bundled', 'off'] as const) {
    for (const [platform, versions] of Object.entries(releaseOpenCodeV2Contract(mode).qualified)) {
      const result = Bun.spawnSync([process.execPath, '--no-install', '-e', expression], {
        env: { ...process.env, RELEASE_PLATFORM: platform, RUNTIME_OPENCODE_V2: mode },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe(String(versions.length > 0))
    }
  }
  const unknown = Bun.spawnSync([process.execPath, '--no-install', '-e', expression], {
    env: { ...process.env, RELEASE_PLATFORM: 'unknown', RUNTIME_OPENCODE_V2: 'bundled' },
  })
  expect(unknown.exitCode).not.toBe(0)
  expect(workflow).toContain("if: runner.os == 'Windows' && steps.staged-support.outputs.qualified == 'true'")
  expect(workflow).toContain("if: runner.os != 'Windows' && steps.staged-support.outputs.qualified == 'true'")
})

test('staging refuses a missing qualified descriptor but accepts an unqualified base', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-release-smoke-routing-'))
  const saved = process.env.RUNTIME_OPENCODE_V2
  process.env.RUNTIME_OPENCODE_V2 = 'bundled'
  try {
    await mkdir(path.join(root, 'release/runtime'), { recursive: true })
    await writeFile(path.join(root, 'release/runtime/VERSION'), '0.0.157\n')
    await writeFile(path.join(root, 'release/runtime/COMMIT_SHA'), 'a'.repeat(40) + '\n')
    for (const [platform, versions] of Object.entries(releaseOpenCodeV2Contract().qualified)) {
      if (versions.length) await expect(stageOpenCodeV2ReleaseFiles(platform, root)).rejects.toMatchObject({ code: 'ENOENT' })
      else await stageOpenCodeV2ReleaseFiles(platform, root)
    }
  } finally {
    if (saved === undefined) delete process.env.RUNTIME_OPENCODE_V2
    else process.env.RUNTIME_OPENCODE_V2 = saved
    await rm(root, { recursive: true, force: true })
  }
})
