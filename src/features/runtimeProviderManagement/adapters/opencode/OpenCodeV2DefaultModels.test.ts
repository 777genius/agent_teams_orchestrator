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
    const { emptyOpenCodeV2ReadStatus, readModel, readProvider } = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/catalog/OpenCodeV2ReadStatus.ts'))})
    const { openCodeV2InventorySnapshot } = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/catalog/OpenCodeV2InventoryService.ts'))})
    const native = { generation: 'v2', version: '2.1.4', engineVersion: '2.1.4', dialect: 'v2-2.1.4',
      executablePath: path.join(root, 'TEST-opencode'), executableSha256: 'a'.repeat(64), packageName: null }
    const selected = { native, policy: { generation: 'v2', version: native.version }, fingerprint: null }
    let tests = 0, valid = true, proof = false, hasNativeDefault = true, anonymousInventoryOnly = false
    const model = { modelId: 'deepseek/chat', providerId: 'deepseek', displayName: 'Chat', sourceLabel: 'native',
      catalogStatus: 'active', availability: 'untested', free: false, default: false,
      declaredInputModalities: ['text'], accessKind: 'credentialed', routeKind: 'catalog_provider',
      proofState: 'needs_probe', requiresExecutionProof: true, accessReason: 'Selected-model execution proof is required.',
      catalogContextTokens: 8192, catalogOutputTokens: 512, managedContextTokens: null, managedOutputTokens: null, managedUpdatedAt: null }
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
        providers: ['opencode', 'deepseek'].map(id => readProvider({ id, activation: 'enabled' })),
        models: [['opencode', hasNativeDefault ? 'builtin-free' : 'fallback'], ['deepseek', 'chat'], ['deepseek', 'reasoner']].map(([providerID, id]) =>
          readModel({ id, modelID: id, providerID, enabled: true, status: 'active', variants: [],
            capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 } })),
      })
      if (anonymousInventoryOnly) {
        value.readStatus.models = value.readStatus.models.filter(row => row.providerId === 'opencode')
        value.readStatus.providers = value.readStatus.providers.filter(row => row.id === 'opencode')
        value.models = value.models.filter(id => id.startsWith('opencode/'))
        value.connectedProviders = [{ id: 'deepseek', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }]
      }
      if (!hasNativeDefault) value.models = ['opencode/fallback']
      return value
    }
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: { probe: async directory => snapshot(directory ?? project) },
      hostManager: { ensureHost: async () => assert.fail('V1 host must not run'), releaseHost: async () => {} },
    })
    const input = { runtimeId: 'opencode', providerId: 'deepseek', modelId: model.modelId, projectPath: project, probe: false }
    const directoryDefaults = async (directory, summary = false) => {
      const result = await adapter.loadDirectory({ runtimeId: 'opencode', projectPath: directory, summary, limit: null })
      assert.equal(result.ok, true, JSON.stringify(result))
      return Object.fromEntries(result.value.entries.map(entry => [entry.providerId, entry.defaultModelId]))
    }
    try {
      assert.equal((await directoryDefaults(project)).opencode, 'opencode/builtin-free')
      const before = await adapter.loadView({ runtimeId: 'opencode', projectPath: project })
      assert.equal(before.ok, true, JSON.stringify(before))
      assert.equal(before.value.configuredModels.some(row => row.modelId === model.modelId), false,
        'A paid catalog model is not already a configured model before saving it')
      const global = await adapter.setDefaultModel({ ...input, scope: 'all_projects' })
      assert.equal(global.ok, true, JSON.stringify(global))
      assert.equal(global.value.allProjectsDefaultModel, model.modelId)
      assert.equal(global.value.defaultModelSource, 'all_projects')
      assert.deepEqual(global.value.configuredModels.find(row => row.modelId === model.modelId),
        { ...model, default: true }, 'The successful save must include its validated selected model row')
      assert.deepEqual(global.value.configuredModels.filter(row => row.default).map(row => row.modelId), [model.modelId])
      for (const previous of before.value.configuredModels) {
        assert.deepEqual(global.value.configuredModels.find(row => row.modelId === previous.modelId),
          { ...previous, default: false }, 'Preserve existing model metadata while replacing the default flag')
      }
      for (const summary of [false, true]) {
        const defaults = await directoryDefaults(project, summary)
        assert.equal(defaults.deepseek, 'deepseek/chat')
        assert.equal((await directoryDefaults(other, summary)).deepseek, 'deepseek/chat')
        assert.equal(defaults.opencode, null, 'Managed selection replaces the native default in other provider rows')
      }
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
      // The real passive host has no saved credential. Its anonymous rows are
      // not evidence that a validated selected-account preference was retired.
      anonymousInventoryOnly = true
      const storedBeforeRead = await preferences.readOpenCodeManagedDefaultSelection(project)
      const partialView = await adapter.loadView({ runtimeId: 'opencode', projectPath: project })
      assert.equal(partialView.ok, true, JSON.stringify(partialView))
      assert.equal(partialView.value.defaultModel, 'deepseek/chat')
      assert.equal(partialView.value.defaultModelSource, 'all_projects')
      for (const summary of [false, true]) {
        const partialDirectory = await adapter.loadDirectory({ runtimeId: 'opencode', projectPath: project, summary, limit: null })
        assert.equal(partialDirectory.ok, true, JSON.stringify(partialDirectory))
        const account = partialDirectory.value.entries.find(row => row.providerId === 'deepseek')
        assert.equal(account.defaultModelId, 'deepseek/chat')
        assert.equal(account.modelCount, null, 'The account catalog is unknown, not empty')
      }
      const partialCli = await getProviderModels('opencode', { getOpenCodeInventorySnapshot: async () => snapshot(project) })
      assert.equal(partialCli.defaultModel, 'deepseek/chat')
      assert.equal(partialCli.models.some(row => row.id === 'deepseek/chat'), false)
      const partialStatus = (await getUnifiedRuntimeStatusPayload('opencode', {
        getOpenCodeInventorySnapshot: async () => snapshot(project),
      })).providers.opencode
      assert.equal(partialStatus.modelCatalog.defaultModelId, 'opencode/builtin-free', 'Only a listed row is marked in the passive catalog')
      assert.equal(partialStatus.modelCatalog.defaultLaunchModel, null, 'The display fallback is never launch authority')
      assert.equal(partialStatus.authenticated, false)
      assert.equal(partialStatus.capabilities.teamLaunch, false)
      assert.deepEqual(await preferences.readOpenCodeManagedDefaultSelection(project), storedBeforeRead)
      assert.equal(tests, 0, 'Passive reads cannot probe, substitute or rewrite the saved selection')
      anonymousInventoryOnly = false
      model.modelId = 'deepseek/reasoner'
      const local = await adapter.setDefaultModel({ ...input, modelId: model.modelId, scope: 'project' })
      assert.equal(local.ok, true, JSON.stringify(local))
      assert.equal(local.value.projectDefaultModel, model.modelId)
      assert.equal(local.value.defaultModelSource, 'project')
      assert.deepEqual(local.value.configuredModels.find(row => row.modelId === model.modelId),
        { ...model, default: true })
      for (const summary of [false, true]) {
        assert.equal((await directoryDefaults(project, summary)).deepseek, 'deepseek/reasoner')
        assert.equal((await directoryDefaults(other, summary)).deepseek, 'deepseek/chat')
      }
      assert.equal((await preferences.readOpenCodeManagedDefaultSelection(other)).defaultModel, 'deepseek/chat')
      assert.equal((await getProviderModels('opencode', { getOpenCodeInventorySnapshot: async () => snapshot(project) })).defaultModel, model.modelId)
      const cleared = await adapter.clearProjectDefaultModel({ runtimeId: 'opencode', projectPath: project })
      assert.equal(cleared.ok, true, JSON.stringify(cleared))
      assert.equal(cleared.value.projectDefaultModel, null)
      assert.equal(cleared.value.defaultModel, 'deepseek/chat')
      assert.equal(cleared.value.defaultModelSource, 'all_projects')
      for (const summary of [false, true]) {
        assert.equal((await directoryDefaults(project, summary)).deepseek, 'deepseek/chat')
      }
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
      for (const summary of [false, true]) {
        const fallbackDirectory = await directoryDefaults(project, summary)
        assert.equal(fallbackDirectory.deepseek, null)
        assert.equal(fallbackDirectory.opencode, null, 'No native or managed directory default is invented')
      }
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
