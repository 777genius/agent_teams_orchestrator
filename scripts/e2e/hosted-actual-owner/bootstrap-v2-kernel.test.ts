import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processV2, type OwnerV2LaunchSelection } from '../../../src/services/hostedControl/HostedControlBootstrapV2Launch.js'
import { canonicalV2, hashV2, OWNER_V2_ROLES } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'
import { createHostedApprovalActivationV2Proof } from '../../../src/services/hostedControl/HostedApprovalRuntimeActivation.js'
import { HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 } from '../../../src/services/hostedControl/HostedApprovalOwnerProvenance.js'
import { activationGolden, assembleFixtureV2, fixtureHeaderV2 } from '../../../src/services/hostedControl/fixtures/bootstrapV2Producer.js'
import { OwnedKernelChild, KernelChannel as Channel } from './kernel-fixture-ownership.js'

let directory: string, image: string, imageSha: string, peer: ChildProcessWithoutNullStreams
const owned = new Set<OwnedKernelChild>()
let failed = false
const own = (child: ChildProcessWithoutNullStreams, group = false) => {
  const owner = new OwnedKernelChild(child, group); owned.add(owner); return owner
}
const childModule = fileURLToPath(new URL('./fixtures/bootstrap-v2-child.ts', import.meta.url))
const python = fileURLToPath(new URL('./fixtures/bootstrap-v2-kernel.py', import.meta.url))
beforeAll(() => {
  if (process.platform !== 'linux') return
  try {
  directory = mkdtempSync(join(tmpdir(), 'owner-v2-kernel-')); image = join(directory, 'bun')
  copyFileSync(process.execPath, image); chmodSync(image, 0o500); imageSha = hashV2(readFileSync(image))
  // Process identity fixture only: no HTTP server or simulated provider.
  peer = own(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' })).child
  } catch (error) { failed = true; throw error }
})
afterAll(async () => {
  const stopped = await Promise.allSettled([...owned].map(child => child.stop(0)))
  failed ||= stopped.some(result => result.status === 'rejected')
  try {
    if (directory && !failed) {
      // This is a newly created task-only sandbox. PATH resolves the mandatory
      // host Git/Docker/liveness guard; a refusal retains the entire directory.
      if (!existsSync('/usr/local/bin/rm')) throw new Error('Mandatory cleanup guard is unavailable')
      const cleanup = new OwnedKernelChild(spawn('rm', ['-r', '--', directory], {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: 'pipe',
      }))
      try {
        if (!await cleanup.wait(5000) || cleanup.child.exitCode !== 0) throw new Error('Guarded cleanup failed: ' + cleanup.stderr)
      } finally { await cleanup.stop(0) }
    }
    const error = stopped.find(result => result.status === 'rejected')
    if (error?.status === 'rejected') throw error.reason
  } catch (error) { failed = true; throw error }
  finally { if (failed && directory) console.error('Retained kernel diagnostics: ' + directory) }
}, 10000)
const linuxTest = (name: string, run: () => Promise<void>, timeout = 20000) =>
  test.skipIf(process.platform !== 'linux')(name, async () => {
    try { await run() } catch (error) { failed = true; throw error }
  }, timeout)
async function saveAndStop(owner: OwnedKernelChild, root: string): Promise<void> {
  try { await owner.stop() } finally {
    writeFileSync(join(root, 'helper-stderr.log'), owner.stderr)
  }
}
async function fixture(scenario = 'valid', mutate?: (header: any, selection: any) => void) {
  const root = mkdtempSync(join(directory, 'case-')), selected = join(root, 'selection.json'), result = join(root, 'result.json')
  const helper = own(spawn('/usr/bin/python3', [python, image, childModule, selected, result, scenario], {
    stdio: 'pipe', detached: true, env: { PATH: '/usr/bin:/bin' },
  }), true)
  try {
  const channel = new Channel(helper), first = await channel.next()
  expect(first.type).toBe('held'); const held = first.held
  const h = fixtureHeaderV2(), self = processV2(process.pid), host = processV2(peer.pid!)
  const hostExe = statSync(`/proc/${host.pid}/exe`, { bigint: true }), ownerExe = statSync(image, { bigint: true })
  const selfExe = statSync('/proc/self/exe', { bigint: true })
  h.socketPath = join(root, 'owner.sock')
  h.expectedHost.process = { pid: host.pid, startTicks: host.startTicks, startIdentity: `start_${hashV2(`${host.pid}\0proc:${host.startTicks}`)}`,
    supervisorProcessStartToken: 'b'.repeat(64), pidNamespaceInode: host.pidNamespaceInode, networkNamespaceInode: host.networkNamespaceInode }
  h.expectedHost.executable = { device: String(hostExe.dev), inode: String(hostExe.ino), size: String(hostExe.size),
    sha256: imageSha, artifactManifestSha256: 'a'.repeat(64), moduleSha256: imageSha }
  const globalAdmission = JSON.parse(activationGolden.admissionDocument)
  for (const route of globalAdmission.routes) route.openCodeBinding.openCodeArtifactDigest = `sha256:${imageSha}`
  const admissionDocument = `${JSON.stringify(globalAdmission)}\n`
  writeFileSync(join(root, 'admission.json'), admissionDocument, { mode: 0o600 })
  const digest = `sha256:${hashV2(admissionDocument)}`
  h.approvalActivationV2.admissionDocumentDigest = digest; h.expectedHost.activation.admissionDocumentDigest = digest
  const roles = Object.keys(OWNER_V2_ROLES)
  h.descriptorMap = { schemaVersion: 2, contract: 'agent-teams.hosted-owner-child-fd-map/v2', wrapperPid: held.parentPid,
    wrapperStartTicks: held.parentStartTicks, wrapperStartToken: hashV2(canonicalV2({ contract: 'agent-teams.hosted-owner-wrapper-process-start/v1', pid: held.parentPid, startTime: held.parentStartTicks })),
    spawnNonce: held.spawnNonce, descriptors: held.descriptors.map((d: any, i: number) => {
      const { childFd, kind, device, inode, uid, gid, mode, accessMode, append } = d
      return { role: roles[i], childFd, kind, device, inode, uid, gid, mode, accessMode, append }
    }) }
  Object.assign(h.leaseEvidence, Object.fromEntries(['device', 'inode', 'uid', 'gid', 'mode'].map(k => [k, held.descriptors[0][k]])))
  const moduleSha = hashV2(readFileSync(childModule))
  const capsule = canonicalV2({ activation: { controllerNonce: h.expectedHost.activation.controllerNonce, runId: h.expectedHost.activation.runId,
    stackManifestSha256: h.expectedHost.activation.stackManifestSha256 }, contract: 'claude-team/hosted-producer-provenance',
    version: 2, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256, producerRole: 'owner', expectedProducer: {
      artifactManifestSha256: 'a'.repeat(64), executableSha256: imageSha, implementationId: 'agent-teams.orchestrator.hosted-approval-owner.v1', moduleSha256: moduleSha },
    streams: { ownerWalTimeline: { fd: 9, device: held.descriptors[6].device, inode: held.descriptors[6].inode } } })
  Object.assign(h.supervisorBinding, { supervisorPid: self.pid, supervisorStartTicks: self.startTicks, supervisorExecutableSha256: imageSha,
    ownerEntrySha256: moduleSha, ownerPid: held.ownerPid, ownerStartTicks: held.ownerStartTicks, ownerProducerCapsuleSha256: hashV2(capsule) })
  const selection: any = { rawRetention: structuredClone(h.rawRetention), expectedHost: structuredClone(h.expectedHost), supervisorProcessStartToken: h.supervisorBinding.supervisorStartToken,
    ownerProcessStartToken: h.supervisorBinding.ownerProcessStartToken, recipeSha256: h.supervisorBinding.recipeSha256,
    harnessContractSha256: h.supervisorBinding.harnessContractSha256, ownerModule: { path: childModule, sha256: moduleSha }, ownerArtifactManifestSha256: 'a'.repeat(64),
    ownerExecutable: { device: String(ownerExe.dev), inode: String(ownerExe.ino), size: Number(ownerExe.size), sha256: imageSha },
    supervisorExecutable: { device: String(selfExe.dev), inode: String(selfExe.ino), sha256: imageSha },
    refs: { openCode: '1'.repeat(40), orchestrator: '2'.repeat(40), product: '3'.repeat(40) },
    serializedProductBootstrap: '{"product":"bootstrap"}', producerCapsule: capsule, runtimeManifestSha256: '4'.repeat(64), harnessContractPath: '/unused-unit-contract', held }
  if (scenario === 'large') {
    h.expectedHost.profile.sourceAuthSources = Array.from({ length: 32 }, (_, i) => ({ path: '/sandbox/' + String(i) + 'x'.repeat(700), fingerprint: null }))
    selection.expectedHost = structuredClone(h.expectedHost)
  }
  mutate?.(h, selection)
  const frames = assembleFixtureV2(h)
  selection.bootstrapV2HeaderSha256 = hashV2(canonicalV2(frames.header))
  channel.send({ lease: frames.lease.toString('base64'), bootstrap: frames.bootstrapFrame.toString('base64'), auth: frames.authFrame.toString('base64') })
  const exec = await channel.next(); expect(exec.type).toBe('executed')
  selection.executed = { ...exec.executed, executableSha256: imageSha }
  writeFileSync(selected, JSON.stringify(selection), { mode: 0o600 }); channel.send({ release: true })
  const until = performance.now() + 10000
  while (!existsSync(result) && performance.now() < until && helper.alive) await new Promise(r => setTimeout(r, 5))
  if (!existsSync(result)) throw new Error('kernel fixture has no result: ' + helper.stderr)
  const report = JSON.parse(readFileSync(result, 'utf8'))
  return { root, result, report, header: h, channel, globalAdmission, selection: selection as OwnerV2LaunchSelection,
    async waitForActivationClose() {
      let timer: ReturnType<typeof setTimeout> | undefined
      const observed = async () => {
        for (;;) {
          const event = await channel.next()
          if (event.type === 'activation_closed') return
          if (event.type !== 'delivered') throw new Error('Unexpected bytes before activation close')
        }
      }
      try { await Promise.race([observed(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('inherited activation was not revoked')), 8000)
      })]) } finally { clearTimeout(timer) }
    },
    async close() { await saveAndStop(helper, root) } }
  } catch (error) {
    try { await saveAndStop(helper, root) } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Kernel fixture setup and cleanup failed; retained at ' + root)
    }
    throw error
  }
}
function proof(value: any, direction: 'owner-ready-request' | 'admission') {
  const controllerProof = createHostedApprovalActivationV2Proof(Buffer.alloc(32, 42), direction, JSON.stringify(value))
  return { ...value, controllerProof }
}
function activationFrames(f: Awaited<ReturnType<typeof fixture>>, change?: (binding: any) => void) {
  const h = f.header, b = structuredClone(activationGolden.binding)
  b.ownerBinding = f.report.ownerBinding; b.socketPath = h.socketPath
  b.admissionDocumentDigest = h.approvalActivationV2.admissionDocumentDigest
  // The publication candidate is available only after the actual socket exists.
  b.signedManifest.manifestDigest = `sha256:${hashV2(JSON.stringify({ format: b.signedManifest.format, ownerBinding: b.ownerBinding }))}`
  change?.(b)
  const prepare = proof({ schemaVersion: 2, operation: 'approval_activation_prepare', capability: 'agent-teams-hosted-approval-activation-v2', challenge: '3'.repeat(64), binding: b }, 'owner-ready-request')
  const envelope = proof({ schemaVersion: 2, purpose: 'agent-teams.hosted-approval-activation/v2', binding: b, admission: f.globalAdmission }, 'admission')
  const { publicKeyDigest, contractDigest, testOnlyPrivateKeyPkcs8Pem } = activationGolden.signing
  const statement = { schemaVersion: 2, algorithm: 'Ed25519', publicKeyDigest, contractDigest, envelope }
  const signature = sign(null, Buffer.from(JSON.stringify(statement)), createPrivateKey(testOnlyPrivateKeyPkcs8Pem)).toString('base64url')
  return { prepare: JSON.stringify(prepare) + '\n', publication: JSON.stringify({ schemaVersion: 2, envelope,
    authorship: { algorithm: 'Ed25519', publicKeyDigest, contractDigest, signature } }) + '\n' }
}
async function activationLine(channel: Channel): Promise<any> {
  let bytes = ''
  for (;;) {
    const event = await channel.next()
    if (event.type === 'delivered') continue
    if (event.type !== 'activation') throw new Error('Activation closed before its expected frame')
    bytes += Buffer.from(event.bytes, 'base64').toString('utf8')
    if (Buffer.byteLength(bytes) > 65536) throw new Error('Activation response overflow')
    if (bytes.endsWith('\n')) return JSON.parse(bytes)
  }
}
describe('actual inherited Linux bootstrap-v2 descriptors', () => {
  linuxTest('early setup failure reaps the immediately registered held child and helper', async () => {
    let childPid = 0
    const before = new Set(owned)
    await expect(fixture('valid', h => {
      childPid = h.supervisorBinding.ownerPid; throw new Error('injected setup failure')
    })).rejects.toThrow('injected setup failure')
    expect(childPid).toBeGreaterThan(0); expect(existsSync(`/proc/${childPid}`)).toBe(false)
    expect([...owned].filter(child => !before.has(child)).every(child => !child.alive)).toBe(true)
  })
  linuxTest('observation rejects terminal helpers and already signalled peer teardown is bounded', async () => {
    const owner = own(spawn('/usr/bin/python3', ['-c', 'import os,signal; os.kill(os.getpid(),signal.SIGTERM)'], { stdio: 'pipe' }))
    const channel = new Channel(owner)
    try {
      await expect(channel.next()).rejects.toThrow()
      expect(await owner.wait(1000)).toBe(true)
      expect(owner.child.signalCode).toBe('SIGTERM'); expect(owner.child.exitCode).toBeNull()
      await owner.stop(); await owner.stop()
    } finally { await owner.stop(0) }
  })
  linuxTest('partial simultaneous streams reach EOF, close one-use/anchor, retain role FD9', async () => {
    const f = await fixture('large')
    try {
      expect(f.report.ok).toBe(true); expect(f.report.oneUseClosed).toEqual([true, true, true])
      expect(f.report.roles).toEqual(Object.entries(OWNER_V2_ROLES))
      expect(statSync(f.result + '.wal').size).toBe(0)
    } finally { await f.close() }
  }, 20000)
  for (const scenario of ['missing-seals', 'writable-lease', 'alias', 'missing-eof']) {
    linuxTest(scenario + ' fails without WAL or raw effects', async () => {
      const f = await fixture(scenario)
      try { expect(f.report.ok).toBe(false); expect(statSync(f.result + '.raw').size).toBe(0); expect(statSync(f.result + '.wal').size).toBe(0) }
      finally { await f.close() }
    }, 20000)
  }
  for (const [name, mutate] of [
    ['owner start', (h: any) => { h.supervisorBinding.ownerStartTicks = '1' }],
    ['namespace', (h: any) => { h.expectedHost.process.networkNamespaceInode = '1' }],
    ['selected executable', (_: any, s: any) => { s.ownerExecutable.sha256 = '0'.repeat(64) }],
    ['selected recipe', (_: any, s: any) => { s.recipeSha256 = '0'.repeat(64) }],
    ['wrapper token', (h: any) => { h.descriptorMap.wrapperStartToken = '0'.repeat(64) }],
    ['role', (h: any) => { h.descriptorMap.descriptors[1].role = 'private-server-auth' }],
  ] as const) linuxTest(name + ' rejects self-consistently re-MACed input', async () => {
    const f = await fixture('valid', mutate)
    try { expect(f.report.ok).toBe(false); expect(statSync(f.result + '.wal').size).toBe(0) } finally { await f.close() }
  }, 20000)
  linuxTest('same inherited FD5 publishes real-socket-bound owner_ready then verified ready exactly once', async () => {
    const f = await fixture('activation')
    try {
      expect(f.report.ok).toBe(true); expect(f.report.repeatedRejected).toBe(true)
      expect(f.report.repeatedAttachmentRejected).toBe(true)
      const frames = activationFrames(f)
      f.channel.send({ activation: Buffer.from(frames.prepare).toString('base64') })
      expect((await activationLine(f.channel)).kind).toBe('owner_ready')
      expect(existsSync(f.result + '.adopted')).toBe(false)
      f.channel.send({ activation: Buffer.from(frames.publication).toString('base64') })
      expect((await activationLine(f.channel)).kind).toBe('ready')
      expect(readFileSync(f.result + '.adopted', 'utf8')).toBe('verified-before-adoption')
      f.channel.send({ activation: Buffer.from(frames.prepare).toString('base64') })
      await f.waitForActivationClose()
      expect(readFileSync(f.result + '.adopted', 'utf8')).toBe('verified-before-adoption')
    } finally { await f.close() }
  }, 20000)
  for (const failure of ['socket', 'release', 'signature']) linuxTest('deferred ' + failure + ' fails before adoption', async () => {
    const f = await fixture('activation')
    try {
      expect(f.report.ok).toBe(true)
      const frames = activationFrames(f, b => {
        if (failure === 'socket') b.ownerBinding.socketIdentity.inode = '1'
        if (failure === 'release') b.signedManifest.releasePinDigest = `sha256:${'0'.repeat(64)}`
      })
      f.channel.send({ activation: Buffer.from(frames.prepare).toString('base64') })
      if (failure === 'signature') {
        expect((await activationLine(f.channel)).kind).toBe('owner_ready')
        const pub = JSON.parse(frames.publication); pub.authorship.signature = 'A'.repeat(86)
        f.channel.send({ activation: Buffer.from(JSON.stringify(pub) + '\n').toString('base64') })
      }
      // Wait for the handler to reject; do not make the test pass by closing first.
      await f.waitForActivationClose()
    } finally { await f.close() }
    expect(existsSync(f.result + '.adopted')).toBe(false)
  }, 20000)
})
