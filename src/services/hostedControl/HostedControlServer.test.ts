import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, rename, rm, unlink } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostedDomainProof, createHostedRawDomainProof } from './ownerProof.js'
import { hostedControlGoldenRequestFixture } from './protocol.js'
import { HostedControlDispatcher } from './HostedControlDispatcher.js'
import { admitHostedReadiness, HOSTED_LIFECYCLE_PROOF_DOMAIN, HostedControlServer } from './HostedControlServer.js'
import type { HostedControlBootstrapBinding } from './HostedControlBootstrap.js'
import type { HostedApprovalActivationConnection } from './HostedApprovalActivationSession.js'

const roots: string[] = []
const servers: HostedControlServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('HostedControlServer', () => {
  test('notifies advisory recovery only after authenticated readiness retains the sole lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-readiness-recovery-'))
    roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const fixture = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
    let callbacks = 0
    let leaseCurrent: Promise<boolean> | null = null
    const server = new HostedControlServer({
      socketPath, secret, ownerIdentity, authority: fixture.authority,
      dispatchCoexistingOperation: async () => null,
      onReadinessLease: () => { callbacks++; leaseCurrent = server.hasActiveLease() },
    })
    servers.push(server)
    await server.start()
    expect(await exchange(socketPath, `${JSON.stringify({ schemaVersion: 2, operation: 'readiness',
      capability: 'hosted-lifecycle-command', socketIdentity: server.ownerBinding!.socketIdentity,
      challenge: 'f'.repeat(64), ownerProof: '0'.repeat(64) })}\n`)).toBe('')
    expect(callbacks).toBe(0)
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    expect(await leaseCurrent).toBe(true)
    expect(callbacks).toBe(1)
    expect(await exchange(socketPath, legacyReadinessLine(server.ownerBinding!))).toBe('')
    expect(callbacks).toBe(1)
    lease.socket.destroy()
  })

  test('enforces descriptor-v2 exact binding and legacy string-config readiness policy', () => {
    const secret = Buffer.alloc(32, 9)
    const fixture = hostedControlGoldenRequestFixture()
    const ownerBinding = fixture.ownerBinding
    const bootstrapBinding: HostedControlBootstrapBinding = {
      deploymentId: fixture.authority.deploymentId, bootId: fixture.authority.bootId,
      workspaceId: fixture.authority.workspaceId, mountGeneration: fixture.authority.mountBinding.mountGeneration,
      bootstrapDigest: '3'.repeat(64), ownerArtifactDigest: `sha256:${'4'.repeat(64)}`,
      proofKeyId: createHash('sha256').update(secret).digest('hex'),
    }
    const admits = (lineWithNewline: string, expected = bootstrapBinding) => {
      const line = lineWithNewline.slice(0, -1)
      return admitHostedReadiness({ secret, ownerBinding, bootstrapBinding: expected,
        line, message: JSON.parse(line) as Record<string, unknown> })
    }
    expect(admits(legacyReadinessLine(ownerBinding))).toBe(false)
    const mutations: Record<keyof HostedControlBootstrapBinding, unknown> = {
      deploymentId: 'deployment-mutated', bootId: 'boot-mutated', workspaceId: 'workspace-mutated',
      mountGeneration: bootstrapBinding.mountGeneration + 1, bootstrapDigest: '6'.repeat(64),
      ownerArtifactDigest: `sha256:${'7'.repeat(64)}`, proofKeyId: '8'.repeat(64),
    }
    for (const field of Object.keys(mutations) as Array<keyof HostedControlBootstrapBinding>) {
      expect(admits(descriptorReadinessLine(secret, ownerBinding, {
        ...bootstrapBinding, [field]: mutations[field],
      }))).toBe(false)
    }
    expect(admits(descriptorReadinessLine(secret, ownerBinding, bootstrapBinding))).toBe(true)

    const legacyLine = legacyReadinessLine(ownerBinding).slice(0, -1)
    expect(admitHostedReadiness({ secret, ownerBinding, line: legacyLine,
      message: JSON.parse(legacyLine) as Record<string, unknown> })).toBe(true)
    const descriptorLine = descriptorReadinessLine(secret, ownerBinding, bootstrapBinding).slice(0, -1)
    expect(admitHostedReadiness({ secret, ownerBinding, line: descriptorLine,
      message: JSON.parse(descriptorLine) as Record<string, unknown> })).toBe(false)
  })

  test('does not advertise readiness without the coexisting lifecycle and message dispatcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-task-only-'))
    roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority })
    servers.push(server)
    await server.start()

    expect(await exchange(socketPath, `${JSON.stringify({
      schemaVersion: 2,
      operation: 'readiness',
      capability: 'hosted-lifecycle-command',
      socketIdentity: server.ownerBinding!.socketIdentity,
      challenge: 'a'.repeat(64),
    })}\n`)).toBe('')
  })

  test('closes a retired task frame even when its old task-board proof is valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-test-'))
    roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture()
    let dispatched = 0
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, dispatchCoexistingOperation: async () => { dispatched += 1; return { kind: 'ok' } } })
    servers.push(server)
    await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!); const ready = JSON.parse(lease.line) as Record<string, unknown>; const { ownerProof, ...unsignedReady } = ready
    expect(Object.keys(ready)).toEqual(['schemaVersion', 'kind', 'capability', 'challenge', 'ownerBinding', 'ownerProof'])
    expect(ownerProof).toBe(createHostedDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', unsignedReady))
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding! }
    expect(await exchange(socketPath, legacyTaskLine(secret, requestUnsigned))).toBe('')
    expect(dispatched).toBe(0)
    lease.socket.destroy()
  })

  test('returns a signed lifecycle response through the broker after write and dispatches one frame per socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-write-'))
    roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const fixture = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
    const planGeneration = `plan-generation_${'a'.repeat(64)}`
    const ownerEffectFence = { grantRevision: '1'.repeat(64), identityChecksum: '2'.repeat(64) }
    let dispatches = 0
    let releaseSecond!: () => void
    let markSecondStarted!: () => void
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve })
    let server!: HostedControlServer
    const dispatcher = new HostedControlDispatcher({
      secret, authority: fixture.authority, getOwnerBinding: () => server.ownerBinding,
      lifecycle: { dispatch: async () => {
        dispatches += 1
        if (dispatches === 2) { markSecondStarted(); await secondGate }
        return { payload: { schemaVersion: 1, kind: 'admitted', workspaceId: fixture.authority.workspaceId,
          teamId: fixture.authority.teamId, planGeneration }, resourceRevision: null }
      } },
      messages: { dispatch: async () => ({ schemaVersion: 2, kind: 'not_found' }) },
    })
    server = new HostedControlServer({
      socketPath, secret, ownerIdentity, authority: fixture.authority,
      dispatchCoexistingOperation: (message, rawLine) => dispatcher.dispatch(message, rawLine),
    })
    servers.push(server)
    await server.start()
    const ownerBinding = server.ownerBinding!
    const lease = await openReadiness(socketPath, ownerBinding)
    const frame = (exchangeSuffix: string) => {
      const exchangeId = `lifecycle-request_${exchangeSuffix.repeat(32)}`
      const operation = 'admit_launch_plan'
      const actorId = 'actor-a'
      const sessionId = 'session-a'
      const authority = {
        actorId, workspaceId: fixture.authority.workspaceId, teamId: fixture.authority.teamId,
        deploymentId: fixture.authority.deploymentId, bootId: fixture.authority.bootId,
        restoreGeneration: fixture.authority.restoreGeneration,
        mountGeneration: fixture.authority.mountBinding.mountGeneration,
        resourceRevision: null, ownerEffectFence,
      }
      const unsigned = {
        schemaVersion: 2, exchangeId, operation,
        provenance: {
          from: { kind: 'controller', deploymentId: authority.deploymentId, bootId: authority.bootId,
            actorId, sessionId },
          to: { kind: 'owner', ownerAuthority: ownerBinding.ownerAuthority,
            ownerGeneration: ownerBinding.ownerGeneration, ownerSessionId: ownerBinding.ownerSessionId },
          target: { capability: 'hosted-lifecycle-command', exchangeId, operation,
            workspaceId: authority.workspaceId, teamId: authority.teamId },
        },
        ownerBinding, ownerEffectFence,
        payload: {
          request: { schemaVersion: 1, workspaceId: authority.workspaceId, teamId: authority.teamId,
            workspaceRoot: '/sandbox/workspace', expectedPlanGeneration: planGeneration },
          context: { actorId, sessionId, deploymentId: authority.deploymentId, bootId: authority.bootId,
            requestId: `request-${exchangeSuffix}`, authorizedScope: 'owner', deadlineAtMs: 1 },
          authority,
        },
      }
      return `${JSON.stringify({ ...unsigned, ownerProof: createHostedRawDomainProof(
        secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'request', JSON.stringify(unsigned),
      ) })}\n`
    }

    // exchange() uses socket.write(), leaving the request's write side open while Owner responds.
    const response = JSON.parse(await exchange(socketPath, frame('a'))) as Record<string, unknown>
    const { ownerProof, ...unsignedResponse } = response
    expect(response.payload).toMatchObject({ kind: 'admitted', planGeneration })
    expect(ownerProof).toBe(createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN,
      'response', JSON.stringify(unsignedResponse)))
    expect(dispatches).toBe(1)

    const second = connect(socketPath)
    const secondClosed = new Promise<void>((resolve, reject) => {
      second.once('close', resolve)
      second.once('error', reject)
    })
    try {
      await new Promise<void>(resolve => second.once('connect', resolve))
      second.write(frame('b'))
      await secondStarted
      second.write(frame('c'))
      await secondClosed
      expect(dispatches).toBe(2)
    } finally {
      releaseSecond()
      second.destroy()
      lease.socket.destroy()
    }
  })

  test('binds canonical readiness to bootstrap, controller, active owner and mount generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-canonical-readiness-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9)
    const fixture = hostedControlGoldenRequestFixture(); const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
    const bootstrapBinding = {
      deploymentId: fixture.authority.deploymentId,
      bootId: fixture.authority.bootId,
      workspaceId: fixture.authority.workspaceId,
      mountGeneration: fixture.authority.mountBinding.mountGeneration,
      bootstrapDigest: '3'.repeat(64),
      ownerArtifactDigest: `sha256:${'4'.repeat(64)}`,
      proofKeyId: createHash('sha256').update(secret).digest('hex'),
    }
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: fixture.authority,
      bootstrapBinding,
      dispatchCoexistingOperation: async () => null })
    servers.push(server); await server.start()
    const ownerBinding = server.ownerBinding!
    const unsigned = { schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command', socketIdentity: ownerBinding.socketIdentity, challenge: '5'.repeat(64), bootstrapBinding, expectedOwnerBinding: ownerBinding }
    const serialized = JSON.stringify(unsigned)
    const controllerProof = createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', serialized)
    const line = await exchange(socketPath, `${serialized.slice(0, -1)},"controllerProof":"${controllerProof}"}\n`)
    const ready = JSON.parse(line) as Record<string, unknown>; const { ownerProof, ...readyUnsigned } = ready
    expect(ready).toMatchObject({ kind: 'ready', challenge: unsigned.challenge, bootstrapDigest: bootstrapBinding.bootstrapDigest, ownerBinding })
    expect(ownerProof).toBe(createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', JSON.stringify(readyUnsigned)))
  })

  test('does not consume the sole readiness lease for an unauthenticated first client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-readiness-dos-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture(); const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, dispatchCoexistingOperation: async () => null }); servers.push(server); await server.start()
    expect(await exchange(socketPath, `${JSON.stringify({ schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command', socketIdentity: server.ownerBinding!.socketIdentity, challenge: 'f'.repeat(64), ownerProof: '0'.repeat(64) })}\n`)).toBe('')
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    expect(lease.line).toContain('"kind":"ready"')
    lease.socket.destroy()
  })

  test('descriptor readiness requires exact equality for every bootstrap binding field and rejects legacy readiness', async () => {
    const root = await mkdtemp('/tmp/hcdr-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture(); const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const bootstrapBinding: HostedControlBootstrapBinding = {
      deploymentId: unsigned.authority.deploymentId,
      bootId: unsigned.authority.bootId,
      workspaceId: unsigned.authority.workspaceId,
      mountGeneration: unsigned.authority.mountBinding.mountGeneration,
      bootstrapDigest: '3'.repeat(64), ownerArtifactDigest: `sha256:${'4'.repeat(64)}`,
      proofKeyId: createHash('sha256').update(secret).digest('hex'),
    }
    const server = new HostedControlServer({
      socketPath, secret, ownerIdentity, authority: unsigned.authority, bootstrapBinding,
      dispatchCoexistingOperation: async () => null,
    })
    servers.push(server); await server.start()
    expect(await exchange(socketPath, legacyReadinessLine(server.ownerBinding!))).toBe('')

    const mutations: Record<keyof HostedControlBootstrapBinding, unknown> = {
      deploymentId: 'deployment-mutated', bootId: 'boot-mutated', workspaceId: 'workspace-mutated',
      mountGeneration: bootstrapBinding.mountGeneration + 1, bootstrapDigest: '6'.repeat(64),
      ownerArtifactDigest: `sha256:${'7'.repeat(64)}`, proofKeyId: '8'.repeat(64),
    }
    for (const field of Object.keys(mutations) as Array<keyof HostedControlBootstrapBinding>) {
      const mutated = { ...bootstrapBinding, [field]: mutations[field] }
      expect(await exchange(socketPath, descriptorReadinessLine(secret, server.ownerBinding!, mutated))).toBe('')
    }
    const lease = await openDescriptorReadiness(socketPath, secret, server.ownerBinding!, bootstrapBinding)
    const ready = JSON.parse(lease.line) as Record<string, unknown>
    expect(ready.bootstrapDigest).toBe(bootstrapBinding.bootstrapDigest)
    lease.socket.destroy()
  })

  test('legacy string-config mode rejects descriptor readiness and continues to admit legacy readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-legacy-readiness-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture(); const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority,
      dispatchCoexistingOperation: async () => null })
    servers.push(server); await server.start()
    const binding: HostedControlBootstrapBinding = {
      deploymentId: unsigned.authority.deploymentId, bootId: unsigned.authority.bootId,
      workspaceId: unsigned.authority.workspaceId, mountGeneration: unsigned.authority.mountBinding.mountGeneration,
      bootstrapDigest: '3'.repeat(64), ownerArtifactDigest: `sha256:${'4'.repeat(64)}`, proofKeyId: '5'.repeat(64),
    }
    expect(await exchange(socketPath, descriptorReadinessLine(secret, server.ownerBinding!, binding))).toBe('')
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    expect(lease.line).toContain('"kind":"ready"')
    lease.socket.destroy()
  })

  test('fails closed when a client sends more than one JSON line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-lines-test-'))
    roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture()
    let dispatched = 0
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, dispatchCoexistingOperation: async () => { dispatched += 1; return { kind: 'ok' } } })
    servers.push(server)
    await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!); expect(lease.line).toContain('"kind":"ready"')
    expect(await exchange(socketPath, `${JSON.stringify({ operation: 'control_state' })}\n{}\n`)).toBe('')
    expect(dispatched).toBe(0)
    lease.socket.destroy()
  })

  test('admits one Product owner-bound line and never replies once trailing bytes follow it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-product-trailing-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let dispatched = 0; let release!: () => void; let markStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { markStarted = resolve })
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority,
      dispatchCoexistingOperation: async message => { dispatched += 1; markStarted(); await gate; return { schemaVersion: 2, operation: message.operation, payload: { schemaVersion: 2, kind: 'delivered' } } } })
    servers.push(server); await server.start()
    await openReadiness(socketPath, server.ownerBinding!)
    const frame = `${JSON.stringify({ schemaVersion: 2, exchangeId: `message-request_${'9'.repeat(32)}`, operation: 'message_deliver', ownerBinding: server.ownerBinding, authority: { ...unsigned.authority, actorId: 'actor', ownerEffectFence: { grantRevision: 'd'.repeat(64), identityChecksum: 'e'.repeat(64) } }, payload: {}, ownerProof: '0'.repeat(64) })}\n`

    expect(await exchange(socketPath, `${frame}x`)).toBe('')
    expect(dispatched).toBe(0)

    const socket = connect(socketPath); let output = ''
    socket.setEncoding('utf8'); socket.on('data', chunk => { output += chunk })
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    socket.once('connect', () => socket.write(frame))
    await started
    socket.write('x')
    await closed
    release()
    expect(output).toBe('')
    expect(dispatched).toBe(1)
  })

  test('rejects malformed UTF-8 without conflating it with a literal replacement character', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-utf8-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let values: unknown[] = []
    const server = new HostedControlServer({
      socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority,
      dispatchCoexistingOperation: async message => { values.push(message.value); return { kind: 'ok' } },
    })
    servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const literal = Buffer.from(`${JSON.stringify({ operation: 'utf8_probe', value: '\uFFFD' })}\n`, 'utf8')
    expect(await exchangeBytes(socketPath, literal)).not.toBe('')
    expect(values).toEqual(['\uFFFD'])

    values = []
    const malformed = Buffer.from(literal)
    const replacement = Buffer.from('\uFFFD', 'utf8')
    const offset = malformed.indexOf(replacement)
    expect(offset).toBeGreaterThanOrEqual(0)
    malformed.set([0xc3, 0x28, 0x20], offset)
    expect(await exchangeBytes(socketPath, malformed)).toBe('')
    expect(values).toEqual([])

    const bomPrefixed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), literal])
    expect(await exchangeBytes(socketPath, bomPrefixed)).toBe('')
    expect(values).toEqual([])
    lease.socket.destroy()
  })

  test('drops the readiness lease when the controller half-closes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-lease-fin-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, dispatchCoexistingOperation: async () => ({ schemaVersion: 2, operation: 'control_state' }), readDeadlineMs: 60_000 })
    servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    expect(await server.hasActiveLease()).toBe(true)
    const leaseClosed = new Promise<void>(resolve => lease.socket.once('close', () => resolve()))
    lease.socket.end()
    for (let attempt = 0; attempt < 250 && await server.hasActiveLease(); attempt += 1) await Bun.sleep(2)
    expect(await server.hasActiveLease()).toBe(false)
    await withinMs(leaseClosed, 1_000)
    expect(await exchange(socketPath, `${JSON.stringify({ operation: 'control_state' })}\n`)).toBe('')
  })

  test('closes a half-closed connection that sent no complete frame without waiting for the read deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-half-closed-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let dispatched = 0
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, dispatchCoexistingOperation: async () => { dispatched += 1; return null }, readDeadlineMs: 60_000 })
    servers.push(server); await server.start()
    for (const bytes of ['', '{"operation":"control_state"', '{not json\n']) {
      const socket = connect({ path: socketPath, allowHalfOpen: true }); let output = ''
      socket.setEncoding('utf8'); socket.on('data', chunk => { output += chunk })
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
      socket.once('connect', () => socket.end(bytes))
      await withinMs(closed, 1_000)
      expect(output).toBe('')
    }
    expect(dispatched).toBe(0)
  })

  test('does not return a coexisting-operation response after the readiness lease closes', async () => {
    const root = await mkdtemp('/tmp/hc-coexist-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    let release!: () => void; let markStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({
      socketPath,
      secret,
      ownerIdentity,
      authority: unsigned.authority,
      dispatchCoexistingOperation: async () => { markStarted(); await gate; return { kind: 'signed-later' } },
    })
    servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const pending = exchange(socketPath, `${JSON.stringify({ operation: 'control_state' })}\n`)
    await started
    lease.socket.destroy()
    for (let attempt = 0; attempt < 50 && await server.hasActiveLease(); attempt += 1) await Bun.sleep(2)
    release()
    expect(await pending).toBe('')
  })

  test('stop drains every admitted coexisting handler before resolving', async () => {
    const root = await mkdtemp('/tmp/hc-stop-drain-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture()
    const gates = new Map<string, () => void>()
    const started = new Map<string, Promise<void>>()
    const starts = new Map<string, () => void>()
    for (const operation of ['control_state', 'get_status']) {
      started.set(operation, new Promise<void>(resolve => { starts.set(operation, resolve) }))
    }
    const completed: string[] = []
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({
      socketPath, secret, ownerIdentity, authority: unsigned.authority,
      dispatchCoexistingOperation: async message => {
        const operation = String(message.operation)
        const gate = new Promise<void>(resolve => { gates.set(operation, resolve) })
        starts.get(operation)!()
        await gate
        completed.push(operation)
        return { kind: 'ok' }
      },
    })
    servers.push(server)
    await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const first = exchange(socketPath, `${JSON.stringify({ operation: 'control_state' })}\n`)
    const second = exchange(socketPath, `${JSON.stringify({ operation: 'get_status' })}\n`)
    await Promise.all(started.values())
    let stopped = false
    const stopping = server.stop().then(() => { stopped = true })
    await Bun.sleep(0)
    expect(stopped).toBe(false)
    gates.get('control_state')!()
    await Bun.sleep(0)
    expect(stopped).toBe(false)
    gates.get('get_status')!()
    await stopping
    expect(completed.sort()).toEqual(['control_state', 'get_status'])
    expect(stopped).toBe(true)
    lease.socket.destroy()
    await Promise.all([first, second])
  })

  test('frames the complete bounded JSON before dispatching an operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-framing-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let dispatched = ''
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, dispatchCoexistingOperation: async message => { dispatched = String(message.operation); return { kind: 'ok' } } }); servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const message = { padding: `nested text \\"operation\\":\\"task_mutate\\" ${'x'.repeat(5_000)}`, operation: 'team_message' }
    await exchange(socketPath, `${JSON.stringify(message)}\n`)
    expect(dispatched).toBe('team_message')
    lease.socket.destroy()
  })

  test('forwards the admitted raw JSON bytes to dispatch unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-raw-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture(); const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let receivedRaw = ''
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority,
      dispatchCoexistingOperation: async (_message, rawLine) => { receivedRaw = rawLine; return { kind: 'ok' } } })
    servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const rawLine = '{ "padding" : "\\u0061", "operation" : "team_message" }'
    expect(await exchange(socketPath, `${rawLine}\n`)).toContain('"kind":"ok"')
    expect(receivedRaw).toBe(rawLine)
    lease.socket.destroy()
  })

  test('stop preserves a socket substituted at the original path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-swap-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority }); servers.push(server); await server.start()
    await unlink(socketPath)
    const replacement = createServer()
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(socketPath, resolve) })
    await server.stop()
    await new Promise<void>((resolve, reject) => { const socket = connect(socketPath); socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('error', reject) })
    await unlink(socketPath)
    await new Promise<void>((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()))
  })

  test('fails closed without chmod or unlink when the published socket is substituted before adoption', async () => {
    const root = await mkdtemp('/tmp/hc-publish-swap-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const replacement = createServer(socket => socket.end('replacement'))
    let replacementIdentity: Awaited<ReturnType<typeof lstat>> | null = null
    const server = new HostedControlServer({
      socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority,
      afterSocketPublicationForTest: async () => {
        await unlink(socketPath)
        await new Promise<void>((resolve, reject) => {
          replacement.once('error', reject)
          replacement.listen(socketPath, resolve)
        })
        replacementIdentity = await lstat(socketPath)
      },
    })
    await expect(server.start()).rejects.toThrow('changed during publication')
    expect(replacementIdentity).not.toBeNull()
    const afterFailure = await lstat(socketPath)
    expect({ inode: afterFailure.ino, mode: afterFailure.mode & 0o777 }).toEqual({
      inode: replacementIdentity!.ino,
      mode: replacementIdentity!.mode & 0o777,
    })
    expect(await exchange(socketPath, '')).toBe('replacement')
    await unlink(socketPath)
    await new Promise<void>((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()))
  })

  test('broker A shutdown preserves replacement B bound at the hidden publication path', async () => {
    const root = await mkdtemp('/tmp/hc-hidden-close-swap-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const replacement = createServer(socket => socket.end('replacement'))
    let replacementIdentity: Awaited<ReturnType<typeof lstat>> | null = null
    const server = new HostedControlServer({
      socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority,
      beforeSocketCloseForTest: async hiddenPath => {
        await new Promise<void>((resolve, reject) => {
          replacement.once('error', reject)
          replacement.listen(hiddenPath, resolve)
        })
        replacementIdentity = await lstat(hiddenPath)
      },
    })
    await server.start()
    await server.stop()
    expect(replacementIdentity).not.toBeNull()
    const hiddenPath = String(replacement.address())
    const afterClose = await lstat(hiddenPath)
    expect({ inode: afterClose.ino, mode: afterClose.mode & 0o777 }).toEqual({
      inode: replacementIdentity!.ino,
      mode: replacementIdentity!.mode & 0o777,
    })
    expect(await exchange(hiddenPath, '')).toBe('replacement')
    await unlink(hiddenPath)
    await new Promise<void>((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()))
  })

  test('removes the hidden publication path immediately after canonical publication', async () => {
    const root = await mkdtemp('/tmp/hc-hidden-retained-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let hiddenPath = ''
    const server = new HostedControlServer({
      socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority,
      beforeSocketCloseForTest: async path => {
        hiddenPath = path
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await lstat(socketPath)).isSocket()).toBe(true)
      },
    })
    await server.start()
    await server.stop()
    expect(hiddenPath).not.toBe('')
    await expect(lstat(hiddenPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('reclaims only an inactive private socket inode and refuses an active listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-reclaim-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    await mkdir(join(root, 'private'), { mode: 0o700 })
    const stale = spawn(process.execPath, ['-e', `
      const { createServer } = require('node:net');
      const { chmodSync } = require('node:fs');
      const server = createServer();
      server.listen(${JSON.stringify(socketPath)}, () => {
        chmodSync(${JSON.stringify(socketPath)}, 0o600);
        process.stdout.write('ready\\n');
      });
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolve, reject) => {
      let output = ''
      stale.stdout!.setEncoding('utf8')
      stale.stdout!.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve() })
      stale.once('error', reject)
      stale.once('exit', code => { if (!output.includes('\n')) reject(new Error(`stale socket fixture exited ${code}`)) })
    })
    stale.kill('SIGKILL')
    await new Promise<void>(resolve => stale.once('exit', () => resolve()))
    expect((await lstat(socketPath)).isSocket()).toBe(true)

    const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({
      socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority,
      dispatchCoexistingOperation: async () => null,
    })
    servers.push(server)
    await server.start()
    expect(server.ownerBinding?.socketIdentity.inode).toBe(String((await lstat(socketPath)).ino))
    await server.stop()

    const active = createServer()
    await new Promise<void>((resolve, reject) => {
      active.once('error', reject)
      active.listen(socketPath, resolve)
    })
    await chmod(socketPath, 0o600)
    const contender = new HostedControlServer({
      socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority,
      dispatchCoexistingOperation: async () => null,
    })
    await expect(contender.start()).rejects.toThrow('active hosted control socket')
    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath)
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', reject)
    })
    await new Promise<void>((resolve, reject) => active.close(error => error ? reject(error) : resolve()))
    await unlink(socketPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  })

  test('retains one activation connection through owner-ready, publication, recovery and ready', async () => {
    const fixture = await activationServerFixture()
    let connection!: HostedApprovalActivationConnection
    let publication = ''
    let revokeCalls = 0
    fixture.create(({ connection: candidate }) => {
      connection = candidate
      return {
        activate: async prepare => {
          expect(prepare).toBe(activationPrepare())
          publication = await candidate.receivePublicationAfterOwnerReady(
            '{"kind":"owner_ready"}\n', 512 * 1024,
          )
          const token = candidate.prepareEffectToken()!
          expect(token.consume()).toBe(true)
          expect(token.consume()).toBe(false)
          return '{"kind":"ready"}\n'
        },
        revoke: async () => { revokeCalls += 1 },
      }
    })
    const client = await openStreamingSocket(fixture.socketPath)
    client.socket.write(activationPrepare())
    expect(await client.nextLine()).toBe('{"kind":"owner_ready"}')
    client.socket.write('{"publication":1}\n')
    expect(await client.nextLine()).toBe('{"kind":"ready"}')
    expect(publication).toBe('{"publication":1}\n')
    expect(connection.isCurrent()).toBe(true)
    expect(client.socket.destroyed).toBe(false)

    client.socket.write('x')
    await waitFor(() => revokeCalls === 1)
    expect(connection.isCurrent()).toBe(false)
    await fixture.server.stop()
    expect(revokeCalls).toBe(1)
  })

  test('clears the publication deadline for slow recovery and separately bounds recovery', async () => {
    const slow = await activationServerFixture(false, true, {
      readDeadlineMs: 100,
      activationRecoveryDeadlineMs: 5_000,
    })
    let slowRevokes = 0
    slow.create(({ connection }) => ({
      activate: async () => {
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        await Bun.sleep(300)
        expect(connection.prepareEffectToken()?.consume()).toBe(true)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { slowRevokes += 1 },
    }))
    const slowClient = await openStreamingSocket(slow.socketPath)
    slowClient.socket.write(activationPrepare())
    expect(await slowClient.nextLine()).toContain('owner_ready')
    slowClient.socket.write('{"publication":"slow"}\n')
    expect(await slowClient.nextLine()).toContain('ready')
    expect(slowRevokes).toBe(0)

    const bounded = await activationServerFixture(false, true, {
      readDeadlineMs: 100,
      activationRecoveryDeadlineMs: 100,
    })
    let boundedRevokes = 0
    let observeBoundedRevocation!: () => void
    const boundedRevocation = new Promise<void>(resolve => { observeBoundedRevocation = resolve })
    let releaseBoundedRecovery!: () => void
    const boundedRecovery = new Promise<void>(resolve => { releaseBoundedRecovery = resolve })
    bounded.create(({ connection }) => ({
      activate: async () => {
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        await boundedRecovery
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { boundedRevokes += 1; observeBoundedRevocation() },
    }))
    const boundedClient = await openStreamingSocket(bounded.socketPath)
    boundedClient.socket.write(activationPrepare())
    await boundedClient.nextLine()
    boundedClient.socket.write('{"publication":"bounded"}\n')
    await boundedRevocation
    releaseBoundedRecovery()
    await waitFor(() => boundedClient.socket.destroyed)
    expect(await exchange(bounded.socketPath, activationPrepare())).toBe('')
    expect(boundedRevokes).toBe(1)
    slowClient.socket.destroy()
  })

  test('owner-ready and ready write failures destroy the retained socket and revoke once', async () => {
    const ownerReadyFailure = await activationServerFixture(false, true, {
      beforeActivationFrameWriteForTest: (phase, socket) => {
        if (phase === 'owner_ready') socket.destroy(new Error('owner-ready write failure'))
      },
    })
    let ownerReadyRevokes = 0
    ownerReadyFailure.create(({ connection }) => ({
      activate: async () => {
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { ownerReadyRevokes += 1 },
    }))
    const ownerReadyClient = await openStreamingSocket(ownerReadyFailure.socketPath)
    ownerReadyClient.socket.write(activationPrepare())
    await waitFor(() => ownerReadyRevokes === 1 && ownerReadyClient.socket.destroyed)
    expect(await exchange(ownerReadyFailure.socketPath, activationPrepare())).toBe('')
    expect(ownerReadyRevokes).toBe(1)

    const readyFailure = await activationServerFixture(false, true, {
      beforeActivationFrameWriteForTest: (phase, socket) => {
        if (phase === 'ready') socket.destroy(new Error('ready write failure'))
      },
    })
    let readyRevokes = 0
    readyFailure.create(({ connection }) => ({
      activate: async () => {
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { readyRevokes += 1 },
    }))
    const readyClient = await openStreamingSocket(readyFailure.socketPath)
    readyClient.socket.write(activationPrepare())
    await readyClient.nextLine()
    readyClient.socket.write('{"publication":"ready-write"}\n')
    await waitFor(() => readyRevokes === 1 && readyClient.socket.destroyed)
    expect(await exchange(readyFailure.socketPath, activationPrepare())).toBe('')
    expect(readyRevokes).toBe(1)
  })

  test('RST/error and parent drift destroy the exact activation socket and revoke once', async () => {
    let retainedServerSocket!: Socket
    const errored = await activationServerFixture(false, true, {
      beforeActivationFrameWriteForTest: (phase, socket) => {
        if (phase === 'ready') retainedServerSocket = socket
      },
    })
    let errorRevokes = 0
    errored.create(({ connection }) => ({
      activate: async () => {
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { errorRevokes += 1 },
    }))
    const errorClient = await openStreamingSocket(errored.socketPath)
    errorClient.socket.write(activationPrepare())
    await errorClient.nextLine()
    errorClient.socket.write('{"publication":"error"}\n')
    await errorClient.nextLine()
    retainedServerSocket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    await waitFor(() => errorRevokes === 1 && retainedServerSocket.destroyed && errorClient.socket.destroyed)
    expect(await exchange(errored.socketPath, activationPrepare())).toBe('')
    expect(errorRevokes).toBe(1)

    const drifted = await activationServerFixture()
    let driftConnection!: HostedApprovalActivationConnection
    let releaseRecovery!: () => void
    const recovery = new Promise<void>(resolve => { releaseRecovery = resolve })
    let driftRevokes = 0
    drifted.create(({ connection }) => {
      driftConnection = connection
      return {
        activate: async () => {
          await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
          await recovery
          return '{"kind":"ready"}\n'
        },
        revoke: async () => { driftRevokes += 1 },
      }
    })
    const driftClient = await openStreamingSocket(drifted.socketPath)
    driftClient.socket.write(activationPrepare())
    await driftClient.nextLine()
    driftClient.socket.write('{"publication":"parent-drift"}\n')
    const parent = join(drifted.socketPath, '..')
    const movedParent = join(parent, '..', 'private-moved')
    await rename(parent, movedParent)
    await mkdir(parent, { mode: 0o700 })
    await waitFor(() => driftRevokes === 1 && driftClient.socket.destroyed)
    expect(driftConnection.isCurrent()).toBe(false)
    expect(await exchange(join(movedParent, 'control.sock'), activationPrepare())).toBe('')
    expect(driftRevokes).toBe(1)
    releaseRecovery()
  })

  test('rejects activation pipelining, cross-connection publication and every second activation', async () => {
    const pipelined = await activationServerFixture()
    let factoryCalls = 0
    let revokeCalls = 0
    let releaseOwnerReady!: () => void
    const ownerReadyGate = new Promise<void>(resolve => { releaseOwnerReady = resolve })
    pipelined.create(({ connection }) => ({
      activate: async () => {
        factoryCalls += 1
        await ownerReadyGate
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { revokeCalls += 1 },
    }))
    expect(await exchange(pipelined.socketPath, `${activationPrepare()}{"publication":1}\n`)).toBe('')
    expect(factoryCalls).toBe(0)

    const candidate = await openStreamingSocket(pipelined.socketPath)
    candidate.socket.write(activationPrepare())
    await waitFor(() => factoryCalls === 1)
    candidate.socket.write('{"publication":1}\n')
    await waitFor(() => revokeCalls === 1)
    releaseOwnerReady()
    expect(await exchange(pipelined.socketPath, activationPrepare())).toContain('owner_ready')
    expect(factoryCalls).toBe(2)

    const cross = await activationServerFixture()
    let crossRevokes = 0
    cross.create(({ connection }) => ({
      activate: async () => {
        const publication = await connection.receivePublicationAfterOwnerReady(
          '{"kind":"owner_ready"}\n', 512 * 1024,
        )
        expect(publication).toBe('{"publication":2}\n')
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { crossRevokes += 1 },
    }))
    const retained = await openStreamingSocket(cross.socketPath)
    retained.socket.write(activationPrepare())
    expect(await retained.nextLine()).toContain('owner_ready')
    expect(await exchange(cross.socketPath, activationPrepare())).toBe('')
    expect(await exchange(cross.socketPath, '{"publication":"wrong-socket"}\n')).toBe('')
    retained.socket.write('{"publication":2}\n')
    expect(await retained.nextLine()).toContain('ready')
    expect(await exchange(cross.socketPath, activationPrepare())).toBe('')
    retained.socket.end()
    await waitFor(() => crossRevokes === 1)
  })

  test('does not let an unauthenticated prepare consume the permanent activation slot', async () => {
    const fixture = await activationServerFixture()
    let attempts = 0
    let publicationTransitions = 0
    fixture.create(({ connection }) => ({
      activate: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('unauthenticated')
        publicationTransitions += 1
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => undefined,
    }))
    expect(await exchange(fixture.socketPath, activationPrepare())).toBe('')
    const valid = await openStreamingSocket(fixture.socketPath)
    valid.socket.write(activationPrepare())
    expect(await valid.nextLine()).toContain('owner_ready')
    valid.socket.write('{"publication":1}\n')
    expect(await valid.nextLine()).toContain('ready')
    expect(attempts).toBe(2)
    expect(publicationTransitions).toBe(1)
    valid.socket.destroy()
  })

  test('synchronously fences replacement races and keeps activation independent of readiness', async () => {
    const fixture = await activationServerFixture(true)
    let connection!: HostedApprovalActivationConnection
    let token: { consume(): boolean } | null = null
    let releaseRecovery!: () => void
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
    let revokeCalls = 0
    fixture.create(({ connection: candidate }) => {
      connection = candidate
      return {
        activate: async () => {
          await candidate.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
          token = candidate.prepareEffectToken()
          await recoveryGate
          if (!token!.consume()) throw new Error('stale')
          return '{"kind":"ready"}\n'
        },
        revoke: async () => { revokeCalls += 1 },
      }
    })
    const readiness = await openReadiness(fixture.socketPath, fixture.server.ownerBinding!)
    const activation = await openStreamingSocket(fixture.socketPath)
    activation.socket.write(activationPrepare())
    expect(await activation.nextLine()).toContain('owner_ready')
    activation.socket.write('{"publication":3}\n')
    await waitFor(() => token !== null)

    await unlink(fixture.socketPath)
    const replacement = createServer()
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject)
      replacement.listen(fixture.socketPath, resolve)
    })
    expect(token!.consume()).toBe(false)
    expect(token!.consume()).toBe(false)
    await waitFor(() => revokeCalls === 1 && activation.socket.destroyed)
    expect(connection.isCurrent()).toBe(false)
    expect(await fixture.server.hasActiveLease()).toBe(false)
    // Replacement invalidates the shared pathname identity, but activation
    // revocation itself never consumes or clears the lifecycle lease object.
    expect(readiness.socket.destroyed).toBe(false)
    releaseRecovery()
    await fixture.server.stop()
    expect(revokeCalls).toBe(1)
    readiness.socket.destroy()
    await unlink(fixture.socketPath)
    await new Promise<void>((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()))
  })

  test('activation lease EOF and stop revoke once while ordinary dispatch stays compatible without a factory', async () => {
    const fixture = await activationServerFixture(true)
    let revokeCalls = 0
    fixture.create(({ connection }) => ({
      activate: async () => {
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { revokeCalls += 1 },
    }))
    const readiness = await openReadiness(fixture.socketPath, fixture.server.ownerBinding!)
    const activation = await openStreamingSocket(fixture.socketPath)
    activation.socket.write(activationPrepare())
    await activation.nextLine()
    activation.socket.write('{"publication":4}\n')
    await activation.nextLine()
    activation.socket.end()
    await waitFor(() => revokeCalls === 1)
    expect(await fixture.server.hasActiveLease()).toBe(true)
    expect(await exchange(fixture.socketPath, '{"operation":"probe"}\n')).toContain('ok')
    await fixture.server.stop()
    expect(revokeCalls).toBe(1)
    readiness.socket.destroy()

    const legacy = await activationServerFixture(true, false)
    const lease = await openReadiness(legacy.socketPath, legacy.server.ownerBinding!)
    expect(await exchange(legacy.socketPath, '{"operation":"probe"}\n')).toContain('ok')
    lease.socket.destroy()
  })

  test('stop synchronously revokes an active activation and waits for its cleanup', async () => {
    const fixture = await activationServerFixture()
    let revokeCalls = 0
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
    fixture.create(({ connection }) => ({
      activate: async () => {
        await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { revokeCalls += 1; await cleanup },
    }))
    const activation = await openStreamingSocket(fixture.socketPath)
    activation.socket.write(activationPrepare())
    await activation.nextLine()
    activation.socket.write('{"publication":5}\n')
    await activation.nextLine()
    let stopped = false
    const stopping = fixture.server.stop().then(() => { stopped = true })
    expect(revokeCalls).toBe(1)
    await Bun.sleep(0)
    expect(stopped).toBe(false)
    releaseCleanup()
    await stopping
    expect(stopped).toBe(true)
    expect(revokeCalls).toBe(1)
  })
})

async function activationServerFixture(
  dispatcher = false,
  installFactory = true,
  options: {
    readDeadlineMs?: number
    activationRecoveryDeadlineMs?: number
    beforeActivationFrameWriteForTest?: (
      phase: 'owner_ready' | 'ready', socket: Socket,
    ) => void | Promise<void>
  } = {},
): Promise<{
  socketPath: string
  server: HostedControlServer
  create(factory: (input: { connection: HostedApprovalActivationConnection }) => {
    activate(frame: string): Promise<string>
    revoke(): Promise<void>
  }): void
}> {
  const root = await mkdtemp('/tmp/hc-activation-')
  roots.push(root)
  const socketPath = join(root, 'private', 'control.sock')
  const fixture = hostedControlGoldenRequestFixture()
  const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
  let factory: ((input: { connection: HostedApprovalActivationConnection }) => {
    activate(frame: string): Promise<string>
    revoke(): Promise<void>
  }) | null = null
  const server = new HostedControlServer({
    socketPath,
    secret: Buffer.alloc(32, 9),
    ownerIdentity,
    authority: fixture.authority,
    dispatchCoexistingOperation: dispatcher ? async () => ({ kind: 'ok' }) : undefined,
    ...options,
    activationSessionFactory: installFactory
      ? connection => {
        if (!factory) throw new Error('activation test factory not installed')
        return factory({ connection })
      }
      : undefined,
  })
  servers.push(server)
  await server.start()
  return { socketPath, server, create: value => { factory = value } }
}

function activationPrepare(): string {
  return '{"schemaVersion":2,"operation":"approval_activation_prepare"}\n'
}

function openStreamingSocket(socketPath: string): Promise<{
  socket: Socket
  nextLine(): Promise<string>
}> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffered = ''
    const waiters: Array<(line: string) => void> = []
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffered += chunk
      while (buffered.includes('\n') && waiters.length > 0) {
        const newline = buffered.indexOf('\n')
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        waiters.shift()!(line)
      }
    })
    socket.once('connect', () => resolve({
      socket,
      nextLine: () => new Promise<string>(lineResolve => {
        const newline = buffered.indexOf('\n')
        if (newline >= 0) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          lineResolve(line)
        } else waiters.push(lineResolve)
      }),
    }))
    socket.once('error', reject)
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(2)
  }
  throw new Error('condition was not reached')
}

function withinMs(promise: Promise<void>, ms: number): Promise<void> {
  return Promise.race([promise, new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`not settled within ${ms}ms`)), ms))])
}

function openReadiness(socketPath: string, ownerBinding: NonNullable<HostedControlServer['ownerBinding']>): Promise<{ socket: ReturnType<typeof connect>; line: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let output = ''; socket.setEncoding('utf8')
    socket.once('connect', () => {
      const unsigned = { schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command', socketIdentity: ownerBinding.socketIdentity, challenge: 'a'.repeat(64) }
      socket.write(`${JSON.stringify({ ...unsigned, ownerProof: createHostedDomainProof(Buffer.alloc(32, 9), HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', unsigned) })}\n`)
    })
    socket.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve({ socket, line: output.trim() }) })
    socket.once('error', reject)
  })
}

function legacyReadinessLine(ownerBinding: NonNullable<HostedControlServer['ownerBinding']>): string {
  const unsigned = { schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command', socketIdentity: ownerBinding.socketIdentity, challenge: 'a'.repeat(64) }
  return `${JSON.stringify({ ...unsigned, ownerProof: createHostedDomainProof(Buffer.alloc(32, 9), HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', unsigned) })}\n`
}

function descriptorReadinessLine(
  secret: Uint8Array,
  ownerBinding: NonNullable<HostedControlServer['ownerBinding']>,
  bootstrapBinding: HostedControlBootstrapBinding,
): string {
  const unsigned = { schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command',
    socketIdentity: ownerBinding.socketIdentity, challenge: 'b'.repeat(64), bootstrapBinding,
    expectedOwnerBinding: ownerBinding }
  return `${JSON.stringify({ ...unsigned, controllerProof: createHostedDomainProof(secret,
    HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', unsigned) })}\n`
}

function openDescriptorReadiness(
  socketPath: string,
  secret: Uint8Array,
  ownerBinding: NonNullable<HostedControlServer['ownerBinding']>,
  bootstrapBinding: HostedControlBootstrapBinding,
): Promise<{ socket: ReturnType<typeof connect>; line: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let output = ''; socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(descriptorReadinessLine(secret, ownerBinding, bootstrapBinding)))
    socket.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve({ socket, line: output.trim() }) })
    socket.once('error', reject)
  })
}

/** The retired task-board frame, signed as its last client did. */
function legacyTaskLine(secret: Uint8Array, unsigned: Record<string, unknown>): string {
  const proof = createHmac('sha256', secret)
    .update(`agent-teams.hosted-task-board.owner-proof/v1\0request\0${JSON.stringify(unsigned)}`)
    .digest('hex')
  return `${JSON.stringify({ ...unsigned, ownerProof: proof })}\n`
}

function exchange(socketPath: string, input: string): Promise<string> {
  return exchangeBytes(socketPath, Buffer.from(input))
}

function exchangeBytes(socketPath: string, input: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let output = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(input))
    socket.on('data', chunk => {
      output += chunk
      if (output.includes('\n')) socket.destroy()
    })
    socket.once('end', () => resolve(output.trim()))
    socket.once('close', () => resolve(output.trim()))
    socket.once('error', reject)
  })
}
