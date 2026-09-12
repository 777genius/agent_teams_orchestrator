import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, chownSync, closeSync, constants, existsSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP_UID = 65534
const APP_GID = 65534
const osGate = process.platform === 'linux' && process.geteuid?.() === 0
const gatedTest = (name: string, body: () => Promise<void>) =>
  (osGate ? test : test.skip)(name, body, 45_000)
// Child startup imports the real Owner graph; lock deadlines below remain 80/500ms.
const CHILD_DEADLINE_MS = 15_000

function spawnPiped(options: {
  cmd: string[]; uid: number; gid: number; cwd: string; env: Record<string, string>
}) {
  return Bun.spawn({ ...options, stdout: 'pipe' as const, stderr: 'pipe' as const })
}

type FixtureProcess = ReturnType<typeof spawnPiped>

type Fixture = { base: string; team: string; anchor: string; record: string
  specification: string; entered: string; release: string; worker: string
  runtime: string; namespace: string; registry: string; tasks: string; children: Set<FixtureChild> }

type FixtureChild = {
  process: FixtureProcess
  completion: Promise<{ exitCode: number; stdout: string; stderr: string }>
  label: string
}

const fixtures: Fixture[] = []

function fdMountId(path: string, directory = false): number {
  const fd = openSync(path, constants.O_RDONLY | 0o2000000 | (directory ? constants.O_DIRECTORY : 0))
  try {
    const match = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
    if (!match) throw new Error(`missing mount id for ${path}`)
    return Number(match[1])
  } finally {
    closeSync(fd)
  }
}

function fixture(): Fixture {
  const base = mkdtempSync('/tmp/canonical-team-authority-')
  const namespace = join(base, 'namespace')
  const teams = join(namespace, 'teams')
  const team = join(teams, 'atlas')
  const registry = join(namespace, 'registry')
  const tasks = join(namespace, 'tasks')
  const runtime = join(base, 'runtime')
  const anchorParent = join(registry, 'registration-a')
  const anchor = join(anchorParent, 'lock')
  const record = join(anchorParent, 'binding.json')
  mkdirSync(team, { recursive: true, mode: 0o700 })
  mkdirSync(anchorParent, { recursive: true, mode: 0o755 })
  mkdirSync(runtime, { mode: 0o700 })
  mkdirSync(tasks, { mode: 0o700 })
  chownSync(runtime, APP_UID, APP_GID)
  chownSync(tasks, APP_UID, APP_GID)
  writeFileSync(anchor, '')
  chmodSync(anchor, 0o444)
  chownSync(team, APP_UID, APP_GID)
  chmodSync(team, 0o700)
  chmodSync(teams, 0o555)
  chmodSync(anchorParent, 0o555)
  chmodSync(registry, 0o555)
  chmodSync(namespace, 0o555)
  chmodSync(base, 0o555)

  const root = lstatSync(team)
  const rootParent = lstatSync(teams)
  const anchorStats = lstatSync(anchor)
  const anchorParentStats = lstatSync(anchorParent)
  const binding = {
    protocolVersion: 1, registrationId: 'registration-a', publicTeamId: 'public-team-a',
    legacyKey: 'atlas', storageGeneration: 'storage-generation-a',
    admittedWriterImage: 'fixture-image-digest', canonicalTeamRoot: team,
    root: { dev: root.dev, ino: root.ino, mountId: fdMountId(team, true) },
    rootParent: { dev: rootParent.dev, ino: rootParent.ino, mountId: fdMountId(teams, true) },
    anchor: { dev: anchorStats.dev, ino: anchorStats.ino, mountId: fdMountId(anchor) },
    anchorParent: { dev: anchorParentStats.dev, ino: anchorParentStats.ino, mountId: fdMountId(anchorParent, true) },
  }
  writeFileSync(record, JSON.stringify(binding))
  chmodSync(record, 0o444)

  const specification = join(base, 'specification.json')
  writeFileSync(specification, JSON.stringify({ namespace, team, teams, tasks, anchor, anchorParent, record, binding }))
  chmodSync(specification, 0o444)
  const entered = join(team, 'entered')
  const release = join(team, 'release')
  const worker = join(base, 'worker.ts')
  writeFileSync(worker, WORKER_SOURCE)
  chmodSync(worker, 0o444)
  const value = {
    base, team, anchor, record, specification, entered, release, worker, runtime, namespace, registry, tasks,
    children: new Set<FixtureChild>(),
  }
  fixtures.push(value)
  return value
}

const WORKER_SOURCE = String.raw`
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
const [specPath, authorityUrl, helpersUrl, operation, entered, release] = process.argv.slice(2)
const spec = JSON.parse(await Bun.file(specPath).text())
const authorityModule = await import(authorityUrl)
const helpers = await import(helpersUrl)
const fds = {
  rootFd: openSync(spec.retainedTeam ?? spec.team, constants.O_RDONLY | 0o2000000 | constants.O_DIRECTORY), rootParentFd: openSync(spec.retainedTeams ?? spec.teams, constants.O_RDONLY | 0o2000000 | constants.O_DIRECTORY),
  anchorFd: openSync(spec.anchor, constants.O_RDONLY | 0o2000000), anchorParentFd: openSync(spec.anchorParent, constants.O_RDONLY | 0o2000000 | constants.O_DIRECTORY),
  bindingRecordFd: openSync(spec.record, constants.O_RDONLY | 0o2000000),
}
let authority
let canonicalRenamePossible = false
let callbackCalled = false
let reviewTrace
try {
  if (operation === 'readonly-alias-mismatch') {
    const saved = spec.team + '.saved'
    renameSync(spec.team, saved)
    canonicalRenamePossible = true
    renameSync(saved, spec.team)
    const canonicalParentFd = openSync(spec.teams, constants.O_RDONLY | 0o2000000 | constants.O_DIRECTORY)
    const descriptorMountId = fd => Number(/^mnt_id:\s+(\d+)$/m.exec(
      readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))[1])
    const status = readFileSync('/proc/self/status', 'utf8')
    const statusHex = name => new RegExp('^' + name + ':\\s*([0-9a-f]+)$', 'mi').exec(status)[1]
    reviewTrace = {
      effectiveUid: process.geteuid(), effectiveGid: process.getegid(),
      capEffective: statusHex('CapEff'), capPermitted: statusHex('CapPrm'), capAmbient: statusHex('CapAmb'),
      canonicalParentMountId: descriptorMountId(canonicalParentFd),
      retainedParentMountId: descriptorMountId(fds.rootParentFd),
      recordedParentMountId: spec.binding.rootParent.mountId,
    }
    closeSync(canonicalParentFd)
  }
  authority = await authorityModule.admitCanonicalTeamLockAuthority({
    binding: {
      protocolVersion: spec.binding.protocolVersion, registrationId: spec.binding.registrationId,
      publicTeamId: spec.binding.publicTeamId, legacyKey: spec.binding.legacyKey,
      storageGeneration: spec.binding.storageGeneration, admittedWriterImage: spec.binding.admittedWriterImage,
      canonicalTeamRoot: spec.binding.canonicalTeamRoot,
    },
    ...fds,
    rootName: 'atlas', anchorName: 'lock', bindingRecordName: 'binding.json',
  })
  if (operation === 'readonly-alias-mismatch' || operation === 'unqualified-terminal-erofs') {
    await authorityModule.withCanonicalTeamLock(authority, { deadlineMs: Date.now() + 500 }, async () => {
      callbackCalled = true
    })
    console.log(JSON.stringify({ ok: false, canonicalRenamePossible, callbackCalled }))
  } else if (operation === 'hold-helper') {
    await helpers.withTeamFileLockAtCanonicalRoot(spec.team, 'atlas', async () => {
      writeFileSync(entered, 'entered')
      while (!existsSync(release)) await Bun.sleep(5)
    })
    console.log(JSON.stringify({ ok: true }))
  } else if (operation === 'attempt-short') {
    let called = false
    try {
      await authorityModule.withCanonicalTeamLock(authority,
        { deadlineMs: Date.now() + 80, pollIntervalMs: 5 }, async () => { called = true })
      console.log(JSON.stringify({ ok: true, called }))
    } catch (error) {
      console.log(JSON.stringify({ ok: false, called, name: error.name, message: error.message }))
    }
  } else if (operation === 'cancel') {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 25)
    try {
      await authorityModule.withCanonicalTeamLock(authority,
        { deadlineMs: Date.now() + 1000, signal: controller.signal }, async () => undefined)
      console.log(JSON.stringify({ ok: true }))
    } catch (error) {
      console.log(JSON.stringify({ ok: false, name: error.name }))
    }
  } else if (operation === 'repeat') {
    let count = 0
    await authorityModule.withCanonicalTeamLock(authority, { deadlineMs: Date.now() + 500 }, async () => { count++ })
    await authorityModule.withCanonicalTeamLock(authority, { deadlineMs: Date.now() + 500 }, async () => { count++ })
    console.log(JSON.stringify({ ok: true, count }))
  } else if (operation === 'revoke') {
    try {
      await authorityModule.withCanonicalTeamLock(authority, { deadlineMs: Date.now() + 500 }, async () => {
        authorityModule.revokeCanonicalTeamLockAuthority(authority)
      })
      console.log(JSON.stringify({ ok: true }))
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }))
    }
  } else if (operation === 'nested-helper') {
    let innerCalled = false
    try {
      await helpers.withTeamFileLockAtCanonicalRoot(spec.team, 'atlas', async () => {
        await helpers.withTeamFileLockAtCanonicalRoot(spec.team, 'atlas', async () => { innerCalled = true })
      })
      console.log(JSON.stringify({ ok: true, innerCalled }))
    } catch (error) {
      console.log(JSON.stringify({ ok: false, innerCalled, message: error.message }))
    }
  } else if (operation === 'standalone-write' || operation === 'readonly-standalone-write') {
    let readOnlyWriteCode
    if (operation === 'readonly-standalone-write') {
      try { accessSync(spec.namespace, constants.W_OK) }
      catch (error) { readOnlyWriteCode = error.code }
      if (readOnlyWriteCode !== 'EROFS') throw new Error('read-only fixture did not exercise EROFS')
    }
    const teamFile = { name: 'atlas', createdAt: 1, leadAgentId: 'team-lead@atlas', members: [] }
    await helpers.writeTeamFileAtCanonicalRoot(spec.team, 'atlas', teamFile)
    writeFileSync(spec.tasks + '/standalone-write', 'writable')
    const read = await helpers.readTeamFileAtCanonicalRoot(spec.team, 'atlas')
    console.log(JSON.stringify({ ok: read?.name === 'atlas', readOnlyWriteCode }))
  } else if (operation === 'detached-write' || operation === 'revoke-before-publish') {
    let reachedResolve, publishResolve
    const reached = new Promise(resolve => { reachedResolve = resolve })
    const publish = new Promise(resolve => { publishResolve = resolve })
    helpers.__setTeamFileLockExchangeTestHook(async event => {
      if (event.phase === 'before-config-publish') { reachedResolve(); await publish }
    })
    const teamFile = { name: 'atlas', createdAt: 1, leadAgentId: 'team-lead@atlas', members: [] }
    let writePromise
    let outerRejected = false
    try {
      await authorityModule.withCanonicalTeamLock(authority, { deadlineMs: Date.now() + 500 }, async () => {
        writePromise = helpers.writeTeamFileAtCanonicalRoot(spec.team, 'atlas', teamFile)
        await reached
        if (operation === 'revoke-before-publish') authorityModule.revokeCanonicalTeamLockAuthority(authority)
      })
    } catch { outerRejected = true }
    let writeRejected = false
    let contenderEntered = false
    const finishWrite = async () => { try { await writePromise } catch { writeRejected = true } }
    if (operation === 'detached-write') {
      await authorityModule.withCanonicalTeamLock(authority, { deadlineMs: Date.now() + 500 }, async () => {
        contenderEntered = true
        publishResolve()
        await finishWrite()
      })
    } else {
      publishResolve()
      await finishWrite()
    }
    console.log(JSON.stringify({
      ok: writeRejected && !existsSync(spec.team + '/config.json'), outerRejected, contenderEntered,
    }))
  } else if (operation === 'expired' || operation === 'eintr-deadline' || operation === 'late-success') {
    let called = false
    let attempts = 0
    const deadlineMs = operation === 'expired' ? Date.now() : Date.now() + 25
    authorityModule.__setCanonicalTeamLockFlockAttemptForTests(() => {
      attempts++
      if (operation === 'late-success') {
        while (Date.now() <= deadlineMs) {}
        return { result: 0, errno: 0 }
      }
      return { result: -1, errno: 4 }
    })
    try {
      await authorityModule.withCanonicalTeamLock(authority, { deadlineMs }, async () => { called = true })
      console.log(JSON.stringify({ ok: false, called, attempts }))
    } catch (error) {
      console.log(JSON.stringify({ ok: !called, called, attempts, message: error.message }))
    } finally {
      authorityModule.__setCanonicalTeamLockFlockAttemptForTests(null)
    }
  }
} catch (error) {
  if (operation === 'readonly-alias-mismatch') {
    console.log(JSON.stringify({
      ok: canonicalRenamePossible && !callbackCalled && /mount identity/.test(error.message),
      canonicalRenamePossible, callbackCalled, reviewTrace, message: error.message,
    }))
  } else if (operation === 'unqualified-terminal-erofs') {
    console.log(JSON.stringify({
      ok: !callbackCalled && /read-only mount is not qualified/.test(error.message),
      callbackCalled, message: error.message,
    }))
  } else {
    console.log(JSON.stringify({ ok: false, name: error.name, message: error.message }))
  }
} finally {
  for (const fd of Object.values(fds)) try { closeSync(fd) } catch {}
}
`

function fixtureEnvironment(value: Fixture): Record<string, string> {
  // Do not expose the test runner's credentials or user configuration to the
  // dropped-credential process. Bun gets one fixture-owned writable location
  // for home, temporary, and cache state.
  return {
    HOME: value.runtime,
    TMPDIR: value.runtime,
    XDG_CACHE_HOME: value.runtime,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    NO_COLOR: '1',
    NODE_ENV: 'test',
  }
}

function trackChild(
  value: Fixture,
  label: string,
  process: FixtureProcess,
): FixtureChild {
  // Begin draining both pipes at spawn time. Waiting for one pipe before the
  // other (or before exited) can hide an early loader error or deadlock on a
  // full pipe.
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    try { return await new Response(stream).text() } catch (error) {
      return `[pipe capture failed: ${String(error)}]`
    }
  }
  const stdout = capture(process.stdout)
  const stderr = capture(process.stderr)
  const completion = Promise.all([process.exited, stdout, stderr])
    .then(([exitCode, capturedStdout, capturedStderr]) => ({
      exitCode, stdout: capturedStdout, stderr: capturedStderr,
    }))
  const child = { process, completion, label }
  value.children.add(child)
  void completion.then(() => value.children.delete(child))
  return child
}

function spawnWorker(value: Fixture, operation: string): FixtureChild {
  const authorityUrl = pathToFileURL(join(import.meta.dir, 'canonicalTeamLockAuthority.ts')).href
  const helpersUrl = pathToFileURL(join(import.meta.dir, 'teamHelpers.ts')).href
  return trackChild(value, `worker:${operation}`, spawnPiped({
    cmd: [process.execPath, '--no-install', '--tsconfig-override',
      join(import.meta.dir, '../../../tsconfig.json'), value.worker, value.specification, authorityUrl, helpersUrl,
      operation, value.entered, value.release],
    uid: APP_UID,
    gid: APP_GID,
    cwd: join(import.meta.dir, '../../..'),
    env: fixtureEnvironment(value),
  }))
}

function spawnAppMutation(value: Fixture, label: string, source: string): FixtureChild {
  return trackChild(value, label, spawnPiped({
    cmd: [process.execPath, '-e', source], uid: APP_UID, gid: APP_GID,
    cwd: join(import.meta.dir, '../../..'), env: fixtureEnvironment(value),
  }))
}

function spawnReadonlyNamespaceWorker(value: Fixture): FixtureChild {
  const setup = join(value.base, 'readonly-namespace.ts')
  const teams = join(value.namespace, 'teams')
  const authorityUrl = pathToFileURL(join(import.meta.dir, 'canonicalTeamLockAuthority.ts')).href
  const helpersUrl = pathToFileURL(join(import.meta.dir, 'teamHelpers.ts')).href
  writeFileSync(setup, String.raw`
import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
const [namespace, teams, tasks, registry, specPath, worker, authorityUrl, helpersUrl, runtime] = process.argv.slice(2)
for (const args of [['--bind', namespace, namespace], ['--bind', teams, teams], ['--bind', tasks, tasks], ['--bind', registry, registry],
  ['-o', 'remount,bind,ro', namespace]]) {
  const mounted = Bun.spawnSync({ cmd: ['mount', ...args] })
  if (mounted.exitCode !== 0) process.exit(mounted.exitCode)
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const mountId = (path, directory = false) => {
  const fd = openSync(path, constants.O_RDONLY | 0o2000000 | (directory ? constants.O_DIRECTORY : 0))
  try { return Number(/^mnt_id:\s+(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))[1]) }
  finally { closeSync(fd) }
}
const root = lstatSync(spec.team), rootParent = lstatSync(spec.teams)
const anchor = lstatSync(spec.anchor), anchorParent = lstatSync(spec.anchorParent)
spec.binding.root = { dev: root.dev, ino: root.ino, mountId: mountId(spec.team, true) }
spec.binding.rootParent = { dev: rootParent.dev, ino: rootParent.ino, mountId: mountId(spec.teams, true) }
spec.binding.anchor = { dev: anchor.dev, ino: anchor.ino, mountId: mountId(spec.anchor) }
spec.binding.anchorParent = { dev: anchorParent.dev, ino: anchorParent.ino, mountId: mountId(spec.anchorParent, true) }
writeFileSync(spec.record, JSON.stringify(spec.binding))
writeFileSync(specPath, JSON.stringify(spec))
const child = Bun.spawnSync({
  cmd: ['setpriv', '--reuid=${APP_UID}', '--regid=${APP_GID}', '--clear-groups', '--no-new-privs',
    process.execPath, '--no-install', '--tsconfig-override', ${JSON.stringify(join(import.meta.dir, '../../../tsconfig.json'))},
    worker, specPath, authorityUrl, helpersUrl, 'readonly-standalone-write', spec.team + '/entered', spec.team + '/release'],
  cwd: ${JSON.stringify(join(import.meta.dir, '../../..'))},
  env: { HOME: runtime, TMPDIR: runtime, XDG_CACHE_HOME: runtime, PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'test', NO_COLOR: '1' },
})
process.stdout.write(child.stdout)
process.stderr.write(child.stderr)
process.exit(child.exitCode)
`)
  return trackChild(value, 'readonly-namespace', spawnPiped({
    cmd: ['unshare', '--mount', '--propagation', 'private', process.execPath, '--no-install',
      '--tsconfig-override', join(import.meta.dir, '../../../tsconfig.json'), setup,
      value.namespace, teams, value.tasks, value.registry, value.specification, value.worker, authorityUrl, helpersUrl, value.runtime],
    uid: 0, gid: 0, cwd: join(import.meta.dir, '../../..'), env: fixtureEnvironment(value),
  }))
}

function spawnReadonlyAliasMismatchWorker(value: Fixture): FixtureChild {
  const setup = join(value.base, 'readonly-alias-mismatch.ts')
  const teams = join(value.namespace, 'teams')
  const retainedTeams = join(value.namespace, 'retained')
  mkdirSync(retainedTeams, { mode: 0o755 })
  chmodSync(teams, 0o777)
  const authorityUrl = pathToFileURL(join(import.meta.dir, 'canonicalTeamLockAuthority.ts')).href
  const helpersUrl = pathToFileURL(join(import.meta.dir, 'teamHelpers.ts')).href
  writeFileSync(setup, String.raw`
import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
const [teams, retainedTeams, specPath, worker, authorityUrl, helpersUrl, runtime] = process.argv.slice(2)
for (const args of [['--bind', teams, retainedTeams], ['-o', 'remount,bind,ro', retainedTeams]]) {
  const mounted = Bun.spawnSync({ cmd: ['mount', ...args], stdout: 'pipe', stderr: 'pipe' })
  if (mounted.exitCode !== 0) {
    process.stderr.write(mounted.stderr)
    process.exit(mounted.exitCode)
  }
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
spec.retainedTeams = retainedTeams
spec.retainedTeam = retainedTeams + '/atlas'
const identity = (path, directory = false) => {
  const fd = openSync(path, constants.O_RDONLY | 0o2000000 | (directory ? constants.O_DIRECTORY : 0))
  try {
    const stats = lstatSync(path)
    return { dev: stats.dev, ino: stats.ino,
      mountId: Number(/^mnt_id:\s+(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))[1]) }
  } finally { closeSync(fd) }
}
spec.binding.root = identity(spec.retainedTeam, true)
spec.binding.rootParent = identity(spec.retainedTeams, true)
spec.binding.anchor = identity(spec.anchor)
spec.binding.anchorParent = identity(spec.anchorParent, true)
writeFileSync(spec.record, JSON.stringify(spec.binding))
writeFileSync(specPath, JSON.stringify(spec))
const child = Bun.spawnSync({
  cmd: ['setpriv', '--reuid=${APP_UID}', '--regid=${APP_GID}', '--clear-groups', '--no-new-privs',
    process.execPath, '--no-install', '--tsconfig-override', ${JSON.stringify(join(import.meta.dir, '../../../tsconfig.json'))},
    worker, specPath, authorityUrl, helpersUrl, 'readonly-alias-mismatch', spec.team + '/entered', spec.team + '/release'],
  cwd: ${JSON.stringify(join(import.meta.dir, '../../..'))},
  env: { HOME: runtime, TMPDIR: runtime, XDG_CACHE_HOME: runtime, PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'test', NO_COLOR: '1' },
})
process.stdout.write(child.stdout)
process.stderr.write(child.stderr)
process.exit(child.exitCode)
`)
  return trackChild(value, 'readonly-alias-mismatch', spawnPiped({
    cmd: ['unshare', '--mount', '--propagation', 'private', process.execPath, '--no-install',
      '--tsconfig-override', join(import.meta.dir, '../../../tsconfig.json'), setup,
      teams, retainedTeams, value.specification, value.worker, authorityUrl, helpersUrl, value.runtime],
    uid: 0, gid: 0, cwd: join(import.meta.dir, '../../..'), env: fixtureEnvironment(value),
  }))
}

function spawnUnqualifiedTerminalReadonlyWorker(value: Fixture): FixtureChild {
  const setup = join(value.base, 'unqualified-terminal-erofs.ts')
  const teams = join(value.namespace, 'teams')
  chmodSync(teams, 0o777)
  const authorityUrl = pathToFileURL(join(import.meta.dir, 'canonicalTeamLockAuthority.ts')).href
  const helpersUrl = pathToFileURL(join(import.meta.dir, 'teamHelpers.ts')).href
  writeFileSync(setup, String.raw`
import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
const [teams, specPath, worker, authorityUrl, helpersUrl, runtime] = process.argv.slice(2)
for (const args of [['--bind', teams, teams], ['-o', 'remount,bind,ro', teams]]) {
  const mounted = Bun.spawnSync({ cmd: ['mount', ...args], stdout: 'pipe', stderr: 'pipe' })
  if (mounted.exitCode !== 0) {
    process.stderr.write(mounted.stderr)
    process.exit(mounted.exitCode)
  }
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const identity = (path, directory = false) => {
  const fd = openSync(path, constants.O_RDONLY | 0o2000000 | (directory ? constants.O_DIRECTORY : 0))
  try {
    const stats = lstatSync(path)
    return { dev: stats.dev, ino: stats.ino,
      mountId: Number(/^mnt_id:\s+(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))[1]) }
  } finally { closeSync(fd) }
}
spec.binding.root = identity(spec.team, true)
spec.binding.rootParent = identity(spec.teams, true)
spec.binding.anchor = identity(spec.anchor)
spec.binding.anchorParent = identity(spec.anchorParent, true)
writeFileSync(spec.record, JSON.stringify(spec.binding))
writeFileSync(specPath, JSON.stringify(spec))
const child = Bun.spawnSync({
  cmd: ['setpriv', '--reuid=${APP_UID}', '--regid=${APP_GID}', '--clear-groups',
    process.execPath, '--no-install', '--tsconfig-override', ${JSON.stringify(join(import.meta.dir, '../../../tsconfig.json'))},
    worker, specPath, authorityUrl, helpersUrl, 'unqualified-terminal-erofs', spec.team + '/entered', spec.team + '/release'],
  cwd: ${JSON.stringify(join(import.meta.dir, '../../..'))},
  env: { HOME: runtime, TMPDIR: runtime, XDG_CACHE_HOME: runtime, PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'test', NO_COLOR: '1' },
})
process.stdout.write(child.stdout)
process.stderr.write(child.stderr)
process.exit(child.exitCode)
`)
  return trackChild(value, 'unqualified-terminal-erofs', spawnPiped({
    cmd: ['unshare', '--mount', '--propagation', 'private', process.execPath, '--no-install',
      '--tsconfig-override', join(import.meta.dir, '../../../tsconfig.json'), setup,
      teams, value.specification, value.worker, authorityUrl, helpersUrl, value.runtime],
    uid: 0, gid: 0, cwd: join(import.meta.dir, '../../..'), env: fixtureEnvironment(value),
  }))
}

function diagnostics(child: FixtureChild, outcome: {
  exitCode: number; stdout: string; stderr: string
}): string {
  return `${child.label} exited ${outcome.exitCode}; stdout=${JSON.stringify(outcome.stdout)}; stderr=${JSON.stringify(outcome.stderr)}`
}

async function within<T>(promise: Promise<T>, deadlineMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), deadlineMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function terminateAndJoin(child: FixtureChild): Promise<{
  exitCode: number; stdout: string; stderr: string
}> {
  if (child.process.exitCode === null) child.process.kill('SIGKILL')
  return within(child.completion, CHILD_DEADLINE_MS, `${child.label} did not exit after SIGKILL`)
}

async function completed(child: FixtureChild): Promise<Awaited<typeof child.completion>> {
  try {
    return await within(child.completion, CHILD_DEADLINE_MS, `${child.label} exceeded its deadline`)
  } catch (error) {
    const terminated = await terminateAndJoin(child)
    throw new Error(`${String(error)}; ${diagnostics(child, terminated)}`, { cause: error })
  }
}

async function result(child: FixtureChild) {
  const outcome = await completed(child)
  if (outcome.exitCode !== 0) throw new Error(`worker failed: ${diagnostics(child, outcome)}`)
  if (!outcome.stdout.trim()) throw new Error(`worker emitted no result: ${diagnostics(child, outcome)}`)
  try {
    return JSON.parse(outcome.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
  } catch (error) {
    throw new Error(`worker emitted an invalid result: ${diagnostics(child, outcome)}`, { cause: error })
  }
}

async function waitFor(path: string, child: FixtureChild): Promise<void> {
  const deadline = Date.now() + CHILD_DEADLINE_MS
  while (!existsSync(path)) {
    const outcome = await Promise.race([
      child.completion.then(value => ({ kind: 'exit' as const, value })),
      Bun.sleep(5).then(() => ({ kind: 'poll' as const })),
    ])
    if (outcome.kind === 'exit') {
      throw new Error(`worker exited before creating ${path}: ${diagnostics(child, outcome.value)}`)
    }
    if (Date.now() >= deadline) {
      const terminated = await terminateAndJoin(child)
      throw new Error(`timed out waiting for ${path}: ${diagnostics(child, terminated)}`)
    }
  }
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    const children = [...value.children]
    await Promise.all(children.map(child => terminateAndJoin(child)))
    // Every child is joined before removal; base is the exact mkdtemp-owned
    // fixture subtree, including any paths renamed by the replacement test.
    rmSync(value.base, { recursive: true, force: true })
  }
})

describe('host-issued canonical team lock authority (Linux root-gated OS fixture)', () => {
  test('gate is explicit outside Linux/root', () => {
    if (!osGate) expect(true).toBe(true)
  })

  gatedTest('actual helper uses a cross-process flock; busy/cancel and fresh acquisitions are bounded', async () => {
    const value = fixture()
    const legacy = join(value.team, '.config.lock')
    mkdirSync(legacy)
    writeFileSync(join(value.team, 'foreign-target'), 'foreign metadata')
    symlinkSync('../foreign-target', join(legacy, 'metadata.json'))
    const fifo = join(legacy, 'foreign.fifo')
    const mkfifo = Bun.spawnSync({ cmd: ['mkfifo', fifo] })
    expect(mkfifo.exitCode).toBe(0)
    const holder = spawnWorker(value, 'hold-helper')
    await waitFor(value.entered, holder)
    const busy = await result(spawnWorker(value, 'attempt-short'))
    const cancelled = await result(spawnWorker(value, 'cancel'))
    expect(busy).toMatchObject({ ok: false, called: false })
    expect(cancelled).toMatchObject({ ok: false, name: 'AbortError' })
    expect(readFileSync(join(legacy, 'metadata.json'), 'utf8')).toBe('foreign metadata')
    expect(lstatSync(join(legacy, 'metadata.json')).isSymbolicLink()).toBe(true)
    expect(lstatSync(fifo).isFIFO()).toBe(true)
    writeFileSync(value.release, 'release')
    expect(await result(holder)).toMatchObject({ ok: true })
    expect(await result(spawnWorker(value, 'repeat'))).toMatchObject({ ok: true, count: 2 })
  })

  gatedTest('dead holder releases through descriptor close and no metadata reclaim', async () => {
    const value = fixture()
    const holder = spawnWorker(value, 'hold-helper')
    await waitFor(value.entered, holder)
    holder.process.kill('SIGKILL')
    await completed(holder)
    expect(await result(spawnWorker(value, 'repeat'))).toMatchObject({ ok: true, count: 2 })
  })

  gatedTest('kernel denies app-uid root/anchor mutation and revocation rejects completion', async () => {
    const value = fixture()
    const mutation = trackChild(value, 'kernel-mutation', spawnPiped({
      cmd: [process.execPath, '-e', `
        import {chmodSync, linkSync, renameSync, truncateSync, unlinkSync} from 'node:fs'
        const attempts = [
          () => renameSync(${JSON.stringify(value.team)}, ${JSON.stringify(`${value.team}.moved`)}),
          () => unlinkSync(${JSON.stringify(value.anchor)}),
          () => chmodSync(${JSON.stringify(value.anchor)}, 0o600),
          () => truncateSync(${JSON.stringify(value.anchor)}, 1),
          () => linkSync(${JSON.stringify(value.anchor)}, ${JSON.stringify(join(value.team, 'anchor-alias'))}),
        ]
        let denied = 0
        for (const attempt of attempts) try { attempt() } catch { denied++ }
        process.exit(denied === attempts.length ? 0 : 1)
      `],
      uid: APP_UID, gid: APP_GID, cwd: join(import.meta.dir, '../../..'), env: fixtureEnvironment(value),
    }))
    const mutationOutcome = await completed(mutation)
    expect(mutationOutcome.exitCode).toBe(0)
    expect(existsSync(value.team)).toBe(true)
    expect(await result(spawnWorker(value, 'nested-helper')))
      .toMatchObject({ ok: false, innerCalled: false })
    expect(await result(spawnWorker(value, 'revoke'))).toMatchObject({ ok: false })
  })

  gatedTest('rejects owner-chmod, sticky-owner, registry-ancestor, and ACL namespace authority', async () => {
    const ownerChmod = fixture()
    chownSync(ownerChmod.namespace, APP_UID, APP_GID)
    chmodSync(ownerChmod.namespace, 0o555)
    const ownerTeams = join(ownerChmod.namespace, 'teams')
    expect((await completed(spawnAppMutation(ownerChmod, 'owner-chmod', `
      import { chmodSync, renameSync } from 'node:fs'
      chmodSync(${JSON.stringify(ownerChmod.namespace)}, 0o755)
      renameSync(${JSON.stringify(ownerTeams)}, ${JSON.stringify(`${ownerTeams}.moved`)})
    `))).exitCode).toBe(0)
    renameSync(`${ownerTeams}.moved`, ownerTeams)
    chmodSync(ownerChmod.namespace, 0o555)
    expect(await result(spawnWorker(ownerChmod, 'repeat'))).toMatchObject({ ok: false })

    const stickyOwner = fixture()
    chownSync(stickyOwner.namespace, APP_UID, APP_GID)
    chmodSync(stickyOwner.namespace, 0o1777)
    const stickyTeams = join(stickyOwner.namespace, 'teams')
    expect((await completed(spawnAppMutation(stickyOwner, 'sticky-owner', `
      import { renameSync } from 'node:fs'
      renameSync(${JSON.stringify(stickyTeams)}, ${JSON.stringify(`${stickyTeams}.moved`)})
    `))).exitCode).toBe(0)
    renameSync(`${stickyTeams}.moved`, stickyTeams)
    expect(await result(spawnWorker(stickyOwner, 'repeat'))).toMatchObject({ ok: false })

    const effectiveGroup = fixture()
    chownSync(effectiveGroup.namespace, 0, APP_GID)
    chmodSync(effectiveGroup.namespace, 0o775)
    const groupTeams = join(effectiveGroup.namespace, 'teams')
    expect((await completed(spawnAppMutation(effectiveGroup, 'effective-gid', `
      import { renameSync } from 'node:fs'
      renameSync(${JSON.stringify(groupTeams)}, ${JSON.stringify(`${groupTeams}.moved`)})
    `))).exitCode).toBe(0)
    renameSync(`${groupTeams}.moved`, groupTeams)
    expect(await result(spawnWorker(effectiveGroup, 'repeat'))).toMatchObject({ ok: false })

    const registryOwner = fixture()
    chownSync(registryOwner.registry, APP_UID, APP_GID)
    chmodSync(registryOwner.registry, 0o555)
    const registration = join(registryOwner.registry, 'registration-a')
    expect((await completed(spawnAppMutation(registryOwner, 'registry-owner', `
      import { chmodSync, renameSync } from 'node:fs'
      chmodSync(${JSON.stringify(registryOwner.registry)}, 0o755)
      renameSync(${JSON.stringify(registration)}, ${JSON.stringify(`${registration}.moved`)})
    `))).exitCode).toBe(0)
    renameSync(`${registration}.moved`, registration)
    chmodSync(registryOwner.registry, 0o555)
    expect(await result(spawnWorker(registryOwner, 'repeat'))).toMatchObject({ ok: false })

    const aclProbe = Bun.spawnSync({ cmd: ['setfacl', '--version'], stdout: 'ignore', stderr: 'ignore' })
    if (aclProbe.exitCode === 0) {
      const acl = fixture()
      const applied = Bun.spawnSync({
        cmd: ['setfacl', '-m', `u:${APP_UID}:rwx`, acl.namespace],
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(applied.exitCode).toBe(0)
      const aclTeams = join(acl.namespace, 'teams')
      expect((await completed(spawnAppMutation(acl, 'writable-acl', `
        import { renameSync } from 'node:fs'
        renameSync(${JSON.stringify(aclTeams)}, ${JSON.stringify(`${aclTeams}.moved`)})
      `))).exitCode).toBe(0)
      renameSync(`${aclTeams}.moved`, aclTeams)
      expect(await result(spawnWorker(acl, 'repeat'))).toMatchObject({ ok: false })
    }
  })

  gatedTest('admits an app-owned ancestor only through a qualified read-only mount edge', async () => {
    const prerequisites = ['unshare', 'mount', 'setpriv'].every(command =>
      Bun.spawnSync({ cmd: ['sh', '-c', `command -v "$1"`, 'probe', command] }).exitCode === 0)
    if (!prerequisites) return
    const value = fixture()
    chownSync(value.namespace, APP_UID, APP_GID)
    chmodSync(value.namespace, 0o755)
    expect(await result(spawnReadonlyNamespaceWorker(value)))
      .toMatchObject({ ok: true, readOnlyWriteCode: 'EROFS' })
  })

  gatedTest('rejects retained read-only alias mismatch and unqualified terminal EROFS before callback', async () => {
    const prerequisites = ['unshare', 'mount', 'setpriv'].every(command =>
      Bun.spawnSync({ cmd: ['sh', '-c', `command -v "$1"`, 'probe', command] }).exitCode === 0)
    if (!prerequisites) return

    const mismatch = await result(spawnReadonlyAliasMismatchWorker(fixture()))
    expect(mismatch).toMatchObject({
      ok: true, canonicalRenamePossible: true, callbackCalled: false,
      reviewTrace: {
        effectiveUid: APP_UID, effectiveGid: APP_GID,
        capEffective: '0000000000000000', capPermitted: '0000000000000000',
        capAmbient: '0000000000000000',
      },
    })
    expect(String(mismatch.message)).toContain('mount identity')
    const trace = mismatch.reviewTrace as Record<string, unknown>
    expect(trace.recordedParentMountId).toBe(trace.retainedParentMountId)
    expect(trace.canonicalParentMountId).not.toBe(trace.retainedParentMountId)

    const unqualified = await result(spawnUnqualifiedTerminalReadonlyWorker(fixture()))
    expect(unqualified).toMatchObject({ ok: true, callbackCalled: false })
    expect(String(unqualified.message)).toContain('read-only mount is not qualified')
  })

  gatedTest('standalone writes succeed while detached and revoked writes cannot publish', async () => {
    expect(await result(spawnWorker(fixture(), 'standalone-write'))).toMatchObject({ ok: true })
    expect(await result(spawnWorker(fixture(), 'detached-write')))
      .toMatchObject({ ok: true, outerRejected: false, contenderEntered: true })
    expect(await result(spawnWorker(fixture(), 'revoke-before-publish')))
      .toMatchObject({ ok: true, outerRejected: true })
  })

  gatedTest('EINTR yielding and a late apparent acquisition honor the exact deadline', async () => {
    const expired = await result(spawnWorker(fixture(), 'expired'))
    expect(expired).toMatchObject({ ok: true, called: false, attempts: 0 })
    const interrupted = await result(spawnWorker(fixture(), 'eintr-deadline'))
    expect(interrupted).toMatchObject({ ok: true, called: false })
    expect(Number(interrupted.attempts)).toBeGreaterThan(8)
    const late = await result(spawnWorker(fixture(), 'late-success'))
    expect(late).toMatchObject({ ok: true, called: false, attempts: 1 })
  })

  gatedTest('privileged root replacement fails callback completion but release remains descriptor-only', async () => {
    const value = fixture()
    const holder = spawnWorker(value, 'hold-helper')
    await waitFor(value.entered, holder)
    renameSync(value.team, `${value.team}.original`)
    mkdirSync(value.team, { mode: 0o700 })
    chownSync(value.team, APP_UID, APP_GID)
    writeFileSync(join(value.team, 'release'), 'release')
    const completion = await result(holder)
    expect(completion).toMatchObject({ ok: false })
    expect(existsSync(join(value.team, '.config.lock'))).toBe(false)
    expect(await result(spawnWorker(value, 'attempt-short'))).toMatchObject({ ok: false })
  })
})
