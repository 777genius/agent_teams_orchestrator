/* eslint-disable custom-rules/no-process-exit -- Isolated TEST process proves cleanup before real exit. */
import { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { spyOn } from 'bun:test'
import * as lockfile from '../../../utils/lockfile.js'
import { OpenCodeHostManager } from '../OpenCodeHostManager.js'
import { OpenCodeAuthorityVetoError } from '../OpenCodeAuthorityStoreRead.js'
import type { OpenCodePreparedProfile } from '../types.js'

const [root, profilePath, mode] = process.argv.slice(2)
if (mode !== 'success' && mode !== 'read_failure') throw new Error('Invalid TEST fixture mode')
if (!root || !profilePath) throw new Error('Missing TEST fixture paths')
const profile: OpenCodePreparedProfile = JSON.parse(await readFile(profilePath, 'utf8'))
const registry = path.join(root, 'host-registry.json')
const lockDirectory = `${registry}.lock.lock`
const child = new ChildProcess()
const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
Object.defineProperties(child, {
  pid: { value: 420001 }, stdout: { value: stdout },
  stderr: { value: stderr }, stdin: { value: stdin },
  // An unspawned Bun ChildProcess has no lazy stdio backing state. Model the
  // three configured pipe slots explicitly, using the same stream instances.
  stdio: { value: [stdin, stdout, stderr] },
  unref: { value: () => {} },
  kill: { value: () => { throw new Error('TEST must not terminate a host') } },
})
let exited = false
const manager = new OpenCodeHostManager({
  persistentRegistryPath: registry, processAttributionDirectory: null,
  prepareProfile: async () => profile, allocateLoopbackPort: async () => 43120,
  spawnHostProcess: () => child, readProcessStartTimeMs: async () => 42,
  isProcessAlive: () => !exited,
  fetchJson: async () => ({ status: 200, data: { healthy: true, version: 'TEST' } }),
})
await manager.ensureHost({ hostKey: 'TEST-exit-host', hostLifetime: 'persistent',
  prewarmManagedSubscriptionPlugins: false, resolveConfigFingerprint: false })

// Real mkdir/utimes: pause only the mtime-probe completion, before proper-lockfile
// publishes its in-memory ownership used by its process-exit hook.
let entered!: () => void
const acquisitionPaused = new Promise<void>(resolve => { entered = resolve })
let gateReleased = false, armed = true
const originalLock = lockfile.lock
spyOn(lockfile, 'lock').mockImplementation((file, options) => {
  if (file !== `${registry}.lock` || !armed) return originalLock(file, options)
  armed = false
  const gatedFs = { ...fs, utimes(...args: Parameters<typeof fs.utimes>) {
    const [file, atime, mtime, callback] = args
    fs.utimes(file, atime, mtime, error => {
      if (error) { callback(error); return }
      setTimeout(() => { gateReleased = true; callback(null) }, 100)
      entered()
    })
  } }
  return originalLock(file, { ...options, fs: gatedFs })
})
exited = true
child.emit('exit', 0, null)
await acquisitionPaused
if (!fs.existsSync(lockDirectory)) throw new Error('Real registry acquisition did not create its directory')
if (mode === 'read_failure') fs.writeFileSync(registry, '{invalid-TEST-registry')
let cleanupReadFailed = false
// The CLI awaits this same HostManager cleanup before process.exit. Importing
// the full command router here would load every provider into this isolated test.
try { await manager.disposeUnregisteredOwnedHosts() }
catch (error) {
  if (mode !== 'read_failure' || !(error instanceof OpenCodeAuthorityVetoError)
    || error.store !== 'host' || error.reason !== 'invalid') throw error
  cleanupReadFailed = true
}
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
  acquisitionPaused: true, gateReleased, cleanupReadFailed,
  lockPresentBeforeExit: fs.existsSync(lockDirectory), registryPresent: fs.existsSync(registry),
}))
process.exit(0)
