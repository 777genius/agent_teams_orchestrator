import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DARWIN_SCOPE_POLICY } from './OpenCodeV2DarwinPolicy.js'

const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
function assert(value: unknown): asserts value { if (!value) throw new Error('execution_containment_qualification_pending') }
function run(command: string, args: string[]) {
  const r = spawnSync(command, args, { env: {}, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 })
  if (r.error || r.signal) throw r.error ?? new Error('qualification_probe_timeout')
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
function json(command: string, args: string[]) { const r = run(command, args); assert(r.status === 0); return JSON.parse(r.stdout) }
function identityKey(v: ReturnType<typeof json>) {
  return JSON.stringify([v.hostPID, v.nativePID, v.executablePath, v.birth?.format, v.birth?.value,
    v.birth?.bootId, v.coalition?.resource, v.coalition?.jetsam])
}
// A default-deny fixture keeps conditional process-fork meaningful. Broader file
// grants affect these disposable probes only; no project or auth state is used.
const base = '(version 1)\n(deny default)\n(allow file* sysctl-read process-exec process-info* signal mach* appleevent-send network*)\n'
export async function qualifyDarwin(nativeRoot: string, output?: string) {
  assert(process.platform === 'darwin')
  assert(path.isAbsolute(nativeRoot) && await realpath(nativeRoot) === nativeRoot)
  const helper = path.join(nativeRoot, 'OpenCodeV2Scope.app/Contents/MacOS/opencode-v2-darwin-scope')
  const helperStat = await lstat(helper)
  assert(helperStat.isFile() && (helperStat.mode & 0o6022) === 0 && await realpath(helper) === helper)
  const helperSha256 = digest(await readFile(helper))
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, 'darwin-helper.json'), 'utf8'))
  assert(manifest.format === 1 && manifest.sha256 === helperSha256)
  const probe = path.join(nativeRoot, 'opencode-v2-darwin-qualification-probe'), probeStat = await lstat(probe)
  const probeSha256 = digest(await readFile(probe))
  assert(probeStat.isFile() && (probeStat.mode & 0o6022) === 0 && await realpath(probe) === probe &&
    typeof manifest.probeSha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.probeSha256) && manifest.probeSha256 === probeSha256)
  const platform = json(helper, ['--platform'])
  assert(typeof platform.osBuild === 'string' && /^[0-9A-Z]+$/.test(platform.osBuild) &&
    typeof platform.kernelRelease === 'string' && /^\d+\.\d+\.\d+$/.test(platform.kernelRelease))
  const policySha256 = digest(DARWIN_SCOPE_POLICY), profile = base + DARWIN_SCOPE_POLICY
  const sandbox = (p: string, executable: string, args: string[]) => run('/usr/bin/sandbox-exec', ['-p', p, executable, ...args])
  const normalSpawn = sandbox(profile, '/bin/bash', ['-c', '/usr/bin/true && printf "ordinaryChildExited=0\\n"'])
  assert(normalSpawn.status === 0 && normalSpawn.stdout === 'ordinaryChildExited=0\n')
  const ssh = ['-T', '-F', '/dev/null', '-o', 'ProxyCommand=/usr/bin/true', '-o', 'BatchMode=yes',
    '-o', 'IdentityFile=/dev/null', '-o', 'IdentityAgent=none', 'TEST.invalid']
  const signed = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', '/usr/bin/ssh'])
  assert(signed.status === 0 && (signed.stdout + signed.stderr).includes('<key>keychain-access-groups</key>'))
  const dynamicRows = ['keychain-access-groups', 'org.opencode.TEST.absent'].map(key => {
    // SSH needs directory-service lookup before reaching fork. Isolate the
    // canonical fork predicate; delegation rules are measured independently.
    const p = base + DARWIN_SCOPE_POLICY.split('\n')[0]!.replace('com.apple.private.coalition-spawn', key)
    return { key, profileSha256: digest(p), ...sandbox(p, '/bin/bash', ['-c',
      '/usr/bin/true && printf "ordinaryChildExited=0\\n" && exec /usr/bin/ssh "$@"', 'TEST', ...ssh]) }
  })
  assert(dynamicRows.every(r => r.status === 255 && r.stdout === 'ordinaryChildExited=0\n') &&
    dynamicRows[0]!.stderr.includes('fork failed: Operation not permitted') &&
    dynamicRows[1]!.stderr.includes('Connection closed by UNKNOWN port 65535'))
  let receipt: Record<string, unknown> | undefined
  const machControl = json(probe, ['--mach'])
  const machResult = sandbox(profile, probe, ['--mach'])
  assert(machResult.status === 0)
  const machDenied = JSON.parse(machResult.stdout)
  assert(machControl.code === 0 && machDenied.code === 1100)
  const target = spawn(probe, ['--target'], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise<void>(resolve => target.once('close', () => resolve()))
  let ended = false; target.once('close', () => { ended = true })
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('qualification_target_timeout')), 5000)
      target.once('error', error => { clearTimeout(timer); reject(error) })
      target.stdout.once('data', chunk => { clearTimeout(timer); resolve(chunk.toString().trim()) })
    })
    assert(target.pid && ready === String(target.pid) && !ended)
    const before = json(helper, ['--identity', ready])
    assert(before.hostPID === target.pid && typeof before.executablePath === 'string' &&
      await realpath(before.executablePath) === probe && before.birth?.format === 'darwin-pidversion')
    const first = json(probe, ['--appleevent', ready])
    const deniedResult = sandbox(profile, probe, ['--appleevent', ready]); assert(deniedResult.status === 0)
    const denied = JSON.parse(deniedResult.stdout), second = json(probe, ['--appleevent', ready])
    const after = json(helper, ['--identity', ready])
    assert(!ended && identityKey(before) === identityKey(after) && first.code === 0 && second.code === 0 &&
      first.sandboxDenied === 0 && second.sandboxDenied === 0 && denied.sandboxDenied === 1 && denied.code === -600)
    receipt = { format: 1, helperSha256, probeSha256, osBuild: platform.osBuild, kernelRelease: platform.kernelRelease,
      policySha256, fixtureProfileSha256: digest(profile), probes: {
        normalSpawn: { passed: true, ...normalSpawn },
        dynamicCallerEntitlementFork: { passed: true, signedExecutable: '/usr/bin/ssh',
          executableSha256: digest(await readFile('/usr/bin/ssh')), rows: dynamicRows },
        externalDelegation: { passed: true, machLookup: { control: machControl, denied: machDenied },
          appleEvent: { target: before, controlBefore: first, denied, controlAfter: second,
            note: '-600 is an obscured denial only with live identical target, two successful controls, and explicit sandbox decision' } },
      } }
  } finally {
    if (!ended) target.kill('SIGTERM')
    const timer = setTimeout(() => { if (!ended) target.kill('SIGKILL') }, 2000)
    try { await exited } finally { clearTimeout(timer) }
  }
  const afterPlatform = json(helper, ['--platform'])
  assert(receipt && ended && digest(await readFile(helper)) === helperSha256 && digest(await readFile(probe)) === probeSha256 &&
    afterPlatform.osBuild === platform.osBuild && afterPlatform.kernelRelease === platform.kernelRelease)
  receipt.targetCleanup = { exitCode: target.exitCode, signalCode: target.signalCode }
  if (output) await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  return receipt
}
