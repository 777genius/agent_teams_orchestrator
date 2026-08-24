import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, open, rm } from 'node:fs/promises'
import type { Stats, WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOSTED_CONTROL_BOOTSTRAP_FORMAT,
  type HostedControlBootstrapHeader,
} from './HostedControlBootstrap.js'

const roots: string[] = []
const children = new Set<ChildProcess>()
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('hosted control inherited-descriptor bootstrap', () => {
  test('admits exact canonical bytes, closes FD5, retains FD3, and loses authority on FD4 EOF', async () => {
    const fixture = await launchFixture(10_000)
    fixture.bootstrap.write(frame(fixture.header, fixture.secret))
    fixture.bootstrap.end()

    expect(await fixture.lines.next()).toEqual({
      kind: 'admitted', fd5Closed: true, secretBytes: 32,
      fd3Retained: true, fd4Retained: true,
      declaredRootHash: fixture.header.declaredRootHash,
      bootstrapBinding: fixture.header.bootstrapBinding,
    })
    expect(fixture.child.exitCode).toBeNull()
    fixture.liveness.end()
    expect(await fixture.lines.next()).toEqual({
      kind: 'lost', secretZeroed: true, fd3Closed: true, fd4Closed: true,
    })
    expect(await exitCode(fixture.child)).toBe(0)
  }, 30_000)

  test('rejects non-canonical headers, invalid authentication, evidence mismatches, trailing bytes, and never reports secret material', async () => {
    for (const mutate of [
      (header: HostedControlBootstrapHeader) => Buffer.from(`${JSON.stringify(header)}\n`),
      (header: HostedControlBootstrapHeader) => Buffer.from(JSON.stringify({ ...header, extra: true })),
      (header: HostedControlBootstrapHeader) => Buffer.from(JSON.stringify({ ...header, leaseEvidence: { ...header.leaseEvidence, inode: '1' } })),
    ]) {
      const fixture = await launchFixture(10_000)
      const bytes = mutate(fixture.header)
      fixture.bootstrap.end(frameBytes(bytes, fixture.secret))
      const output = await fixture.lines.next()
      expect(output).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
      expect(JSON.stringify(output)).not.toContain(fixture.secret.toString('hex'))
      fixture.liveness.end()
      expect(await exitCode(fixture.child)).toBe(2)
    }

    const unauthenticated = await launchFixture(10_000)
    const tampered = frame(unauthenticated.header, unauthenticated.secret)
    tampered[tampered.byteLength - 1] ^= 1
    unauthenticated.bootstrap.end(tampered)
    const unauthenticatedOutput = await unauthenticated.lines.next()
    expect(unauthenticatedOutput).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
    expect(JSON.stringify(unauthenticatedOutput)).not.toContain(unauthenticated.secret.toString('hex'))
    unauthenticated.liveness.end()
    expect(await exitCode(unauthenticated.child)).toBe(2)

    const trailing = await launchFixture(10_000)
    trailing.bootstrap.end(Buffer.concat([frame(trailing.header, trailing.secret), Buffer.from([0])]))
    expect(await trailing.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
    trailing.liveness.end()
    expect(await exitCode(trailing.child)).toBe(2)
  }, 60_000)

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
    for (const mutate of [
      (header: HostedControlBootstrapHeader) => ({ ...header, declaredRootHash: 'B'.repeat(64) }),
      (header: HostedControlBootstrapHeader) => ({ ...header, bootstrapBinding: {
        ...header.bootstrapBinding, ownerArtifactDigest: `sha256:${'0'.repeat(64)}`,
      } }),
      (header: HostedControlBootstrapHeader) => ({ ...header, bootstrapBinding: {
        ...header.bootstrapBinding, proofKeyId: '0'.repeat(64),
      } }),
    ]) {
      const fixture = await launchFixture(10_000)
      fixture.bootstrap.end(frame(mutate(fixture.header), fixture.secret))
      expect(await fixture.lines.next()).toEqual({ kind: 'rejected', message: 'Hosted control bootstrap was rejected' })
      fixture.liveness.end()
      expect(await exitCode(fixture.child)).toBe(2)
    }
  }, 30_000)
})

async function launchFixture(deadlineMs = 1_000) {
  const root = await makeRoot()
  const lease = await open(join(root, 'lease'), 'w+', 0o600)
  const artifact = Buffer.from('immutable-launcher-lease-artifact')
  await lease.writeFile(artifact)
  await chmod(join(root, 'lease'), 0o600)
  const stat = await lease.stat()
  const digest = createHash('sha256').update(artifact).digest('hex')
  const child = spawn(process.execPath, [childFixture(), String(deadlineMs)], {
    stdio: ['ignore', 'pipe', 'pipe', lease.fd, 'pipe', 'pipe'],
  })
  children.add(child)
  child.once('exit', () => { children.delete(child); void lease.close().catch(() => undefined) })
  const stdio = child.stdio as unknown as Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>
  ;(stdio[4] as WriteStream).on('error', () => undefined)
  ;(stdio[5] as WriteStream).on('error', () => undefined)
  return {
    child,
    header: makeHeader(stat, digest),
    secret: Buffer.alloc(32, 0xa5),
    liveness: stdio[4] as WriteStream,
    bootstrap: stdio[5] as WriteStream,
    lines: jsonLines(child.stdout!),
  }
}

function makeHeader(stat: Stats, digest: string): HostedControlBootstrapHeader {
  return {
    format: HOSTED_CONTROL_BOOTSTRAP_FORMAT,
    restoreGeneration: 2, teamId: `team_${'a'.repeat(32)}`,
    declaredRootHash: 'b'.repeat(64),
    ownerAuthority: 'owner-authority_bootstrap-test', ownerGeneration: 4,
    ownerSessionId: 'owner-session_bootstrap-test', claudeRoot: '/sandbox/claude',
    socketPath: '/sandbox/control.sock', legacyKey: 'legacy',
    bootstrapBinding: {
      deploymentId: 'deployment-test', bootId: 'boot-test', workspaceId: 'workspace-test',
      mountGeneration: 3, bootstrapDigest: 'c'.repeat(64),
      ownerArtifactDigest: `sha256:${digest}`,
      proofKeyId: createHash('sha256').update(Buffer.alloc(32, 0xa5)).digest('hex'),
    },
    leaseEvidence: {
      device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, gid: stat.gid,
      mode: stat.mode & 0o777, launcherLeaseId: 'launcher-lease-test',
      launcherArtifactDigest: digest,
    },
  }
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
