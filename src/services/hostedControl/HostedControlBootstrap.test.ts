import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { closeSync, fchmodSync, fstatSync, writeSync } from 'node:fs'
import type { Stats, WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOSTED_CONTROL_BOOTSTRAP_FORMAT,
  HOSTED_CONTROL_LAUNCHER_LEASE_FORMAT,
  HOSTED_CONTROL_LAUNCHER_LEASE_MAX_BYTES,
  type HostedControlBootstrapHeader,
  type HostedControlLauncherLeaseV1,
} from './HostedControlBootstrap.js'

const F_ADD_SEALS = 1033
const ALL_REQUIRED_SEALS = 0x000f
const memfdLibc = dlopen('libc.so.6', {
  memfd_create: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  socketpair: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32,
  },
})

const roots: string[] = []
const children = new Set<ChildProcess>()
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('hosted control inherited-descriptor bootstrap', () => {
  test('admits exact canonical bytes, closes FD5, retains FD3, and loses authority on FD4 EOF', async () => {
    const fixture = await launchFixture(10_000, {
      expectedOwnerArtifactDigest: `sha256:${createHash('sha256').update('running-owner').digest('hex')}`,
    })
    fixture.bootstrap.write(frame(fixture.header, fixture.secret))
    fixture.bootstrap.end()

    expect(await fixture.lines.next()).toEqual({
      kind: 'admitted', fd5Closed: true, secretBytes: 32,
      fd3Retained: true, fd4Retained: true,
      declaredRootHash: fixture.header.declaredRootHash,
      bootstrapBinding: fixture.header.bootstrapBinding,
      expectedOwnerArtifactDigest: fixture.header.bootstrapBinding.ownerArtifactDigest,
    })
    expect(fixture.child.exitCode).toBeNull()
    fixture.liveness.end()
    expect(await fixture.lines.next()).toEqual({
      kind: 'lost', secretZeroed: true, fd3Closed: true, fd4Closed: true,
    })
    expect(await exitCode(fixture.child)).toBe(0)
  }, 30_000)

  test('rejects non-canonical headers, invalid authentication, evidence mismatches, trailing bytes, and never reports secret material', async () => {
    const frames = [
      (header: HostedControlBootstrapHeader, secret: Buffer) =>
        frameBytes(Buffer.from(`${JSON.stringify(header)}\n`), secret),
      (header: HostedControlBootstrapHeader, secret: Buffer) =>
        frameBytes(Buffer.from(JSON.stringify({ ...header, extra: true })), secret),
      (header: HostedControlBootstrapHeader, secret: Buffer) => frameBytes(Buffer.from(JSON.stringify({
        ...header, leaseEvidence: { ...header.leaseEvidence, inode: '1' },
      })), secret),
      (header: HostedControlBootstrapHeader, secret: Buffer) => {
        const tampered = frame(header, secret)
        tampered[tampered.byteLength - 1] ^= 1
        return tampered
      },
      (header: HostedControlBootstrapHeader, secret: Buffer) =>
        Buffer.concat([frame(header, secret), Buffer.from([0])]),
    ]
    await Promise.all(frames.map(async makeFrame => {
      const fixture = await launchFixture(10_000)
      fixture.bootstrap.end(makeFrame(fixture.header, fixture.secret))
      const output = await fixture.lines.next()
      expect(output).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
      expect(JSON.stringify(output)).not.toContain(fixture.secret.toString('hex'))
      fixture.liveness.end()
      expect(await exitCode(fixture.child)).toBe(2)
    }))
  }, 30_000)

  test('applies one deadline to the entire frame and rejects a replayable regular-file FD5', async () => {
    const deadline = await launchFixture(40)
    deadline.bootstrap.write(frame(deadline.header, deadline.secret))
    // A complete payload is not a frame until the launcher closes FD5; EOF is
    // part of the one-use admission and shares the same absolute deadline.
    expect(await deadline.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
    deadline.liveness.end()
    expect(await exitCode(deadline.child)).toBe(2)

    const root = await makeRoot()
    const lease = await open(join(root, 'lease'), 'w+', 0o600)
    await lease.writeFile('lease-artifact')
    const leaseStat = await lease.stat()
    const header = makeHeader(leaseStat, createHash('sha256').update('lease-artifact').digest('hex'))
    const replay = await open(join(root, 'bootstrap'), 'w+', 0o600)
    await replay.writeFile(frame(header, Buffer.alloc(32, 7)))
    const child = spawn(process.execPath, [childFixture(), '500'], {
    stdio: ['ignore', 'pipe', 'pipe', lease.fd, 'pipe', replay.fd],
    })
    children.add(child)
    ;(child.stdio[4] as WriteStream).on('error', () => undefined)
    const lines = jsonLines(child.stdout!)
    expect(await lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
    ;(child.stdio[4] as WriteStream).end()
    expect(await exitCode(child)).toBe(2)
    await Promise.all([lease.close(), replay.close()])
  }, 30_000)

  test('validates declaredRootHash independently and binds owner artifact and proof key identities', async () => {
    const mutations = [
      (header: HostedControlBootstrapHeader) => ({ ...header, declaredRootHash: 'B'.repeat(64) }),
      (header: HostedControlBootstrapHeader) => ({ ...header, bootstrapBinding: {
        ...header.bootstrapBinding, ownerArtifactDigest: `sha256:${'0'.repeat(64)}`,
      } }),
      (header: HostedControlBootstrapHeader) => ({ ...header, bootstrapBinding: {
        ...header.bootstrapBinding, proofKeyId: '0'.repeat(64),
      } }),
      (header: HostedControlBootstrapHeader) => ({
        ...header,
        approvalActivationV2: {
          ...header.approvalActivationV2,
          ownerArtifactDigest: `sha256:${'0'.repeat(64)}` as const,
        },
      }),
    ]
    await Promise.all(mutations.map(async mutate => {
      const fixture = await launchFixture(10_000)
      fixture.bootstrap.end(frame(mutate(fixture.header), fixture.secret))
      expect(await fixture.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
      fixture.liveness.end()
      expect(await exitCode(fixture.child)).toBe(2)
    }))
  }, 30_000)

  test('rejects oversized or noncanonical lease statements and independent lease hash mismatches', async () => {
    const invalidOptions: FixtureOptions[] = [
      { leaseBytes: () => Buffer.alloc(HOSTED_CONTROL_LAUNCHER_LEASE_MAX_BYTES + 1, 0x20) },
      { leaseBytes: (canonical: Buffer) => Buffer.concat([canonical, Buffer.from('\n')]) },
      { header: (header: HostedControlBootstrapHeader) => ({
        ...header, leaseEvidence: { ...header.leaseEvidence, leaseArtifactDigest: '0'.repeat(64) },
      }) },
    ]
    await Promise.all(invalidOptions.map(async options =>
      expectRejected(await launchFixture(10_000, options))))
  }, 30_000)

  test('requires a private anonymous memfd and every immutable seal', async () => {
    const invalidOptions: FixtureOptions[] = [
      ...[
        ALL_REQUIRED_SEALS & ~0x1,
        ALL_REQUIRED_SEALS & ~0x2,
        ALL_REQUIRED_SEALS & ~0x4,
        ALL_REQUIRED_SEALS & ~0x8,
      ].map(leaseSeals => ({ leaseSeals })),
      { leaseMode: 0o640 },
      { leaseMode: 0o700 },
    ]
    await Promise.all(invalidOptions.map(async options =>
      expectRejected(await launchFixture(10_000, options))))

    const child = spawn(process.execPath, [childFixture(), '10000'], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    for (const index of [3, 4, 5]) {
      ;(child.stdio[index] as WriteStream).on('error', () => undefined)
    }
    expect(await jsonLines(child.stdout!).next()).toEqual({
      kind: 'rejected', message: 'Hosted control bootstrap was rejected',
    })
    for (const index of [3, 4, 5]) (child.stdio[index] as WriteStream).end()
    expect(await exitCode(child)).toBe(2)
  }, 30_000)

  test('rejects lease/frame/executable cross-splices and every lease binding mismatch', async () => {
    const wrongOwner = `sha256:${'9'.repeat(64)}` as const
    const mutations: Array<(lease: HostedControlLauncherLeaseV1) => HostedControlLauncherLeaseV1> = [
      lease => ({ ...lease, ownerArtifactDigest: wrongOwner }),
      lease => ({ ...lease, bootstrapDigest: '9'.repeat(64) }),
      lease => ({ ...lease, proofKeyId: '9'.repeat(64) }),
      lease => ({ ...lease, ownerGeneration: lease.ownerGeneration + 1 }),
      lease => ({ ...lease, ownerSessionId: 'owner-session_cross-splice' }),
      lease => ({ ...lease, launcherLeaseId: 'launcher-lease-cross-splice' }),
    ]
    await Promise.all([
      ...mutations.map(async leaseStatement =>
        expectRejected(await launchFixture(10_000, { leaseStatement }))),
      (async () => expectRejected(await launchFixture(10_000, {
        expectedOwnerArtifactDigest: `sha256:${'8'.repeat(64)}`,
      })))(),
    ])
  }, 30_000)

  test('rejects an omitted independent owner artifact pin even when every in-band digest agrees', async () => {
    const attackerDigest = `sha256:${'8'.repeat(64)}` as const
    await expectRejected(await launchFixture(10_000, {
      omitExpectedOwnerArtifactDigest: true,
      leaseStatement: lease => ({ ...lease, ownerArtifactDigest: attackerDigest }),
      header: header => ({
        ...header,
        bootstrapBinding: { ...header.bootstrapBinding, ownerArtifactDigest: attackerDigest },
        approvalActivationV2: { ...header.approvalActivationV2, ownerArtifactDigest: attackerDigest },
      }),
    }))
  }, 30_000)

  test('rejects a closed datagram socket on FD4', async () => {
    const fixture = await launchDeadLivenessFixture(2)
    fixture.bootstrap.end(frame(fixture.header, fixture.secret))
    expect(await fixture.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
    expect(await exitCode(fixture.child)).toBe(2)
  }, 30_000)

  test('rejects FD4 EOF before admission and an FD5 replay frame', async () => {
    const eof = await launchDeadLivenessFixture()
    eof.bootstrap.end(frame(eof.header, eof.secret))
    expect(await eof.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
    expect(await exitCode(eof.child)).toBe(2)

    const replay = await launchFixture(10_000)
    const once = frame(replay.header, replay.secret)
    replay.bootstrap.end(Buffer.concat([once, once]))
    expect(await replay.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
    replay.liveness.end()
    expect(await exitCode(replay.child)).toBe(2)
  }, 30_000)

  test('closes the guard stream before rejection can reuse its descriptor', async () => {
    const fixture = await launchFixture(10_000, { rejectAfterGuardCreated: true })
    fixture.bootstrap.end(frame(fixture.header, fixture.secret))
    expect(await fixture.lines.next()).toEqual({
      kind: 'rejected',
      message: 'Hosted control bootstrap was rejected',
      reusedDescriptorStable: true,
    })
    fixture.liveness.end()
    expect(await exitCode(fixture.child)).toBe(2)
  }, 30_000)
})

async function expectRejected(fixture: Awaited<ReturnType<typeof launchFixture>>): Promise<void> {
  fixture.bootstrap.end(frame(fixture.header, fixture.secret))
  expect(await fixture.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
  fixture.liveness.end()
  expect(await exitCode(fixture.child)).toBe(2)
}

type FixtureOptions = {
  leaseStatement?: (lease: HostedControlLauncherLeaseV1) => HostedControlLauncherLeaseV1
  leaseBytes?: (canonical: Buffer) => Buffer
  leaseSeals?: number
  leaseMode?: number
  header?: (header: HostedControlBootstrapHeader) => HostedControlBootstrapHeader
  expectedOwnerArtifactDigest?: string
  omitExpectedOwnerArtifactDigest?: boolean
  rejectAfterGuardCreated?: boolean
}

async function launchFixture(deadlineMs = 1_000, options: FixtureOptions = {}) {
  const secret = Buffer.alloc(32, 0xa5)
  const baseLeaseStatement = makeLeaseStatement(secret)
  const leaseStatement = options.leaseStatement?.(baseLeaseStatement) ?? baseLeaseStatement
  const canonical = Buffer.from(JSON.stringify(leaseStatement))
  const artifact = options.leaseBytes?.(canonical) ?? canonical
  const lease = createMemfd(artifact, options.leaseSeals, options.leaseMode)
  const stat = fstatSync(lease.fd)
  const digest = createHash('sha256').update(artifact).digest('hex')
  const baseHeader = makeHeader(stat, digest)
  const header = options.header?.(baseHeader) ?? baseHeader
  const expectedOwnerArtifactDigest = options.omitExpectedOwnerArtifactDigest
    ? ''
    : options.expectedOwnerArtifactDigest ?? `sha256:${createHash('sha256').update('running-owner').digest('hex')}`
  const child = spawn(process.execPath, [
    childFixture(), String(deadlineMs), expectedOwnerArtifactDigest,
    options.rejectAfterGuardCreated ? 'reject-after-guard' : '',
  ], {
    stdio: ['ignore', 'pipe', 'pipe', lease.fd, 'pipe', 'pipe'],
  })
  children.add(child)
  child.once('exit', () => { children.delete(child); lease.close() })
  const stdio = child.stdio as unknown as Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>
  ;(stdio[4] as WriteStream).on('error', () => undefined)
  ;(stdio[5] as WriteStream).on('error', () => undefined)
  return {
    child,
    header,
    secret,
    liveness: stdio[4] as WriteStream,
    bootstrap: stdio[5] as WriteStream,
    lines: jsonLines(child.stdout!),
  }
}

function makeHeader(stat: Stats, digest: string): HostedControlBootstrapHeader {
  const ownerArtifactDigest = createHash('sha256').update('running-owner').digest('hex')
  return {
    format: HOSTED_CONTROL_BOOTSTRAP_FORMAT,
    restoreGeneration: 2, teamId: `team_${'a'.repeat(32)}`,
    declaredRootHash: 'b'.repeat(64),
    ownerAuthority: 'owner-authority_bootstrap-test', ownerGeneration: 11,
    ownerSessionId: 'owner-session_bootstrap-test', claudeRoot: '/sandbox/claude',
    socketPath: '/sandbox/control.sock', legacyKey: 'legacy',
    approvalActivationV2: {
      approvalGeneration: 7,
      admissionOwnerGeneration: 11,
      approvalDigest: `sha256:${'d'.repeat(64)}`,
      admissionDocumentDigest: `sha256:${'e'.repeat(64)}`,
      ownerArtifactDigest: `sha256:${ownerArtifactDigest}`,
      wireCapabilityDigest: `sha256:${'f'.repeat(64)}`,
      signedManifest: {
        format: 'agent-teams.hosted-lifecycle-owner-admission/v4',
        manifestDigest: `sha256:${'1'.repeat(64)}`,
        releasePinDigest: `sha256:${'2'.repeat(64)}`,
        launcherKeyId: '3'.repeat(64),
      },
    },
    bootstrapBinding: {
      deploymentId: 'deployment-test', bootId: 'boot-test', workspaceId: 'workspace-test',
      mountGeneration: 3, bootstrapDigest: 'c'.repeat(64),
      ownerArtifactDigest: `sha256:${ownerArtifactDigest}`,
      proofKeyId: createHash('sha256').update(Buffer.alloc(32, 0xa5)).digest('hex'),
    },
    leaseEvidence: {
      device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, gid: stat.gid,
      mode: stat.mode & 0o777, launcherLeaseId: 'launcher-lease-test',
      leaseArtifactDigest: digest,
    },
  }
}

function makeLeaseStatement(secret: Buffer): HostedControlLauncherLeaseV1 {
  return {
    format: HOSTED_CONTROL_LAUNCHER_LEASE_FORMAT,
    launcherLeaseId: 'launcher-lease-test',
    ownerArtifactDigest: `sha256:${createHash('sha256').update('running-owner').digest('hex')}`,
    bootstrapDigest: 'c'.repeat(64),
    proofKeyId: createHash('sha256').update(secret).digest('hex'),
    ownerGeneration: 11,
    ownerSessionId: 'owner-session_bootstrap-test',
  }
}

function createMemfd(bytes: Buffer, seals = ALL_REQUIRED_SEALS, mode = 0o600) {
  const name = Buffer.from('hosted-control-launcher-lease\0')
  const fd = memfdLibc.symbols.memfd_create(ptr(name), 0x0002)
  if (fd < 0) throw new Error('memfd_create failed')
  try {
    fchmodSync(fd, mode)
    let offset = 0
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset)
    if (memfdLibc.symbols.fcntl(fd, F_ADD_SEALS, seals) !== 0) throw new Error('seal failed')
    return { fd, close: () => { try { closeSync(fd) } catch {} } }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

async function launchDeadLivenessFixture(socketType = 1) {
  const secret = Buffer.alloc(32, 0xa5)
  const artifact = Buffer.from(JSON.stringify(makeLeaseStatement(secret)))
  const lease = createMemfd(artifact)
  const header = makeHeader(
    fstatSync(lease.fd), createHash('sha256').update(artifact).digest('hex'),
  )
  const pair = new Int32Array(2)
  if (memfdLibc.symbols.socketpair(1, socketType, 0, ptr(pair)) !== 0) {
    lease.close()
    throw new Error('socketpair failed')
  }
  const child = spawn(process.execPath, [
    childFixture(), '10000', `sha256:${createHash('sha256').update('running-owner').digest('hex')}`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe', lease.fd, pair[0]!, 'pipe'],
  })
  children.add(child)
  closeSync(pair[0]!)
  closeSync(pair[1]!)
  child.once('exit', () => { children.delete(child); lease.close() })
  const bootstrap = (child.stdio as unknown as Array<unknown>)[5] as WriteStream
  bootstrap.on('error', () => undefined)
  return { child, header, secret, bootstrap, lines: jsonLines(child.stdout!) }
}

function frame(header: HostedControlBootstrapHeader, secret: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header))
  return frameBytes(headerBytes, secret)
}
function frameBytes(headerBytes: Buffer, secret: Buffer): Buffer {
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(headerBytes.byteLength)
  const authenticated = Buffer.concat([prefix, headerBytes])
  const authenticator = createHmac('sha256', secret)
    .update(HOSTED_CONTROL_BOOTSTRAP_FORMAT, 'utf8').update(Buffer.from([0]))
    .update(authenticated).digest()
  return Buffer.concat([authenticated, secret, authenticator])
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-bootstrap-'))
  roots.push(root)
  return root
}
function childFixture(): string { return join(import.meta.dir, 'fixtures', 'hostedControlBootstrapChild.ts') }

function jsonLines(stream: NodeJS.ReadableStream): { next(): Promise<Record<string, unknown>> } {
  let buffered = ''
  const waiting: Array<(value: Record<string, unknown>) => void> = []
  const parsed: Record<string, unknown>[] = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const value = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>
      buffered = buffered.slice(newline + 1)
      const resolve = waiting.shift()
      if (resolve) resolve(value); else parsed.push(value)
    }
  })
  return { next: () => parsed.length ? Promise.resolve(parsed.shift()!) : new Promise(resolve => waiting.push(resolve)) }
}
function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise(resolve => {
    let settled = false
    const finish = (code: number | null) => { if (!settled) { settled = true; resolve(code) } }
    child.once('exit', finish)
    if (child.exitCode !== null) finish(child.exitCode)
  })
}
