import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { OpenCodeClientFactory } from '../OpenCodeClientFactory.js'
import { launchNativeCustody, recoverNativeCustody, nativeCustodyForEndpoint, bindNativeRequestOwner, type NativeCustody } from './OpenCodeNativeCustody.js'
import { OpenCodeHostManager } from '../OpenCodeHostManager.js'
import type { OpenCodePreparedProfile } from '../types.js'
import { fetchNativeOpenCode } from './OpenCodeNativeRequestLease.js'
import { nativeAuthorityPath, readNativeAuthority } from './OpenCodeNativeAuthority.js'

// Required in the physical Linux qualification lane. Mac/Windows cannot count
// this as their custody proof; their retained native backends remain separate.
describe.skipIf(process.platform !== 'linux')('physical Linux native custody', () => {
  let root: string, profile: string, helper: string, original: string, replacement: string, helperSha: string
  let preserve = false
  const vendors = new Map<string, string>()
  const active = new Set<NativeCustody>()
  const epochs = new Set<NativeCustody>()
  const execute = promisify(execFile)
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-native-custody-')))
    await chmod(root, 0o700)
    profile = path.join(root, 'profile'); await mkdir(profile, { mode: 0o700 })
    helper = path.join(root, 'source-custodian'); original = path.join(root, 'installer-A'); replacement = path.join(root, 'installer-B')
    const source = path.resolve(import.meta.dir, '../../../..', 'native/opencode-custody')
    const options = { timeout: 60000 }
    const failurePaths = path.join(root, 'TEST-failurepaths')
    await execute('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
      path.join(source, 'failurepaths.test.c'), '-o', failurePaths], options)
    const checked = await execute(failurePaths, [], { timeout: 5000, cwd: root, env: {} })
    expect(checked.stdout.trim()).toBe('TEST native helper finite failure paths passed')
    const staged = process.env.OPENCODE_NATIVE_CUSTODY_TEST_HELPER
    if (staged) {
      expect(path.isAbsolute(staged) && await realpath(staged) === staged).toBe(true)
      const metadata = await lstat(staged)
      expect(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o555).toBe(true)
      const manifest = JSON.parse(await readFile(`${staged}.json`, 'utf8')) as Record<string, unknown>
      const bytes = await readFile(staged)
      expect(manifest).toMatchObject({ schemaVersion: 1, platform: 'linux', arch: process.arch, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceSha256: createHash('sha256').update(await readFile(path.join(source, 'linux.c'))).digest('hex') })
      await copyFile(staged, helper)
    } else {
      await execute('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', path.join(source, 'linux.c'), '-o', helper], options)
    }
    for (const [marker, output] of [['A', original], ['B', replacement]]) {
      await execute('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', `-DFIXTURE_MARKER="${marker}"`, path.join(source, 'fixture.c'), '-o', output], options)
    }
    helperSha = createHash('sha256').update(await readFile(helper)).digest('hex')
    console.log(`TEST native custody helper sha256=${helperSha}`)
    const vendorManifest = process.env.OPENCODE_NATIVE_CUSTODY_TEST_VENDORS
    if (vendorManifest) {
      expect(path.isAbsolute(vendorManifest) && await realpath(vendorManifest) === vendorManifest).toBe(true)
      const metadata = await lstat(vendorManifest)
      expect(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid!() &&
        (metadata.mode & 0o777) === 0o600 && metadata.size <= 16384).toBe(true)
      const manifest = JSON.parse(await readFile(vendorManifest, 'utf8')) as {
        schemaVersion: unknown; vendors: Array<{ version: string; binaryPath: string; sha256: string }>
      }
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.vendors.map(row => row.version).sort()).toEqual(['1.16.0', '1.18.34'])
      for (const row of manifest.vendors) {
        expect(path.isAbsolute(row.binaryPath) && await realpath(row.binaryPath) === row.binaryPath &&
          /^[a-f0-9]{64}$/.test(row.sha256)).toBe(true)
        const file = await lstat(row.binaryPath)
        expect(file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid!() &&
          (file.mode & 0o111) !== 0 && !(file.mode & 0o022)).toBe(true)
        expect(createHash('sha256').update(await readFile(row.binaryPath)).digest('hex')).toBe(row.sha256)
        vendors.set(row.version, row.binaryPath)
      }
    }
    await writeFile(`${helper}.json`, JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: process.arch,
      size: (await readFile(helper)).length, sha256: helperSha }), { mode: 0o600 })
  }, 60000)
  afterAll(async () => {
    for (const custody of active) {
      try { await custody.stopExact(); active.delete(custody) }
      catch { preserve = true }
    }
    if (!preserve && root) {
      for (const custody of epochs) {
        const file = path.join(path.dirname(path.dirname(custody.reference.images.root)), 'current-custody.json')
        const authority = await readNativeAuthority(file)
        if (authority.phase !== 'dead' || authority.images.epoch !== custody.reference.epoch) {
          preserve = true; break
        }
        await chmod(custody.reference.images.root, 0o700)
      }
      if (!preserve) await rm(root, { recursive: true, force: true })
    }
    if (preserve) throw new Error(`Native fixture closure is uncertain; owned TEST files preserved at ${root}`)
  }, 30000)
  async function unusedPort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return address.port
  }
  async function start(hostKey: string, binary = original, deferred = false, extraArgs: string[] = []): Promise<NativeCustody> {
    const port = await unusedPort()
    try {
      const custody = await launchNativeCustody({ helper: { path: helper, sha256: helperSha },
        selectedBinary: binary, profileRoot: profile, hostKey, scope: { fixture: hostKey }, cwd: root,
        baseUrl: `http://127.0.0.1:${port}`, args: ['serve', '--hostname', '127.0.0.1', '--port', String(port), ...(deferred ? ['--deferred-accept'] : []), ...extraArgs],
        env: { PATH: '/usr/bin:/bin' }, persistent: true, minimumVersion: '1.16.0' })
      active.add(custody); epochs.add(custody)
      const client = new OpenCodeClientFactory().create(custody.reference.baseUrl, undefined, bindNativeRequestOwner({}, custody))
      for (let attempt = 0; ; attempt++) {
        try { await client.getConfig(); return custody }
        catch (error) { if (attempt === 49) throw error; await Bun.sleep(20) }
      }
    } catch (error) { preserve = true; throw error }
  }
  test('the ordinary production factory refuses an unbound foreign listener before HTTP bytes', async () => {
    let bytes = 0
    const sockets = new Set<Socket>()
    const foreign = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket))
      socket.on('data', chunk => { bytes += chunk.length; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}') })
    })
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve))
    const address = foreign.address(); if (!address || typeof address === 'string') throw new Error('fixture_address')
    try {
      await expect(new OpenCodeClientFactory().create(`http://127.0.0.1:${address.port}`).getConfig()).rejects.toThrow('native_custody')
      expect(bytes).toBe(0)
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => foreign.close(() => resolve())) }
  })
  test('ordinary HostManager spawn, fresh-controller retained acquisition, Factory read and Stop use real custody', async () => {
    const keys = ['CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', 'OPENCODE_BIN_PATH', 'CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER']
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const data = path.join(root, 'ordinary-managed-data'), project = path.join(root, 'TEST-project')
    const profileRoot = path.join(data, 'opencode', 'profiles', '0123456789abcdef')
    await mkdir(project, { mode: 0o700 })
    await mkdir(profileRoot, { mode: 0o700, recursive: true })
    const prepared: OpenCodePreparedProfile = {
      projectPath: project, canonicalProjectPath: project, workingDirectoryPath: project, scopeToken: null,
      profileRootKey: '0123456789abcdef', profileRootPath: profileRoot,
      projectBehaviorFingerprint: 'neutral-native-fixture', behaviorSources: [], managedConfig: {},
      managedConfigFingerprint: 'neutral-native-config', homePath: path.join(profileRoot, 'home'),
      tmpPath: path.join(profileRoot, 'tmp'), xdgConfigHome: path.join(profileRoot, 'config'),
      xdgDataHome: path.join(profileRoot, 'data'), xdgCacheHome: path.join(profileRoot, 'cache'),
      managedAuthPath: path.join(profileRoot, 'auth.json'), sourceAuthPath: null,
      sourceAuthFingerprint: null, managedAuthFingerprint: null, authState: 'missing',
      env: { HOME: path.join(profileRoot, 'home'), PATH: '/usr/bin:/bin' },
    }
    for (const folder of [prepared.homePath, prepared.tmpPath, prepared.xdgConfigHome, prepared.xdgDataHome, prepared.xdgCacheHome])
      await mkdir(folder, { mode: 0o700 })
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = data
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = original
    process.env.CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER = helper
    delete process.env.OPENCODE_BIN_PATH
    const manager = new OpenCodeHostManager()
    const recovered = new OpenCodeHostManager()
    try {
      const host = await manager.ensureHost({ hostKey: 'ordinary-native-fixture', preparedProfile: prepared,
        resolveConfigFingerprint: false, prewarmManagedSubscriptionPlugins: false })
      const custody = nativeCustodyForEndpoint(host.baseUrl); active.add(custody); epochs.add(custody)
      const authorization = custody.reference.authorization
      const encoded = authorization.slice('Basic '.length)
      const password = Buffer.from(encoded, 'base64').toString('utf8').slice('opencode:'.length)
      const containsPrivateCredential = (value: string) => [authorization, encoded, password].some(secret => value.includes(secret))
      expect(containsPrivateCredential(JSON.stringify(host))).toBe(false)
      expect(containsPrivateCredential(JSON.stringify(host.profile))).toBe(false)
      expect(containsPrivateCredential(JSON.stringify(host.diagnostics))).toBe(false)
      const commandLines = await Promise.all([host.pid, custody.reference.custodianPid].map(pid => readFile(`/proc/${pid}/cmdline`, 'utf8')))
      expect(commandLines.some(containsPrivateCredential)).toBe(false)
      let failure = ''
      try { await recovered.ensureHost({ hostKey: host.hostKey, preparedProfile: { ...prepared, projectBehaviorFingerprint: 'different-scope' }, existingOnly: true }) }
      catch (error) { failure = String(error) + JSON.stringify(error) + (error instanceof Error ? error.stack : '') }
      expect(failure.length > 0 && !containsPrivateCredential(failure)).toBe(true)
      let bodyFailure = ''
      try { await new OpenCodeClientFactory().create(host.baseUrl, undefined, host).getSession('broken-body') }
      catch (error) { bodyFailure = String(error) + JSON.stringify(error) + (error instanceof Error ? error.stack : '') }
      expect(bodyFailure.length > 0 && !containsPrivateCredential(bodyFailure)).toBe(true)
      expect(host.pid).toBe(custody.reference.nativePid)
      expect(host.pid).not.toBe(custody.reference.custodianPid)
      const retained = await recovered.ensureHost({ hostKey: host.hostKey, preparedProfile: prepared, existingOnly: true })
      expect(retained.pid).toBe(host.pid)
      expect(await new OpenCodeClientFactory().create(retained.baseUrl, undefined, retained).getConfig()).toMatchObject({ marker: 'A' })
      expect(await manager.disposeHost(host.hostKey)).toBe(true)
      active.delete(custody)
      expect((await readNativeAuthority(nativeAuthorityPath(profileRoot, host.hostKey))).phase).toBe('dead')
      await manager.drainPendingLifecycleCleanups()
    } catch (error) { preserve = true; throw error }
    finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  }, 30000)
  for (const version of ['1.16.0', '1.18.34']) {
    test.skipIf(!process.env.OPENCODE_NATIVE_CUSTODY_TEST_VENDORS)(`real pinned V1 ${version} protects config ingress through the ordinary production host and client`, async () => {
      const binary = vendors.get(version)
      if (!binary) throw new Error('Required verified vendor fixture missing')
      const keys = ['CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', 'OPENCODE_BIN_PATH', 'CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER']
      const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
      const data = path.join(root, `vendor-${version}-data`), project = path.join(root, `TEST-vendor-${version}-project`)
      const profileRoot = path.join(data, 'opencode', 'profiles', '0123456789abcdef')
      await mkdir(project, { mode: 0o700 })
      await mkdir(profileRoot, { mode: 0o700, recursive: true })
      const sentinel = `Bearer TEST-vendor-${version}-MCP-private`
      const config = { mcp: { fixture: { type: 'remote', url: 'http://127.0.0.1:1/mcp', enabled: false,
        headers: { Authorization: sentinel } } } }
      const prepared: OpenCodePreparedProfile = {
        projectPath: project, canonicalProjectPath: project, workingDirectoryPath: project, scopeToken: null,
        profileRootKey: '0123456789abcdef', profileRootPath: profileRoot,
        projectBehaviorFingerprint: 'neutral-pinned-vendor', behaviorSources: [], managedConfig: config,
        managedConfigFingerprint: `neutral-pinned-${version}`, homePath: path.join(profileRoot, 'home'),
        tmpPath: path.join(profileRoot, 'tmp'), xdgConfigHome: path.join(profileRoot, 'config'),
        xdgDataHome: path.join(profileRoot, 'data'), xdgCacheHome: path.join(profileRoot, 'cache'),
        managedAuthPath: path.join(profileRoot, 'auth.json'), sourceAuthPath: null,
        sourceAuthFingerprint: null, managedAuthFingerprint: null, authState: 'missing',
        env: { HOME: path.join(profileRoot, 'home'), PATH: '/usr/bin:/bin',
          XDG_CONFIG_HOME: path.join(profileRoot, 'config'), XDG_DATA_HOME: path.join(profileRoot, 'data'),
          XDG_CACHE_HOME: path.join(profileRoot, 'cache'), XDG_STATE_HOME: path.join(profileRoot, 'state'),
          TMPDIR: path.join(profileRoot, 'tmp'), NO_COLOR: '1', NODE_ENV: 'production',
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      }
      for (const folder of [prepared.homePath, prepared.tmpPath, prepared.xdgConfigHome, prepared.xdgDataHome,
        prepared.xdgCacheHome, path.join(profileRoot, 'state')]) await mkdir(folder, { mode: 0o700 })
      process.env.CLAUDE_MULTIMODEL_DATA_HOME = data
      process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = binary
      process.env.CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER = helper
      delete process.env.OPENCODE_BIN_PATH
      const manager = new OpenCodeHostManager()
      try {
        const host = await manager.ensureHost({ hostKey: `TEST-pinned-native-${version}`, preparedProfile: prepared,
          resolveConfigFingerprint: false, prewarmManagedSubscriptionPlugins: false })
        const custody = nativeCustodyForEndpoint(host.baseUrl); active.add(custody); epochs.add(custody)
        expect(host.version).toBe(version)
        expect(custody.reference.measuredVersion).toBe(version)
        const authorization = custody.reference.authorization, encoded = authorization.slice('Basic '.length)
        const password = Buffer.from(encoded, 'base64').toString('utf8').slice('opencode:'.length)
        const containsPrivateCredential = (value: string) => [password, encoded, authorization].some(secret => value.includes(secret))
        expect(containsPrivateCredential(JSON.stringify(host))).toBe(false)
        expect(containsPrivateCredential(JSON.stringify(prepared))).toBe(false)
        expect(containsPrivateCredential(JSON.stringify(host.diagnostics))).toBe(false)
        const argv = await Promise.all([host.pid, custody.reference.custodianPid].map(pid => readFile(`/proc/${pid}/cmdline`, 'utf8')))
        expect(argv.some(containsPrivateCredential)).toBe(false)
        for (const headers of [new Headers(), new Headers({ authorization: 'Basic TEST-wrong-key' })]) {
          const response = await globalThis.fetch(`${host.baseUrl}/config`, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) })
          expect(response.status).toBe(401)
          expect((await response.text()).includes(sentinel)).toBe(false)
        }
        const admitted = await new OpenCodeClientFactory().create(host.baseUrl, undefined, host).getConfig()
        expect(admitted).toMatchObject({ mcp: { fixture: { headers: { Authorization: sentinel } } } })
        expect(containsPrivateCredential(JSON.stringify(admitted))).toBe(false)
        expect(await manager.disposeHost(host.hostKey)).toBe(true)
        active.delete(custody)
        expect((await readNativeAuthority(nativeAuthorityPath(profileRoot, host.hostKey))).phase).toBe('dead')
        await manager.drainPendingLifecycleCleanups()
      } catch (error) { preserve = true; throw error }
      finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
    }, 60000)
  }
  test('retains the actual image across same-path replacement/unlink, recovers and stops only that child', async () => {
    const source = path.join(root, 'same-path-opencode')
    await copyFile(original, source)
    const custody = await start('same-path', source), sentinel = await start('unrelated-sentinel')
    const client = new OpenCodeClientFactory().create(custody.reference.baseUrl, undefined, bindNativeRequestOwner({}, custody))
    expect(await client.getConfig()).toMatchObject({ marker: 'A' })
    const staging = `${source}.replacement`; await copyFile(replacement, staging); await rename(staging, source); await unlink(source)
    const recovered = await recoverNativeCustody(profile, 'same-path', custody.reference.baseUrl)
    expect(recovered.reference.nativePid).toBe(custody.reference.nativePid)
    expect(recovered.reference.nativeBirth).toBe(custody.reference.nativeBirth)
    expect(await new OpenCodeClientFactory().create(recovered.reference.baseUrl, undefined, bindNativeRequestOwner({}, recovered)).getConfig()).toMatchObject({ marker: 'A' })
    await recovered.stopExact(); active.delete(custody)
    expect((await readNativeAuthority(nativeAuthorityPath(profile, 'same-path'))).phase).toBe('dead')
    expect(await new OpenCodeClientFactory().create(sentinel.reference.baseUrl, undefined, bindNativeRequestOwner({}, sentinel)).getConfig()).toMatchObject({ marker: 'A' })
  }, 20000)
  test('native config ingress denies unauthenticated access while the production request path remains authorized', async () => {
    const custody = await start('native-ingress-privacy')
    const response = await globalThis.fetch(`${custody.reference.baseUrl}/config`, { redirect: 'error' })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('')
    const wrong = await globalThis.fetch(`${custody.reference.baseUrl}/config`, { redirect: 'error', headers: { authorization: 'Basic TEST-wrong-key' } })
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toBe('')
    expect(await new OpenCodeClientFactory().create(custody.reference.baseUrl, undefined, bindNativeRequestOwner({}, custody)).getConfig()).toMatchObject({
      marker: 'A', mcp: { fixture: { headers: { Authorization: 'Bearer TEST-private-MCP-sentinel' } } },
    })
  }, 20000)
  test('admits genuine deferred accept only after proving the exact native listener socket option', async () => {
    const custody = await start('native-deferred-accept', original, true)
    expect(await new OpenCodeClientFactory().create(custody.reference.baseUrl, undefined, bindNativeRequestOwner({}, custody)).getConfig()).toMatchObject({ marker: 'A' })
  }, 20000)
  test('a replacement listener receives zero HTTP bytes despite the same URL and a live old child', async () => {
    const custody = await start('foreign-port-takeover')
    await (await fetchNativeOpenCode(`${custody.reference.baseUrl}/close-listener`, { method: 'POST' }, bindNativeRequestOwner({}, custody))).text()
    await Bun.sleep(30)
    let bytes = 0
    const sockets = new Set<Socket>()
    const foreign = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket))
      socket.on('data', chunk => { bytes += chunk.length; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}') })
    })
    await new Promise<void>(resolve => foreign.listen(Number(new URL(custody.reference.baseUrl).port), '127.0.0.1', resolve))
    try {
      let failure = ''
      try { await new OpenCodeClientFactory().create(custody.reference.baseUrl, undefined, bindNativeRequestOwner({}, custody)).getConfig() }
      catch (error) { failure = String(error) + JSON.stringify(error) + (error instanceof Error ? error.stack : '') }
      const encoded = custody.reference.authorization.slice('Basic '.length)
      const password = Buffer.from(encoded, 'base64').toString('utf8').slice('opencode:'.length)
      expect(failure.includes('native_custody')).toBe(true)
      expect([password, encoded, custody.reference.authorization].some(secret => failure.includes(secret))).toBe(false)
      expect(bytes).toBe(0)
      await custody.stopExact(); active.delete(custody)
      expect(foreign.listening).toBe(true)
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => foreign.close(() => resolve())) }
  }, 20000)
  test('an exit after custody acquisition retires by captured exit receipt without a fresh PID action', async () => {
    const custody = await start('exit-before-action'), sentinel = await start('action-sentinel')
    await custody.verify()
    await (await fetchNativeOpenCode(`${custody.reference.baseUrl}/global/dispose`, { method: 'POST' }, bindNativeRequestOwner({}, custody))).text()
    await Bun.sleep(30)
    await custody.stopExact(); active.delete(custody)
    expect((await readNativeAuthority(nativeAuthorityPath(profile, 'exit-before-action'))).phase).toBe('dead')
    expect(await new OpenCodeClientFactory().create(sentinel.reference.baseUrl, undefined, bindNativeRequestOwner({}, sentinel)).getConfig()).toMatchObject({ marker: 'A' })
  }, 20000)
  test('held pidfd Stop drains a real descendant that escaped the process group and preserves an unrelated sentinel', async () => {
    const descendantPort = await unusedPort()
    const custody = await start('escaped-session-descendant', original, false, ['--descendant-port', String(descendantPort)])
    const sentinel = await start('descendant-sentinel')
    const listening = () => new Promise<boolean>(resolve => {
      const socket = connect({ host: '127.0.0.1', port: descendantPort })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    let observed = false
    for (let attempt = 0; attempt < 50; attempt++) { if (await listening()) { observed = true; break }; await Bun.sleep(20) }
    expect(observed).toBe(true)
    await custody.stopExact(); active.delete(custody)
    expect(await listening()).toBe(false)
    expect(await new OpenCodeClientFactory().create(sentinel.reference.baseUrl, undefined, bindNativeRequestOwner({}, sentinel)).getConfig()).toMatchObject({ marker: 'A' })
  }, 20000)
})
