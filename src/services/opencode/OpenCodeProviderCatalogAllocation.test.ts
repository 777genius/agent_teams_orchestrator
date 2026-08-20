import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'

import { allocateOpenCodeProviderCatalogAttempt } from './OpenCodeProviderCatalogService.js'

test('global allocator keeps 4,096 scopes in fixed rows and monotonic sqlite_sequence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-attempt-bound-'))
  const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
  process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
  try {
    const scope = '/canonical/project\0deepinfra'
    let allocation = await allocateOpenCodeProviderCatalogAttempt(`${scope}-0`, 1_000)
    for (let index = 1; index < 4_096; index += 1) {
      allocation = await allocateOpenCodeProviderCatalogAttempt(`${scope}-${index}`, 1_000)
      if (index % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    expect(allocation.requestGeneration).toBe(4_096)
    const allocationRoot = path.join(root, 'opencode', 'provider-catalog-attempts-v2')
    await mkdir(path.join(allocationRoot, 'crashed-unrelated.ticket'), { recursive: true })
    expect((await allocateOpenCodeProviderCatalogAttempt(scope, 900)).requestGeneration).toBe(4_097)
    const inspection = new Database(path.join(allocationRoot, 'attempts.sqlite'))
    inspection.exec('PRAGMA wal_checkpoint(PASSIVE)')
    expect(inspection.query<{ count: number }, []>('SELECT count(*) AS count FROM allocation_ticket').get()?.count)
      .toBeLessThanOrEqual(64)
    expect(inspection.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count)
      .toBeLessThanOrEqual(16)
    inspection.close()
    const modulePath = path.join(import.meta.dir, 'OpenCodeProviderCatalogService.ts')
    const children = Array.from({ length: 8 }, () => Bun.spawn([
      process.execPath, '-e',
      `import { allocateOpenCodeProviderCatalogAttempt as allocate } from ${JSON.stringify(modulePath)}; console.log((await allocate(${JSON.stringify(scope)}, 800)).requestGeneration)`,
    ], { env: { ...process.env, CLAUDE_MULTIMODEL_CACHE_HOME: root }, stdout: 'pipe', stderr: 'pipe' }))
    const concurrent = await Promise.all(children.map(async child => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (exitCode !== 0) throw new Error(`fake allocator child failed: ${stderr}`)
      return Number(stdout.trim())
    }))
    expect(concurrent.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 8 }, (_, index) => 4_098 + index),
    )
    expect((await allocateOpenCodeProviderCatalogAttempt(scope, 700)).requestGeneration).toBe(4_106)
    const files = await readdir(allocationRoot)
    expect(files.filter(file => file.startsWith('attempts.sqlite')).length).toBeLessThanOrEqual(3)
    expect((await stat(path.join(allocationRoot, 'attempts.sqlite'))).size).toBeLessThan(1_000_000)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
