import { expect, test } from 'bun:test'

test('saved API keys affect only the selected private model catalog without connection or model effects', async () => {
  // Scope resolution, private materialization, the published SDK and ProviderWire
  // are real. The live native smoke separately checks OpenCode's paid-model filter.
  const script = `
    import assert from 'node:assert/strict'
    import { spyOn } from 'bun:test'
    import { createHash } from 'node:crypto'
    import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
    import path from 'node:path'
    import { tmpdir } from 'node:os'
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-key-')))
    for (const name of ['home', 'data', 'cache', 'project']) await mkdir(path.join(root, name))
    Object.assign(process.env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'xdg-data') })
    const project = await realpath(path.join(root, 'project'))
    const profiles = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))})
    const auth = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeAuthStore.ts'))})
    const receipts = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.ts'))})
    const host = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/host/OpenCodeV2ExecutionHost.ts'))})
    const pin = '2.1.4', providerId = 'opencode', secret = 'TEST-selected-key', unrelated = 'TEST-unrelated-key'
    const sourceAuth = path.join(root, 'data/opencode/auth.json')
    const native = { generation: 'v2', version: pin, engineVersion: pin, dialect: 'v2-2.1.4',
      executablePath: path.join(root, 'TEST-opencode'), executableSha256: 'a'.repeat(64), packageName: null }
    const selectedRead = { native, policy: { generation: 'v2', version: pin }, fingerprint: null }
    const input = { runtimeId: 'opencode', providerId, projectPath: project, limit: null }
    const models = [
      { id: 'free', modelID: 'free', providerID: providerId, name: 'Free', enabled: true, status: 'active',
        capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
      { id: 'paid', modelID: 'paid', providerID: providerId, name: 'Paid', enabled: true, status: 'active',
        capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 },
        cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] },
    ]
    const catalogs = [], requests = []
    let profile, authority, endpoint, closed = 0, unregistered = 0, integrationFailure = null, providerFailure = null, modelFailure = null
    const spies = [
      spyOn(receipts, 'createOpenCodeV2ExecutionReceipt').mockResolvedValue({ graph: {} }),
      spyOn(host, 'acquireOpenCodeV2CatalogLease').mockImplementation(async (_native, selectedProfile) => {
        profile = selectedProfile; catalogs.push(profile)
        assert.equal(profile.selection.purpose, 'catalog')
        assert.equal(profile.directory, project)
        assert.equal(profile.config.sha256, createHash('sha256').update(profile.config.content).digest('hex'))
        const configPath = path.join(profile.config.directory, 'opencode.json')
        assert.equal(await readFile(configPath, 'utf8'), profile.config.content)
        if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600)
        const controller = new AbortController()
        authority = { pin, directory: project }
        endpoint = { baseUrl: 'http://127.0.0.1:1', password: 'TEST-private-transport', signal: controller.signal,
          async fetch(input, init) {
            const request = new Request(input, init), url = new URL(request.url)
            requests.push([request.method, url.pathname])
            assert.equal(request.method, 'GET', 'Catalog reads cannot authenticate or execute a model')
            assert.equal(request.body, null)
            assert.equal(url.searchParams.get('location[directory]'), project)
            if (url.pathname === '/api/model' && modelFailure) {
              if (modelFailure === 'transport') throw new Error('TEST-model-read-failed')
              return Response.json({ location: { directory: path.join(project, 'TEST-other-scope') }, data: models.slice(0, 1) })
            }
            const optionalFailure = url.pathname === '/api/provider' ? providerFailure
              : url.pathname === '/api/integration/opencode' ? integrationFailure : null
            if (optionalFailure) {
              if (optionalFailure === 'transport') throw new Error('TEST-optional-read-failed')
              if (optionalFailure === 'malformed') return new Response('TEST-not-json', { headers: { 'content-type': 'application/json' } })
              return Response.json({ location: { directory: path.join(project, 'TEST-other-scope') },
                data: url.pathname === '/api/provider' ? [] : { id: providerId, name: 'OpenCode', methods: [{ type: 'key' }], connections: [] } })
            }
            const key = JSON.parse(profile.config.content).providers.opencode?.settings?.apiKey
            const data = url.pathname === '/api/model' ? (key === secret ? models : models.slice(0, 1))
              : url.pathname === '/api/provider' ? [{ id: providerId, integrationID: providerId,
                name: 'OpenCode', activation: 'enabled', settings: { apiKey: key ?? 'public' } }]
              : url.pathname === '/api/integration/opencode'
                ? { id: providerId, name: 'OpenCode', methods: [{ type: 'key' }], connections: [] }
                : assert.fail('Unexpected request: ' + url.pathname)
            return Response.json({ location: { directory: project }, data })
          } }
        return { authority, signal: controller.signal, close: async () => { closed++; controller.abort() } }
      }),
      spyOn(host, 'requireExecutionEndpoint').mockImplementation(value => { assert.equal(value, authority); return endpoint }),
      spyOn(host, 'registerExecutionDisposer').mockImplementation(() => () => { unregistered++ }),
    ]
    try {
      const { loadOpenCodeV2ProviderModels, loadOpenCodeV2ProviderSetupForm } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProviderManagement.ts'))})
      const anonymous = await loadOpenCodeV2ProviderModels(input, selectedRead)
      assert.equal(anonymous.ok, true, JSON.stringify(anonymous))
      assert.deepEqual(anonymous.value.models.map(row => row.modelId), ['opencode/free'])
      assert.equal(anonymous.value.models[0].accessKind, 'builtin_free')
      for (const source of ['provider', 'integration']) for (const failure of ['transport', 'malformed', 'scope']) {
        providerFailure = source === 'provider' ? failure : null
        integrationFailure = source === 'integration' ? failure : null
        const fallback = await loadOpenCodeV2ProviderModels(input, selectedRead)
        assert.equal(fallback.ok, true, JSON.stringify(fallback))
        assert.deepEqual(fallback.value.models.map(row => row.modelId), ['opencode/free'])
        assert.equal(fallback.value.models[0].accessKind, 'credentialed')
        assert.equal(fallback.value.models[0].routeKind, 'catalog_provider')
        assert.equal(fallback.value.models[0].free, true)
        assert.equal(fallback.value.models[0].proofState, 'needs_probe')
        assert.equal(fallback.value.models[0].requiresExecutionProof, true)
      }
      providerFailure = null; integrationFailure = null
      for (const failure of ['transport', 'scope']) {
        modelFailure = failure
        const requiredRead = await loadOpenCodeV2ProviderModels(input, selectedRead)
        assert.equal(requiredRead.ok, false, 'An unavailable or incorrectly scoped required catalog must remain a failure')
      }
      modelFailure = null
      await auth.upsertOpenCodeApiAuthCredential({ authPath: sourceAuth, providerId, apiKey: secret })
      await auth.upsertOpenCodeApiAuthCredential({ authPath: sourceAuth, providerId: 'deepseek', apiKey: unrelated })
      const sourceBefore = await readFile(sourceAuth, 'utf8')
      const credentialed = await loadOpenCodeV2ProviderModels(input, selectedRead)
      assert.equal(credentialed.ok, true, JSON.stringify(credentialed))
      assert.deepEqual(credentialed.value.models.map(row => row.modelId), ['opencode/free', 'opencode/paid'])
      assert.equal(credentialed.value.models[1].availability, 'untested')
      assert.equal(credentialed.value.models[1].proofState, 'needs_probe')
      assert.equal(credentialed.value.models[1].requiresExecutionProof, true)
      assert.equal(credentialed.value.models[0].accessKind, 'credentialed')
      assert.equal(JSON.stringify(credentialed).includes(secret), false)
      assert.equal(JSON.stringify(credentialed).includes(unrelated), false)
      const savedProfile = catalogs.at(-1)
      assert.deepEqual(JSON.parse(savedProfile.config.content).providers, { opencode: { settings: { apiKey: secret } } })
      assert.deepEqual(JSON.parse(await readFile(path.join(savedProfile.root, 'data/opencode/auth.json'), 'utf8')),
        { opencode: { type: 'api', key: secret } })
      assert.equal(await readFile(sourceAuth, 'utf8'), sourceBefore)
      const setup = await loadOpenCodeV2ProviderSetupForm(input, selectedRead)
      assert.equal(setup.ok, true, JSON.stringify(setup))
      assert.deepEqual(JSON.parse(catalogs.at(-1).config.content).providers, { opencode: {} },
        'Setup/Connect must retain the initially empty native connection flow')
      assert.equal(JSON.stringify(setup).includes(secret), false)
      assert.equal(await readFile(sourceAuth, 'utf8'), sourceBefore)
      await auth.removeOpenCodeAuthCredential({ authPath: sourceAuth, providerId })
      const removed = await loadOpenCodeV2ProviderModels(input, selectedRead)
      assert.equal(removed.ok, true, JSON.stringify(removed))
      assert.deepEqual(removed.value.models.map(row => row.modelId), ['opencode/free'])
      assert.equal(removed.value.models[0].accessKind, 'builtin_free')
      assert.equal(catalogs.at(-1).config.content.includes(unrelated), false)
      assert.equal(closed, catalogs.length)
      assert.equal(unregistered, catalogs.length)
      await assert.rejects(access(path.join(root, 'data/opencode/v2/provider-connections')), { code: 'ENOENT' })
      await auth.upsertOpenCodeAuthCredential({ authPath: sourceAuth, providerId: 'openai',
        credential: { type: 'oauth', access: 'TEST-access', refresh: 'TEST-refresh', expires: 0 } })
      const scope = await profiles.resolveOpenCodeV2CatalogProfileScope({ providerId: 'openai', projectPath: project })
      const target = path.join(root, 'TEST-oauth-scope.json')
      const oauth = await profiles.materializeOpenCodeV2CatalogScope(scope, project, target, { includeSelectedApiKey: true })
      assert.equal(oauth.provider.apiKey, undefined, 'This path never imports OAuth into native catalog settings')
      await writeFile(target, '{}', { mode: 0o600 })
      await assert.rejects(profiles.materializeOpenCodeV2CatalogScope(scope, project, target, { includeSelectedApiKey: true }),
        /changed since scope resolution/)
    } finally {
      for (const spy of spies) spy.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  `
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', NODE_ENV: 'test',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }
  for (const name of ['TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, env, stdout: 'pipe', stderr: 'pipe' })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ exit, output: stdout + stderr }).toEqual({ exit: 0, output: '' })
}, 30_000)


test('pre-lease catalog failures remove sealed selected keys, but an entered acquisition retains its owned root', async () => {
  const script = `
    import assert from 'node:assert/strict'
    import { spyOn } from 'bun:test'
    import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
    import path from 'node:path'
    import { tmpdir } from 'node:os'
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-prelease-')))
    for (const name of ['home', 'data', 'cache', 'project']) await mkdir(path.join(root, name))
    Object.assign(process.env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'xdg-data') })
    const project = await realpath(path.join(root, 'project'))
    const profiles = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))})
    const auth = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeAuthStore.ts'))})
    const receipts = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.ts'))})
    const host = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/host/OpenCodeV2ExecutionHost.ts'))})
    const pin = '2.1.4', providerId = 'opencode', secret = 'TEST-sealed-prelease-key'
    const sourceAuth = path.join(root, 'data/opencode/auth.json'), parent = path.join(root, 'data/opencode/v2/provider-profiles')
    await auth.upsertOpenCodeApiAuthCredential({ authPath: sourceAuth, providerId, apiKey: secret })
    const originalAuth = await readFile(sourceAuth, 'utf8')
    const selectedRead = { native: { generation: 'v2', version: pin, engineVersion: pin, dialect: 'v2-2.1.4',
      executablePath: path.join(root, 'TEST-opencode'), executableSha256: 'a'.repeat(64), packageName: null },
      policy: { generation: 'v2', version: pin }, fingerprint: null }
    const materialize = profiles.materializeOpenCodeV2CatalogScope
    let phase = 'materialize', catalogRoot, acquired = 0, receiptCalls = 0
    const assertKeys = async (configExpected) => {
      assert.deepEqual(JSON.parse(await readFile(path.join(catalogRoot, 'data/opencode/auth.json'), 'utf8')),
        { opencode: { type: 'api', key: secret } })
      if (configExpected) {
        const config = JSON.parse(await readFile(path.join(catalogRoot, 'config/opencode/opencode.json'), 'utf8'))
        assert.equal(config.providers.opencode.settings.apiKey, secret)
      }
    }
    const spies = [
      spyOn(profiles, 'materializeOpenCodeV2CatalogScope').mockImplementation(async (...args) => {
        const result = await materialize(...args)
        catalogRoot = path.dirname(path.dirname(path.dirname(args[2])))
        await assertKeys(false)
        if (phase === 'materialize') throw new Error('TEST-after-selected-auth-write')
        return result
      }),
      spyOn(receipts, 'createOpenCodeV2ExecutionReceipt').mockImplementation(async () => {
        receiptCalls++; await assertKeys(true)
        if (phase === 'receipt') throw new Error('TEST-receipt-preparation-failed')
        return { graph: {} }
      }),
      spyOn(host, 'acquireOpenCodeV2CatalogLease').mockImplementation(async (_native, profile) => {
        acquired++; assert.equal(phase, 'acquire'); assert.equal(profile.root, catalogRoot)
        await assertKeys(true)
        throw new Error('TEST-entered-acquisition-ownership-unknown')
      }),
    ]
    try {
      const { loadOpenCodeV2ProviderModels } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProviderManagement.ts'))})
      for (const stage of ['materialize', 'receipt', 'acquire']) {
        phase = stage
        const result = await loadOpenCodeV2ProviderModels({ runtimeId: 'opencode', providerId, projectPath: project, limit: null }, selectedRead)
        assert.equal(result.ok, false)
        assert.equal(JSON.stringify(result).includes(secret), false)
        assert.equal(await readFile(sourceAuth, 'utf8'), originalAuth, 'Original selected mirror must remain unchanged')
        if (stage === 'acquire') {
          assert.equal(acquired, 1); await assertKeys(true)
          assert.deepEqual(await readdir(parent), [path.basename(catalogRoot)])
        } else {
          assert.equal(acquired, 0, 'No native acquisition may occur after preparation failure')
          await assert.rejects(access(catalogRoot), { code: 'ENOENT' })
          assert.deepEqual(await readdir(parent), [])
        }
      }
      assert.equal(receiptCalls, 2)
    } finally {
      for (const spy of spies) spy.mockRestore()
      // No native process was ever started by these transport-boundary stubs.
      await rm(root, { recursive: true, force: true })
    }
  `
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', NODE_ENV: 'test',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }
  for (const name of ['TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, env, stdout: 'pipe', stderr: 'pipe' })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exit, output: stdout + stderr }).toEqual({ exit: 0, output: '' })
}, 30_000)
