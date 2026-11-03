import { expect, test } from 'bun:test'

for (const phase of ['selection', 'profile-scope', 'profile-auth', 'receipt'] as const) test(`V2 model catalog cancels stalled ${phase} before any native acquisition`, async () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { mkdtemp, readdir, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import path from 'node:path'
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-read-budget-'))
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    const phase = ${JSON.stringify(phase)}
    const wait = signal => new Promise((_, reject) => {
      assert(signal instanceof AbortSignal)
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const identityPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/compatibility/OpenCodeNativeIdentity.ts'))}
    const identity = await import(identityPath)
    mock.module(identityPath, () => ({ ...identity, inspectOpenCodeReadSelection: async signal => {
      if (phase === 'selection') return wait(signal)
      return { policy: { generation: 'v2', version: '2.1.4' }, native: { generation: 'v2', version: '2.1.4' } }
    } }))
    const profilePath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))}
    const profile = await import(profilePath)
    mock.module(profilePath, () => ({ ...profile,
      canonicalizeOpenCodeProjectPath: async () => root,
      resolveOpenCodeV2CatalogProfileScope: async input => phase === 'profile-scope'
        ? wait(input.abortSignal) : { scopeToken: 'TEST-scope' },
      materializeOpenCodeV2CatalogScope: async (_scope, _project, _auth, options) => phase === 'profile-auth'
        ? wait(options?.signal) : { provider: {}, authPath: path.join(root, 'TEST-auth.json'), preferredModel: null },
    }))
    const receiptPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.ts'))}
    const receipt = await import(receiptPath)
    mock.module(receiptPath, () => ({ ...receipt, createOpenCodeV2ExecutionReceipt: async (_root, _identity, _controller, _binding, signal) => wait(signal) }))
    const hostPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/host/OpenCodeV2ExecutionHost.ts'))}
    const host = await import(hostPath)
    let acquisitions = 0
    mock.module(hostPath, () => ({ ...host, acquireOpenCodeV2CatalogLease: async () => { acquisitions++; throw Error('TEST-unexpected-acquisition') } }))
    const { OpenCodeProviderManagementAdapter } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeProviderManagementAdapter.ts'))})
    try {
      const adapter = new OpenCodeProviderManagementAdapter({ catalogOverallTimeoutMs: 100 })
      const result = await adapter.loadModels({ runtimeId: 'opencode', providerId: 'opencode', projectPath: root })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'runtime-unhealthy')
      assert.match(result.error.message, new RegExp('catalog timed out during ' + (phase.startsWith('profile') ? 'profile' : phase)))
      assert.match(result.error.message, /budget 100ms/)
      assert.equal(acquisitions, 0)
      if (phase === 'receipt' || phase === 'profile-auth') assert.deepEqual(await readdir(path.join(root, 'opencode/v2/provider-profiles')), [])
    } finally { await rm(root, { recursive: true, force: true }) }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(code).toBe(0)
}, 20_000)

test('catalog profile cancellation reaches the real auth publication lock without writing after release', async () => {
  const script = `
    import assert from 'node:assert/strict'
    import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import path from 'node:path'
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-auth-cancel-')))
    for (const name of ['home', 'data', 'cache', 'project']) await mkdir(path.join(root, name))
    Object.assign(process.env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'xdg-data') })
    const { resolveOpenCodeV2CatalogProfileScope, materializeOpenCodeV2CatalogScope } = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))})
    const { withOpenCodeAuthCoordinationLock } = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeAuthCoordinationLock.ts'))})
    const { OpenCodeV2CatalogReadBudget } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2CatalogReadBudget.ts'))})
    let release, claimed, lock, work, watchdog
    const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { claimed = resolve })
    const input = { projectPath: path.join(root, 'project'), providerId: 'opencode' }
    const authPath = path.join(root, 'private/auth.json')
    try {
      const cancelled = new AbortController(), reason = new Error('TEST-catalog-scope-cancelled')
      cancelled.abort(reason)
      await assert.rejects(resolveOpenCodeV2CatalogProfileScope({ ...input, abortSignal: cancelled.signal }), error => error === reason)
      const scope = await resolveOpenCodeV2CatalogProfileScope(input)
      lock = withOpenCodeAuthCoordinationLock({ authPath, operation: async () => { claimed(); await gate } })
      await ready
      const budget = new OpenCodeV2CatalogReadBudget(50)
      work = budget.run(async current => {
        current.enter('profile')
        return materializeOpenCodeV2CatalogScope(scope, input.projectPath, authPath, { signal: current.signal })
      }).then(() => null, error => error)
      const result = await Promise.race([work, new Promise(resolve => { watchdog = setTimeout(() => resolve(null), 1000) })])
      assert(result instanceof Error, 'Cancellation must finish while the auth lock is still held')
      assert.match(result.message, /catalog timed out during profile/)
      await assert.rejects(access(authPath), { code: 'ENOENT' })
      release(); await lock; await work
      await assert.rejects(access(authPath), { code: 'ENOENT' })
    } finally {
      clearTimeout(watchdog); release()
      await lock?.catch(() => undefined); await work
      await rm(root, { recursive: true, force: true })
    }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(code).toBe(0)
}, 20_000)
