// Isolated mocks: no real child process, executable, profile or user project is used.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock, spyOn } from 'bun:test'

const scenario = process.argv[2]
assert(scenario && ['slow', 'near-limit', 'caller-limit', 'expired', 'abort', 'tampered'].includes(scenario))
const startedAt = 1_000_000
let now = startedAt, spawned = 0, removed = 0, closed = 0
const clock = spyOn(Date, 'now').mockImplementation(() => now)
const controller = new AbortController()
const reason = new Error('TEST-cancel-during-validation')
const digest = 'a'.repeat(64)
const preparationMs = scenario === 'near-limit' ? 140_000 : scenario === 'expired' ? 180_001 : 24_000
const startupMs = scenario === 'near-limit' ? 20_000 : 23_000
const callerDeadline = startedAt + (scenario === 'caller-limit' ? 40_000 : 240_000)

class PrivateChild extends EventEmitter {
  pid = 2147483000
  connected = true
  send(message: Record<string, unknown>): void {
    if (message.type === 'start') {
      now += startupMs
      queueMicrotask(() => this.emit('message', { type: 'ready', nonce: message.nonce,
        pid: this.pid, version: '2.1.4', moduleSha256: digest, executableSha256: digest,
        baseUrl: 'http://127.0.0.1:12345' }))
    } else if (message.type === 'close') {
      queueMicrotask(() => {
        closed++
        this.emit('message', { type: 'closed', nonce: message.nonce })
        this.connected = false
        this.emit('close', 0)
      })
    } else throw new Error('Unexpected TEST IPC operation')
  }
  kill(): never { throw new Error('No real process may be signalled by the loading-budget fixture') }
}
mock.module('node:child_process', () => ({ spawn: () => { spawned++; return new PrivateChild() } }))
mock.module('node:fs/promises', () => ({ realpath: async (value: string) => value }))
mock.module('../../../../utils/processKill.js', () => ({ readProcessStartTimeMs: async () => 1 }))
mock.module('../../compatibility/OpenCodeNativeIdentity.js', () => ({
  hashOpenCodeFile: async () => scenario === 'tampered' ? 'b'.repeat(64) : digest,
}))
mock.module('../../profile/OpenCodeV2ManagedConfig.js', () => ({
  createOpenCodeV2ReadRoots: async () => ({ root: '/TEST-private', env: {}, remove: async () => { removed++ } }),
}))
mock.module('../OpenCodeV2ChildEntry.js', () => ({
  resolveOpenCodeV2ChildDelivery: async () => ({ entryPath: '/TEST-server.ts' }),
}))
mock.module('../OpenCodeV2ServerGraph.js', () => ({ verifyOpenCodeV2ServerGraph: async () => {
  now += preparationMs
  if (scenario === 'abort') controller.abort(reason)
  return { moduleSha256: digest }
} }))
mock.module('../OpenCodeV2GraphFiles.js', () => ({ collectOpenCodeV2GraphFiles: async () => [] }))

try {
  const { acquireOpenCodeV2ReadHost, assertOpenCodeV2EndpointAuthority } = await import('../OpenCodeHostNativeAdapter.js')
  const native = { executablePath: '/TEST-opencode', executableSha256: digest, version: '2.1.4',
    engineVersion: '2.1.4', dialect: 'current', generation: 'v2' } as Parameters<typeof acquireOpenCodeV2ReadHost>[0]
  let host: Awaited<ReturnType<typeof acquireOpenCodeV2ReadHost>> | undefined, failure: unknown
  try {
    host = await acquireOpenCodeV2ReadHost(native, '/TEST-project', {
      signal: controller.signal, remainingMs: () => callerDeadline - now,
    })
  } catch (error) { failure = error }
  if (scenario === 'slow' || scenario === 'near-limit') {
    assert.equal(failure, undefined, `Slow startup must succeed: ${String(failure)}`)
    assert(host)
    assertOpenCodeV2EndpointAuthority(host.authority)
    await host.close()
    assert.throws(() => assertOpenCodeV2EndpointAuthority(host!.authority), /identity_mismatch/)
    assert.equal(spawned, 1); assert.equal(closed, 1); assert.equal(removed, 1)
  } else {
    assert.equal(host, undefined, 'Failed or cancelled loading must not publish authority')
    if (scenario === 'abort') assert.equal(failure, reason)
    else assert.match(String(failure), scenario === 'tampered' ? /identity_mismatch/ : /timeout/)
    assert.equal(spawned, scenario === 'caller-limit' ? 1 : 0)
    assert.equal(closed, spawned); assert.equal(removed, spawned)
  }
  console.log(JSON.stringify({ scenario, elapsedMs: now - startedAt, spawned, closed, removed, ok: true }))
} finally { clock.mockRestore() }
