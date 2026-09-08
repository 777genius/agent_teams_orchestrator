import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, unlink } from 'node:fs/promises'
import { connect, createServer, Socket, type Server } from 'node:net'
import type { HostedControlConnection } from './HostedControlConnection.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostedControlProof, createHostedDomainProof, createHostedRawDomainProof, verifyHostedControlProof } from './ownerProof.js'
import { decodeHostedTaskMutationRequest, hostedControlGoldenRequestFixture, type HostedTaskMutationResponse } from './protocol.js'
import { admitHostedReadiness, HOSTED_LIFECYCLE_PROOF_DOMAIN, HostedControlServer, type HostedTaskMutationPort } from './HostedControlServer.js'
import type { HostedControlBootstrapBinding } from './HostedControlBootstrap.js'
import type { HostedApprovalActivationConnection } from './HostedApprovalActivationSession.js'

const roots: string[] = []
const servers: HostedControlServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('HostedControlServer', () => {
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
    const service = { mutate: async () => ({ kind: 'unavailable' as const }) } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service })
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

  test('accepts exactly one authenticated JSON line and signs the response direction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-test-'))
    roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture()
    const service = {
      mutate: async () => ({ kind: 'unavailable' as const }),
    } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service, dispatchCoexistingOperation: async () => null })
    servers.push(server)
    await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!); const ready = JSON.parse(lease.line) as Record<string, unknown>; const { ownerProof, ...unsignedReady } = ready
    expect(Object.keys(ready)).toEqual(['schemaVersion', 'kind', 'capability', 'challenge', 'ownerBinding', 'ownerProof'])
    expect(ownerProof).toBe(createHostedDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', unsignedReady))
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding! }
    const request = { ...requestUnsigned, ownerProof: createHostedControlProof(secret, 'request', requestUnsigned) }

    const line = await exchange(socketPath, `${JSON.stringify(request)}\n`)
    const response = JSON.parse(line) as HostedTaskMutationResponse
    expect(response.payload).toEqual({ kind: 'unavailable' })
    expect(verifyHostedControlProof(secret, 'response', response)).toBe(true)
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
      bootstrapBinding, service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service: { mutate: async () => ({ kind: 'unavailable' as const }) }, dispatchCoexistingOperation: async () => null }); servers.push(server); await server.start()
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) }, dispatchCoexistingOperation: async () => null })
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
    const service = { mutate: async () => ({ kind: 'unavailable' as const }) } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service, dispatchCoexistingOperation: async () => null })
    servers.push(server)
    await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!); expect(lease.line).toContain('"kind":"ready"')
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding! }
    const request = { ...requestUnsigned, ownerProof: createHostedControlProof(secret, 'request', requestUnsigned) }
    expect(await exchange(socketPath, `${JSON.stringify(request)}\n{}\n`)).toBe('')
  })

  test('rejects malformed UTF-8 without conflating it with a literal replacement character', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-utf8-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const unsigned = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let values: unknown[] = []
    const server = new HostedControlServer({
      socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority,
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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

  test('does not return a mutation receipt after the readiness lease closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-lease-test-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    let release!: () => void; let markStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { markStarted = resolve })
    let markCompleted!: () => void; let markLost!: () => void
    const completed = new Promise<void>(resolve => { markCompleted = resolve })
    const lost = new Promise<void>(resolve => { markLost = resolve })
    let server!: HostedControlServer
    let originalLeaseStillValid = true
    const service = { mutate: async () => { markStarted(); await gate; originalLeaseStillValid = await server.hasActiveLease(); markCompleted(); return { kind: 'unavailable' as const } } } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service, onProviderAuthorityLost: () => markLost(), dispatchCoexistingOperation: async () => null }); servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding! }; const request = { ...requestUnsigned, ownerProof: createHostedControlProof(secret, 'request', requestUnsigned) }
    const pending = exchange(socketPath, `${JSON.stringify(request)}\n`); await started; lease.socket.destroy()
    await lost
    expect(await exchange(socketPath, `${JSON.stringify({ schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command', socketIdentity: server.ownerBinding!.socketIdentity, challenge: 'b'.repeat(64) })}\n`)).toBe('')
    release()
    expect(await pending).toBe('')
    // Eager response close can settle pending before the released service resumes.
    await completed
    await server.stop() // Drain the actual handler, including its reply fence.
    expect(originalLeaseStillValid).toBe(false)
  })

  test('does not sign a committed task result substituted by the injected mutation port', async () => {
    const root = await mkdtemp('/tmp/hc-task-correlation-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture()
    const command = unsigned.payload.command
    const receipt = {
      schemaVersion: 1 as const,
      outcome: 'committed' as const,
      commandId: command.commandId,
      teamId: command.teamId,
      sourceGeneration: command.expectedSourceGeneration,
      revision: command.expectedRevision,
      affectedTaskIds: [],
    }
    const valid = {
      kind: 'committed' as const,
      currentSourceGeneration: command.expectedSourceGeneration,
      payloadFingerprint: unsigned.payload.payloadFingerprint,
      receipt,
    }
    const substituted = [
      { ...valid, payloadFingerprint: 'A'.repeat(43) },
      { ...valid, receipt: { ...receipt, commandId: 'command_substituted' } },
      { ...valid, receipt: { ...receipt, teamId: `team_${'f'.repeat(32)}` } },
      {
        ...valid,
        currentSourceGeneration: 'generation_substituted',
        receipt: { ...receipt, sourceGeneration: 'generation_substituted' },
      },
    ]
    let response = substituted.shift() ?? valid
    const service = { mutate: async () => response } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({
      socketPath,
      secret,
      ownerIdentity,
      authority: unsigned.authority,
      service,
      dispatchCoexistingOperation: async () => null,
    })
    servers.push(server)
    await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding! }
    const request = { ...requestUnsigned, ownerProof: createHostedControlProof(secret, 'request', requestUnsigned) }
    while (response !== valid) {
      expect(await exchange(socketPath, `${JSON.stringify(request)}\n`)).toBe('')
      response = substituted.shift() ?? valid
    }
    const accepted = JSON.parse(await exchange(socketPath, `${JSON.stringify(request)}\n`)) as HostedTaskMutationResponse
    expect(accepted.payload).toEqual(valid)
    expect(verifyHostedControlProof(secret, 'response', accepted)).toBe(true)
    lease.socket.destroy()
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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

  test('stop drains every admitted mutation and coexisting handler before resolving', async () => {
    const root = await mkdtemp('/tmp/hc-stop-drain-'); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const unsigned = hostedControlGoldenRequestFixture()
    let releaseMutation!: () => void
    let releaseCoexisting!: () => void
    let markMutationStarted!: () => void
    let markCoexistingStarted!: () => void
    const mutationGate = new Promise<void>(resolve => { releaseMutation = resolve })
    const coexistingGate = new Promise<void>(resolve => { releaseCoexisting = resolve })
    const mutationStarted = new Promise<void>(resolve => { markMutationStarted = resolve })
    const coexistingStarted = new Promise<void>(resolve => { markCoexistingStarted = resolve })
    const completed: string[] = []
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({
      socketPath, secret, ownerIdentity, authority: unsigned.authority,
      service: { mutate: async () => {
        markMutationStarted(); await mutationGate; completed.push('mutation')
        return { kind: 'unavailable' as const }
      } },
      dispatchCoexistingOperation: async () => {
        markCoexistingStarted(); await coexistingGate; completed.push('coexisting')
        return { kind: 'ok' }
      },
    })
    servers.push(server)
    await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding! }
    const request = { ...requestUnsigned, ownerProof: createHostedControlProof(secret, 'request', requestUnsigned) }
    const mutation = exchange(socketPath, `${JSON.stringify(request)}\n`)
    const coexisting = exchange(socketPath, `${JSON.stringify({ operation: 'control_state' })}\n`)
    await Promise.all([mutationStarted, coexistingStarted])
    let stopped = false
    const stopping = server.stop().then(() => { stopped = true })
    await Bun.sleep(0)
    expect(stopped).toBe(false)
    releaseMutation()
    await Bun.sleep(0)
    expect(stopped).toBe(false)
    releaseCoexisting()
    await stopping
    expect(completed.sort()).toEqual(['coexisting', 'mutation'])
    expect(stopped).toBe(true)
    lease.socket.destroy()
    await Promise.all([mutation, coexisting])
  })

  test('rejects a validly signed request for any authority other than the configured authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-authority-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    let calls = 0
    const service = { mutate: async () => { calls += 1; return { kind: 'unavailable' as const } } } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service, dispatchCoexistingOperation: async () => null }); servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding!, authority: { ...unsigned.authority, bootId: 'other-boot' } }
    const request = { ...requestUnsigned, ownerProof: createHostedControlProof(secret, 'request', requestUnsigned) }
    expect(await exchange(socketPath, `${JSON.stringify(request)}\n`)).toBe('')
    expect(calls).toBe(0)
    lease.socket.destroy()
  })

  test('frames the complete bounded JSON before dispatching an operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-server-framing-')); roots.push(root)
    const socketPath = join(root, 'private', 'control.sock'); const secret = Buffer.alloc(32, 9); const unsigned = hostedControlGoldenRequestFixture()
    const service = { mutate: async () => ({ kind: 'unavailable' as const }) } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    let dispatched = ''
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service, dispatchCoexistingOperation: async message => { dispatched = String(message.operation); return { kind: 'ok' } } }); servers.push(server); await server.start()
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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
    const server = new HostedControlServer({ socketPath, secret: Buffer.alloc(32, 9), ownerIdentity, authority: unsigned.authority, service: { mutate: async () => ({ kind: 'unavailable' as const }) } }); servers.push(server); await server.start()
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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

  test('provider adoption requires the retained ready write and a separate lifecycle lease', async () => {
    for (const withLease of [false, true]) {
      let calls = 0; let revokes = 0; let readyWriteStarted = false; let authorityLosses = 0
      const fixture = await activationServerFixture(true, true, {
        beforeActivationFrameWriteForTest: phase => {
          if (phase === 'ready') {
            expect(calls).toBe(0)
            expect(fixture.server.prepareRetainedProviderToken()).toBeNull()
            readyWriteStarted = true
          }
        },
        onActivationReady: async () => { expect(readyWriteStarted).toBe(true); calls++ },
        onProviderAuthorityLost: () => { authorityLosses++ },
      })
      const lease = withLease ? await openReadiness(fixture.socketPath, fixture.server.ownerBinding!) : null
      expect(fixture.server.prepareRetainedProviderToken()).toBeNull()
      fixture.create(({ connection }) => ({
        activate: async () => {
          await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
          return '{"kind":"ready"}\n'
        },
        revoke: async () => { revokes++ },
      }))
      const client = await openStreamingSocket(fixture.socketPath)
      client.socket.write(activationPrepare())
      await client.nextLine()
      client.socket.write('{"publication":"provider-adoption"}\n')
      await client.nextLine()
      if (withLease) {
        await waitFor(() => calls === 1)
        expect(fixture.server.hasRetainedActivation()).toBe(true)
        const positive = fixture.server.prepareRetainedProviderToken()!
        expect(positive.consume()).toBe(true)
        expect(positive.consume()).toBe(false)
        const pending = fixture.server.prepareRetainedProviderToken()!
        lease!.socket.destroy()
        await waitFor(() => fixture.server.prepareRetainedProviderToken() === null)
        expect(authorityLosses).toBe(1)
        expect(pending.consume()).toBe(false)
        expect(pending.consume()).toBe(false)
      } else {
        await waitFor(() => revokes === 1)
        expect(calls).toBe(0)
        expect(fixture.server.hasRetainedActivation()).toBe(false)
        expect(fixture.server.prepareRetainedProviderToken()).toBeNull()
      }
      client.socket.destroy(); lease?.socket.destroy()
      await fixture.server.stop()
      expect(authorityLosses).toBe(1)
    }
  })

  test('RST/error and parent drift destroy the exact activation socket and revoke once', async () => {
    let retainedServerSocket!: Socket
    const errored = await activationServerFixture(false, true, {
      beforeActivationFrameWriteForTest: (phase, socket) => {
        if (phase === 'ready') {
          if (!(socket instanceof Socket)) throw new Error('Legacy transport must remain a node:net Socket')
          retainedServerSocket = socket
        }
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
    onActivationReady?: () => Promise<void>
    onProviderAuthorityLost?: () => void
    beforeSocketCloseForTest?: (listenPath: string) => void | Promise<void>
    beforeActivationDrainForTest?: (revocation: Promise<void>) => void
    afterBrokerTargetCreatedForTest?: (server: Server, token: Buffer) => void
    beforeActivationFrameWriteForTest?: (
      phase: 'owner_ready' | 'ready', socket: HostedControlConnection,
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
    service: { mutate: async () => ({ kind: 'unavailable' as const }) },
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

// Existing real helper entrypoint; these are lifecycle server tests, not native
// A+B runtime/admission fixtures. Root runs them in the authorized sandbox.
describe('HostedControlServer bounded broker publication', () => {
  async function pair(hooks: Array<Partial<ConstructorParameters<typeof HostedControlServer>[0]>> = []) {
    const root = await mkdtemp('/tmp/hc-pair-'); roots.push(root)
    const fixture = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
    const secret = Buffer.alloc(32, 9)
    const pids: number[] = []
    const children = new Set<ChildProcess>()
    const exitedChildren = new Set<ChildProcess>()
    const closedChildren = new Set<ChildProcess>()
    const targets: Array<{ server: Server; token: Buffer; originalToken: Buffer; closed: boolean;
      accepted: Socket[]; closedPeers: Set<Socket> }> = []
    const paths = [join(root, 'a.sock'), join(root, 'b.sock')]
    const pair = paths.map((socketPath, index) => new HostedControlServer({
      socketPath, secret, ownerIdentity, authority: fixture.authority,
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
      dispatchCoexistingOperation: async () => ({ kind: `slot-${index}` }),
      ...hooks[index],
      afterBrokerSpawnForTest: child => {
        if (!children.has(child)) {
          children.add(child)
          child.once('exit', () => exitedChildren.add(child))
          child.once('close', () => closedChildren.add(child))
        }
        hooks[index]?.afterBrokerSpawnForTest?.(child)
      },
      afterBrokerTargetCreatedForTest: (server, token) => {
        const target = { server, token, originalToken: Buffer.from(token), closed: false,
          accepted: [] as Socket[], closedPeers: new Set<Socket>() }
        targets.push(target)
        server.once('close', () => { target.closed = true })
        server.on('connection', socket => {
          target.accepted.push(socket)
          socket.once('close', () => target.closedPeers.add(socket))
        })
        hooks[index]?.afterBrokerTargetCreatedForTest?.(server, token)
      },
      afterSocketPublicationForTest: async pid => {
        pids.push(pid)
        await hooks[index]?.afterSocketPublicationForTest?.(pid)
      },
    }))
    servers.push(...pair)
    const holdTargetPeers = async () => {
      await Promise.all(targets.map(async target => {
        const address = target.server.address()
        if (!address || typeof address === 'string') throw new Error('Missing actual target listener')
        const accepted = new Promise<void>(resolve => target.server.once('connection', () => resolve()))
        const client = connect({ host: '127.0.0.1', port: address.port })
        client.on('error', () => undefined)
        client.resume()
        await accepted
        expect(target.accepted.at(-1)!.destroyed).toBe(false)
      }))
    }
    const assertDrained = async (names: string[] = [], targetCount = 2, childCount = 1) => {
      expect(targets.length).toBe(targetCount)
      expect(children.size).toBe(childCount)
      expect(exitedChildren.size).toBe(childCount)
      expect(closedChildren.size).toBe(childCount)
      for (const target of targets) {
        expect(target.server.listening).toBe(false)
        expect(target.closed).toBe(true)
        expect(target.token.equals(Buffer.alloc(32))).toBe(true)
        expect(target.closedPeers.size).toBe(target.accepted.length)
        expect(target.accepted.every(peer => peer.destroyed)).toBe(true)
      }
      for (const child of children) expect(() => process.kill(child.pid!, 0)).toThrow()
      expect(secret.equals(Buffer.alloc(32, 9))).toBe(true)
      expect((await readdir(root)).sort()).toEqual(names.sort())
    }
    return { root, paths, pair, secret, pids, targets, children, exitedChildren, closedChildren,
      holdTargetPeers, assertDrained }
  }

  test('two lifecycle endpoints use one PID; stopping one preserves the sibling lease and parent secret', async () => {
    const fixture = await pair()
    await HostedControlServer.startBatch(fixture.pair)
    const [a, b] = fixture.pair as [HostedControlServer, HostedControlServer]
    expect(fixture.children.size).toBe(1)
    expect(fixture.targets.length).toBe(2)
    expect(fixture.targets.every(target => target.server.listening)).toBe(true)
    expect((await readdir(fixture.root)).sort()).toEqual(['a.sock', 'b.sock'])
    expect(fixture.pids.length).toBe(2)
    expect(new Set(fixture.pids).size).toBe(1)
    expect(a.ownerBinding!.socketIdentity).not.toEqual(b.ownerBinding!.socketIdentity)
    const leases = await Promise.all(fixture.paths.map((path, index) => openReadiness(path, fixture.pair[index]!.ownerBinding!)))
    expect(await a.hasActiveLease()).toBe(true)
    expect(await b.hasActiveLease()).toBe(true)
    await a.stop()
    expect(await a.hasActiveLease()).toBe(false)
    expect(await b.hasActiveLease()).toBe(true)
    expect(fixture.targets[0]!.closed).toBe(true)
    expect(fixture.targets[0]!.token.equals(Buffer.alloc(32))).toBe(true)
    expect(fixture.targets[0]!.closedPeers.size).toBe(fixture.targets[0]!.accepted.length)
    expect(fixture.targets[1]!.server.listening).toBe(true)
    expect(fixture.targets[1]!.token.equals(fixture.targets[1]!.originalToken)).toBe(true)
    expect(fixture.closedChildren.size).toBe(0)
    expect(fixture.secret.equals(Buffer.alloc(32, 9))).toBe(true)
    expect(await exchange(fixture.paths[1]!, '{"operation":"team_message"}\n')).toContain('slot-1')
    expect(() => process.kill(fixture.pids[0]!, 0)).not.toThrow()
    await b.stop()
    expect(() => process.kill(fixture.pids[0]!, 0)).toThrow()
    for (const path of fixture.paths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const lease of leases) lease.socket.destroy()
    await fixture.assertDrained()
  })

  test('shared broker loss fences every published server and readiness lease', async () => {
    const lost = [false, false]
    let allLost!: () => void
    const loss = new Promise<void>(resolve => { allLost = resolve })
    const fixture = await pair([0, 1].map(index => ({ onProviderAuthorityLost: () => {
      lost[index] = true
      if (lost.every(Boolean)) allLost()
    } })))
    await HostedControlServer.startBatch(fixture.pair)
    const leases = await Promise.all(fixture.paths.map((path, index) => openReadiness(path, fixture.pair[index]!.ownerBinding!)))
    // Hold target reads so a lease EOF cannot be mistaken for the shared child
    // loss notification. Child exit must drive the synchronous owner fence.
    for (const target of fixture.targets) for (const peer of target.accepted) if (!peer.destroyed) peer.pause()
    const child = [...fixture.children][0]!
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    process.kill(fixture.pids[0]!, 'SIGKILL')
    await Promise.all([loss, exited])
    for (const server of fixture.pair) {
      expect(await server.hasActiveLease()).toBe(false)
      expect(server.prepareRetainedProviderToken()).toBeNull()
      expect(server.ownerBinding).toBeNull()
    }
    await Promise.all(fixture.pair.map(server => server.stop()))
    for (const path of fixture.paths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const lease of leases) lease.socket.destroy()
    await fixture.assertDrained()
  })

  test('shared loss rejects sibling activation tokens before the sibling loss callback runs', async () => {
    const connections: HostedApprovalActivationConnection[] = []
    let siblingToken: { consume(): boolean } | null = null
    let consumedDuringFirstLoss: boolean | undefined
    let siblingLost = false
    let siblingNotYetNotified = false
    let bindingsDuringFirstLoss: Array<HostedControlServer['ownerBinding']> = []
    let firstLost!: () => void
    const loss = new Promise<void>(resolve => { firstLost = resolve })
    let fixture!: Awaited<ReturnType<typeof pair>>
    fixture = await pair([0, 1].map(index => ({
      activationSessionFactory: (connection: HostedApprovalActivationConnection) => {
        connections[index] = connection
        return {
          activate: async () => {
            await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
            return '{"kind":"ready"}\n'
          },
          revoke: async () => undefined,
        }
      },
      onProviderAuthorityLost: () => {
        if (index === 0) {
          siblingNotYetNotified = !siblingLost
          bindingsDuringFirstLoss = fixture.pair.map(server => server.ownerBinding)
          consumedDuringFirstLoss = siblingToken?.consume()
          firstLost()
        } else siblingLost = true
      },
    })))
    await HostedControlServer.startBatch(fixture.pair)
    const clients = await Promise.all(fixture.paths.map(path => openStreamingSocket(path)))
    for (const client of clients) {
      client.socket.write(activationPrepare())
      expect(await client.nextLine()).toContain('owner_ready')
      client.socket.write('{"publication":1}\n')
      expect(await client.nextLine()).toContain('ready')
    }
    await waitFor(() => fixture.pair.every(server => server.hasRetainedActivation()))
    siblingToken = connections[1]!.prepareEffectToken()
    expect(siblingToken).not.toBeNull()
    expect(connections[1]!.isCurrent()).toBe(true)
    // Keep actual accepted activation peers open until the broker's shared
    // exit callback, rather than accidentally testing independent peer EOF.
    for (const target of fixture.targets) for (const peer of target.accepted) if (!peer.destroyed) peer.pause()
    process.kill(fixture.pids[0]!, 'SIGKILL')
    await loss
    expect(siblingNotYetNotified).toBe(true)
    expect(bindingsDuringFirstLoss).toEqual([null, null])
    expect(consumedDuringFirstLoss).toBe(false)
    for (const server of fixture.pair) expect(server.hasRetainedActivation()).toBe(false)
    await Promise.all(fixture.pair.map(server => server.stop()))
    for (const client of clients) client.socket.destroy()
    await fixture.assertDrained()
  })

  test('failure preparing B drains A before launching any broker', async () => {
    const fixture = await pair()
    await mkdir(fixture.paths[1]!)
    await expect(HostedControlServer.startBatch(fixture.pair)).rejects.toThrow('unsafe')
    expect(fixture.pids).toEqual([])
    expect(fixture.children.size).toBe(0)
    expect(fixture.pair.every(server => server.ownerBinding === null)).toBe(true)
    await expect(lstat(fixture.paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(fixture.paths[1]!)).isDirectory()).toBe(true)
    await fixture.assertDrained(['b.sock'], 1, 0)
  })

  test('partial attachment failure drains both publications and does not admit early traffic', async () => {
    const hidden: string[] = []
    let fixture!: Awaited<ReturnType<typeof pair>>
    fixture = await pair([
      { beforeSocketCloseForTest: path => { hidden.push(path) } },
      { afterSocketPublicationForTest: async () => {
        const binding = fixture.pair[0]!.ownerBinding!
        expect(binding).not.toBeNull()
        const request = legacyReadinessLine(binding)
        expect(admitHostedReadiness({ secret: fixture.secret, ownerBinding: binding,
          line: request.trim(), message: JSON.parse(request) })).toBe(true)
        expect(await exchange(fixture.paths[0]!, request)).toBe('')
        await fixture.holdTargetPeers()
        throw new Error('injected attachment failure')
      }, beforeSocketCloseForTest: path => { hidden.push(path) } },
    ])
    await expect(HostedControlServer.startBatch(fixture.pair)).rejects.toThrow('injected attachment failure')
    expect(new Set(fixture.pids).size).toBe(1)
    expect(fixture.pair.every(server => server.ownerBinding === null)).toBe(true)
    expect(() => process.kill(fixture.pids[0]!, 0)).toThrow()
    expect(hidden.length).toBe(2)
    for (const path of [...fixture.paths, ...hidden]) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.targets.every(target => target.accepted.length >= 2)).toBe(true)
    await fixture.assertDrained()
  })

  test('equivalent authenticated readiness is denied in B publication and succeeds after the batch', async () => {
    let fixture!: Awaited<ReturnType<typeof pair>>
    let request = ''
    fixture = await pair([{}, { afterSocketPublicationForTest: async () => {
      const binding = fixture.pair[0]!.ownerBinding!
      expect(binding).not.toBeNull()
      request = legacyReadinessLine(binding)
      expect(admitHostedReadiness({ secret: fixture.secret, ownerBinding: binding,
        line: request.trim(), message: JSON.parse(request) })).toBe(true)
      expect(await exchange(fixture.paths[0]!, request)).toBe('')
      expect(await fixture.pair[0]!.hasActiveLease()).toBe(false)
    } }])
    await HostedControlServer.startBatch(fixture.pair)
    expect(request).toBe(legacyReadinessLine(fixture.pair[0]!.ownerBinding!))
    const ready = JSON.parse(await exchange(fixture.paths[0]!, request))
    const { ownerProof, ...unsigned } = ready
    expect(ready).toMatchObject({ kind: 'ready', ownerBinding: fixture.pair[0]!.ownerBinding })
    expect(ownerProof).toBe(createHostedDomainProof(fixture.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', unsigned))
    await Promise.all(fixture.pair.map(server => server.stop()))
    await fixture.assertDrained()
  })

  test('partial publication detects substitution and preserves B replacement while cleaning A', async () => {
    let fixture!: Awaited<ReturnType<typeof pair>>
    const replacement = createServer(socket => socket.end('replacement'))
    let inode = 0
    fixture = await pair([{}, { afterSocketPublicationForTest: async () => {
      const path = fixture.paths[1]!
      await unlink(path)
      await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(path, resolve) })
      inode = (await lstat(path)).ino
    } }])
    try {
      await expect(HostedControlServer.startBatch(fixture.pair)).rejects.toThrow('changed during publication')
      await expect(lstat(fixture.paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await lstat(fixture.paths[1]!)).ino).toBe(inode)
      expect(await exchange(fixture.paths[1]!, '')).toBe('replacement')
      expect(() => process.kill(fixture.pids[0]!, 0)).toThrow()
      await fixture.assertDrained(['b.sock'])
    } finally {
      await new Promise<void>(resolve => replacement.close(() => resolve()))
    }
  })

  test('no-replace publication preserves a listener appearing at B after preparation', async () => {
    let fixture!: Awaited<ReturnType<typeof pair>>
    const replacement = createServer(socket => socket.end('replacement'))
    let inode = 0
    fixture = await pair([{ afterSocketPublicationForTest: async () => {
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject); replacement.listen(fixture.paths[1]!, resolve)
      })
      inode = (await lstat(fixture.paths[1]!)).ino
    } }])
    try {
      await expect(HostedControlServer.startBatch(fixture.pair)).rejects.toMatchObject({ code: 'EEXIST' })
      expect((await lstat(fixture.paths[1]!)).ino).toBe(inode)
      expect(await exchange(fixture.paths[1]!, '')).toBe('replacement')
      await expect(lstat(fixture.paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(() => process.kill(fixture.pids[0]!, 0)).toThrow()
      await fixture.assertDrained(['b.sock'])
    } finally { await new Promise<void>(resolve => replacement.close(() => resolve())) }
  })

  test('stopping a borrowed participant during attachment aborts and drains the whole batch', async () => {
    let fixture!: Awaited<ReturnType<typeof pair>>
    fixture = await pair([{ afterSocketPublicationForTest: async () => {
      await fixture.holdTargetPeers()
      await fixture.pair[1]!.stop()
    } }])
    await expect(HostedControlServer.startBatch(fixture.pair)).rejects.toThrow('attachment is unavailable')
    expect(fixture.pair.every(server => server.ownerBinding === null)).toBe(true)
    for (const path of fixture.paths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => process.kill(fixture.pids[0]!, 0)).toThrow()
    expect(fixture.targets.every(target => target.accepted.length > 0)).toBe(true)
    await fixture.assertDrained()
  })

  test('bounded count and overlapping batches cannot take or stop an existing participant', async () => {
    const fixture = await pair()
    await expect(HostedControlServer.startBatch([])).rejects.toThrow('one or two')
    await expect(HostedControlServer.startBatch([...fixture.pair, fixture.pair[0]!])).rejects.toThrow('one or two')
    await expect(HostedControlServer.startBatch([fixture.pair[0]!, fixture.pair[0]!])).rejects.toThrow('distinct')
    const starting = HostedControlServer.startBatch(fixture.pair)
    await expect(fixture.pair[0]!.start()).rejects.toThrow('already started')
    await starting
    expect(fixture.pair.every(server => server.ownerBinding !== null)).toBe(true)
    await Promise.all(fixture.pair.map(server => server.stop()))
    await fixture.assertDrained()
  })
})


describe('HostedControlServer explicit legacy isolation', () => {
  test('publishes explicit legacy readiness and drains only its owned paths and child', async () => {
    const root = await mkdtemp('/tmp/hc-legacy-server-'); roots.push(root)
    const socketPath = join(root, 'control.sock')
    const fixture = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
    const secret = Buffer.alloc(32, 9)
    let child!: ChildProcess
    let closed = false
    let schema = ''
    const server = new HostedControlServer({ socketPath, secret, ownerIdentity,
      brokerTransport: 'legacy', authority: fixture.authority,
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
      dispatchCoexistingOperation: async () => null,
      afterBrokerSpawnForTest: broker => {
        child = broker
        broker.stdout!.on('data', chunk => { schema += chunk.toString() })
        broker.once('close', () => { closed = true })
      },
    })
    servers.push(server)
    await server.start()
    expect(schema).toBe('{"schemaVersion":1,"kind":"ready"}\n')
    expect(child.spawnargs.slice(-2)[0]).not.toBe(socketPath)
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    expect(JSON.parse(lease.line).kind).toBe('ready')
    lease.socket.destroy()
    await server.stop()
    await server.stop()
    expect(closed).toBe(true)
    expect(server.ownerBinding).toBeNull()
    expect(await readdir(root)).toEqual([])
    expect(secret).toEqual(Buffer.alloc(32, 9))
    expect(() => process.kill(child.pid!, 0)).toThrow()
  }, 10_000)

  test('rejects explicit legacy in startBatch and inherited-v2 before any spawn', async () => {
    const root = await mkdtemp('/tmp/hc-no-downgrade-'); roots.push(root)
    const fixture = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
    let spawns = 0
    const options = { socketPath: join(root, 'control.sock'), secret: Buffer.alloc(32, 9),
      ownerIdentity, authority: fixture.authority, brokerTransport: 'legacy' as const,
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
      afterBrokerSpawnForTest: () => { spawns += 1 },
    }
    const legacy = new HostedControlServer(options); servers.push(legacy)
    await expect(HostedControlServer.startBatch([legacy])).rejects.toThrow('cannot select legacy')
    const sealed = new HostedControlServer({ ...options, activationTransport: 'inherited-v2' })
    servers.push(sealed)
    await expect(sealed.start()).rejects.toThrow('requires native broker')
    expect(spawns).toBe(0)
    expect(await readdir(root)).toEqual([])
  })

  test.skipIf(process.platform !== 'darwin')('Darwin native singleton rejects without launching legacy', async () => {
    const root = await mkdtemp('/tmp/hc-darwin-native-'); roots.push(root)
    const fixture = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = fixture.ownerBinding
    const args: string[][] = []
    const server = new HostedControlServer({ socketPath: join(root, 'control.sock'),
      secret: Buffer.alloc(32, 9), ownerIdentity, authority: fixture.authority,
      brokerTransport: 'native-batch',
      service: { mutate: async () => ({ kind: 'unavailable' as const }) },
      afterBrokerSpawnForTest: child => { args.push([...child.spawnargs]) },
    })
    servers.push(server)
    await expect(server.start()).rejects.toThrow()
    expect(args.length).toBe(1)
    expect(args[0]!.length).toBe(2) // executable + native no-argv fixture
    expect(await readdir(root)).toEqual([])
    expect(server.ownerBinding).toBeNull()
  }, 10_000)
})

// Actual server + native broker + canonical HMAC readiness. These source tests
// require root's qualified Bun/helper environment; no selected-launch claim.
describe('HostedControlServer actual request FIN', () => {
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>(accept => { resolve = accept })
    return { promise, resolve }
  }

  async function fixture(withActivation = false) {
    const root = await mkdtemp('/tmp/hc-fin-'); roots.push(root)
    const socketPath = join(root, 'control.sock')
    const secret = Buffer.alloc(32, 9)
    const golden = hostedControlGoldenRequestFixture()
    const { socketIdentity: _, ...ownerIdentity } = golden.ownerBinding
    const bootstrapBinding = {
      deploymentId: golden.authority.deploymentId, bootId: golden.authority.bootId,
      workspaceId: golden.authority.workspaceId,
      mountGeneration: golden.authority.mountBinding.mountGeneration,
      bootstrapDigest: '3'.repeat(64), ownerArtifactDigest: `sha256:${'4'.repeat(64)}`,
      proofKeyId: createHash('sha256').update(secret).digest('hex'),
    }
    const entered = deferred(), gate = deferred(), lost = deferred(), closing = deferred()
    const peers: Socket[] = [], closedPeers = new Set<Socket>(), clients: Socket[] = []
    let target!: Server, token!: Buffer, targetClosed = false, brokerExited = false, brokerClosed = false
    const mutationInputs: unknown[] = []
    let calls = 0, rejectHandler = false
    const finish = async () => { calls++; entered.resolve(); await gate.promise; if (rejectHandler) throw new Error('port rejected after FIN') }
    const { HostedControlDispatcher } = await import('./HostedControlDispatcher.js')
    const dispatcher = new HostedControlDispatcher({ secret, authority: golden.authority,
      getOwnerBinding: () => server.ownerBinding,
      lifecycle: { dispatch: async () => { await finish(); return { payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null } } },
      messages: { dispatch: async () => { throw new Error('unexpected message port') } },
    })
    const server: HostedControlServer = new HostedControlServer({ socketPath, secret, ownerIdentity,
      authority: golden.authority, bootstrapBinding,
      // Optional synthetic session exercises retained transport loss only.
      activationSessionFactory: withActivation ? connection => ({
        activate: async () => {
          await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
          return '{"kind":"ready"}\n'
        },
        revoke: async () => undefined,
      }) : undefined,
      service: { mutate: async request => { mutationInputs.push(request); await finish(); return { kind: 'unavailable' } } },
      dispatchCoexistingOperation: (message, raw) => dispatcher.dispatch(message, raw),
      onProviderAuthorityLost: () => lost.resolve(),
      beforeSocketCloseForTest: () => closing.resolve(),
      afterBrokerSpawnForTest: child => {
        child.once('exit', () => { brokerExited = true })
        child.once('close', () => { brokerClosed = true })
      },
      afterBrokerTargetCreatedForTest: (listener, credential) => {
        target = listener; token = Buffer.from(credential)
        listener.once('close', () => { targetClosed = true })
        listener.on('connection', peer => { peers.push(peer); peer.once('close', () => closedPeers.add(peer)) })
      },
    })
    servers.push(server)
    await server.start()
    const binding = server.ownerBinding!
    const mutationLine = () => {
      const unsigned = { ...golden, ownerBinding: binding }
      return `${JSON.stringify({ ...unsigned, ownerProof: createHostedControlProof(secret, 'request', unsigned) })}\n`
    }
    const readinessLine = () => descriptorReadinessLine(secret, binding, bootstrapBinding)
    const ready = async () => {
      const lease = await openDescriptorReadiness(socketPath, secret, binding, bootstrapBinding)
      clients.push(lease.socket)
      const { ownerProof, ...unsigned } = JSON.parse(lease.line)
      expect(unsigned).toEqual({ schemaVersion: 2, kind: 'ready', capability: 'hosted-lifecycle-command',
        challenge: 'b'.repeat(64), bootstrapDigest: bootstrapBinding.bootstrapDigest, ownerBinding: binding })
      expect(ownerProof).toBe(createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', JSON.stringify(unsigned)))
      expect(await server.hasActiveLease()).toBe(true)
      return { ...lease, peer: peers.at(-1)! }
    }
    const finite = async (input: string | Buffer, direct = false) => {
      const accepted = new Promise<Socket>(resolve => target.once('connection', resolve))
      const address = target.address()
      if (!address || typeof address === 'string') throw new Error('missing target')
      const client = direct ? connect({ host: '127.0.0.1', port: address.port }) : connect(socketPath)
      clients.push(client)
      let output = '', ended = false
      const errors: Error[] = []
      client.setEncoding('utf8')
      client.on('data', chunk => { output += chunk })
      client.on('error', error => errors.push(error))
      client.once('end', () => { ended = true })
      const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
      // Install target observers before sending even a credential byte.
      const peer = await accepted
      let timeouts = 0
      peer.on('timeout', () => { timeouts++ })
      const fin = new Promise<void>(resolve => peer.once('end', () => resolve()))
      const peerClosed = new Promise<void>(resolve => peer.once('close', () => resolve()))
      client.end(input)
      return { client, peer, fin, closed, peerClosed, errors, timeouts: () => timeouts, output: () => output, ended: () => ended }
    }
    const activate = async () => {
      const accepted = new Promise<Socket>(resolve => target.once('connection', resolve))
      const client = await openStreamingSocket(socketPath)
      clients.push(client.socket)
      const peer = await accepted
      client.socket.write(activationPrepare())
      await client.nextLine()
      client.socket.write('{"publication":1}\n')
      await client.nextLine()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(server.hasRetainedActivation()).toBe(true)
      return { socket: client.socket, peer }
    }
    const cleanup = async () => {
      gate.resolve()
      for (const client of clients) client.destroy()
      await server.stop()
      expect(targetClosed).toBe(true)
      expect(brokerExited).toBe(true); expect(brokerClosed).toBe(true)
      expect(closedPeers.size).toBe(peers.length)
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    return { server, secret, golden, binding, ready, finite, mutationLine, readinessLine,
      token, entered, gate, lost, closing, cleanup, activate, mutationInputs, calls: () => calls,
      reject: () => { rejectHandler = true } }
  }

  for (const operation of ['mutation', 'lifecycle'] as const) test(`${operation} signs full response only after target FIN and authenticated port entry`, async () => {
    const f = await fixture()
    try {
      await f.ready()
      let line = f.mutationLine()
      let lifecycleUnsigned: Record<string, any> | undefined
      if (operation === 'lifecycle') {
        const { createHostedLifecycleOwnerIdentityChecksum } = await import('./HostedControlDispatcher.js')
        const a = f.golden.authority, b = f.binding
        const ownerEffectFence = { grantRevision: '5'.repeat(64), identityChecksum: createHostedLifecycleOwnerIdentityChecksum(b, a) }
        const exchangeId = `lifecycle-request_${'c'.repeat(32)}`
        const context = { actorId: a.actorId, sessionId: 'session-fin', deploymentId: a.deploymentId,
          bootId: a.bootId, requestId: 'request-fin', authorizedScope: 'hosted-lifecycle-command', deadlineAtMs: Date.now() + 60_000 }
        lifecycleUnsigned = { schemaVersion: 2, exchangeId, operation: 'control_state',
          provenance: {
            from: { kind: 'controller', deploymentId: a.deploymentId, bootId: a.bootId, actorId: a.actorId, sessionId: context.sessionId },
            to: { kind: 'owner', ownerAuthority: b.ownerAuthority, ownerGeneration: b.ownerGeneration, ownerSessionId: b.ownerSessionId },
            target: { capability: 'hosted-lifecycle-command', exchangeId, operation: 'control_state', workspaceId: a.workspaceId, teamId: a.teamId },
          }, ownerBinding: b, ownerEffectFence,
          payload: { request: { schemaVersion: 1, workspaceId: a.workspaceId, teamId: a.teamId }, context,
            authority: { actorId: a.actorId, workspaceId: a.workspaceId, teamId: a.teamId, deploymentId: a.deploymentId,
              restoreGeneration: a.restoreGeneration, mountGeneration: a.mountBinding.mountGeneration,
              bootId: a.bootId, resourceRevision: null, ownerEffectFence } },
        }
        line = `${JSON.stringify({ ...lifecycleUnsigned, ownerProof: createHostedRawDomainProof(f.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'request', JSON.stringify(lifecycleUnsigned)) })}\n`
      }
      const request = await f.finite(line)
      await Promise.race([
        Promise.all([request.fin, f.entered.promise]).then(() => new Promise<void>(resolve => setImmediate(resolve))),
        request.closed.then(() => { throw new Error('response closed before port release') }),
        request.peerClosed.then(() => { throw new Error('target closed before port release') }),
      ])
      expect(request.peer.destroyed).toBe(false); expect(request.peer.writableEnded).toBe(false)
      expect(request.output()).toBe(''); expect(f.calls()).toBe(1)
      expect(f.mutationInputs).toEqual(operation === 'mutation' ? [JSON.parse(line)] : [])
      expect(await f.server.hasActiveLease()).toBe(true)
      f.gate.resolve()
      await Promise.all([request.closed, request.peerClosed])
      expect(request.ended()).toBe(true); expect(request.errors).toEqual([])
      expect(request.output().split('\n').length).toBe(2); expect(request.output().endsWith('\n')).toBe(true)
      const response = JSON.parse(request.output())
      if (operation === 'mutation') {
        const { ownerProof: _, ...unsigned } = response
        expect(unsigned).toEqual({ schemaVersion: f.golden.schemaVersion, exchangeId: f.golden.exchangeId,
          operation: f.golden.operation, ownerBinding: f.binding, authority: f.golden.authority, payload: { kind: 'unavailable' } })
        expect(verifyHostedControlProof(f.secret, 'response', response)).toBe(true)
      } else {
        const { ownerProof, ...unsigned } = response
        expect(unsigned).toEqual({ schemaVersion: 2, exchangeId: lifecycleUnsigned!.exchangeId, operation: 'control_state',
          provenance: { from: lifecycleUnsigned!.provenance.to, to: lifecycleUnsigned!.provenance.from, target: lifecycleUnsigned!.provenance.target },
          ownerBinding: f.binding, ownerEffectFence: lifecycleUnsigned!.ownerEffectFence,
          authority: lifecycleUnsigned!.payload.authority, payload: { schemaVersion: 1, kind: 'not_found' } })
        expect(ownerProof).toBe(createHostedRawDomainProof(f.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'response', JSON.stringify(unsigned)))
      }
    } finally { await f.cleanup() }
  })

  test('credential and incomplete protocol EOF close without dispatch or consuming readiness', async () => {
    const f = await fixture()
    try {
      for (const input of [Buffer.alloc(0), f.token.subarray(0, 12)]) {
        const request = await f.finite(input, true)
        await request.fin
        // Credential handoff installs protocol end after the helper's observer.
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(request.peer.destroyed).toBe(true)
        expect(request.timeouts()).toBe(0)
        await Promise.all([request.peerClosed, request.closed])
        expect(request.timeouts()).toBe(0)
        expect(request.output()).toBe('')
        expect(f.mutationInputs).toEqual([])
      }
      for (const input of ['', f.mutationLine().slice(0, -1), Buffer.from([0x7b, 0x22, 0xe2, 0x82])]) {
        const request = await f.finite(input)
        await request.fin
        // Credential handoff installs protocol end after the helper's observer.
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(request.peer.destroyed).toBe(true)
        expect(request.timeouts()).toBe(0)
        await Promise.all([request.peerClosed, request.closed])
        expect(request.timeouts()).toBe(0)
        expect(request.output()).toBe('')
        expect(f.mutationInputs).toEqual([])
      }
      expect(f.calls()).toBe(0); expect(await f.server.hasActiveLease()).toBe(false)
      await f.ready()
    } finally { await f.cleanup() }
  })

  test('complete bad proof, binding, authority, pipelined and oversized FIN requests never enter port', async () => {
    const f = await fixture()
    try {
      await f.ready()
      f.gate.resolve() // A wrongly admitted vector must settle so entry assertions run.
      const valid = JSON.parse(f.mutationLine())
      const wrongOwner = { ...valid, ownerBinding: { ...valid.ownerBinding, ownerSessionId: 'owner-session_' + '4'.repeat(32) } }
      const wrongAuthority = { ...valid, authority: { ...valid.authority, bootId: 'wrong-boot' } }
      const sign = ({ ownerProof: _, ...unsigned }: typeof valid) => JSON.stringify({ ...unsigned, ownerProof: createHostedControlProof(f.secret, 'request', unsigned) }) + '\n'
      for (const vector of [wrongOwner, wrongAuthority]) {
        const decoded = decodeHostedTaskMutationRequest(JSON.parse(sign(vector)))
        expect(verifyHostedControlProof(f.secret, 'request', decoded)).toBe(true)
      }
      for (const input of [JSON.stringify({ ...valid, ownerProof: '0'.repeat(64) }) + '\n',
        sign(wrongOwner), sign(wrongAuthority), f.mutationLine() + '{}\n', ' '.repeat(64 * 1024) + f.mutationLine()]) {
        const request = await f.finite(input)
        await Promise.all([request.closed, request.peerClosed])
        expect(f.mutationInputs).toEqual([])
        expect(f.calls()).toBe(0)
        expect(request.output()).toBe('')
      }
      expect(f.calls()).toBe(0)
    } finally { await f.cleanup() }
  })

  for (const terminal of ['readiness FIN', 'activation FIN', 'shutdown', 'reject', 'timeout event', 'error event'] as const) test(`${terminal} while finite handler held closes response and drains actual settlement`, async () => {
    const f = await fixture(terminal === 'activation FIN')
    try {
      const lease = await f.ready()
      const activation = terminal === 'activation FIN' ? await f.activate() : null
      const request = await f.finite(f.mutationLine())
      await Promise.all([request.fin, f.entered.promise])
      expect(f.mutationInputs).toEqual([JSON.parse(f.mutationLine())])
      if (terminal === 'readiness FIN') {
        let synchronousLoss = false
        const observed = new Promise<void>(resolve => lease.peer.once('end', () => {
          // Server's end callback was installed first and has already fenced peers.
          synchronousLoss = request.peer.destroyed
          resolve()
        }))
        lease.socket.end()
        await Promise.all([observed, f.lost.promise])
        expect(synchronousLoss).toBe(true)
        expect(await f.server.hasActiveLease()).toBe(false)
        const reuse = await f.finite(f.readinessLine())
        await reuse.closed; expect(reuse.output()).toBe('')
      } else if (terminal === 'activation FIN') {
        let responseDestroyedAtFin = false, retainedAtFin = true
        const fin = new Promise<void>(resolve => activation!.peer.once('end', () => {
          responseDestroyedAtFin = request.peer.destroyed
          retainedAtFin = f.server.hasRetainedActivation()
          resolve()
        }))
        activation!.socket.end()
        await Promise.all([fin, f.lost.promise])
        expect(responseDestroyedAtFin).toBe(true)
        expect(retainedAtFin).toBe(false)
        // Independent readiness remains retained; the activation is revoked.
        expect(await f.server.hasActiveLease()).toBe(true)
      } else if (terminal === 'reject') {
        f.reject(); f.gate.resolve()
      } else if (terminal === 'timeout event') {
        // Cleanup wiring only: the read timer is disabled after LF.
        request.peer.emit('timeout')
      } else if (terminal === 'error event') {
        request.peer.emit('error', new Error('injected terminal socket error'))
      } else {
        void f.server.stop()
        await f.closing.promise
      }
      await Promise.all([request.closed, request.peerClosed])
      expect(request.output()).toBe('')
      let drained = false
      const stopping = f.server.stop().then(() => { drained = true })
      await f.closing.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      if (terminal !== 'reject') expect(drained).toBe(false)
      f.gate.resolve()
      await stopping
      expect(request.output()).toBe(''); expect(f.calls()).toBe(1)
    } finally { await f.cleanup() }
  })

  test('canonical readiness immediate FIN consumes and revokes the sole lease', async () => {
    const f = await fixture()
    try {
      const request = await f.finite(f.readinessLine())
      await Promise.all([request.fin, request.closed, f.lost.promise])
      expect(await f.server.hasActiveLease()).toBe(false)
      const reuse = await f.finite(f.readinessLine())
      await reuse.closed; expect(reuse.output()).toBe(''); expect(f.calls()).toBe(0)
    } finally { await f.cleanup() }
  })
})

// Synthetic activation-session frames, actual server/broker/target EOF.
// This preserves transport semantics; native FD5 authentication stays root-owned.
for (const phase of ['owner_ready', 'publication', 'recovery', 'ready', 'leased'] as const) {
  test(`activation target FIN revokes once during ${phase} and cannot install late`, async () => {
    let release!: () => void, reached!: () => void, revoked!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const held = new Promise<void>(resolve => { reached = resolve })
    const loss = new Promise<void>(resolve => { revoked = resolve })
    let target!: Server, calls = 0, publicationRejected = false
    let connection!: HostedApprovalActivationConnection
    const fixture = await activationServerFixture(false, true, {
      afterBrokerTargetCreatedForTest: listener => { target = listener },
      beforeActivationFrameWriteForTest: async writePhase => {
        if (writePhase === phase) { reached(); await gate }
      },
    })
    fixture.create(({ connection: candidate }) => {
      connection = candidate
      return {
        activate: async () => {
          try { await candidate.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024) }
          catch (error) { publicationRejected = true; throw error }
          if (phase === 'recovery') { reached(); await gate }
          return '{"kind":"ready"}\n'
        },
        revoke: async () => { calls++; revoked() },
      }
    })
    let client: Awaited<ReturnType<typeof openStreamingSocket>> | undefined
    try {
      const accepted = new Promise<Socket>(resolve => target.once('connection', resolve))
      client = await openStreamingSocket(fixture.socketPath)
      const peer = await accepted
      const closed = new Promise<void>(resolve => peer.once('close', () => resolve()))
      let output = ''
      client.socket.on('data', chunk => { output += chunk })
      client.socket.write(activationPrepare())
      if (phase !== 'owner_ready') {
        await client.nextLine()
        if (phase === 'publication') reached()
        else client.socket.write('{"publication":1}\n')
      }
      if (phase === 'leased') {
        await client.nextLine()
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(fixture.server.hasRetainedActivation()).toBe(true)
      } else await held
      const before = output
      let currentAtFin = true, callsAtFin = 0
      const fin = new Promise<void>(resolve => peer.once('end', () => {
        currentAtFin = connection.isCurrent()
        callsAtFin = calls
        resolve()
      }))
      client.socket.end()
      await Promise.all([fin, closed, loss])
      expect(currentAtFin).toBe(false)
      expect(callsAtFin).toBe(1)
      expect(fixture.server.hasRetainedActivation()).toBe(false)
      expect(connection.prepareEffectToken()).toBeNull()
      release()
      // The authenticated owner-ready transition consumed this generation.
      expect(await exchange(fixture.socketPath, activationPrepare())).toBe('')
      await fixture.server.stop()
      expect(output).toBe(before)
      expect(calls).toBe(1)
      if (phase === 'publication' || phase === 'owner_ready') expect(publicationRejected).toBe(true)
    } finally {
      release(); client?.socket.destroy(); await fixture.server.stop()
    }
  })
}

test('activation target FIN provider-loss callback reenters stop and drains one gated cleanup', async () => {
  let release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  let markDrain!: () => void
  const drainEntered = new Promise<void>(resolve => { markDrain = resolve })
  let retained: Promise<void> | undefined
  let target!: Server, calls = 0, losses = 0, drained = false, cleanupCompleted = false
  let stopping: Promise<void> | undefined
  let connection!: HostedApprovalActivationConnection
  let currentAtLoss: boolean | undefined
  const fixture = await activationServerFixture(false, true, {
    afterBrokerTargetCreatedForTest: listener => { target = listener },
    beforeActivationDrainForTest: revocation => { retained = revocation; markDrain() },
    onProviderAuthorityLost: () => {
      losses++
      currentAtLoss = connection.isCurrent()
      stopping = fixture.server.stop().then(() => { drained = true })
    },
  })
  fixture.create(({ connection: candidate }) => {
    connection = candidate
    return {
      activate: async () => {
        await candidate.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { calls++; await cleanup; cleanupCompleted = true },
    }
  })
  let client: Awaited<ReturnType<typeof openStreamingSocket>> | undefined
  try {
    const accepted = new Promise<Socket>(resolve => target.once('connection', resolve))
    client = await openStreamingSocket(fixture.socketPath)
    const peer = await accepted
    const closed = new Promise<void>(resolve => peer.once('close', () => resolve()))
    const targetClosed = new Promise<void>(resolve => target.once('close', () => resolve()))
    client.socket.write(activationPrepare())
    await client.nextLine()
    client.socket.write('{"publication":1}\n')
    await client.nextLine()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fixture.server.hasRetainedActivation()).toBe(true)
    let callsAtFin = 0, currentAtFin = true, destroyedAtFin = false
    const fin = new Promise<void>(resolve => peer.once('end', () => {
      callsAtFin = calls
      currentAtFin = connection.isCurrent()
      destroyedAtFin = peer.destroyed
      resolve()
    }))
    client.socket.end()
    await fin
    expect(currentAtLoss).toBe(false)
    expect(currentAtFin).toBe(false)
    expect(destroyedAtFin).toBe(true)
    expect(callsAtFin).toBe(1)
    expect(losses).toBe(1)
    expect(stopping).toBeDefined()
    await Promise.all([closed, targetClosed])
    await drainEntered
    expect(retained).toBeDefined()
    // Both race inputs are native promises. An already-resolved retained
    // placeholder wins by registration order, regardless of filesystem I/O.
    const pending = Symbol('actual cleanup pending')
    expect(await Promise.race([retained!, Promise.resolve(pending)])).toBe(pending)
    expect(calls).toBe(1)
    expect(cleanupCompleted).toBe(false)
    expect(drained).toBe(false)
    release()
    await stopping
    expect(await retained).toBeUndefined()
    expect(cleanupCompleted).toBe(true)
    expect(drained).toBe(true)
    expect(calls).toBe(1)
    expect(connection.isCurrent()).toBe(false)
  } finally {
    release(); client?.socket.destroy(); await fixture.server.stop()
    await stopping
  }
})

test('activation target FIN rejecting cleanup is observed before the late shutdown drain', async () => {
  let release!: () => void
  const teardown = new Promise<void>(resolve => { release = resolve })
  const failure = new Error('activation cleanup rejected after FIN')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  let markDrain!: () => void
  const drainEntered = new Promise<void>(resolve => { markDrain = resolve })
  let retained: Promise<void> | undefined
  let target!: Server, calls = 0, losses = 0, drained = false, cleanupCompleted = false
  let stopping: Promise<void> | undefined
  let connection!: HostedApprovalActivationConnection
  let currentAtLoss: boolean | undefined
  const fixture = await activationServerFixture(false, true, {
    afterBrokerTargetCreatedForTest: listener => { target = listener },
    beforeSocketCloseForTest: () => teardown,
    beforeActivationDrainForTest: revocation => { retained = revocation; markDrain() },
    onProviderAuthorityLost: () => {
      losses++
      currentAtLoss = connection.isCurrent()
      stopping = fixture.server.stop().then(() => { drained = true })
    },
  })
  fixture.create(({ connection: candidate }) => {
    connection = candidate
    return {
      activate: async () => {
        await candidate.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
        return '{"kind":"ready"}\n'
      },
      revoke: async () => { calls++; cleanupCompleted = true; throw failure },
    }
  })
  let client: Awaited<ReturnType<typeof openStreamingSocket>> | undefined
  process.on('unhandledRejection', onUnhandled)
  try {
    const accepted = new Promise<Socket>(resolve => target.once('connection', resolve))
    client = await openStreamingSocket(fixture.socketPath)
    const peer = await accepted
    const closed = new Promise<void>(resolve => peer.once('close', () => resolve()))
    const targetClosed = new Promise<void>(resolve => target.once('close', () => resolve()))
    client.socket.write(activationPrepare())
    await client.nextLine()
    client.socket.write('{"publication":1}\n')
    await client.nextLine()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fixture.server.hasRetainedActivation()).toBe(true)
    let callsAtFin = 0, currentAtFin = true, destroyedAtFin = false
    const fin = new Promise<void>(resolve => peer.once('end', () => {
      callsAtFin = calls
      currentAtFin = connection.isCurrent()
      destroyedAtFin = peer.destroyed
      resolve()
    }))
    client.socket.end()
    await fin
    expect(currentAtLoss).toBe(false)
    expect(currentAtFin).toBe(false)
    expect(destroyedAtFin).toBe(true)
    expect(callsAtFin).toBe(1)
    expect(losses).toBe(1)
    expect(stopping).toBeDefined()
    // Stop is explicitly held before broker/filesystem/handler teardown. No
    // test rejection handler touches the retained promise before this checkpoint.
    // Complete the FIN turn's rejection reporting, not an elapsed-time window.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(cleanupCompleted).toBe(true)
    expect(retained).toBeUndefined()
    expect(unhandled).toEqual([])
    expect(calls).toBe(1)
    expect(drained).toBe(false)
    release()
    await drainEntered
    expect(retained).toBeDefined()
    await expect(retained!).rejects.toBe(failure)
    await stopping // Existing policy observes activation errors and completes stop.
    await Promise.all([closed, targetClosed])
    expect(unhandled).toEqual([])
    expect(cleanupCompleted).toBe(true)
    expect(drained).toBe(true)
    expect(calls).toBe(1)
    expect(connection.isCurrent()).toBe(false)
  } finally {
    release(); client?.socket.destroy()
    try { await fixture.server.stop(); await stopping }
    finally { process.off('unhandledRejection', onUnhandled) }
  }
})

test('actual incomplete frame read deadline closes on observed timeout (not a handler deadline)', async () => {
  let target!: Server
  const fixture = await activationServerFixture(false, false, {
    readDeadlineMs: 100,
    afterBrokerTargetCreatedForTest: listener => { target = listener },
  })
  const accepted = new Promise<Socket>(resolve => target.once('connection', resolve))
  const client = connect(fixture.socketPath)
  client.on('error', () => undefined)
  client.resume()
  try {
    const peer = await accepted
    const timeout = new Promise<void>(resolve => peer.once('timeout', () => resolve()))
    const closed = new Promise<void>(resolve => peer.once('close', () => resolve()))
    client.write('{')
    await Promise.all([timeout, closed])
    expect(peer.destroyed).toBe(true)
    expect(await fixture.server.hasActiveLease()).toBe(false)
  } finally { client.destroy(); await fixture.server.stop() }
})
