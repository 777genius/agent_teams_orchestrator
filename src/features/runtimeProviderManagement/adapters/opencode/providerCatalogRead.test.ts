import { expect, test } from 'bun:test'

import { providerCatalogReadFailures, readProviderCatalogWithRetry } from './providerCatalogRead.js'

test('does not repeat successful reads, including an honestly empty catalog', async () => {
  let calls = 0
  expect(await readProviderCatalogWithRetry(async () => { calls += 1; return [] })).toEqual({ ok: true, value: [] })
  expect(calls).toBe(1)
})

test('recovers a transient read once and records both errors on permanent failure', async () => {
  const attempts: number[] = []
  expect(await readProviderCatalogWithRetry(async attempt => {
    attempts.push(attempt)
    if (attempt === 0) throw new Error('cold start timeout')
    return ['github-copilot']
  })).toEqual({ ok: true, value: ['github-copilot'] })
  expect(attempts).toEqual([0, 1])
  let failures = 0
  const result = await readProviderCatalogWithRetry(async () => { failures += 1; throw new Error(`timeout ${failures}`) })
  expect(failures).toBe(2)
  expect(providerCatalogReadFailures({ '/provider': result })).toContain('/provider: Both catalog read attempts failed: timeout 1\ntimeout 2')
  expect(providerCatalogReadFailures({ '/provider': { ok: true, value: [] } })).toBeNull()
})
