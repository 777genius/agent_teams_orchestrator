// Runs exclusively inside a newly marked TEST Git project. Product classes below
// are bundled unmodified from the immutable product INPUT by buildWorker().
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { VersionedJsonStore } from '../../.task-inputs/product/src/main/services/team/opencode/store/VersionedJsonStore'
import { createRuntimeStoreManifestStore, createDefaultRuntimeStoreManifest, validateRuntimeStoreManifest } from '../../.task-inputs/product/src/main/services/team/opencode/store/RuntimeStoreManifest'
import { readRuntimeStoreManifestEvidenceData } from '../../.task-inputs/product/src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceData'
import { identity, manifest, outcome, session, stamp, type Reader } from './fixtures'

const input = JSON.parse(await readFile('case-input.json', 'utf8'))
const marker = JSON.parse(await readFile('.test-project-owner.json', 'utf8'))
if (marker.nonce !== input.nonce || marker.project !== process.cwd() || !path.basename(process.cwd()).startsWith('TEST-')) throw new Error('TEST ownership mismatch')
await readdir('.git')
const effects: string[] = []
// These are tripwires, not replacement reader implementations.
globalThis.fetch = async () => { effects.push('network-attempt'); throw new Error('S5a forbids network') }
const clock = () => new Date(stamp)
let privilege: any = { uidBefore: process.getuid?.(), uidAfter: process.getuid?.(), probe: null }
function errorData(e: any) { return { name: e?.name ?? typeof e, code: e?.code ?? null, reason: e?.reason ?? null,
  message: String(e?.message ?? e), quarantinePath: e?.quarantinePath ?? null } }
const reader: Reader = input.reader
let store: any
try {
  // Dynamic imports keep unavailable owner dependencies honest and separate from
  // product qualification. No mock module or source rewrite is used.
  if (reader === 'outcome') {
    const mod = await import(path.join(input.ownerSource, 'src/services/opencode/OpenCodeCommandOutcomeStore.ts'))
    store = new mod.OpenCodeCommandOutcomeStore('store.json')
  } else if (reader === 'session') {
    const mod = await import(path.join(input.ownerSource, 'src/services/opencode/OpenCodeSessionStore.ts'))
    store = new mod.OpenCodeSessionStore('store.json')
  } else if (reader === 'host') {
    const mod = await import(path.join(input.ownerSource, 'src/services/opencode/OpenCodeHostManager.ts'))
    const deny = (name: string) => () => { effects.push(name); throw new Error(`S5a forbids ${name}`) }
    store = new mod.OpenCodeHostManager({ persistentRegistryPath: 'store.json', processAttributionDirectory: 'attribution',
      isProcessAlive: () => true, readProcessStartTimeMs: async () => 123,
      inspectProcessLiveness: async () => 'alive', readProcessCommandLine: async () => null,
      spawnHostProcess: deny('spawn'), allocateLoopbackPort: deny('allocate-port'),
      fetchJson: deny('fetchJson'), killProcess: deny('kill'), prepareProfile: deny('prepareProfile'), now: clock })
  } else if (reader === 'manifest-store') store = createRuntimeStoreManifestStore({ filePath: 'store.json', teamName: 'TEST-team', clock })
  else if (reader === 'versioned') store = new VersionedJsonStore({ filePath: 'store.json', schemaVersion: 1,
    defaultData: () => createDefaultRuntimeStoreManifest('TEST-team', stamp), validate: validateRuntimeStoreManifest, clock })
} catch (e) {
  console.log(JSON.stringify({ qualification: 'MISSING', stage: 'reader-load', error: errorData(e), privilege, effects }))
  process.exit(0)
}
if (input.unreadable) {
  privilege.uidMap = await readFile('/proc/self/uid_map', 'utf8').catch(() => null)
  privilege.gidMap = await readFile('/proc/self/gid_map', 'utf8').catch(() => null)
  try {
    if (process.getuid?.() === 0) {
      const failures: any[] = []
      for (const [operation, run] of [['setgroups', () => process.setgroups!([])], ['setgid', () => process.setgid!(65534)], ['setuid', () => process.setuid!(65534)]] as const) {
        try { run() } catch (e: any) { failures.push({ operation, code: e.code, message: e.message }) }
      }
      privilege.dropFailures = failures
      if (process.getuid?.() === 0) privilege.dropError = failures.at(-1)
    }
    privilege.uidAfter = process.getuid?.()
    try { await readFile('store.json'); privilege.probe = { readSucceeded: true } }
    catch (e: any) { privilege.probe = { readSucceeded: false, code: e.code, syscall: e.syscall } }
  } catch (e: any) { privilege.dropError = { name: e.name, code: e.code, message: e.message } }
  if (privilege.uidAfter === 0 || privilege.probe?.code !== 'EACCES') {
    console.log(JSON.stringify({ qualification: 'MISSING', reason: 'Actual unprivileged EACCES unavailable', privilege, effects }))
    process.exit(0)
  }
}
let result: any
try {
  const op = input.operation
  if (reader === 'outcome') {
    if (op === 'query') result = await store.query({ requestId: 'TEST-request' })
    else if (op === 'prune') result = await store.prune(0, new Date('2026-10-02').getTime())
    else result = await store.upsert({ ...outcome(input.project), requestId: 'TEST-new-request', status: 'received' })
  } else if (reader === 'session') {
    if (op === 'list-get') result = { list: await store.list(), get: await store.get('TEST-team', 'primary', 'TEST-member') }
    else if (op === 'upsert') result = await store.upsert({ ...session(input.project), memberName: 'TEST-new-member' })
    else if (op === 'claim') result = await store.claimMaterialization({ ...identity, memberName: 'TEST-new-member' }, 'TEST-attempt', 'TEST-run')
    else result = await store.delete('TEST-team', 'primary', 'TEST-member')
  } else if (reader === 'host') {
    if (op === 'resolveOwnedSessionEndpoint') result = await store.resolveOwnedSessionEndpoint('TEST-host', { ...identity, projectPath: input.project, expectedProcessStartedAtMs: 123 })
    else if (op === 'retainHostLease') result = await store.retainHostLease('TEST-host', { ...identity, memberName: 'TEST-new-member' })
    else result = await store.releaseHostLeaseStrict('TEST-host', identity)
  } else if (reader === 'manifest-evidence') result = await readRuntimeStoreManifestEvidenceData('store.json', 'TEST-team', clock)
  else if (op === 'read') result = await store.read()
  else if (reader === 'manifest-store') result = await store.setActiveRun({ runId: 'TEST-new-run' })
  else result = await store.updateLocked((data: any) => ({ ...data, activeRunId: 'TEST-new-run' }))
  console.log(JSON.stringify({ qualification: 'OBSERVED', returned: true, result: result ?? null, privilege, effects }))
} catch (e) {
  const error = errorData(e)
  // Missing package is qualification MISSING, not a preservation veto.
  const missing = error.message.includes("Cannot find package") || error.message.includes('Cannot find module')
  console.log(JSON.stringify({ qualification: missing ? 'MISSING' : 'OBSERVED', returned: false, error, privilege, effects }))
}
