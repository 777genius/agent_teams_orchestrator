import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeAuthorityVetoError, isKnownHostRegistry, readOpenCodeAuthority, requireOpenCodeAuthority } from '../../OpenCodeAuthorityStoreRead.js'
import { NativeIngressFixtureCases } from './OpenCodeNativeIngressFixture.js'
import { cleanupNativeIngressHost } from './OpenCodeNativeIngressCleanup.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const resultOf = (promise: Promise<unknown>) => promise.then(() => null, error => error)

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-native-ingress-cleanup-'))
  roots.push(root)
  const registryPath = path.join(root, 'host-registry.json'), hostKey = 'TEST-original-host'
  await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, hosts: {} }), { mode: 0o600 })
  const events: string[] = []
  let phase = 'published'
  const manager = {
    async disposeHost(key: string) {
      expect(key).toBe(hostKey)
      events.push('dispose')
      requireOpenCodeAuthority(await readOpenCodeAuthority(registryPath, isKnownHostRegistry), 'host', () => ({ schemaVersion: 1 as const, hosts: {} }))
      phase = 'dead'
      return true
    },
    async drainPendingLifecycleCleanups() { events.push('drain') },
  }
  const custody = { async stopExact() { events.push('captured-stop'); phase = 'dead' } }
  const assertDead = async () => { events.push('read-dead'); expect(phase).toBe('dead') }
  return { registryPath, hostKey, manager, custody, assertDead, events, getPhase: () => phase, setPhase(value: string) { phase = value } }
}

describe('native ingress captured cleanup', () => {
  test('checks the immediate dead receipt before draining lifecycle work', async () => {
    const f = await fixture()
    expect(await cleanupNativeIngressHost(f)).toBe(true)
    expect(f.events).toEqual(['dispose', 'read-dead', 'drain'])
  })

  test('rejects a dead receipt that becomes true only during lifecycle drain', async () => {
    const f = await fixture(), failure = new Error('TEST immediate dead receipt missing')
    f.manager.disposeHost = async () => { f.events.push('dispose'); return true }
    f.assertDead = async () => { f.events.push('read-dead'); if (f.getPhase() !== 'dead') throw failure }
    f.manager.drainPendingLifecycleCleanups = async () => { f.events.push('drain'); f.setPhase('dead') }
    expect(await resultOf(cleanupNativeIngressHost(f))).toBe(failure)
    expect(f.events).toEqual(['dispose', 'read-dead', 'drain'])
  })

  test('preserves an initial registry veto while retiring only the captured custody once', async () => {
    const f = await fixture(), bytes = '{ TEST invalid original registry'
    await writeFile(f.registryPath, bytes)
    const cases = new NativeIngressFixtureCases(), owner = cases.begin()
    let restores = 0
    const failure = await resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(() => cleanupNativeIngressHost(f))
      await owner.adopt({})
      await owner.stage('stop', () => owner.cleanup())
    }))
    expect(failure).toBeInstanceOf(OpenCodeAuthorityVetoError)
    expect(failure).toMatchObject({ store: 'host', reason: 'invalid' })
    expect(f.events).toEqual(['captured-stop', 'drain'])
    await expect(owner.cleanup()).rejects.toBe(failure)
    await expect(owner.cleanup()).rejects.toBe(failure)
    expect(f.events).toEqual(['captured-stop', 'drain'])
    expect(restores).toBe(0)
    expect(owner.settledSuccessfully).toBe(false)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
    expect(await readFile(f.registryPath, 'utf8')).toBe(bytes)
  })

  test('a nonregular original registry is a veto, while a missing registry still reaches the manager', async () => {
    const f = await fixture()
    await unlink(f.registryPath)
    await mkdir(f.registryPath)
    expect(await resultOf(cleanupNativeIngressHost(f))).toMatchObject({ store: 'host', reason: 'nonregular' })
    expect(f.events).toEqual(['captured-stop', 'drain'])
    await rm(f.registryPath, { recursive: true })
    f.events.length = 0
    expect(await cleanupNativeIngressHost(f)).toBe(true)
    expect(f.events).toEqual(['dispose', 'read-dead', 'drain'])
  })

  test('a registry failure after manager admission never authorizes another Stop', async () => {
    const f = await fixture(), failure = new OpenCodeAuthorityVetoError('host', 'invalid')
    f.manager.disposeHost = async () => {
      f.events.push('dispose')
      await writeFile(f.registryPath, '{ TEST raced registry after original dispatch')
      throw failure
    }
    expect(await resultOf(cleanupNativeIngressHost(f))).toBe(failure)
    expect(f.events).toEqual(['dispose', 'drain'])
  })

  test('a false manager outcome remains unconfirmed without reading dead or falling back', async () => {
    const f = await fixture()
    f.manager.disposeHost = async () => { f.events.push('dispose'); return false }
    expect(await cleanupNativeIngressHost(f)).toBe(false)
    expect(f.events).toEqual(['dispose', 'drain'])
  })

  test('a failed captured fallback retains both failures and still drains once', async () => {
    const f = await fixture(), failure = new Error('TEST captured Stop uncertain')
    await writeFile(f.registryPath, '{ TEST invalid original registry')
    f.custody.stopExact = async () => { f.events.push('captured-stop'); throw failure }
    const error = await resultOf(cleanupNativeIngressHost(f))
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors[0]).toMatchObject({ store: 'host', reason: 'invalid' })
    expect(error.errors[1]).toBe(failure)
    expect(f.events).toEqual(['captured-stop', 'drain'])
  })

  test('lifecycle failure cannot replace the immediate receipt failure', async () => {
    const f = await fixture(), receipt = new Error('TEST immediate dead receipt missing'), drain = new Error('TEST lifecycle drain failed')
    f.assertDead = async () => { f.events.push('read-dead'); throw receipt }
    f.manager.drainPendingLifecycleCleanups = async () => { f.events.push('drain'); throw drain }
    const error = await resultOf(cleanupNativeIngressHost(f))
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([receipt, drain])
    expect(f.events).toEqual(['dispose', 'read-dead', 'drain'])
  })
})
