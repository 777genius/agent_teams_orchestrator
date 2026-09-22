import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const launcherPath = join(repoRoot, 'cli-source')

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createFakeBunHome(): Promise<{
  homeDir: string
  capturePath: string
}> {
  const tempDir = await mkdtemp(join(tmpdir(), 'cli-source-launcher-test-'))
  tempDirs.push(tempDir)
  const homeDir = join(tempDir, 'home')
  const binDir = join(homeDir, '.bun', 'bin')
  const capturePath = join(tempDir, 'node-env.txt')
  const fakeBunPath = join(binDir, 'bun')
  await mkdir(binDir, { recursive: true })
  await writeFile(
    fakeBunPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s" "${NODE_ENV:-}" > "${CAPTURE_NODE_ENV}"',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  )
  await chmod(fakeBunPath, 0o755)
  return { homeDir, capturePath }
}

function buildLauncherEnv(params: {
  homeDir: string
  capturePath: string
  preserveNodeEnv?: boolean
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: params.homeDir,
    NODE_ENV: 'production',
    CAPTURE_NODE_ENV: params.capturePath,
  }
  delete env.BUN_INSTALL
  if (params.preserveNodeEnv) {
    env.CLAUDE_TEAM_SOURCE_LAUNCHER_PRESERVE_NODE_ENV = '1'
  } else {
    delete env.CLAUDE_TEAM_SOURCE_LAUNCHER_PRESERVE_NODE_ENV
  }
  return env
}

describe('cli-source launcher', () => {
  it('normalizes production NODE_ENV to development for source smoke runs', async () => {
    const { homeDir, capturePath } = await createFakeBunHome()

    const result = spawnSync(launcherPath, ['--version'], {
      env: buildLauncherEnv({ homeDir, capturePath }),
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    await expect(readFile(capturePath, 'utf8')).resolves.toBe('development')
  })

  it('can preserve production NODE_ENV when explicitly requested', async () => {
    const { homeDir, capturePath } = await createFakeBunHome()

    const result = spawnSync(launcherPath, ['--version'], {
      env: buildLauncherEnv({
        homeDir,
        capturePath,
        preserveNodeEnv: true,
      }),
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    await expect(readFile(capturePath, 'utf8')).resolves.toBe('production')
  })
})
