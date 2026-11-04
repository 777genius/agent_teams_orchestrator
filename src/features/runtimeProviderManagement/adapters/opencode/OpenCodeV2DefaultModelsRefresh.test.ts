import { expect, test } from 'bun:test'

test.each(['project', 'all_projects', 'clear'] as const)('V2 %s default reports a committed write separately from refresh failure', async operation => {
  const script = `
    import assert from 'node:assert/strict'
    import { spyOn } from 'bun:test'
    import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
    import path from 'node:path'
    import { tmpdir } from 'node:os'
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-default-refresh-')))
    for (const name of ['home', 'data', 'project']) await mkdir(path.join(root, name))
    process.env.HOME = path.join(root, 'home')
    process.env.USERPROFILE = process.env.HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(root, 'data')
    process.env.XDG_CONFIG_HOME = path.join(root, 'config')
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data')
    const project = await realpath(path.join(root, 'project'))
    const preferences = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeManagedDefaultSelection.ts'))})
    const writes = await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/OpenCodeManagedPreferences.ts'))})
    const management = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProviderManagement.ts'))})
    const defaults = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2DefaultModels.ts'))})
    const operation = ${JSON.stringify(operation)}
    const selection = await preferences.readOpenCodeManagedDefaultSelection(project)
    await writes.setOpenCodeManagedGlobalDefaultModel(selection.dataRoot, 'provider/global-old')
    if (operation !== 'all_projects') await writes.setOpenCodeManagedDefaultModel(selection.profileRoot, 'provider/project-old')
    const originalRead = preferences.readOpenCodeManagedDefaultSelection
    const writeName = operation === 'clear' ? 'clearOpenCodeManagedDefaultModel'
      : operation === 'all_projects' ? 'setOpenCodeManagedGlobalDefaultModel' : 'setOpenCodeManagedDefaultModel'
    const originalWrite = writes[writeName]
    let committed = false
    const spies = [
      spyOn(management, 'loadOpenCodeV2ProviderModels').mockResolvedValue({ ok: true, value: {
        providerId: 'provider', models: [{ modelId: 'provider/new', catalogStatus: 'active', availability: 'untested' }],
      } }),
      spyOn(writes, writeName).mockImplementation(async (...args) => {
        const value = await originalWrite(...args)
        committed = true
        return value
      }),
      spyOn(preferences, 'readOpenCodeManagedDefaultSelection').mockImplementation(async directory => {
        if (committed) throw new Error('TEST post-commit refresh failed')
        return originalRead(directory)
      }),
    ]
    const readView = async () => ({ ok: true, value: { runtimeId: 'opencode', projectPath: project,
      configuredModels: [], defaultModel: 'provider/old-view', fallbackModel: 'provider/native',
      projectDefaultModel: operation === 'all_projects' ? null : 'provider/project-old', allProjectsDefaultModel: 'provider/global-old' } })
    const run = read => operation === 'clear'
      ? defaults.clearOpenCodeV2ProjectDefaultModel({ runtimeId: 'opencode', projectPath: project }, read)
      : defaults.setOpenCodeV2DefaultModel({ runtimeId: 'opencode', projectPath: project,
          providerId: 'provider', modelId: 'provider/new', scope: operation, probe: false }, read)
    try {
      const unavailableView = { ok: false, error: { code: 'runtime-unhealthy', message: 'TEST pre-write view unavailable', recoverable: true } }
      assert.deepEqual(await run(async () => unavailableView), unavailableView)
      assert.equal(committed, false, 'A failed pre-write view cannot mutate preferences')
      const unchanged = await originalRead(project)
      assert.equal(unchanged.allProjectsDefaultModel, 'provider/global-old')
      assert.equal(unchanged.projectDefaultModel, operation === 'all_projects' ? null : 'provider/project-old')
      const result = await run(readView)
      assert.equal(committed, true)
      const persisted = await originalRead(project)
      assert.equal(persisted.allProjectsDefaultModel, operation === 'all_projects' ? 'provider/new' : 'provider/global-old')
      assert.equal(persisted.projectDefaultModel, operation === 'project' ? 'provider/new' : null)
      assert.equal(result.ok, false, 'A stale captured view must not be returned as current')
      assert.equal(result.error.code, 'runtime-unhealthy')
      assert.equal(result.error.recoverable, true)
      assert.match(result.error.message, operation === 'clear' ? /was cleared/ : /was saved/)
      assert.match(result.error.message, /could not be refreshed/)
      assert.equal('value' in result, false)
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
