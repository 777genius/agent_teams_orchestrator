// Virtual timing with a real private IPC child and a disposable, project-owned TEST root.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mock, spyOn } from 'bun:test'
import { openCodeV2Dialect } from '../../compatibility/OpenCodeV2Registry.js'

const scenario = process.argv[2]
assert(scenario && ['slow', 'near-limit', 'caller-limit', 'expired', 'abort', 'tampered'].includes(scenario))
const root = await realpath(await mkdtemp(path.join(process.cwd(), 'TEST-read-host-loading-')))
const project = path.join(root, 'project'), privateRoot = path.join(root, 'private')
await mkdir(project); await mkdir(privateRoot)
const entryPath = fileURLToPath(new URL('./readHostBudgetPeer.ts', import.meta.url))
const startedAt = 1_000_000
let now = startedAt, removed = 0, birthReads = 0, pid: number | undefined
const clock = spyOn(Date, 'now').mockImplementation(() => now)
const controller = new AbortController(), reason = new Error('TEST-cancel-during-validation')
const digest = 'a'.repeat(64)
const preparationMs = scenario === 'near-limit' ? 140_000 : scenario === 'expired' ? 180_001 : 24_000
const startupMs = scenario === 'near-limit' ? 20_000 : 23_000
const callerDeadline = startedAt + (scenario === 'caller-limit' ? 40_000 : 240_000)
mock.module('../../../../utils/processKill.js', () => ({ readProcessStartTimeMs: async (value: number) => {
  pid = value
  if (++birthReads === 2) now += startupMs
  return 1
} }))
mock.module('../../compatibility/OpenCodeNativeIdentity.js', () => ({
  hashOpenCodeFile: async () => scenario === 'tampered' ? 'b'.repeat(64) : digest,
}))
mock.module('../../profile/OpenCodeV2ManagedConfig.js', () => ({
  createOpenCodeV2ReadRoots: async () => ({ root: privateRoot, env: {}, remove: async () => {
    await rm(privateRoot, { recursive: true, force: true }); removed++
  } }),
}))
mock.module('../OpenCodeV2ChildEntry.js', () => ({ resolveOpenCodeV2ChildDelivery: async () => ({ entryPath }) }))
mock.module('../OpenCodeV2ServerGraph.js', () => ({ verifyOpenCodeV2ServerGraph: async () => {
  now += preparationMs
  if (scenario === 'abort') controller.abort(reason)
  return { moduleSha256: digest }
} }))
mock.module('../OpenCodeV2GraphFiles.js', () => ({ collectOpenCodeV2GraphFiles: async () => [] }))

try {
  const { acquireOpenCodeV2ReadHost, assertOpenCodeV2EndpointAuthority } = await import('../OpenCodeHostNativeAdapter.js')
  const native = { executablePath: path.join(root, 'TEST-opencode'), executableSha256: digest, version: '2.1.4',
    engineVersion: '2.1.4', dialect: openCodeV2Dialect('2.1.4'), generation: 'v2' } as Parameters<typeof acquireOpenCodeV2ReadHost>[0]
  let host: Awaited<ReturnType<typeof acquireOpenCodeV2ReadHost>> | undefined, failure: unknown
  try {
    host = await acquireOpenCodeV2ReadHost(native, project, {
      signal: controller.signal, remainingMs: () => callerDeadline - now,
    })
  } catch (error) { failure = error }
  if (scenario === 'slow' || scenario === 'near-limit') {
    assert.equal(failure, undefined, `Slow startup must succeed: ${String(failure)}`)
    assert(host)
    assertOpenCodeV2EndpointAuthority(host.authority)
    await host.close()
    assert.throws(() => assertOpenCodeV2EndpointAuthority(host!.authority), /identity_mismatch/)
    assert(pid); assert.equal(removed, 1)
  } else {
    assert.equal(host, undefined, 'Failed or cancelled loading must not publish authority')
    if (scenario === 'abort') assert.equal(failure, reason)
    else assert.match(String(failure), scenario === 'tampered' ? /identity_mismatch/ : /timeout/)
    assert.equal(Boolean(pid), scenario === 'caller-limit')
    assert.equal(removed, pid ? 1 : 0)
  }
  if (pid) assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' })
  console.log(JSON.stringify({ scenario, elapsedMs: now - startedAt, removed, ok: true }))
} finally {
  clock.mockRestore()
  let gone = !pid
  if (pid) try { process.kill(pid, 0) } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
  if (gone) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}
