import { expect, test } from 'bun:test'
import { openCodeV2InventorySnapshot } from './OpenCodeV2InventoryService.js'
import { emptyOpenCodeV2ReadStatus, readModel, readProvider } from './OpenCodeV2ReadStatus.js'
import { buildOpenCodeV2RuntimeStatus } from './OpenCodeV2RuntimeStatus.js'
import type { OpenCodeV2NativeIdentity } from '../compatibility/OpenCodeNativeIdentity.js'

const native: OpenCodeV2NativeIdentity = {
  generation: 'v2', version: '2.1.4', engineVersion: '2.1.4', dialect: 'v2-2.1.4',
  executablePath: '/TEST/opencode', executableSha256: 'a'.repeat(64), packageName: null,
}

test.each([
  ['provider/removed', 'native', 'provider/native'],
  ['provider/disabled', 'native', 'provider/disabled'],
  ['provider/removed', null, null],
] as const)('V2 status resolves managed default %s with native default %s to %s', (managed, nativeDefault, expected) => {
  const project = '/TEST/default-models'
  const snapshot = openCodeV2InventorySnapshot(native, project, {
    ...emptyOpenCodeV2ReadStatus(native, project), catalog: 'ready',
    providers: [readProvider({ id: 'provider', activation: 'enabled' })],
    models: ['native', 'disabled'].map(id => readModel({ id, modelID: id, providerID: 'provider',
      enabled: id !== 'disabled', status: 'active', variants: [], capabilities: { tools: true, input: ['text'], output: ['text'] },
      limit: { context: 8192, output: 512 } })),
    defaultModel: nativeDefault ? { providerId: 'provider', catalogId: nativeDefault } : null,
  })
  const status = buildOpenCodeV2RuntimeStatus(snapshot, managed)
  expect(status.modelCatalog?.defaultModelId).toBe(expected)
  expect(status.modelCatalog?.models.filter(model => model.isDefault).map(model => model.id)).toEqual(expected ? [expected] : [])
  expect(status.modelCatalog?.models.find(model => model.id === 'provider/disabled')?.hidden).toBe(true)
  expect(status.modelCatalog?.defaultLaunchModel).toBeNull()
  expect(status.authenticated).toBe(false)
  expect(status.capabilities.teamLaunch).toBe(false)
})

test.each(['command-wait', 'target-wait', 'command-exhausted', 'target-exhausted', 'timely'] as const)(
  'full V2 status bounds optional managed preference reads: %s', async mode => {
    const script = `
      import assert from 'node:assert/strict'
      import { spyOn } from 'bun:test'
      import * as filesystem from 'node:fs/promises'
      import path from 'node:path'
      import { tmpdir } from 'node:os'
      const mode = ${JSON.stringify(mode)}
      const root = await filesystem.realpath(await filesystem.mkdtemp(path.join(tmpdir(), 'TEST-v2-status-default-budget-')))
      process.env.HOME = root; process.env.USERPROFILE = root
      process.env.XDG_CONFIG_HOME = path.join(root, 'config'); process.env.XDG_DATA_HOME = path.join(root, 'xdg-data')
      process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(root, 'data')
      globalThis.fetch = async () => { throw new Error('TEST-no-network') }
      const project = path.join(root, 'project'); await filesystem.mkdir(project)
      const preferences = await import(${JSON.stringify(import.meta.resolve('../OpenCodeManagedDefaultSelection.ts'))})
      const paths = await import(${JSON.stringify(import.meta.resolve('../OpenCodeManagedPreferences.ts'))})
      const proof = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2StatusProof.ts'))})
      const { openCodeV2InventorySnapshot } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2InventoryService.ts'))})
      const { emptyOpenCodeV2ReadStatus, readModel, readProvider } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ReadStatus.ts'))})
      const { getUnifiedRuntimeStatusPayload } = await import(${JSON.stringify(import.meta.resolve('../../runtimeBackends/registry.ts'))})
      const preferencePath = paths.getOpenCodeManagedPreferencesPath(preferences.openCodeProjectPreferencesRoot(project))
      await filesystem.mkdir(path.dirname(preferencePath), { recursive: true })
      await filesystem.writeFile(preferencePath, JSON.stringify({ schemaVersion: 2, defaultModelId: 'provider/managed',
        modelLimitOverrides: {}, updatedAt: null }))
      const native = { generation: 'v2', version: '2.1.4', engineVersion: '2.1.4', dialect: 'v2-2.1.4',
        executablePath: path.join(root, 'TEST-not-executed'), executableSha256: 'a'.repeat(64), packageName: null }
      const inventory = openCodeV2InventorySnapshot(native, project, { ...emptyOpenCodeV2ReadStatus(native, project), catalog: 'ready',
        providers: [readProvider({ id: 'provider', activation: 'enabled' })],
        models: ['native', 'managed'].map(id => readModel({ id, modelID: id, providerID: 'provider', enabled: true, status: 'active',
          variants: [], capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 } })),
        defaultModel: { providerId: 'provider', catalogId: 'native' } })
      const originalRead = filesystem.readFile, originalSelection = preferences.readOpenCodeManagedDefaultSelection
      const originalNow = Date.now
      let offset = 0, reads = 0, releaseRead, markRead, selectionRead, timer
      const held = new Promise(resolve => { releaseRead = resolve })
      const entered = new Promise(resolve => { markRead = resolve })
      const budgets = [], waiting = mode.endsWith('-wait'), exhausted = mode.endsWith('-exhausted')
      const timeoutMs = mode.startsWith('target-') ? 180000 : mode === 'timely' ? 10000 : 300
      const restores = [
        spyOn(Date, 'now').mockImplementation(() => originalNow() + offset),
        spyOn(filesystem, 'readFile').mockImplementation(async (...args) => {
          if (String(args[0]) !== preferencePath) return originalRead(...args)
          reads++; markRead()
          if (waiting) await held
          if (mode === 'timely') offset += 3000
          return originalRead(...args)
        }),
        spyOn(preferences, 'readOpenCodeManagedDefaultSelection').mockImplementation(directory => {
          selectionRead = originalSelection(directory); return selectionRead
        }),
        spyOn(proof, 'readOpenCodeV2StatusProof').mockImplementation(async (_snapshot, timeout) => {
          budgets.push(timeout); return null
        }),
      ]
      const operation = getUnifiedRuntimeStatusPayload('opencode', { openCodeInventoryTimeoutMs: timeoutMs,
        getOpenCodeInventorySnapshot: async () => {
          if (mode === 'target-wait') offset = 74700
          if (mode === 'target-exhausted') offset = 75001
          if (mode === 'command-exhausted') offset = timeoutMs + 1
          return inventory
        } }, { detailLevel: 'full' })
      let payload
      try {
        if (waiting) assert.equal(await Promise.race([entered.then(() => true), operation.then(() => false)]), true)
        payload = await Promise.race([operation, new Promise(resolve => {
          timer = setTimeout(() => resolve('TEST-managed-preference-still-pending'), 1200)
        })])
        assert.notEqual(payload, 'TEST-managed-preference-still-pending')
        const status = payload.providers.opencode
        assert.equal(status.modelCatalog.status, 'ready'); assert.equal(status.authenticated, false)
        assert.equal(status.capabilities.teamLaunch, false); assert.equal(status.modelCatalog.defaultLaunchModel, null)
        assert.equal(status.modelCatalog.defaultModelId, mode === 'timely' ? 'provider/managed' : 'provider/native')
        assert.equal(reads, exhausted ? 0 : 1, 'Exhausted status skips preference IO entirely')
        assert.equal(budgets.length, 1)
        if (mode === 'timely') assert(budgets[0] > 0 && budgets[0] <= 7000, 'Proof budget is recalculated after preference reading')
        else assert.equal(budgets[0], 0, 'The late proof overlay receives no renewed budget')
      } finally {
        clearTimeout(timer); releaseRead(); await operation
        if (selectionRead) await selectionRead
        for (const restore of restores) restore.mockRestore()
        await filesystem.rm(root, { recursive: true, force: true })
      }
      if (waiting) assert.equal(payload.providers.opencode.modelCatalog.defaultModelId, 'provider/native',
        'Late preference completion cannot mutate a returned status')
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
  }, 30_000,
)
