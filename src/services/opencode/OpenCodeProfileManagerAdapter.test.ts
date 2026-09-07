import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as mcp from './OpenCodeMcpManager.js'
import * as preparation from './OpenCodeProfilePreparation.js'
import { OpenCodeProfileManager } from './OpenCodeProfileManager.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

// Exercise the public desktop adapter and real preparer; only discovery is delayed.
// Redirect adapter preparation inputs to fresh synthetic stores, never user stores.
for (const abortDiscovery of [false, true]) {
  test(`desktop reserves queue and cwd before MCP discovery (abort=${abortDiscovery})`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'profile-adapter-r1089-'))
    const cwd = process.cwd()
    const entered = deferred<void>()
    const discovery = deferred<Awaited<ReturnType<typeof mcp.resolveOpenCodeAppMcpLaunchConfig>>>()
    const original = preparation.prepareOpenCodeProfileUnderLock
    const calls: preparation.OpenCodeProfilePreparationInput[] = []
    const discoverySpy = spyOn(mcp, 'resolveOpenCodeAppMcpLaunchConfig').mockImplementation(() => {
      entered.resolve(); return discovery.promise
    })
    const prepareSpy = spyOn(preparation, 'prepareOpenCodeProfileUnderLock').mockImplementation(input => {
      calls.push(input)
      return original({ ...input, paths: { data: path.join(root, 'data'), cache: path.join(root, 'cache') },
        globalAuthPath: path.join(root, 'data/opencode/auth.json'), sourceHomePath: root,
        sourceAuthPaths: [], environment: {}, platform: 'linux' })
    })
    const pending: Promise<unknown>[] = []
    try {
      await mkdir(path.join(root, 'before/project'), { recursive: true })
      await mkdir(path.join(root, 'after'))
      process.chdir(path.join(root, 'before'))
      const manager = new OpenCodeProfileManager()
      const controller = new AbortController(), reason = new Error('synthetic abort')
      const options = { includeManagedSubscriptionPlugins: false, abortSignal: controller.signal }
      const first = manager.prepareProfile('project', options)
      const firstOutcome = first.then(value => ({ value, error: null }), error => ({ value: null, error }))
      pending.push(firstOutcome)
      await entered.promise
      process.chdir(path.join(root, 'after'))
      const next = manager.prepareProfile(path.join(root, 'before/project'), {
        includeAppMcp: false, includeManagedSubscriptionPlugins: false,
      })
      pending.push(next)
      await turn()
      expect(calls).toHaveLength(0)
      if (abortDiscovery) {
        controller.abort(reason)
        // Discovery stays unresolved until finally: abort and the next call must finish independently.
        expect((await firstOutcome).error).toBe(reason)
        expect((await next).projectPath).toBe(path.join(root, 'before/project'))
        expect(calls).toHaveLength(1)
        expect(calls[0].appMcpConfig).toBeNull()
      } else {
        const config = { type: 'remote' as const, url: 'https://synthetic.invalid/mcp' }
        discovery.resolve({ config } as Awaited<ReturnType<typeof mcp.resolveOpenCodeAppMcpLaunchConfig>>)
        const result = await firstOutcome
        expect(result.error).toBeNull()
        expect(result.value?.projectPath).toBe(path.join(root, 'before/project'))
        await next
        expect(calls.map(input => input.appMcpConfig)).toEqual([config, null])
        expect(calls[0].workingDirectory).toBe(path.join(root, 'before'))
      }
    } finally {
      discovery.resolve({ config: { type: 'remote', url: 'https://synthetic.invalid/mcp' } } as Awaited<ReturnType<typeof mcp.resolveOpenCodeAppMcpLaunchConfig>>)
      await Promise.allSettled(pending)
      prepareSpy.mockRestore(); discoverySpy.mockRestore()
      process.chdir(cwd)
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
}
