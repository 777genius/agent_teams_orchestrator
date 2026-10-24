import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isOpenCodeV2Pin, openCodeV2GraphPackages } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'

type Exit = { exitCode: number; signal?: string | number }
type Terminal = {
  pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: Exit) => void): { dispose(): void }
  kill(): void
}

export function assertNoPtyHooks(environment: NodeJS.ProcessEnv, arguments_: readonly string[]): void {
  const forbidden = new Set(['BUN_PTY_LIB', 'BUN_OPTIONS', 'BUN_PRELOAD', 'BUN_INSPECT', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'])
  assert(!Object.keys(environment).some(key => forbidden.has(key.toUpperCase())), 'PTY loader override or hook is present')
  assert(arguments_.every(argument => argument === '--no-env-file'), 'Unexpected Bun startup arguments')
}

/** A cleanup-generated exit is never accepted as natural process completion. */
export async function observePty(terminal: Terminal, marker: string,
  gone: (pid: number) => Promise<boolean>, timeoutMs = 10_000) {
  assert(Number.isSafeInteger(terminal.pid) && terminal.pid > 0, 'Invalid owned PTY PID')
  let output = '', overflow = false, timedOut = false, cleanupRequested = false
  let cleanupError = false, exit: Exit | null = null, finish!: () => void
  const completion = new Promise<void>(resolve => { finish = resolve })
  const cleanup = () => {
    cleanupRequested = true
    try { terminal.kill() } catch { cleanupError = true }
    finish()
  }
  const data = terminal.onData(value => {
    output = (output + value).slice(0, 4096)
    if (value.length > 4096 || output.length === 4096) { overflow = true; cleanup() }
  })
  const ended = terminal.onExit(event => { exit = event; finish() })
  const deadline = setTimeout(() => { timedOut = true; cleanup() }, timeoutMs)
  try { await completion } finally { clearTimeout(deadline); data.dispose(); ended.dispose() }
  const naturalExit = exit as Exit | null
  const exitObservedBeforeCleanup = !cleanupRequested && naturalExit !== null
  let pidGone = false, cleanupPidGone = false, pidQueryError = false
  try { pidGone = await gone(terminal.pid) } catch { pidQueryError = true }
  const naturalPidGone = exitObservedBeforeCleanup && pidGone
  if (!pidGone && !cleanupRequested) cleanup()
  try { cleanupPidGone = pidGone || await gone(terminal.pid) } catch { pidQueryError = true }
  const naturalProof = !timedOut && !overflow && !cleanupRequested && naturalExit?.exitCode === 0 &&
    naturalExit.signal === undefined && output.includes(marker) && naturalPidGone
  let postNaturalReleaseRequested = false, postNaturalReleaseError = false
  if (naturalProof) {
    // Upstream only closes the retained ConPTY handle through kill(). Listeners
    // are disposed and the captured command PID is already gone; its synthetic
    // exit must never replace the independently completed natural proof.
    postNaturalReleaseRequested = true
    try { terminal.kill() } catch { postNaturalReleaseError = true }
  } else if (!cleanupRequested) cleanup()
  return {
    ok: naturalProof && !postNaturalReleaseError,
    pid: terminal.pid, marker, output, exit: naturalExit, timedOut, overflow,
    cleanupRequested, cleanupError, pidQueryError, exitObservedBeforeCleanup, naturalPidGone, cleanupPidGone,
    postNaturalReleaseRequested, postNaturalReleaseError,
  }
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function physical(file: string, owned: string): Promise<string> {
  const resolved = await realpath(file)
  const relative = path.relative(owned, resolved)
  assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Physical PTY path escapes delivery')
  const info = await lstat(resolved)
  assert(info.isFile() && !info.isSymbolicLink(), 'Physical delivery file required')
  return resolved
}
async function packageInfo(entry: string, name: string, version: string, owned: string) {
  let directory = path.dirname(await physical(entry, owned))
  for (;;) {
    try {
      const info = JSON.parse(await readFile(await physical(path.join(directory, 'package.json'), owned), 'utf8'))
      if (info.name !== undefined || info.version !== undefined) {
        assert.equal(info.name, name); assert.equal(info.version, version)
        return directory
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = path.dirname(directory)
    assert(parent !== directory && directory !== owned, 'Physical package metadata missing')
    directory = parent
  }
}
async function waitGone(pid: number): Promise<boolean> {
  const deadline = performance.now() + 3000
  do {
    try { process.kill(pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
    await Bun.sleep(25)
  } while (performance.now() < deadline)
  return false
}

export async function main(deliveryArgument: string, receipt: string, expectedPlatform: string): Promise<void> {
  const evidence: Record<string, unknown> = { schemaVersion: 1, ok: false,
    sourceHead: process.env.PR_HEAD_SHA ?? process.env.GITHUB_SHA ?? null,
    checkoutSha: process.env.GITHUB_SHA ?? null, platform: process.platform, arch: process.arch,
    bunVersion: Bun.version, cases: [] }
  let fixture: string | undefined
  try {
    assertNoPtyHooks(process.env, process.execArgv)
    assert.equal(process.platform, 'win32'); assert(['x64', 'arm64'].includes(process.arch))
    assert.equal(`${process.platform}-${process.arch}`, expectedPlatform)
    assert.equal(Bun.version, '1.4.3')
    const delivery = await realpath(deliveryArgument)
    const bundle = await realpath(path.join(delivery, 'local-cli'))
    assert.equal(path.relative(delivery, bundle), 'local-cli', 'Physical local-cli must stay inside delivery')
    const bun = await physical(path.join(delivery, 'bun/bun.exe'), delivery)
    assert.equal(await realpath(process.execPath), bun, 'Smoke must execute the shipped physical Bun')
    const entry = await physical(path.join(bundle, 'cli.js'), bundle)
    const identity = JSON.parse(await readFile(await physical(path.join(delivery, 'opencode-delivery.json'), delivery), 'utf8'))
    assert.equal(identity.schema, 1); assert.equal(identity.platform, process.platform)
    assert.equal(identity.arch, process.arch); assert.equal(identity.bunVersion, Bun.version)
    assert.equal(sha(await readFile(bun)), identity.bunSha256)
    assert.equal(sha(await readFile(entry)), identity.entrySha256)
    evidence.delivery = { identity, bun: path.relative(delivery, bun), entry: path.relative(delivery, entry) }
    fixture = await mkdtemp(path.join(tmpdir(), 'TEST-packaged-pty-'))
    const home = path.join(fixture, 'home'), project = path.join(fixture, 'project'), temp = path.join(fixture, 'tmp')
    for (const directory of [home, project, temp, path.join(home, 'appdata'), path.join(home, 'localappdata')]) await mkdir(directory)
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    assert(systemRoot, 'Windows system root missing')
    const command = await realpath(path.join(systemRoot, 'System32/cmd.exe'))
    const environment = { SystemRoot: systemRoot, ComSpec: command, PATH: path.dirname(command),
      HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'),
      LOCALAPPDATA: path.join(home, 'localappdata'), TEMP: temp, TMP: temp }
    // Exercise every graph the bundle staged, as recorded by its own staging manifest.
    const staged = JSON.parse(await readFile(path.join(bundle, 'opencode-v2-graphs.json'), 'utf8')) as { pins: string[]; pty: string }
    assert(Array.isArray(staged.pins) && staged.pins.length > 0 && typeof staged.pty === 'string', 'Staged graph manifest invalid')
    for (const pin of staged.pins) {
      assert(isOpenCodeV2Pin(pin), 'Staged graph manifest invalid')
      const server = await physical(Bun.resolveSync(`${openCodeV2GraphPackages(pin).server}/process`, bundle), bundle)
      await packageInfo(server, '@opencode/server', pin, bundle)
      const core = await physical(Bun.resolveSync('@opencode/core/bus', path.dirname(server)), bundle)
      const coreRoot = await packageInfo(core, '@opencode/core', pin, bundle)
      const adapter = await physical(Bun.resolveSync('#pty', path.dirname(core)), bundle)
      assert.equal(await packageInfo(adapter, '@opencode/core', pin, bundle), coreRoot)
      const pty = await physical(Bun.resolveSync('bun-pty', path.dirname(adapter)), bundle)
      const ptyRoot = await packageInfo(pty, 'bun-pty', staged.pty, bundle)
      const dll = await physical(path.join(ptyRoot, 'rust-pty/target/release', process.arch === 'arm64' ? 'rust_pty_arm64.dll' : 'rust_pty.dll'), bundle)
      const bytes = await readFile(dll), pe = bytes.readUInt32LE(0x3c)
      assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert(pe <= bytes.length - 6)
      assert.equal(bytes.readUInt32LE(pe), 0x4550)
      assert.equal(bytes.readUInt16LE(pe + 4), process.arch === 'arm64' ? 0xaa64 : 0x8664)
      const digest = sha(bytes)
      assert.equal(digest, process.arch === 'arm64' ? '80c44d8cb5123b95494fdb785fe7e2716a5c1f9a57c5d890e469ffc046bddb98' : '0cd0a5124fa6a924329cec8ca74067b268e5f773a0107cc2a792a070f9f3cfe2')
      const api = await import(pathToFileURL(adapter).href) as { spawn(file: string, args: string[], options: object): Terminal }
      const marker = `TEST_PACKAGED_PTY_${pin.replaceAll('.', '_')}_${randomBytes(8).toString('hex')}`
      const result = await observePty(api.spawn(command, ['/d', '/s', '/c', `echo ${marker}`],
        { cwd: project, env: environment, cols: 80, rows: 24 }), marker, waitGone)
      ;(evidence.cases as unknown[]).push({ pin, server: path.relative(bundle, server),
        core: path.relative(bundle, core), adapter: path.relative(bundle, adapter), pty: path.relative(bundle, pty),
        dll: path.relative(bundle, dll), dllSha256: digest, dllMachine: process.arch === 'arm64' ? '0xaa64' : '0x8664', ...result })
      assert(result.ok, `Natural staged PTY proof failed for core ${pin}`)
    }
    evidence.ok = true
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 512) : 'Unknown PTY smoke failure'
    process.exitCode = 1
  } finally {
    if (fixture) {
      try { await rm(fixture, { recursive: true, force: true }); evidence.fixtureRemoved = true }
      catch { evidence.fixtureRemoved = false; evidence.ok = false; process.exitCode = 1 }
    }
    await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify({ ok: evidence.ok, receipt }))
  }
}

if (import.meta.main) {
  const [delivery, receipt, platform] = process.argv.slice(2)
  assert(delivery && receipt && platform, 'Expected delivery, receipt and platform arguments')
  await main(delivery, receipt, platform)
}
