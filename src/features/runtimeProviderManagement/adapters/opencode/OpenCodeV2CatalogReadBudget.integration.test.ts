import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('expired shared budget refuses V1 before starting catalog work', async () => {
  const script = `
    import { mock, spyOn } from 'bun:test'
    import assert from 'node:assert/strict'
    const identityPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/compatibility/OpenCodeNativeIdentity.ts'))}
    const identity = await import(identityPath)
    mock.module(identityPath, () => ({ ...identity, inspectOpenCodeReadSelection: async () => ({
      policy: { generation: 'v1', version: '1.2.27' }, native: null,
    }) }))
    const { OpenCodeProviderManagementAdapter } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeProviderManagementAdapter.ts'))})
    const { OpenCodeV2CatalogReadBudget } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2CatalogReadBudget.ts'))})
    const clock = spyOn(performance, 'now').mockReturnValue(0)
    const run = OpenCodeV2CatalogReadBudget.prototype.run
    spyOn(OpenCodeV2CatalogReadBudget.prototype, 'run').mockImplementation(async function (operation) {
      const value = await run.call(this, operation)
      // A scheduling pause may consume the final remainder between selection's
      // last check and the caller resuming to start the V1 path.
      clock.mockReturnValue(101)
      return value
    })
    let started = 0
    const adapter = new OpenCodeProviderManagementAdapter({ catalogOverallTimeoutMs: 100 })
    adapter.loadModelsWithinDeadline = async () => { started++; return { ok: true, value: { models: [] } } }
    try {
      const result = await adapter.loadModels({ runtimeId: 'opencode', providerId: 'local', projectPath: '/tmp/TEST-expired-selection' })
      assert.equal(started, 0)
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'runtime-unhealthy')
      assert.match(result.error.message, /overall deadline exceeded after 100ms/)
    } finally { mock.restore() }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(code).toBe(0)
}, 20_000)

test('V1 catalog deadline cancels scope preparation before any late profile or host work', async () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const identityPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/compatibility/OpenCodeNativeIdentity.ts'))}
    const identity = await import(identityPath)
    mock.module(identityPath, () => ({ ...identity, inspectOpenCodeReadSelection: async () => ({
      policy: { generation: 'v1', version: '1.19.4' }, native: null,
    }) }))
    const profilePath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))}
    const profile = await import(profilePath)
    let cancelled = false, published = false, inventoryReads = 0, scopeStarted = false, release
    const waiting = new Promise(resolve => { release = resolve })
    mock.module(profilePath, () => ({ ...profile,
      canonicalizeOpenCodeProjectPath: async () => '/TEST/catalog-scope',
      resolveOpenCodeProfileScope: async input => {
        scopeStarted = true
        await new Promise((resolve, reject) => {
          waiting.then(resolve)
          input.abortSignal?.addEventListener('abort', () => {
            cancelled = true; reject(input.abortSignal.reason)
          }, { once: true })
        })
        published = true
        return { scopeToken: 'TEST-late-scope' }
      },
    }))
    const { OpenCodeProviderManagementAdapter } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeProviderManagementAdapter.ts'))})
    // The deadline must cover selection startup before testing the scope cancellation.
    const adapter = new OpenCodeProviderManagementAdapter({ catalogOverallTimeoutMs: 5_000,
      inventoryService: { probe: async () => { inventoryReads++; throw Error('TEST unexpected catalog continuation') } } })
    try {
      const result = await adapter.loadModels({ runtimeId: 'opencode', providerId: 'openrouter', projectPath: '/TEST/catalog-scope' })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'runtime-unhealthy')
      assert.equal(scopeStarted, true, 'The test must reach scoped preparation before its deadline')
      assert.equal(cancelled, true, 'The caller timeout must cancel its owned scope preparation')
      release(); await Bun.sleep(5)
      assert.equal(published, false, 'An expired read must never publish a late scoped profile')
      assert.equal(inventoryReads, 0)
    } finally { release(); mock.restore() }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).not.toContain('AssertionError')
  expect(code).toBe(0)
}, 20_000)

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

for (const source of ['project-config', 'imported-config', 'project-default', 'global-default', 'global-default-cli'] as const) {
  // Reading global defaults follows project/profile preparation. Keep the FIFO
  // read reachable before testing cancellation on busy CI runners.
  const budgetMs = source === 'global-default' ? 1_000 : 200
  test.skipIf(process.platform === 'win32')(`catalog deadline interrupts a blocked ${source} read and joins private profile cleanup`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-file-cancel-'))
    const script = `
      import { mock, spyOn } from 'bun:test'
      import assert from 'node:assert/strict'
      import { constants, openSync, closeSync, writeSync } from 'node:fs'
      import * as filesystem from 'node:fs/promises'
      import { tmpdir } from 'node:os'
      import path from 'node:path'
      const { mkdir, mkdtemp, readdir, realpath, rm } = filesystem
      const root = await realpath(${JSON.stringify(root)})
      for (const name of ['home', 'data', 'cache', 'project']) await mkdir(path.join(root, name))
      Object.assign(process.env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
        CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
        XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'xdg-data') })
      for (const name of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'CLAUDE_MULTIMODEL_OPENCODE_SCOPE_CONFIG_CONTENT']) delete process.env[name]
      const { openCodeProjectPreferencesRoot } = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeManagedDefaultSelection.ts'))})
      const source = ${JSON.stringify(source)}, project = path.join(root, 'project')
      const file = source === 'project-config' ? path.join(project, 'opencode.json')
        : source === 'imported-config' ? path.join(root, 'config/opencode/opencode.jsonc')
        : source === 'project-default' ? path.join(openCodeProjectPreferencesRoot(project), 'agent-teams-runtime-preferences.json')
        : path.join(root, 'data/opencode/global-runtime-preferences.json')
      await mkdir(path.dirname(file), { recursive: true })
      const fifo = Bun.spawn(['mkfifo', file], { stdout: 'pipe', stderr: 'pipe' })
      assert.equal(await fifo.exited, 0, await new Response(fifo.stderr).text())
      let keeper = openSync(file, constants.O_RDWR | constants.O_NONBLOCK)
      const pendingReads = [], originalReadFile = filesystem.readFile
      spyOn(filesystem, 'readFile').mockImplementation((target, options) => {
        const read = originalReadFile(target, options)
        if (target === file) pendingReads.push(read.then(() => undefined, () => undefined))
        return read
      })
      const identityPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/compatibility/OpenCodeNativeIdentity.ts'))}
      const identity = await import(identityPath)
      mock.module(identityPath, () => ({ ...identity, inspectOpenCodeReadSelection: async () => ({
        policy: { generation: 'v2', version: '2.1.4' }, native: { generation: 'v2', version: '2.1.4' },
      }) }))
      const receiptPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.ts'))}
      const receipt = await import(receiptPath)
      let receipts = 0, acquisitions = 0
      mock.module(receiptPath, () => ({ ...receipt, createOpenCodeV2ExecutionReceipt: async () => { receipts++; throw Error('TEST-unexpected-receipt') } }))
      const hostPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/host/OpenCodeV2ExecutionHost.ts'))}
      const host = await import(hostPath)
      mock.module(hostPath, () => ({ ...host, acquireOpenCodeV2CatalogLease: async () => { acquisitions++; throw Error('TEST-unexpected-acquisition') } }))
      const { OpenCodeProviderManagementAdapter } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeProviderManagementAdapter.ts'))})
      const profiles = path.join(root, 'data/opencode/v2/provider-profiles')
      const profileNames = () => readdir(profiles).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      const assertCancelled = async result => {
        assert.equal(pendingReads.length, 1, 'The real helper must reach the blocked file')
        assert(result, 'The catalog deadline must finish before the blocked read is released')
        assert.equal(result.ok, false)
        assert.equal(result.error.code, 'runtime-unhealthy')
        assert.match(result.error.message, new RegExp('catalog timed out during profile.*budget ' + ${budgetMs} + 'ms'))
        assert.deepEqual(await profileNames(), [], 'Private credentials must be cleaned before returning')
        assert.equal(receipts, 0); assert.equal(acquisitions, 0)
      }
      let work, watchdog
      try {
        const adapter = new OpenCodeProviderManagementAdapter({ catalogOverallTimeoutMs: ${budgetMs} })
        if (source === 'global-default-cli') {
          const load = adapter.loadModels.bind(adapter)
          adapter.loadModels = async input => {
            work = load(input)
            const result = await work
            await assertCancelled(result)
            return result
          }
          const facadePath = ${JSON.stringify(import.meta.resolve('../../index.ts'))}
          const facade = await import(facadePath)
          mock.module(facadePath, () => ({ ...facade, openCodeProviderManagementAdapter: adapter }))
          const { runtimeProvidersModels } = await import(${JSON.stringify(import.meta.resolve('../../../../cli/handlers/runtime.ts'))})
          // The existing handler must drain JSON and exit while the FIFO is still
          // held open: readFile's pending OS request cannot keep this command alive.
          await runtimeProvidersModels({ runtime: 'opencode', provider: 'opencode', projectPath: project, json: true })
          assert.fail('The runtime command must exit')
        }
        work = adapter.loadModels({ runtimeId: 'opencode', providerId: 'opencode', projectPath: project })
        const result = await Promise.race([work, new Promise(resolve => { watchdog = setTimeout(() => resolve(null), 1500) })])
        await assertCancelled(result)
        writeSync(keeper, '{}'); closeSync(keeper); keeper = undefined
        await Promise.all(pendingReads)
        await work
        assert.deepEqual(await profileNames(), [])
        assert.equal(receipts, 0); assert.equal(acquisitions, 0)
      } finally {
        clearTimeout(watchdog)
        if (keeper !== undefined) { writeSync(keeper, '{}'); closeSync(keeper) }
        await Promise.all(pendingReads); await work
        mock.restore()
        await rm(root, { recursive: true, force: true })
      }
    `
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(child.signalCode).toBeNull()
      expect(stderr).toBe('')
      expect(code).toBe(source === 'global-default-cli' ? 1 : 0)
      if (source === 'global-default-cli') {
        const response = JSON.parse(stdout)
        expect(response.error.code).toBe('runtime-unhealthy')
        expect(response.error.message).toMatch(new RegExp('catalog timed out during profile.*budget ' + budgetMs + 'ms'))
      }
    } finally {
      clearTimeout(watchdog)
      child.kill('SIGKILL'); await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
}

test('public V2 model catalog refusal keeps a finite profile stage and a private sanitized record', async () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import path from 'node:path'
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-stage-'))
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    const identityPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/compatibility/OpenCodeNativeIdentity.ts'))}
    const identity = await import(identityPath)
    mock.module(identityPath, () => ({ ...identity, inspectOpenCodeReadSelection: async () => ({
      policy: { generation: 'v2', version: '2.1.4' },
      native: { generation: 'v2', version: '2.1.4' },
    }) }))
    const profilePath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))}
    const profile = await import(profilePath)
    const secret = 'TEST-SECRET-private-provider-error'
    mock.module(profilePath, () => ({ ...profile,
      resolveOpenCodeV2CatalogProfileScope: async () => { throw Object.assign(Error(secret), { code: 'EACCES', syscall: 'open', path: secret }) },
    }))
    const { OpenCodeProviderManagementAdapter } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeProviderManagementAdapter.ts'))})
    try {
      const adapter = new OpenCodeProviderManagementAdapter({ catalogOverallTimeoutMs: 2000 })
      const result = await adapter.loadModels({ runtimeId: 'opencode', providerId: 'opencode', projectPath: root })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'runtime-unhealthy')
      assert.match(result.error.message, /stage: profile, category: provider_operation_unknown/)
      assert(!JSON.stringify(result).includes(secret), 'Private provider exception escaped into the public DTO')
      const folder = path.join(root, 'opencode/v2/provider-diagnostics')
      const names = await readdir(folder)
      assert.equal(names.length, 1)
      const bytes = await readFile(path.join(folder, names[0]), 'utf8')
      assert(!bytes.includes(secret), 'Private provider exception escaped into diagnostics')
      const observation = JSON.parse(bytes)
      assert.equal(observation.phase, 'provider-model-catalog-profile')
      assert.equal(observation.category, 'provider_operation_unknown')
      assert.deepEqual(observation.failure, { name: 'Error', errno: 'EACCES', operation: 'open' })
      assert.equal(observation.retainedOriginal, true)
    } finally { mock.restore(); await rm(root, { recursive: true, force: true }) }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: '' })
}, 20_000)

test('V2 model-list failure preserves models phase when lease retirement succeeds', async () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import path from 'node:path'
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-model-failure-'))
    const project = path.join(root, 'project')
    await mkdir(project)
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    const secret = 'TEST-SECRET-native-model-list'
    let retired = 0, unregistered = 0
    const p = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))}
    const profile = await import(p)
    mock.module(p, () => ({ ...profile, canonicalizeOpenCodeProjectPath: async () => project,
      resolveOpenCodeV2CatalogProfileScope: async () => ({ scopeToken: 'TEST-scope' }),
      materializeOpenCodeV2CatalogScope: async () => ({ provider: {}, authPath: path.join(root, 'auth.json'), preferredModel: null }),
    }))
    const r = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.ts'))}
    const receipt = await import(r)
    mock.module(r, () => ({ ...receipt, createOpenCodeV2ExecutionReceipt: async () => ({ graph: { delivery: null } }) }))
    const h = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/host/OpenCodeV2ExecutionHost.ts'))}
    const host = await import(h)
    const authority = { pin: '2.1.4', directory: project }
    mock.module(h, () => ({ ...host,
      acquireOpenCodeV2CatalogLease: async (_native, profile) => ({ authority, close: async () => {
        retired++; await rm(profile.root, { recursive: true, force: true })
      } }),
      requireExecutionEndpoint: () => ({ baseUrl: 'http://127.0.0.1:1', password: 'TEST-only', signal: new AbortController().signal }),
      registerExecutionDisposer: () => () => { unregistered++ },
    }))
    const w = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/transport/OpenCodeV2ProviderWire.ts'))}
    const providerWire = await import(w)
    let disposed = 0
    mock.module(w, () => ({ ...providerWire, OpenCodeV2ProviderWire: class {
      fetch = async () => { throw Error('TEST-unexpected-provider-fetch') }
      async dispose() { disposed++ }
    } }))
    const m = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/transport/OpenCodeV2ClientModule.ts'))}
    const client = await import(m)
    mock.module(m, () => ({ ...client, resolveOpenCodeV2ClientEntry: async () => 'TEST-entry',
      importOpenCodeV2ClientModule: async () => ({ wire: 'current', module: { OpenCode: {
        make: () => ({ model: { list: async () => { throw Error(secret) } } }),
      } } }),
    }))
    const { loadOpenCodeV2ProviderModels } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProviderManagement.ts'))})
    const { OpenCodeV2CatalogReadBudget } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2CatalogReadBudget.ts'))})
    try {
      const budget = new OpenCodeV2CatalogReadBudget(5000)
      const selected = { policy: { generation: 'v2', version: '2.1.4' }, native: { generation: 'v2', version: '2.1.4' } }
      const result = await budget.run(current => loadOpenCodeV2ProviderModels({
        runtimeId: 'opencode', providerId: 'opencode', projectPath: project,
      }, selected, current))
      assert.equal(result.ok, false)
      assert.match(result.error.message, /stage: models, category: provider_operation_unknown/)
      assert(!JSON.stringify(result).includes(secret))
      assert.equal(retired, 1)
      assert.equal(disposed, 1)
      assert.equal(unregistered, 1)
      const directory = path.join(root, 'opencode/v2/provider-diagnostics')
      const names = await readdir(directory)
      assert.equal(names.length, 1)
      const bytes = await readFile(path.join(directory, names[0]), 'utf8')
      assert(!bytes.includes(secret))
      const row = JSON.parse(bytes)
      assert.equal(row.phase, 'provider-model-catalog-models')
      assert.equal(row.category, 'provider_operation_unknown')
    } finally { mock.restore(); await rm(root, { recursive: true, force: true }) }
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' },
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: '' })
}, 20_000)
