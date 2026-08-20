import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import recorded from './BaseVsWipEvidence.json'

const root = path.resolve(import.meta.dir, '..')
const git = '/usr/bin/git'
const command = ['test', 'phase0-opencode-tests/OpenCodeStatusCatalogLaunch.regression.test.ts']

async function run(executable: string, args: string[], cwd: string): Promise<{ code: number; output: string; stdout: string }> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', TMPDIR: path.join(cwd, '.phase0-tmp') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, output: `${stdout}\n${stderr}`, stdout }
}

async function checked(executable: string, args: string[], cwd: string): Promise<string> {
  const result = await run(executable, args, cwd)
  if (result.code !== 0) throw new Error(`${executable} ${args.join(' ')} failed:\n${result.output}`)
  return result.output
}

function outcome(output: string, name: string): 'pass' | 'fail' | 'missing' {
  if (output.includes(`(pass) ${name}`)) return 'pass'
  if (output.includes(`(fail) ${name}`)) return 'fail'
  return 'missing'
}

test('executes unchanged production regressions in disposable base and patch-bound WIP git checkouts', async () => {
  expect(recorded.baseRevision).toMatch(/^[0-9a-f]{40}$/)
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-base-vs-wip-'))
  const base = path.join(tempRoot, 'base')
  const wip = path.join(tempRoot, 'wip')
  const patchFile = path.join(tempRoot, 'wip.patch')
  const phaseFiles = [
    'FakeOpenCodeRegressionHarness.ts',
    'OpenCodeStatusCatalogLaunch.regression.test.ts',
  ]
  const untrackedProduction = (await checked(
    git,
    ['ls-files', '--others', '--exclude-standard', '--', 'src'],
    root,
  )).split('\n').map(value => value.trim()).filter(Boolean)
  const wipRevision = (await checked(git, ['rev-parse', 'HEAD'], root)).trim()

  try {
    for (const checkout of [base, wip]) {
      await checked(git, ['clone', '--shared', '--no-checkout', root, checkout], tempRoot)
    }
    await checked(git, ['checkout', '--detach', recorded.baseRevision], base)
    await checked(git, ['checkout', '--detach', wipRevision], wip)
    for (const checkout of [base, wip]) {
      await mkdir(path.join(checkout, 'phase0-opencode-tests'), { recursive: true })
      await mkdir(path.join(checkout, '.phase0-tmp'), { recursive: true })
      for (const file of phaseFiles) await cp(path.join(import.meta.dir, file), path.join(checkout, 'phase0-opencode-tests', file))
    }

    const patchResult = await run(git, ['diff', '--binary', '--no-ext-diff'], root)
    if (patchResult.code !== 0) throw new Error(`${git} diff failed:\n${patchResult.output}`)
    const patch = patchResult.stdout
    await writeFile(patchFile, patch)
    if (patch.length > 0) await checked(git, ['apply', '--whitespace=nowarn', patchFile], wip)
    for (const relative of untrackedProduction) {
      const source = path.join(root, relative)
      try {
        await mkdir(path.dirname(path.join(wip, relative)), { recursive: true })
        await cp(source, path.join(wip, relative))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    const snapshotHash = createHash('sha256')
    snapshotHash.update(wipRevision)
    snapshotHash.update(patch)
    for (const file of phaseFiles) {
      snapshotHash.update(`phase0-opencode-tests/${file}`)
      snapshotHash.update(await readFile(path.join(import.meta.dir, file)))
    }
    for (const relative of untrackedProduction) {
      try {
        snapshotHash.update(relative)
        snapshotHash.update(await readFile(path.join(root, relative)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    const [baseRun, wipRun] = await Promise.all([
      run(process.execPath, command, base),
      run(process.execPath, command, wip),
    ])
    const names = {
      mothStatus: 'RED/Moth: passive command status completes without prepareProfile, writes, or processes',
      catalog443: '#443 containment: passive catalog uses profile plus live API without verbose/full prewarm',
      publicCompositionAdapter: 'RED/#436/#443: production exposes a public parameterized purpose-composition adapter',
    }
    const evidence = {
      schema: 2,
      baseRevision: recorded.baseRevision,
      wipSnapshotSha256: snapshotHash.digest('hex'),
      command: `${process.execPath} ${command.join(' ')}`,
      base: { exitCode: baseRun.code, outcomes: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, outcome(baseRun.output, name)])) },
      wip: { exitCode: wipRun.code, outcomes: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, outcome(wipRun.output, name)])) },
    }
    await writeFile(path.join(tempRoot, 'generated-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)

    expect(evidence.wipSnapshotSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence.base).toEqual({
      exitCode: 1,
      outcomes: { mothStatus: 'fail', catalog443: 'fail', publicCompositionAdapter: 'fail' },
    })
    expect(evidence.wip).toEqual({
      exitCode: 0,
      outcomes: { mothStatus: 'pass', catalog443: 'pass', publicCompositionAdapter: 'pass' },
    })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}, 120_000)
