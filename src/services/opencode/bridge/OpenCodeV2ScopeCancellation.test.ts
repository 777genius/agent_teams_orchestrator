import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as filesystem from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openCodeOAuthSaveReceiptPath, recoverOpenCodeOwnedOAuthSave, withOpenCodeOAuthRefreshLock } from '../OpenCodeAuthStore.js'
import { resolveOpenCodeProfileScope } from '../OpenCodeProfileManager.js'
import * as profiles from '../OpenCodeProfileManager.js'
import * as mcp from '../OpenCodeMcpManager.js'
import * as identity from '../compatibility/OpenCodeNativeIdentity.js'
import { inspectOpenCodeV2LaunchSelection, inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'

for (const entry of ['owned recovery', 'profile scope', 'V2 source selection'] as const) {
  test(`${entry} cancels pending OAuth lock acquisition without late recovery or publication`, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-scope-abort-')))
    const dataRoot = path.join(root, 'runtime'), globalAuthPath = path.join(dataRoot, 'opencode', 'auth.json')
    const receiptPath = openCodeOAuthSaveReceiptPath(globalAuthPath)
    const previousDataRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = dataRoot
    let release!: () => void, entered!: () => void, ownerChecks = 0
    const held = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    let holder: Promise<unknown> | undefined, outcome: Promise<unknown> | undefined
    let selected: ReturnType<typeof spyOn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await mkdir(path.dirname(globalAuthPath), { recursive: true })
      await writeFile(globalAuthPath, '{}\n', { mode: 0o600 })
      // A pending file triggers lock acquisition. Its contents must never be
      // interpreted while another publisher owns the lock or after cancellation.
      await writeFile(receiptPath, '{}\n', { mode: 0o600 })
      holder = withOpenCodeOAuthRefreshLock({ authPath: globalAuthPath, providerId: 'xai', operation: async () => {
        entered(); await held
      } })
      await ready
      const controller = new AbortController(), reason = new Error('TEST-passive-status-deadline')
      if (entry === 'V2 source selection') {
        selected = spyOn(identity, 'inspectOpenCodeReadSelection').mockResolvedValue({ path: '/TEST/qualified/opencode',
          policy: { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4' }, fingerprint: 'a'.repeat(64),
          native: { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4', executablePath: '/TEST/qualified/opencode',
            executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64' } })
      }
      const request = entry === 'owned recovery'
        ? recoverOpenCodeOwnedOAuthSave({ globalAuthPath, sourceAuthPaths: [globalAuthPath], abortSignal: controller.signal,
          assertOwner: async () => { ownerChecks++ } })
        : entry === 'profile scope'
          ? resolveOpenCodeProfileScope({ projectPath: root, purpose: 'launch_runtime', selectedModel: 'xai/TEST-model',
            abortSignal: controller.signal })
          : inspectOpenCodeV2LaunchSelection({ schemaVersion: 1, requestId: 'TEST-abort', command: 'opencode.readiness', cwd: root,
            startedAt: new Date().toISOString(), timeoutMs: 60_000, body: { selectedModel: 'xai/TEST-model' } },
          { signal: controller.signal, deadlineMs: Date.now() + 15_000 })
      outcome = request.then(() => 'unexpected-success', error => error)
      await new Promise(resolve => setTimeout(resolve, 30))
      controller.abort(reason)
      // The timeout belongs only to the assertion; finally joins both operations
      // before cleanup even on the unfixed path. No mutation is abandoned.
      expect(await Promise.race([outcome, new Promise(resolve => {
        timer = setTimeout(() => resolve('still-waiting-on-auth-lock'), 250)
      })])).toBe(reason)
      expect(ownerChecks).toBe(0)
      if (selected) expect(selected).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(timer)
      release()
      await holder
      await outcome
      selected?.mockRestore()
      if (previousDataRoot === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousDataRoot
      try {
        expect(await readFile(globalAuthPath, 'utf8')).toBe('{}\n')
        expect(await readFile(receiptPath, 'utf8')).toBe('{}\n')
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
}

test('already cancelled scope and recovery do not create an auth coordination store', async () => {
  const controller = new AbortController(), reason = new Error('TEST-already-cancelled-status')
  controller.abort(reason)
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: '/TEST/never-created/auth.json', sourceAuthPaths: [],
    abortSignal: controller.signal, assertOwner: async () => { throw new Error('TEST-owner-must-not-run') },
  })).rejects.toBe(reason)
  await expect(resolveOpenCodeProfileScope({ projectPath: '/TEST/never-created', purpose: 'launch_runtime',
    selectedModel: 'xai/TEST-model', abortSignal: controller.signal,
  })).rejects.toBe(reason)
})

test('source inspection cancels a deferred pure receipt metadata read without publishing late authority', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-receipt-abort-')))
  const executablePath = path.join(root, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  const bytes = Buffer.from('TEST-offline-receipt-input')
  await writeFile(executablePath, bytes)
  const native: identity.OpenCodeV2NativeIdentity = { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4',
    executablePath, executableSha256: createHash('sha256').update(bytes).digest('hex'), packageName: null }
  const controller = new AbortController(), reason = new Error('TEST-source-read-deadline')
  let release!: () => void, entered!: () => void, finished!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const settledRead = new Promise<void>(resolve => { finished = resolve })
  let readStarted = false, readFinished = false, authorityPublished = false
  const originalRead = filesystem.realpath
  const restores = [
    spyOn(identity, 'inspectOpenCodeReadSelection').mockResolvedValue({ native, path: executablePath,
      policy: { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4' }, fingerprint: native.executableSha256 }),
    spyOn(profiles, 'resolveOpenCodeProfileScope').mockResolvedValue({ purpose: 'launch_runtime', providerId: 'opencode',
      scopeToken: 'TEST-read-scope', configFingerprint: 'c'.repeat(64), selectedAuthIdentity: 'absent' }),
    spyOn(mcp, 'resolveOpenCodeAppMcpLaunchConfig').mockResolvedValue({ source: 'env-override',
      config: { type: 'remote', enabled: true, url: 'http://127.0.0.1:1/TEST-no-network', oauth: false } }),
    spyOn(filesystem, 'realpath').mockImplementation((async (...args: Parameters<typeof originalRead>) => {
      if (String(args[0]) !== executablePath) return originalRead(...args)
      readStarted = true; entered(); await held
      try { return await originalRead(...args) }
      finally { readFinished = true; finished() }
    }) as typeof originalRead),
  ]
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = inspectOpenCodeV2SourceAvailability({ schemaVersion: 1, requestId: 'TEST-receipt-read', command: 'opencode.readiness', cwd: root,
    startedAt: new Date().toISOString(), timeoutMs: 60_000, body: { selectedModel: 'opencode/TEST-free' } },
  { signal: controller.signal, deadlineMs: Date.now() + 15_000 }).then(() => {
    authorityPublished = true; return 'unexpected-authority'
  }, error => error)
  try {
    expect(await Promise.race([ready.then(() => true), outcome.then(() => false)])).toBe(true)
    controller.abort(reason)
    expect(await Promise.race([outcome, new Promise(resolve => {
      timer = setTimeout(() => resolve('still-waiting-on-receipt-read'), 250)
    })])).toBe(reason)
    expect(readFinished).toBe(false)
    expect(authorityPublished).toBe(false)
  } finally {
    clearTimeout(timer); release(); await outcome
    if (readStarted) await settledRead
    for (const restore of restores) restore.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
  expect(readFinished).toBe(true)
  expect(authorityPublished).toBe(false)
})
