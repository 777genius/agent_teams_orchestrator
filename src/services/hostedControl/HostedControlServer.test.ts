import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostedControlProof, createHostedDomainProof, createHostedRawDomainProof, verifyHostedControlProof } from './ownerProof.js'
import { hostedControlGoldenRequestFixture, type HostedTaskMutationResponse } from './protocol.js'
import { admitHostedReadiness, HOSTED_LIFECYCLE_PROOF_DOMAIN, HostedControlServer, type HostedTaskMutationPort } from './HostedControlServer.js'
import type { HostedControlBootstrapBinding } from './HostedControlBootstrap.js'

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
    let server!: HostedControlServer
    let originalLeaseStillValid = true
    const service = { mutate: async () => { markStarted(); await gate; originalLeaseStillValid = await server.hasActiveLease(); return { kind: 'unavailable' as const } } } satisfies HostedTaskMutationPort
    const { socketIdentity: _, ...ownerIdentity } = unsigned.ownerBinding
    server = new HostedControlServer({ socketPath, secret, ownerIdentity, authority: unsigned.authority, service, dispatchCoexistingOperation: async () => null }); servers.push(server); await server.start()
    const lease = await openReadiness(socketPath, server.ownerBinding!)
    const requestUnsigned = { ...unsigned, ownerBinding: server.ownerBinding! }; const request = { ...requestUnsigned, ownerProof: createHostedControlProof(secret, 'request', requestUnsigned) }
    const pending = exchange(socketPath, `${JSON.stringify(request)}\n`); await started; lease.socket.destroy()
    for (let attempt = 0; attempt < 50 && await server.hasActiveLease(); attempt += 1) await Bun.sleep(2)
    expect(await exchange(socketPath, `${JSON.stringify({ schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command', socketIdentity: server.ownerBinding!.socketIdentity, challenge: 'b'.repeat(64) })}\n`)).toBe('')
    release()
    expect(await pending).toBe('')
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
})

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
