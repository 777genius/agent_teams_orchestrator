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
    let profile, authority, endpoint, closed = 0, unregistered = 0
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
