import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { allocateOpenCodeProviderCatalogAttempt } from './OpenCodeProviderCatalogService.js'

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

test('compatibility allocation burns monotonic native authority generations', async () => {
  const cacheHome = await mkdtemp(path.join(os.tmpdir(), 'catalog-allocation-')); roots.push(cacheHome)
  const one = await allocateOpenCodeProviderCatalogAttempt('one', 1, { cacheHome })
  const two = await allocateOpenCodeProviderCatalogAttempt('two', 2, { cacheHome })
  expect(two.requestGeneration).toBe(one.requestGeneration + 1)
  expect(two.attemptIdentity).not.toBe(one.attemptIdentity)
})
