import { expect, test } from 'bun:test'

test('native key setup scopes the catalog before real SDK reads without key or model effects', async () => {
  // Isolate boundary spies; the loader, provider wire and installed 2.1.4 SDK
  // remain real. Native activation itself is covered by the separate live smoke.
  const script = `
    import { spyOn } from 'bun:test'
    import assert from 'node:assert/strict'
    import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
    import path from 'node:path'
    import { tmpdir } from 'node:os'
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-setup-form-')))
    await mkdir(path.join(root, 'project'))
    const project = await realpath(path.join(root, 'project'))
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    const profileModule = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))})
    const receiptModule = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.ts'))})
    const host = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/host/OpenCodeV2ExecutionHost.ts'))})
    const pin = '2.1.4', providerId = 'deepseek'
    const native = { generation: 'v2', version: pin, engineVersion: pin, dialect: 'v2-2.1.4',
      executablePath: path.join(root, 'TEST-opencode'), executableSha256: 'a'.repeat(64), packageName: null }
    const selectedRead = { path: native.executablePath, native, policy: { generation: 'v2', version: pin }, fingerprint: null }
    const scope = { scopeToken: 'TEST-catalog-scope' }, requests = [], lifetime = new AbortController()
    let profile, authPath, authority, registered = 0, unregistered = 0, closed = 0
    const endpoint = { baseUrl: 'http://127.0.0.1:1', password: 'TEST-private-transport', signal: lifetime.signal,
      async fetch(input, init) {
        const request = new Request(input, init), url = new URL(request.url)
        requests.push([request.method, url.pathname])
        assert.equal(request.method, 'GET')
        assert.equal(request.body, null)
        assert.equal(url.searchParams.get('location[directory]'), project)
        assert.deepEqual(JSON.parse(profile.config.content).providers, { deepseek: {} })
        const data = url.pathname === '/api/provider'
          ? [{ id: providerId, integrationID: providerId, name: 'DeepSeek', activation: 'enabled', package: '' }]
          : url.pathname === '/api/integration/deepseek'
            ? { id: providerId, name: 'DeepSeek native catalog', methods: [{ type: 'key' }], connections: [] }
            : assert.fail('Unexpected setup request: ' + url.pathname)
        return Response.json({ location: { directory: project }, data })
      } }
    const spies = [
      spyOn(profileModule, 'resolveOpenCodeV2CatalogProfileScope').mockImplementation(async input => {
        assert.deepEqual(input, { projectPath: project, providerId }); return scope
      }),
      spyOn(profileModule, 'materializeOpenCodeV2CatalogScope').mockImplementation(async (actualScope, directory, target) => {
        assert.equal(actualScope, scope); assert.equal(directory, project); authPath = target
        return { provider: {}, preferredModel: null, authPath: target }
      }),
      spyOn(receiptModule, 'createOpenCodeV2ExecutionReceipt').mockImplementation(async (_sourceRoot, selected) => {
        assert.equal(selected, native); return { graph: {} }
      }),
      spyOn(host, 'acquireOpenCodeV2CatalogLease').mockImplementation(async (_native, selectedProfile) => {
        profile = selectedProfile
        assert.equal(profile.directory, project)
        assert.equal(profile.selection.purpose, 'catalog')
        assert.equal(await readFile(path.join(profile.config.directory, 'opencode.json'), 'utf8'), profile.config.content)
        assert.deepEqual(JSON.parse(profile.config.content).providers, { deepseek: {} })
        authority = { pin, directory: project }
        return { authority, signal: lifetime.signal, close: async () => { closed++; lifetime.abort() } }
      }),
      spyOn(host, 'requireExecutionEndpoint').mockImplementation(value => { assert.equal(value, authority); return endpoint }),
      spyOn(host, 'registerExecutionDisposer').mockImplementation((value, dispose) => {
        assert.equal(value, authority); assert.equal(typeof dispose, 'function'); registered++
        return () => { unregistered++ }
      }),
    ]
    try {
      const { loadOpenCodeV2ProviderSetupForm } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProviderManagement.ts'))})
      const result = await loadOpenCodeV2ProviderSetupForm({ runtimeId: 'opencode', providerId, projectPath: project }, selectedRead)
      assert.equal(result.ok, true, JSON.stringify(result))
      const form = result.value
      assert.equal(form.providerId, providerId)
      assert.equal(form.displayName, 'DeepSeek native catalog')
      assert.equal(form.supported, true)
      assert.equal(form.method, 'api')
      assert.equal(form.defaultAuthOptionId, 'api:native')
      assert.equal(form.secret.required, true)
      assert.deepEqual(form.prompts, [])
      assert.equal(form.authOptions.length, 1)
      assert.equal(form.authOptions[0].id, 'api:native')
      assert.equal(form.authOptions[0].secret.required, true)
      assert.deepEqual(form.verification, { kind: 'model-request', freeModelPreferred: false, mayUseQuotaOrBalance: true })
      assert.deepEqual(requests, [['GET', '/api/provider'], ['GET', '/api/integration/deepseek']])
      assert.deepEqual([registered, unregistered, closed], [1, 1, 1])
      await assert.rejects(access(authPath), { code: 'ENOENT' })
    } finally {
      for (const spy of spies) spy.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  `
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', NODE_ENV: 'test',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }
  for (const name of ['TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, env, stdout: 'pipe', stderr: 'pipe' })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ exit, output: stdout + stderr }).toEqual({ exit: 0, output: '' })
}, 15_000)
