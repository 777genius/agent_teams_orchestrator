import { expect, test } from 'bun:test'

test('V2 defaults persist across provider catalogs and CLI reads, isolate projects, and clear back to inheritance', async () => {
  const script = `
    import assert from 'node:assert/strict'
    import { spyOn } from 'bun:test'
    import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
    import path from 'node:path'
    import { tmpdir } from 'node:os'
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-defaults-')))
    for (const name of ['home', 'data', 'cache', 'project-a', 'project-b']) await mkdir(path.join(root, name))
    process.env.HOME = path.join(root, 'home')
    process.env.USERPROFILE = process.env.HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(root, 'data')
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(root, 'cache')
    process.env.XDG_CONFIG_HOME = path.join(root, 'config')
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data')
    const project = await realpath(path.join(root, 'project-a'))
    const other = await realpath(path.join(root, 'project-b'))
    const identity = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/compatibility/OpenCodeNativeIdentity.ts'))})
    const management = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProviderManagement.ts'))})
    const profiles = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeProfileManager.ts'))})
    const preferences = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeManagedDefaultSelection.ts'))})
    const { OpenCodeProviderManagementAdapter } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeProviderManagementAdapter.ts'))})
    const { getProviderModels } = await import(${JSON.stringify(import.meta.resolve('../../../../cli/handlers/model.ts'))})
    const { getUnifiedRuntimeStatusPayload } = await import(${JSON.stringify(import.meta.resolve('../../../../services/runtimeBackends/registry.ts'))})
    const { emptyOpenCodeV2ReadStatus } = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/catalog/OpenCodeV2ReadStatus.ts'))})
    const { openCodeV2InventorySnapshot } = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/catalog/OpenCodeV2InventoryService.ts'))})
    const native = { generation: 'v2', version: '2.1.4', engineVersion: '2.1.4', dialect: 'v2-2.1.4',
      executablePath: path.join(root, 'TEST-opencode'), executableSha256: 'a'.repeat(64), packageName: null }
    const selected = { native, policy: { generation: 'v2', version: native.version }, fingerprint: null }
    let tests = 0, valid = true, proof = false, hasNativeDefault = true
    const model = { modelId: 'deepseek/chat', providerId: 'deepseek', displayName: 'Chat', sourceLabel: 'native',
      catalogStatus: 'active', availability: 'untested', free: false, default: false }
    const spies = [
      spyOn(identity, 'inspectOpenCodeReadSelection').mockResolvedValue(selected),
      spyOn(management, 'loadOpenCodeV2ProviderModels').mockImplementation(async input => {
        assert.equal(input.limit, null)
        return { ok: true, value: { models: valid ? [model] : [], providerId: input.providerId } }
      }),
      spyOn(management, 'testOpenCodeV2ProviderModel').mockImplementation(async () => {
        tests++; return { ok: true, value: { ok: proof, message: 'TEST probe failed' } }
      }),
    ]
    const snapshot = directory => {
      const value = openCodeV2InventorySnapshot(native, directory, {
        ...emptyOpenCodeV2ReadStatus(native, directory), catalog: 'ready',
        defaultModel: hasNativeDefault ? { providerId: 'opencode', catalogId: 'builtin-free' } : null,
      })
      if (!hasNativeDefault) value.models = ['opencode/fallback']
      return value
    }
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: { probe: async directory => snapshot(directory ?? project) },
      hostManager: { ensureHost: async () => assert.fail('V1 host must not run'), releaseHost: async () => {} },
    })
    const input = { runtimeId: 'opencode', providerId: 'deepseek', modelId: model.modelId, projectPath: project, probe: false }
    try {
      const global = await adapter.setDefaultModel({ ...input, scope: 'all_projects' })
      assert.equal(global.ok, true, JSON.stringify(global))
      assert.equal(global.value.allProjectsDefaultModel, model.modelId)
      assert.equal(global.value.defaultModelSource, 'all_projects')
      assert.equal(tests, 0, 'Saving the UI preference must not run a model when probe is false')
      assert.equal((await adapter.loadView({ runtimeId: 'opencode', projectPath: other })).value.defaultModel, model.modelId)
      const scoped = await profiles.resolveOpenCodeV2CatalogProfileScope({ providerId: 'deepseek', projectPath: project })
      const imported = await profiles.materializeOpenCodeV2CatalogScope(scoped, project, path.join(root, 'TEST-auth.json'))
      assert.equal(imported.preferredModel, model.modelId)
      const cli = await getProviderModels('opencode', { getOpenCodeInventorySnapshot: async () => snapshot(project) })
      assert.equal(cli.defaultModel, model.modelId)
      const status = (await getUnifiedRuntimeStatusPayload('opencode', { getOpenCodeInventorySnapshot: async () => snapshot(project) })).providers.opencode
      assert.equal(status.modelCatalog.defaultModelId, model.modelId)
      assert.equal(status.authenticated, false)
      assert.equal(status.capabilities.teamLaunch, false)
      assert.equal(status.modelCatalog.defaultLaunchModel, null)
      model.modelId = 'deepseek/reasoner'
      const local = await adapter.setDefaultModel({ ...input, modelId: model.modelId, scope: 'project' })
      assert.equal(local.ok, true, JSON.stringify(local))
      assert.equal(local.value.projectDefaultModel, model.modelId)
      assert.equal(local.value.defaultModelSource, 'project')
      assert.equal((await preferences.readOpenCodeManagedDefaultSelection(other)).defaultModel, 'deepseek/chat')
      assert.equal((await getProviderModels('opencode', { getOpenCodeInventorySnapshot: async () => snapshot(project) })).defaultModel, model.modelId)
      const cleared = await adapter.clearProjectDefaultModel({ runtimeId: 'opencode', projectPath: project })
      assert.equal(cleared.ok, true, JSON.stringify(cleared))
      assert.equal(cleared.value.projectDefaultModel, null)
      assert.equal(cleared.value.defaultModel, 'deepseek/chat')
      assert.equal(cleared.value.defaultModelSource, 'all_projects')
      const failedProbe = await adapter.setDefaultModel({ ...input, modelId: model.modelId, probe: true })
      assert.equal(failedProbe.ok, false)
      assert.equal(failedProbe.error.code, 'model-test-failed')
      assert.equal(tests, 1)
      assert.equal((await preferences.readOpenCodeManagedDefaultSelection(project)).projectDefaultModel, null)
      valid = false
      const missing = await adapter.setDefaultModel({ ...input, modelId: model.modelId })
      assert.equal(missing.ok, false)
      assert.equal(missing.error.code, 'model-missing')
      assert.equal(tests, 1)
      assert.equal((await preferences.readOpenCodeManagedDefaultSelection(project)).projectDefaultModel, null)
      valid = true; proof = true; hasNativeDefault = false
      await rm(path.join(root, 'data/opencode/global-runtime-preferences.json'))
      assert.equal((await adapter.setDefaultModel({ ...input, modelId: model.modelId, probe: true })).ok, true)
      assert.equal(tests, 2)
      const fallback = await adapter.clearProjectDefaultModel({ runtimeId: 'opencode', projectPath: project })
      const reloaded = await adapter.loadView({ runtimeId: 'opencode', projectPath: project })
      for (const value of [fallback, reloaded]) {
        assert.equal(value.ok, true, JSON.stringify(value))
        assert.equal(value.value.defaultModel, 'opencode/fallback')
        assert.equal(value.value.fallbackModel, 'opencode/fallback')
        assert.equal(value.value.defaultModelSource, 'fallback')
        assert.equal(value.value.projectDefaultModel, null)
        assert.equal(value.value.allProjectsDefaultModel, null)
      }
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
