import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  readOpenCodeAuthCredential, upsertOpenCodeAuthCredential,
  withOpenCodeOwnedOAuthRefresh,
} from './OpenCodeAuthStore.js'

const c0 = { type: 'oauth', access: 'synthetic-access-0', refresh: 'single-use-0', expires: 1000, accountId: 'test-account' }
const c1 = { ...c0, access: 'synthetic-access-1', refresh: 'single-use-1', expires: 500 }
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe('owned OAuth saved authority', () => {
  let root: string
  let global: string
  let local: string
  let managed: string
  let foreign: string
  const read = (authPath: string) => readOpenCodeAuthCredential({ authPath, providerId: 'xai' })
  const write = (authPath: string, credential: Record<string, unknown>) =>
    upsertOpenCodeAuthCredential({ authPath, providerId: 'xai', credential })
  const native = (credential: unknown, authPath = managed) =>
    writeFile(authPath, JSON.stringify({ xai: credential }))
  const owned = (operation: () => Promise<unknown>, extra = {}) => withOpenCodeOwnedOAuthRefresh({
    managedAuthPath: managed, globalAuthPath: global, sourceAuthPaths: [global, local],
    providerId: 'xai', predecessor: c0, assertOwnership: async () => {}, operation, ...extra,
  })
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'opencode-owned-oauth-TEST-'))
    global = path.join(root, 'app', 'opencode', 'auth.json')
    local = path.join(root, 'local', 'auth.json')
    managed = path.join(root, 'app', 'opencode', 'profiles', 'scope-owned', 'data', 'opencode', 'auth.json')
    foreign = path.join(root, 'app', 'opencode', 'profiles', 'scope-foreign', 'data', 'opencode', 'auth.json')
    await write(global, c0)
    await write(managed, c0)
    await write(foreign, { ...c1, refresh: 'foreign-refresh', expires: 999999 })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('publishes lower-expiry successor into exact saved copies and preserves unrelated providers and foreign scopes', async () => {
    await write(local, c0)
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'other', credential: { type: 'api', key: 'test-only' } })
    const foreignBefore = await readFile(foreign, 'utf8')
    await owned(async () => { await native(c1); return 'settled' })
    expect(await read(global)).toEqual(c1)
    expect(await read(local)).toEqual(c1)
    expect(await readFile(foreign, 'utf8')).toBe(foreignBefore)
    expect(JSON.parse(await readFile(global, 'utf8')).other).toEqual({ type: 'api', key: 'test-only' })
  })

  test('fresh child selects saved C1 and a second single-use expiry cycle saves C2', async () => {
    const consumed = new Set<string>()
    const rotate = async (previous: typeof c0, next: typeof c0) => {
      expect(consumed.has(previous.refresh)).toBe(false)
      consumed.add(previous.refresh)
      await native(next)
    }
    await owned(() => rotate(c0, c1))
    const script = `import { readOpenCodeAuthStore, mergeOpenCodeManagedAuthSources } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeAuthStore.ts'))};
      const paths = JSON.parse(process.argv[1]);
      const result = mergeOpenCodeManagedAuthSources({ sourceAuthPaths: paths, sourceStores: await Promise.all(paths.map(readOpenCodeAuthStore)), globalAuthPath: paths[0] });
      process.stdout.write(result.xai.refresh);`
    const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify([global, local])], { stdout: 'pipe', stderr: 'pipe' })
    expect(await new Response(child.stdout).text()).toBe(c1.refresh)
    expect(await child.exited).toBe(0)
    const c2 = { ...c1, access: 'synthetic-access-2', refresh: 'single-use-2' }
    await owned(() => rotate(c1, c2), { predecessor: c1 })
    expect(await read(global)).toEqual(c2)
    expect(consumed.size).toBe(2)
    await expect(owned(() => native(c1))).rejects.toThrow('predecessor changed')
    expect(await read(global)).toEqual(c2)
  })

  test.each([false, true])('queued preprepared operation rejects consumed C0 (shared root: %s)', async shared => {
    const entered = barrier(), proceed = barrier()
    const other = shared ? managed : path.join(root, 'app', 'opencode', 'profiles', 'scope-other', 'data', 'opencode', 'auth.json')
    if (!shared) await write(other, c0)
    const first = owned(async () => { entered.release(); await proceed.promise; await native(c1) })
    await entered.promise
    let consumedAgain = false
    const second = owned(async () => { consumedAgain = true }, { managedAuthPath: other })
      .then(() => null, error => error)
    proceed.release()
    await first
    expect(await second).toBeInstanceOf(Error)
    expect(consumedAgain).toBe(false)
    expect(await read(global)).toEqual(c1)
    expect(await read(other)).toEqual(shared ? c1 : c0)
  })

  test.each([
    ['logout', null], ['API replacement', { type: 'api', key: 'replacement' }],
    ['account swap', { ...c0, accountId: 'other' }],
    ['same-account newer source', { ...c1, expires: 999999 }],
  ])('rejects %s during native execution without overwriting changed source', async (_label, replacement) => {
    await expect(owned(async () => {
      await native(c1)
      await native(replacement, global) // An independent external source writer does not take our lock.
    })).rejects.toThrow('saved authority changed')
    expect(await read(global)).toEqual(replacement)
    expect(await read(managed)).toEqual(c1)
  })

  test('rejects a changed local source and preserves a concurrent unrelated provider', async () => {
    await expect(owned(async () => {
      await native(c1)
      await mkdir(path.dirname(local), { recursive: true })
      await native({ ...c0, refresh: 'local-login' }, local)
    })).rejects.toThrow('saved authority changed')
    expect(await read(global)).toEqual(c0)
  })

  test.each([null, { type: 'api', key: 'test' }, { ...c1, refresh: '' }, { ...c1, expires: '500' }, { ...c1, accountId: 'other' }])('rejects invalid or account-switched native output %#', async credential => {
    await expect(owned(() => native(credential))).rejects.toThrow()
    expect(await read(global)).toEqual(c0)
  })

  test('does not accept same-account expiry as lineage before native execution', async () => {
    await write(local, { ...c0, access: 'foreign', expires: 1 })
    let invoked = false
    await expect(owned(async () => { invoked = true })).rejects.toThrow('sources disagree')
    expect(invoked).toBe(false)
  })

  test('cancellation after settled native output rejects the caller but preserves saved reuse', async () => {
    const controller = new AbortController()
    await expect(owned(async () => { await native(c1); controller.abort(new Error('test cancellation')) }, { abortSignal: controller.signal }))
      .rejects.toThrow('test cancellation')
    expect(await read(global)).toEqual(c1)
    expect(await read(managed)).toEqual(c1)
  })

  test('cancelled native completion cannot publish after host ownership was revoked', async () => {
    const controller = new AbortController()
    let valid = true
    await expect(owned(async () => {
      await native(c1)
      valid = false
      controller.abort(new Error('cancelled'))
    }, {
      abortSignal: controller.signal,
      assertOwnership: async () => { if (!valid) throw new Error('host ownership revoked') },
    })).rejects.toThrow('host ownership revoked')
    expect(await read(global)).toEqual(c0)
  })

  test('cancellation while queued never enters native work', async () => {
    const entered = barrier(), proceed = barrier()
    const first = owned(async () => { entered.release(); await proceed.promise })
    await entered.promise
    const controller = new AbortController()
    let enteredNative = false
    const second = owned(async () => { enteredNative = true }, { abortSignal: controller.signal })
      .then(() => null, error => error)
    controller.abort(new Error('cancel queued operation'))
    expect(await second).toBeInstanceOf(Error)
    proceed.release()
    await first
    expect(enteredNative).toBe(false)
    expect(await read(global)).toEqual(c0)
  })

  test('host/source ownership revocation prevents publication', async () => {
    let valid = true
    await expect(owned(async () => { await native(c1); valid = false }, {
      assertOwnership: async () => { if (!valid) throw new Error('owned host changed') },
    })).rejects.toThrow('owned host changed')
    expect(await read(global)).toEqual(c0)
  })

  test('refuses a foreign scoped root as a saved source before consuming C0', async () => {
    let invoked = false
    await expect(owned(async () => { invoked = true }, { sourceAuthPaths: [global, foreign] }))
      .rejects.toThrow('saved authority paths are invalid')
    expect(invoked).toBe(false)
  })

  test('provider failure before rotation preserves C0 and surfaces failure', async () => {
    await expect(owned(async () => { throw new Error('native rejected') })).rejects.toThrow('native rejected')
    expect(await read(global)).toEqual(c0)
    expect(await read(managed)).toEqual(c0)
  })
})
