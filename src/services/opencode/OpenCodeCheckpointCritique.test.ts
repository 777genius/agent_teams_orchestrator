import { expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as atomic from '../../utils/atomicWrite.js'
const realWrite = atomic.writeJsonFileAtomic
let failurePath: string | undefined
let afterWrite: ((file: string) => Promise<void>) | undefined
let beforeWrite: ((file: string) => Promise<void>) | undefined
mock.module('../../utils/atomicWrite.js', () => ({ ...atomic,
  writeJsonFileAtomic: async (file: string, value: unknown, options: Parameters<typeof realWrite>[2]) => {
    if (file === failurePath) throw new Error('TEST publication failure')
    await beforeWrite?.(file)
    await realWrite(file, value, options)
    await afterWrite?.(file)
  },
}))
const { OpenCodeProfileManager, resolveOpenCodeProfileScope } = await import('./OpenCodeProfileManager.js')
const { readOpenCodeAuthCredential, openCodeOAuthSuccessorPath, upsertOpenCodeAuthCredential } = await import('./OpenCodeAuthStore.js')
const c0 = { type: 'oauth', access: 'TEST-C0', refresh: 'TEST-R0', expires: 1000, accountId: 'TEST-A' }
const c1 = { ...c0, access: 'TEST-C1', refresh: 'TEST-R1', expires: 500 }
const c2 = { ...c0, access: 'TEST-C2', refresh: 'TEST-R2', expires: 400 }
const replacement = { ...c0, access: 'TEST-B', refresh: 'TEST-RB', accountId: 'TEST-B' }
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ariel-oauth-owned-source-TEST-')))
  const project = path.join(root, 'project'), other = path.join(root, 'other')
  await mkdir(project); await mkdir(other)
  const env = { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
  const global = path.join(root, 'app-data', 'opencode', 'auth.json')
  const receipt = `${global}.agent-teams-xai-oauth-save.json`
  await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
  const manager = new OpenCodeProfileManager()
  const resolve = (projectPath = project, sourceEnv = env) => resolveOpenCodeProfileScope({ projectPath,
    selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env: sourceEnv })
  const profile = await manager.prepareProfile(project, { profileScope: await resolve() })
  const rotate = () => manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
    operation: () => writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 })) })
  const pending = async () => { failurePath = openCodeOAuthSuccessorPath(global); await expect(rotate()).rejects.toThrow('TEST publication failure'); failurePath = undefined }
  const read = () => manager.readSavedOAuthCredential(profile)
  return { root, project, other, env, global, receipt, manager, profile, resolve, rotate, pending, read }
}
async function clean(f: Awaited<ReturnType<typeof fixture>>) {
  failurePath = undefined; beforeWrite = undefined; afterWrite = undefined; await rm(f.root, { recursive: true, force: true })
}
test('originating project config change retires terminal receipt without blocking unrelated project', async () => {
  const f = await fixture()
  try {
    await f.pending()
    const receipt = await readFile(f.receipt, 'utf8')
    await writeFile(path.join(f.project, 'opencode.json'), JSON.stringify({ provider: { xai: { options: { baseURL: 'http://test.invalid/changed' } } } }))
    for (let i = 0; i < 2; i++) await f.resolve(f.other)
    expect(await Bun.file(f.receipt).exists()).toBe(false)
    expect(await f.read()).toEqual(c0)
  } finally { await clean(f) }
})
test('changed source paths retire obsolete receipt and allow explicit replacement credentials', async () => {
  const f = await fixture()
  try {
    await f.pending()
    await upsertOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai', credential: replacement })
    const env = { ...f.env, XDG_DATA_HOME: path.join(f.root, 'new-data') }
    for (let i = 0; i < 2; i++) await f.resolve(f.other, env)
    expect(await Bun.file(f.receipt).exists()).toBe(false)
    expect(await f.read()).toEqual(replacement)
  } finally { await clean(f) }
})
for (const recovery of [false, true]) for (const boundary of ['before', 'after'])
for (const mutation of ['account', 'logout', 'C2', 'unrelated'])
test(`independent native ${mutation} survives ${boundary} app successor rename (recovery=${recovery})`, async () => {
  const f = await fixture()
  try {
    const local = path.join(f.env.XDG_DATA_HOME, 'opencode', 'auth.json')
    await upsertOpenCodeAuthCredential({ authPath: local, providerId: 'xai', credential: c0 })
    if (recovery) await f.pending()
    let replaced = false
    const replacementStore = { ...(mutation === 'logout' ? {} : {
      xai: mutation === 'account' ? replacement : mutation === 'C2' ? c2 : c0,
    }), unrelated: { type: 'api', key: 'TEST-NEW' } }
    const hook = async (file: string) => {
      // Native sources no longer have an app compare-to-rename boundary.
      // Inject at the app's only publication destination instead.
      if (file !== openCodeOAuthSuccessorPath(f.global) || replaced) return
      replaced = true
      await writeFile(local, JSON.stringify(replacementStore))
    }
    if (boundary === 'before') beforeWrite = hook; else afterWrite = hook
    const result = await (recovery ? f.resolve() : f.rotate()).then(() => null, error => error)
    expect(replaced).toBe(true)
    expect(JSON.parse(await readFile(local, 'utf8'))).toEqual(replacementStore)
    expect(await readOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai' })).toEqual(c0)
    if (mutation === 'unrelated') {
      expect(result).toBeNull()
      const fresh = await f.manager.prepareProfile(f.project, { profileScope: await f.resolve() })
      expect(await readOpenCodeAuthCredential({ authPath: fresh.managedAuthPath, providerId: 'xai' })).toEqual(c1)
    } else {
      expect(result).toBeInstanceOf(Error)
      // A fresh resolver may accept an explicit replacement, or reject the
      // conflicting consumed-C0 merge. It must never materialize stale C1.
      if (mutation === 'account') {
        const fresh = await f.manager.prepareProfile(f.project, { profileScope: await f.resolve() })
        expect(await readOpenCodeAuthCredential({ authPath: fresh.managedAuthPath, providerId: 'xai' })).toEqual(replacement)
      } else {
        await expect(f.resolve()).rejects.toThrow()
      }
      expect(JSON.parse(await readFile(local, 'utf8'))).toEqual(replacementStore)
    }
    expect(await Bun.file(f.receipt).exists()).toBe(false)
  } finally { await clean(f) }
})
test('CONTROL: completed stale C1 receipt cannot roll back saved C2 with unchanged source list', async () => {
  const f = await fixture()
  try {
    await f.pending(); const old = await readFile(f.receipt, 'utf8')
    await f.resolve()
    const fresh = await f.manager.prepareProfile(f.project, { profileScope: await f.resolve() })
    await f.manager.withOwnedOAuthRefresh({ profile: fresh, assertHostOwnership: async () => {},
      operation: () => writeFile(fresh.managedAuthPath, JSON.stringify({ xai: c2 })) })
    await writeFile(f.receipt, old)
    await f.resolve()
    expect(await f.read()).toEqual(c2)
    expect(await Bun.file(f.receipt).exists()).toBe(false)
  } finally { await clean(f) }
})

for (const boundary of ['before', 'after'])
test(`second generation publication failure ${boundary} rename recovers exact C1-to-C2 lineage`, async () => {
  const f = await fixture()
  try {
    await f.rotate()
    const fresh = await f.manager.prepareProfile(f.project, { profileScope: await f.resolve() })
    const fail = async (file: string) => {
      if (file === openCodeOAuthSuccessorPath(f.global)) throw new Error('TEST second generation write failure')
    }
    if (boundary === 'before') beforeWrite = fail; else afterWrite = fail
    await expect(f.manager.withOwnedOAuthRefresh({ profile: fresh, assertHostOwnership: async () => {},
      operation: () => writeFile(fresh.managedAuthPath, JSON.stringify({ xai: c2 })) }))
      .rejects.toThrow('TEST second generation write failure')
    beforeWrite = undefined; afterWrite = undefined
    expect(await Bun.file(f.receipt).exists()).toBe(true)
    const reopened = new OpenCodeProfileManager()
    const next = await reopened.prepareProfile(f.project, { profileScope: await f.resolve() })
    expect(await readOpenCodeAuthCredential({ authPath: next.managedAuthPath, providerId: 'xai' })).toEqual(c2)
    expect(await readOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai' })).toEqual(c0)
    expect(await Bun.file(f.receipt).exists()).toBe(false)
  } finally { await clean(f) }
})

for (const destination of ['receipt', 'successor'])
for (const corrupt of ['null', '[]', '{}', '{', '{"version":2}'])
test(`corrupt ${destination} cannot disappear into missing authority: ${corrupt}`, async () => {
  const f = await fixture()
  try {
    if (destination === 'receipt') await f.pending()
    else await f.rotate()
    const file = destination === 'receipt' ? f.receipt : openCodeOAuthSuccessorPath(f.global)
    await writeFile(file, corrupt)
    for (let i = 0; i < 2; i++) await expect(f.resolve()).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(corrupt)
    expect(await readOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai' })).toEqual(c0)
  } finally { await clean(f) }
})

test('corrupt xAI successor does not change an unrelated provider selection', async () => {
  const f = await fixture()
  try {
    await f.rotate()
    await writeFile(openCodeOAuthSuccessorPath(f.global), 'null')
    const api = { type: 'api', key: 'TEST-unrelated-provider' }
    await upsertOpenCodeAuthCredential({ authPath: f.global, providerId: 'deepinfra', credential: api })
    const scope = await resolveOpenCodeProfileScope({ projectPath: f.project,
      selectedModel: 'deepinfra/test', purpose: 'launch_runtime', env: f.env })
    const profile = await f.manager.prepareProfile(f.project, { profileScope: scope })
    expect(await readOpenCodeAuthCredential({ authPath: profile.managedAuthPath, providerId: 'deepinfra' })).toEqual(api)
    await expect(f.resolve()).rejects.toThrow()
  } finally { await clean(f) }
})

for (const recovery of [false, true]) for (const crashAfterRename of [false, true])
test(`configuration revoked at successor rename is never fresh authority (recovery=${recovery}, crash=${crashAfterRename})`, async () => {
  const f = await fixture()
  try {
    if (recovery) await f.pending()
    let changed = false
    beforeWrite = async file => {
      if (file !== openCodeOAuthSuccessorPath(f.global) || changed) return
      changed = true
      await writeFile(path.join(f.project, 'opencode.json'), JSON.stringify({ provider: { xai: {
        options: { baseURL: 'http://test.invalid/revoked-at-rename' },
      } } }))
    }
    afterWrite = async file => {
      if (file === openCodeOAuthSuccessorPath(f.global) && crashAfterRename) throw new Error('TEST crash after rename')
    }
    await expect(recovery ? f.resolve() : f.rotate()).rejects.toThrow()
    expect(changed).toBe(true)
    expect(await Bun.file(openCodeOAuthSuccessorPath(f.global)).exists()).toBe(true)
    beforeWrite = undefined; afterWrite = undefined
    // Read-only authority comparison must reject even before receipt recovery.
    await expect(resolveOpenCodeProfileScope({ projectPath: f.other, selectedModel: 'xai/grok-4.3',
      purpose: 'launch_runtime', env: f.env, cacheSnapshot: false })).rejects.toThrow()
    await expect(f.resolve(f.other)).rejects.toThrow()
    expect(await Bun.file(f.receipt).exists()).toBe(false)
    // Removal of the active receipt cannot make revoked C1 selectable in a new coordinator.
    const script = `import { resolveOpenCodeProfileScope } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeProfileManager.ts'))};
      let rejected = false;
      try { await resolveOpenCodeProfileScope({ projectPath: process.argv[1], selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime' }); }
      catch { rejected = true; }
      if (!rejected) throw new Error('TEST revoked successor was selected in fresh child');`
    const child = Bun.spawn([process.execPath, '-e', script, f.other], { env: { ...process.env, ...f.env }, stdout: 'pipe', stderr: 'pipe' })
    expect(await new Response(child.stderr).text()).toBe('')
    expect(await child.exited).toBe(0)
    // Once explicitly retired, restoring old configuration cannot resurrect C1.
    await rm(path.join(f.project, 'opencode.json'))
    await expect(f.resolve(f.other)).rejects.toThrow()
    await upsertOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai', credential: replacement })
    const fresh = await f.manager.prepareProfile(f.other, { profileScope: await f.resolve(f.other) })
    expect(await readOpenCodeAuthCredential({ authPath: fresh.managedAuthPath, providerId: 'xai' })).toEqual(replacement)
    const next = { ...replacement, access: 'TEST-B-next', refresh: 'TEST-B-next-refresh' }
    await f.manager.withOwnedOAuthRefresh({ profile: fresh, assertHostOwnership: async () => {},
      operation: () => writeFile(fresh.managedAuthPath, JSON.stringify({ xai: next })) })
    expect(await f.manager.readSavedOAuthCredential(fresh)).toEqual(next)
    expect(await readOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai' })).toEqual(replacement)
  } finally { await clean(f) }
})

for (const pending of [false, true])
test(`pre-scope successor requires fresh credentials without stranding new login (pending=${pending})`, async () => {
  const f = await fixture()
  try {
    if (pending) {
      afterWrite = async file => { if (file === openCodeOAuthSuccessorPath(f.global)) throw new Error('TEST crash after rename') }
      await expect(f.rotate()).rejects.toThrow()
      afterWrite = undefined
    } else await f.rotate()
    const file = openCodeOAuthSuccessorPath(f.global)
    const legacy = JSON.parse(await readFile(file, 'utf8'))
    delete legacy.owner // Exact a043 sidecar format has no durable publication scope.
    await writeFile(file, JSON.stringify(legacy))
    await expect(f.resolve()).rejects.toThrow()
    await upsertOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai', credential: { ...c0, access: 'TEST-altered-before-replacement' } })
    const reused = await f.manager.prepareProfile(f.other, { profileScope: await f.resolve(f.other) })
    let reusedCalls = 0
    await expect(f.manager.withOwnedOAuthRefresh({ profile: reused, assertHostOwnership: async () => {},
      operation: async () => { reusedCalls += 1 } })).rejects.toThrow('pending')
    expect(reusedCalls).toBe(0)
    await upsertOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai', credential: replacement })
    const fresh = await f.manager.prepareProfile(f.other, { profileScope: await f.resolve(f.other) })
    expect(await readOpenCodeAuthCredential({ authPath: fresh.managedAuthPath, providerId: 'xai' })).toEqual(replacement)
    const next = { ...replacement, access: 'TEST-B-next', refresh: 'TEST-B-next-refresh' }
    await f.manager.withOwnedOAuthRefresh({ profile: fresh, assertHostOwnership: async () => {},
      operation: () => writeFile(fresh.managedAuthPath, JSON.stringify({ xai: next })) })
    expect(await f.manager.readSavedOAuthCredential(fresh)).toEqual(next)
    await upsertOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai', credential: { ...c0, access: 'TEST-altered-access' } })
    const spent = await f.manager.prepareProfile(f.other, { profileScope: await f.resolve(f.other) })
    let calls = 0
    await expect(f.manager.withOwnedOAuthRefresh({ profile: spent, assertHostOwnership: async () => {},
      operation: async () => { calls += 1 } })).rejects.toThrow('pending')
    expect(calls).toBe(0)
  } finally { await clean(f) }
})
