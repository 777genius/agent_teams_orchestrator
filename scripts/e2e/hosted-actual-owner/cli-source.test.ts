import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('hosted actual-owner source launcher black box', () => {
  test('uses the absolute shell and the pinned Bun bytes without module mocks', async () => {
    const root = await mkdtemp('/tmp/actual-owner-source-launch-')
    roots.push(root)
    const bin = join(root, 'bin')
    await mkdir(bin, { mode: 0o700 })
    const pathBashMarker = join(root, 'path-bash-ran')
    await writeFile(join(bin, 'bash'), `#!/bin/sh\nprintf unsafe >${pathBashMarker}\nexit 91\n`, { mode: 0o500 })
    const bunBytes = Buffer.from('#!/bin/sh\nprintf "%s\\n" "$@"\n')
    const bun = join(root, 'bun')
    await writeFile(bun, bunBytes, { mode: 0o500 })

    const repositoryRoot = process.cwd()
    const launcherPath = join(repositoryRoot, 'scripts/e2e/hosted-actual-owner/cli-source')
    const sourceEntry = join(repositoryRoot, 'scripts/e2e/hosted-actual-owner-owner.ts')
    const stagedEntry = join(root, 'owner.ts')
    await copyFile(sourceEntry, stagedEntry)
    await chmod(stagedEntry, 0o400)
    const launcher = await open(launcherPath, 'r')
    try {
      const args = [
        '--hosted-actual-owner-acceptance-entry', stagedEntry,
        '--runtime-manifest', join(root, 'manifest.json'),
        '--actual-owner-contract', join(root, 'contract.json'),
        '--actual-owner-contract-sha256', 'a'.repeat(64),
        '--actual-owner-contract-byte-count', '1',
        '--launcher-lease-fd', '6', '--liveness-fd', '7', '--bootstrap-fd', '8',
      ]
      const child = spawn('/proc/self/fd/3', args, {
        cwd: repositoryRoot,
        env: {
          PATH: bin,
          HOSTED_ACTUAL_OWNER_E2E_BUN_EXECUTABLE: bun,
          HOSTED_ACTUAL_OWNER_E2E_BUN_SHA256: createHash('sha256').update(bunBytes).digest('hex'),
        },
        stdio: ['ignore', 'pipe', 'pipe', launcher.fd],
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout!).text(), new Response(child.stderr!).text(),
        new Promise<number | null>(resolve => child.once('exit', resolve)),
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout.trim().split('\n')).toEqual(['run', sourceEntry, ...args.slice(2)])
      expect(await Bun.file(pathBashMarker).exists()).toBe(false)
    } finally {
      await launcher.close()
    }
  })
})
