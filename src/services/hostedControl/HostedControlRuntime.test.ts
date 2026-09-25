import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { createHostedControlProof, createHostedDomainProof, createHostedRawDomainProof } from './ownerProof.js'
import {
  fingerprintHostedTaskCommand,
  type HostedControlOwnerBinding,
  type HostedTaskMutationCommand,
} from './protocol.js'
import { HostedControlRuntime, type HostedControlRuntimePortFactoryContext } from './HostedControlRuntime.js'
import { createHostedLifecycleOwnerIdentityChecksum } from './HostedControlDispatcher.js'
import type { HostedControlBootstrapAdmission } from './HostedControlBootstrap.js'
import type { HostedApprovalActivationConnection } from './HostedApprovalActivationSession.js'
import { HostedApprovalActivatablePort } from './HostedApprovalActivatablePort.js'
import {
  HOSTED_APPROVAL_PROOF_DOMAIN,
  type HostedApprovalWirePort,
} from './HostedApprovalWire.js'
import {
  HOSTED_LIFECYCLE_PROOF_DOMAIN,
  HOSTED_TEAM_MESSAGE_PROOF_DOMAIN,
} from './HostedControlServer.js'

const roots: string[] = []
const runtimes: HostedControlRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('HostedControlRuntime', () => {
  test('composes activation independently and stops approval before ports and descriptor authority', async () => {
    const root = await realpath(await mkdtemp('/tmp/hosted-control-activation-runtime-'))
    roots.push(root)
    const claudeRoot = join(root, 'claude')
    const runtimeRoot = join(root, 'runtime')
    const socketPath = join(runtimeRoot, 'control.sock')
    const activationSecret = Buffer.alloc(32, 7)
    await mkdir(join(claudeRoot, 'teams', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(join(claudeRoot, 'tasks', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    const actions: string[] = []
    let context!: HostedControlRuntimePortFactoryContext
    let revokeCalls = 0
    const approvals = new HostedApprovalActivatablePort()
    const admission: HostedControlBootstrapAdmission = {
      config: {
        socketPath, claudeRoot,
        deploymentId: 'deployment_test', bootId: 'boot_test', restoreGeneration: 0,
        workspaceId: `workspace_${'1'.repeat(32)}`, teamId: `team_${'a'.repeat(32)}`, legacyKey: 'legacy',
        mountGeneration: 1, declaredRootHash: 'b'.repeat(64),
        ownerAuthority: 'owner-authority_runtime-test', ownerGeneration: 1,
        ownerSessionId: `owner-session_${'c'.repeat(32)}`,
      },
      bootstrapBinding: {
        deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: `workspace_${'1'.repeat(32)}`,
        mountGeneration: 1, bootstrapDigest: 'd'.repeat(64),
        ownerArtifactDigest: `sha256:${'e'.repeat(64)}`,
        proofKeyId: createHash('sha256').update(activationSecret).digest('hex'),
      },
      approvalActivationV2: activationBootstrapExpectation(`sha256:${'e'.repeat(64)}`),
      expectedOwnerArtifactDigest: `sha256:${'e'.repeat(64)}`,
      secret: activationSecret,
      guard: {
        lost: new Promise<void>(() => undefined),
        assertCurrent: async () => true,
        close: async () => { actions.push('descriptor-close') },
      },
    }
    const runtime = new HostedControlRuntime(admission, candidate => {
      context = candidate
      return {
        lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
        messages: { dispatch: async () => ({}) },
        approvals,
        activationSessionFactory: (connection: HostedApprovalActivationConnection) => ({
          activate: async () => {
            await connection.receivePublicationAfterOwnerReady('{"kind":"owner_ready"}\n', 512 * 1024)
            const token = connection.prepareEffectToken()
            if (!token?.consume()) throw new Error('activation token stale')
            const guard = approvals.beginRecovery()
            guard.install(runtimeApprovalDelegate())
            return '{"kind":"ready"}\n'
          },
          revoke: async () => {
            const revocation = approvals.revoke()
            revokeCalls += 1
            actions.push('approval-revoked')
            await revocation
          },
        }),
        close: async () => {
          const closed = await connectionFails(socketPath)
          actions.push(closed ? 'server-closed' : 'server-open')
          actions.push('ports-close')
        },
      }
    })
    runtimes.push(runtime)
    await runtime.start()
    expect(context.activationV2?.expectation).toEqual({
      authority: context.authority,
      socketPath,
      ...admission.approvalActivationV2,
    })
    expect(context.activationV2?.proofKey).toBe(activationSecret)
    expect(await context.isCurrentAuthority({ actorId: 'before-readiness', ...context.authority })).toBe(false)

    const activation = await openActivationStream(socketPath)
    activation.socket.write('{"schemaVersion":2,"operation":"approval_activation_prepare"}\n')
    expect(await activation.nextLine()).toContain('owner_ready')
    activation.socket.write('{"publication":1}\n')
    expect(await activation.nextLine()).toContain('ready')
    expect(await context.isCurrentAuthority({ actorId: 'activation-only', ...context.authority })).toBe(false)

    const readiness = await openDescriptorRuntimeReadiness(
      socketPath,
      admission.secret,
      runtime.server!.ownerBinding!,
      admission.bootstrapBinding,
    )
    expect(await context.isCurrentAuthority({ actorId: 'with-readiness', ...context.authority })).toBe(true)
    expect(JSON.parse(await exchange(socketPath, approvalAckLine(
      activationSecret, runtime.server!.ownerBinding!, context.authority,
    ))).payload.status).toBe('acknowledged')
    activation.socket.write('x')
    await waitForRuntime(() => revokeCalls === 1)
    expect(await context.isCurrentAuthority({ actorId: 'after-activation-loss', ...context.authority })).toBe(true)
    expect(JSON.parse(await exchange(socketPath, approvalAckLine(
      activationSecret, runtime.server!.ownerBinding!, context.authority,
    ))).payload.status).toBe('unavailable')

    await runtime.stop()
    expect(actions).toEqual(['approval-revoked', 'server-closed', 'ports-close', 'descriptor-close'])
    readiness.socket.destroy()
  })

  test('descriptor loss fences admission and drains exact-run compensation before stop settles', async () => {
    const root = await realpath(await mkdtemp('/tmp/hosted-control-descriptor-loss-'))
    roots.push(root)
    const claudeRoot = join(root, 'claude')
    const runtimeRoot = join(root, 'runtime')
    await mkdir(join(claudeRoot, 'teams', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(join(claudeRoot, 'tasks', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    let loseAuthority!: () => void
    const lost = new Promise<void>(resolve => { loseAuthority = resolve })
    let releaseCompensation!: () => void
    const compensationGate = new Promise<void>(resolve => { releaseCompensation = resolve })
    let compensationStarted!: () => void
    const enteredCompensation = new Promise<void>(resolve => { compensationStarted = resolve })
    let portContext!: HostedControlRuntimePortFactoryContext
    const actions: string[] = []
    const admission: HostedControlBootstrapAdmission = {
      config: {
        socketPath: join(runtimeRoot, 'control.sock'), claudeRoot,
        deploymentId: 'deployment_test', bootId: 'boot_test', restoreGeneration: 0,
        workspaceId: 'workspace_test', teamId: `team_${'a'.repeat(32)}`, legacyKey: 'legacy',
        mountGeneration: 1, declaredRootHash: 'b'.repeat(64),
        ownerAuthority: 'owner-authority_runtime-test', ownerGeneration: 1,
        ownerSessionId: `owner-session_${'c'.repeat(32)}`,
      },
      bootstrapBinding: {
        deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
        mountGeneration: 1, bootstrapDigest: 'd'.repeat(64),
        ownerArtifactDigest: `sha256:${'e'.repeat(64)}`,
        proofKeyId: 'f'.repeat(64),
      },
      approvalActivationV2: activationBootstrapExpectation(`sha256:${'e'.repeat(64)}`),
      expectedOwnerArtifactDigest: `sha256:${'e'.repeat(64)}`,
      secret: Buffer.alloc(32, 0xa5),
      guard: {
        lost,
        assertCurrent: async () => true,
        close: async () => undefined,
      },
    }
    const runtime = new HostedControlRuntime(admission, context => {
      portContext = context
      return {
        lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
        messages: { dispatch: async () => ({}) },
        revoke: async () => { actions.push('approval-fenced') },
        close: async () => {
          actions.push('exact-run-stop')
          compensationStarted()
          await compensationGate
          actions.push('drained')
        },
      }
    })
    runtimes.push(runtime)
    await runtime.start()

    loseAuthority()
    await enteredCompensation
    expect(actions).toEqual(['approval-fenced', 'exact-run-stop'])
    expect(runtime.server).toBeNull()
    expect(await portContext.isCurrentAuthority({
      actorId: 'after-descriptor-loss', ...portContext.authority,
    })).toBe(false)
    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    await Bun.sleep(0)
    expect(stopped).toBe(false)
    expect(actions).toEqual(['approval-fenced', 'exact-run-stop'])

    releaseCompensation()
    await stopping
    expect(actions).toEqual(['approval-fenced', 'exact-run-stop', 'drained'])
  })

  test('Core lifecycle omits approval activation, retains descriptor authority, and zeroes key on stop', async () => {
    const root = await realpath(await mkdtemp('/tmp/hosted-control-descriptor-'))
    roots.push(root)
    const claudeRoot = join(root, 'claude')
    const runtimeRoot = join(root, 'runtime')
    await mkdir(join(claudeRoot, 'teams', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(join(claudeRoot, 'tasks', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    const secret = Buffer.alloc(32, 0xa5)
    let currentChecks = 0
    let guardCloses = 0
    let portCloses = 0
    let activationPresent = true
    let portClaudeRoot: string | undefined
    const admission: HostedControlBootstrapAdmission = {
      config: {
        socketPath: join(runtimeRoot, 'control.sock'), claudeRoot,
        deploymentId: 'deployment_test', bootId: 'boot_test', restoreGeneration: 0,
        workspaceId: 'workspace_test', teamId: `team_${'a'.repeat(32)}`, legacyKey: 'legacy',
        mountGeneration: 1, declaredRootHash: 'b'.repeat(64),
        ownerAuthority: 'owner-authority_runtime-test', ownerGeneration: 1,
        ownerSessionId: `owner-session_${'c'.repeat(32)}`,
      },
      bootstrapBinding: {
        deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
        mountGeneration: 1, bootstrapDigest: 'd'.repeat(64),
        ownerArtifactDigest: `sha256:${'e'.repeat(64)}`,
        proofKeyId: 'f'.repeat(64),
      },
      expectedOwnerArtifactDigest: `sha256:${'e'.repeat(64)}`,
      secret,
      guard: {
        lost: new Promise<void>(() => undefined),
        assertCurrent: async () => { currentChecks += 1; return true },
        close: async () => { guardCloses += 1 },
      },
    }
    const runtime = new HostedControlRuntime(admission, context => {
      activationPresent = context.activationV2 !== undefined
      portClaudeRoot = context.claudeRoot
      return {
        lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
        messages: { dispatch: async () => ({}) },
        close: async () => { portCloses += 1 },
      }
    })
    runtimes.push(runtime)
    await runtime.start()
    expect(activationPresent).toBe(false)
    // Host-local lanes and the MCP claude dir use the owner-validated canonical root.
    expect(portClaudeRoot).toBe(claudeRoot)
    expect(currentChecks).toBeGreaterThanOrEqual(4)
    expect(secret.every(byte => byte === 0xa5)).toBe(true)
    await runtime.stop()
    expect(portCloses).toBe(1)
    expect(guardCloses).toBe(1)
    expect(secret.every(byte => byte === 0)).toBe(true)
  })

  test('cancels and disposes startup when stop arrives while port composition is deferred', async () => {
    const root = await realpath(await mkdtemp('/tmp/hosted-control-start-race-'))
    roots.push(root)
    const claudeRoot = join(root, 'claude')
    const runtimeRoot = join(root, 'runtime')
    const socketPath = join(runtimeRoot, 'control.sock')
    const secretFile = join(runtimeRoot, 'owner.key')
    const configPath = join(runtimeRoot, 'config.json')
    const teamId = `team_${'a'.repeat(32)}`
    await mkdir(join(claudeRoot, 'teams', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(join(claudeRoot, 'tasks', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    await writeFile(secretFile, Buffer.alloc(32, 7).toString('hex'), { mode: 0o600 })
    await writeFile(configPath, JSON.stringify({
      socketPath, secretFile, claudeRoot,
      deploymentId: 'deployment_test', bootId: 'boot_test', restoreGeneration: 0,
      workspaceId: 'workspace_test', teamId, legacyKey: 'legacy', mountGeneration: 1,
      declaredRootHash: 'b'.repeat(64), ownerAuthority: 'owner-authority_runtime-test',
      ownerGeneration: 1, ownerSessionId: `owner-session_${'c'.repeat(32)}`,
    }), { mode: 0o600 })
    let enterFactory!: () => void
    const factoryEntered = new Promise<void>(resolve => { enterFactory = resolve })
    let releaseFactory!: () => void
    const factoryGate = new Promise<void>(resolve => { releaseFactory = resolve })
    let closeCalls = 0
    const runtime = new HostedControlRuntime(configPath, async () => {
      enterFactory()
      await factoryGate
      return {
        lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
        messages: { dispatch: async () => ({}) },
        close: async () => { closeCalls += 1 },
      }
    })
    runtimes.push(runtime)
    const starting = runtime.start()
    void starting.catch(() => undefined)
    await factoryEntered
    const stopping = runtime.stop()
    expect(runtime.server).toBeNull()
    releaseFactory()
    await expect(starting).rejects.toThrow('startup was cancelled')
    await stopping
    expect(runtime.server).toBeNull()
    expect(closeCalls).toBe(1)
  })

  test('owns one socket for readiness, lifecycle, message, and task operations and closes all on lease loss', async () => {
    const root = await realpath(await mkdtemp('/tmp/hosted-control-'))
    roots.push(root)
    const claudeRoot = join(root, 'claude')
    const runtimeRoot = join(root, 'runtime')
    const socketPath = join(runtimeRoot, 'control.sock')
    const secretFile = join(runtimeRoot, 'owner.key')
    const configPath = join(runtimeRoot, 'config.json')
    const teamId = `team_${'a'.repeat(32)}`
    const secret = Buffer.alloc(32, 7)
    await mkdir(join(claudeRoot, 'teams', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(join(claudeRoot, 'tasks', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    await writeFile(secretFile, secret.toString('hex'), { mode: 0o600 })
    const teamIdentityBytes = `${JSON.stringify({ schemaVersion: 1, teamId, createdAt: '2026-09-25T00:00:00.000Z' }, null, 2)}\n`
    await writeFile(join(claudeRoot, 'teams', 'legacy', 'team.identity.json'), teamIdentityBytes, { mode: 0o600 })
    const identityChecksum = createHash('sha256').update(teamIdentityBytes).digest('hex')
    await writeFile(configPath, JSON.stringify({
      socketPath,
      secretFile,
      claudeRoot,
      deploymentId: 'deployment_test',
      bootId: 'boot_test',
      restoreGeneration: 0,
      workspaceId: 'workspace_test',
      teamId,
      legacyKey: 'legacy',
      mountGeneration: 1,
      declaredRootHash: 'b'.repeat(64),
      ownerAuthority: 'owner-authority_runtime-test',
      ownerGeneration: 1,
      ownerSessionId: `owner-session_${'c'.repeat(32)}`,
    }), { mode: 0o600 })
    await chmod(configPath, 0o600)
    let lifecycleCalls = 0
    let messageCalls = 0
    let closeCalls = 0
    let releasePortDrain!: () => void
    const portDrain = new Promise<void>(resolve => { releasePortDrain = resolve })
    let portContext!: HostedControlRuntimePortFactoryContext
    const runtime = new HostedControlRuntime(configPath, context => {
      portContext = context
      return ({
      lifecycle: {
        dispatch: async () => {
          lifecycleCalls += 1
          return { payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null }
        },
      },
      messages: {
        dispatch: async () => {
          messageCalls += 1
          return {
            schemaVersion: 2,
            kind: 'persisted',
            receipt: {
              schemaVersion: 1,
              teamId,
              messageId: `message_${'e'.repeat(32)}`,
              clientMessageId: 'client_message_runtime-test',
              persistence: 'durable',
            },
          }
        },
      },
      close: async () => {
        closeCalls += 1
        await portDrain
      },
      })
    })
    runtimes.push(runtime)
    await runtime.start()
    const server = runtime.server!
    const ownerBinding = server.ownerBinding!

    let duplicateCloseCalls = 0
    const duplicate = new HostedControlRuntime(configPath, () => ({
      lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
      messages: { dispatch: async () => ({}) },
      close: async () => { duplicateCloseCalls += 1 },
    }))
    await expect(duplicate.start()).rejects.toThrow('Hosted root already has an active owner')
    expect(duplicateCloseCalls).toBe(0)

    const lease = await openReadiness(socketPath, ownerBinding.socketIdentity)
    expect(lease.line).toContain('"kind":"ready"')
    expect(await portContext.isCurrentAuthority({ actorId: 'actor-context', ...portContext.authority })).toBe(true)
    expect(portContext.legacyKey).toBe('legacy')
    expect(Object.isFrozen(portContext)).toBe(true)
    expect(await portContext.isCurrentAuthority({
      actorId: 'actor-context',
      ...portContext.authority,
      bootId: 'wrong-boot',
    })).toBe(false)

    const ownerEffectFence = {
      grantRevision: '1'.repeat(64),
      identityChecksum: createHostedLifecycleOwnerIdentityChecksum(ownerBinding, portContext.authority),
    }
    const lifecyclePayload = {
      request: { schemaVersion: 1, workspaceId: 'workspace_test', teamId },
      context: {
        actorId: 'actor_lifecycle',
        sessionId: 'session_test',
        deploymentId: 'deployment_test',
        bootId: 'boot_test',
        requestId: 'request_test',
        authorizedScope: 'scope_hosted-lifecycle-command',
        deadlineAtMs: Date.now() + 10_000,
      },
      authority: {
        actorId: 'actor_lifecycle',
        workspaceId: 'workspace_test',
        teamId,
        deploymentId: 'deployment_test',
        restoreGeneration: 0,
        bootId: 'boot_test',
        resourceRevision: null,
        mountGeneration: 1,
        ownerEffectFence,
      },
    }
    const lifecycleUnsigned = {
      schemaVersion: 2,
      exchangeId: `lifecycle-request_${'d'.repeat(32)}`,
      operation: 'control_state',
      provenance: {
        from: { kind: 'controller', deploymentId: 'deployment_test', bootId: 'boot_test', actorId: 'actor_lifecycle', sessionId: 'session_test' },
        to: { kind: 'owner', ownerAuthority: ownerBinding.ownerAuthority, ownerGeneration: ownerBinding.ownerGeneration, ownerSessionId: ownerBinding.ownerSessionId },
        target: { capability: 'hosted-lifecycle-command', exchangeId: `lifecycle-request_${'d'.repeat(32)}`, operation: 'control_state', workspaceId: 'workspace_test', teamId },
      },
      ownerBinding,
      ownerEffectFence,
      payload: lifecyclePayload,
    }
    const lifecycleLine = await exchange(socketPath, signedRawDomainLine(
      secret,
      HOSTED_LIFECYCLE_PROOF_DOMAIN,
      lifecycleUnsigned,
    ))
    expect(JSON.parse(lifecycleLine).payload).toEqual({ schemaVersion: 1, kind: 'not_found' })

    const messageAuthority = {
      actorId: 'actor_message',
      deploymentId: 'deployment_test',
      bootId: 'boot_test',
      restoreGeneration: 0,
      workspaceId: 'workspace_test',
      mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) },
      teamId,
    }
    const messageUnsigned = {
      schemaVersion: 2,
      exchangeId: `message-request_${'e'.repeat(32)}`,
      operation: 'message_persist',
      ownerBinding,
      authority: messageAuthority,
      payload: {
        schemaVersion: 1,
        teamId,
        clientMessageId: 'client_message_runtime-test',
        text: 'hello',
      },
    }
    const messageLine = await exchange(socketPath, signedDomainLine(
      secret,
      HOSTED_TEAM_MESSAGE_PROOF_DOMAIN,
      messageUnsigned,
    ))
    expect(JSON.parse(messageLine).payload.kind).toBe('persisted')
    expect(await exchange(socketPath, `${JSON.stringify({
      ...messageUnsigned,
      payload: { ...messageUnsigned.payload, text: 'tampered' },
      ownerProof: createHostedDomainProof(
        secret,
        HOSTED_TEAM_MESSAGE_PROOF_DOMAIN,
        'request',
        messageUnsigned,
      ),
    })}\n`)).toBe('')
    expect(messageCalls).toBe(1)

    const command: HostedTaskMutationCommand = {
      schemaVersion: 1,
      kind: 'create_task',
      commandId: 'command_runtime-test',
      idempotencyKey: 'runtime:test',
      teamId,
      expectedSourceGeneration: 'generation_stale',
      expectedRevision: 'revision_stale',
      subject: 'Runtime task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    }
    const taskUnsigned = {
      schemaVersion: 2,
      exchangeId: `task-request_${'f'.repeat(32)}`,
      operation: 'task_mutate',
      ownerBinding,
      authority: { ...messageAuthority, actorId: 'actor_task' },
      payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) },
    }
    const taskLine = await exchange(socketPath, `${JSON.stringify({
      ...taskUnsigned,
      ownerProof: createHostedControlProof(secret, 'request', taskUnsigned),
    })}\n`)
    expect(JSON.parse(taskLine).payload.kind).toBe('unavailable')
    // Product's envelope (fenced authority, operation-bound proof) reaches the task writer through
    // the coexisting dispatcher; a config-file owner is not personal-host, so it stays read-only.
    const productLine = (unsigned: Record<string, unknown>) => `${JSON.stringify({
      ...unsigned,
      ownerProof: createHmac('sha256', secret).update(`${HOSTED_TEAM_MESSAGE_PROOF_DOMAIN}\u0000${String(unsigned.operation)}\u0000request\u0000${JSON.stringify(unsigned)}`).digest('hex'),
    })}\n`
    const fencedAuthority = { ...taskUnsigned.authority, ownerEffectFence: { grantRevision: '2'.repeat(64), identityChecksum } }
    const productTaskUnsigned = { ...taskUnsigned, exchangeId: `task-request_${'a'.repeat(32)}`, authority: fencedAuthority }
    const productTaskLine = await exchangeHalfClosed(socketPath, productLine(productTaskUnsigned))
    expect(productTaskLine.endsWith('\n')).toBe(true)
    expect(productTaskLine.indexOf('\n')).toBe(productTaskLine.length - 1)
    expect(JSON.parse(productTaskLine).payload).toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null })
    expect(await exchange(socketPath, productLine({
      ...productTaskUnsigned,
      authority: { ...fencedAuthority, ownerEffectFence: { grantRevision: '2'.repeat(64), identityChecksum: '3'.repeat(64) } },
    }))).toBe('')
    const productMessageLine = await exchangeHalfClosed(socketPath, productLine({
      ...messageUnsigned,
      exchangeId: `message-request_${'a'.repeat(32)}`,
      authority: { ...messageAuthority, ownerEffectFence: fencedAuthority.ownerEffectFence },
    }))
    expect(JSON.parse(productMessageLine).payload.kind).toBe('persisted')
    expect(lifecycleCalls).toBe(1)
    expect(messageCalls).toBe(2)

    lease.socket.destroy()
    for (let attempt = 0; attempt < 100 && await server.hasActiveLease(); attempt += 1) {
      await Bun.sleep(2)
    }
    expect(await server.hasActiveLease()).toBe(false)
    expect(await portContext.isCurrentAuthority({ actorId: 'actor-context', ...portContext.authority })).toBe(false)
    expect(await exchange(socketPath, signedRawDomainLine(
      secret,
      HOSTED_LIFECYCLE_PROOF_DOMAIN,
      lifecycleUnsigned,
    ))).toBe('')
    expect(await exchange(socketPath, signedDomainLine(
      secret,
      HOSTED_TEAM_MESSAGE_PROOF_DOMAIN,
      messageUnsigned,
    ))).toBe('')
    expect(await exchange(socketPath, `${JSON.stringify({
      ...taskUnsigned,
      ownerProof: createHostedControlProof(secret, 'request', taskUnsigned),
    })}\n`)).toBe('')
    expect(lifecycleCalls).toBe(1)
    expect(messageCalls).toBe(2)

    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    await Bun.sleep(0)
    expect(stopped).toBe(false)
    expect(await portContext.isCurrentAuthority({ actorId: 'actor-context', ...portContext.authority })).toBe(false)
    releasePortDrain()
    await stopping
    expect(closeCalls).toBe(1)
  })
})

function signedDomainLine(
  secret: Uint8Array,
  domain: string,
  unsigned: Record<string, unknown>,
): string {
  return `${JSON.stringify({
    ...unsigned,
    ownerProof: createHostedDomainProof(secret, domain, 'request', unsigned),
  })}\n`
}

function approvalAckLine(
  secret: Uint8Array,
  ownerBinding: HostedControlOwnerBinding,
  authority: HostedControlRuntimePortFactoryContext['authority'],
): string {
  const { teamId: _teamId, ...wireAuthority } = authority
  return signedRawDomainLine(secret, HOSTED_APPROVAL_PROOF_DOMAIN, {
    schemaVersion: 4,
    exchangeId: `approval-request_${'6'.repeat(32)}`,
    operation: 'approval_ingress_ack',
    ownerBinding,
    authority: { actorId: 'actor_runtime-approval', ...wireAuthority },
    payload: {
      outboxId: `runtime_permission:effect:${'5'.repeat(64)}`,
      generation: 1,
      ownerId: 'owner_runtime-approval',
      leaseToken: 'lease_runtime-approval',
    },
  })
}

function runtimeApprovalDelegate(): HostedApprovalWirePort {
  return {
    claimIngress: async () => [],
    acknowledgeIngress: async () => ({ status: 'acknowledged' }),
    getAdmittedIngressAuthority: async () => null,
    resolveIngressAuthority: async () => ({ status: 'unavailable' }),
    authorizeDecision: async () => ({ status: 'unavailable' }),
    deliverDecision: async () => ({ status: 'unavailable' }),
    reconcileDecision: async () => ({ status: 'unavailable' }),
  }
}

function signedRawDomainLine(
  secret: Uint8Array,
  domain: string,
  unsigned: Record<string, unknown>,
): string {
  const serialized = JSON.stringify(unsigned)
  const proof = createHostedRawDomainProof(secret, domain, 'request', serialized)
  return `${serialized.slice(0, -1)},"ownerProof":"${proof}"}\n`
}

function openReadiness(
  socketPath: string,
  socketIdentity: { device: string; inode: string; uid: number; gid: number; mode: number },
): Promise<{ socket: Socket; line: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let output = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      const unsigned = {
      schemaVersion: 2,
      operation: 'readiness',
      capability: 'hosted-lifecycle-command',
      socketIdentity,
      challenge: '1'.repeat(64),
      }
      socket.write(`${JSON.stringify({ ...unsigned, ownerProof: createHostedDomainProof(Buffer.alloc(32, 7), HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', unsigned) })}\n`)
    })
    socket.on('data', chunk => {
      output += chunk
      if (output.includes('\n')) resolve({ socket, line: output.trim() })
    })
    socket.once('error', reject)
  })
}

/** Product's owner-bound client: one frame, then write-side EOF, then read the reply. */
function exchangeHalfClosed(socketPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath, allowHalfOpen: true })
    let output = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.end(input))
    socket.on('data', chunk => { output += chunk })
    socket.once('end', () => { socket.destroy(); resolve(output) })
    socket.once('close', () => resolve(output))
    socket.once('error', reject)
  })
}

function exchange(socketPath: string, input: string): Promise<string> {
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

function openActivationStream(socketPath: string): Promise<{
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

function openDescriptorRuntimeReadiness(
  socketPath: string,
  secret: Uint8Array,
  ownerBinding: HostedControlOwnerBinding,
  bootstrapBinding: HostedControlBootstrapAdmission['bootstrapBinding'],
): Promise<{ socket: Socket; line: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let output = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      const unsigned = {
        schemaVersion: 2,
        operation: 'readiness',
        capability: 'hosted-lifecycle-command',
        socketIdentity: ownerBinding.socketIdentity,
        challenge: '1'.repeat(64),
        bootstrapBinding,
        expectedOwnerBinding: ownerBinding,
      }
      const serialized = JSON.stringify(unsigned)
      const proof = createHostedRawDomainProof(
        secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', serialized,
      )
      socket.write(`${serialized.slice(0, -1)},"controllerProof":"${proof}"}\n`)
    })
    socket.on('data', chunk => {
      output += chunk
      if (output.includes('\n')) resolve({ socket, line: output.trim() })
    })
    socket.once('error', reject)
  })
}

async function connectionFails(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(socketPath)
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(true))
  })
}

async function waitForRuntime(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(2)
  }
  throw new Error('condition was not reached')
}

function activationBootstrapExpectation(ownerArtifactDigest: `sha256:${string}`) {
  return {
    approvalGeneration: 7,
    admissionOwnerGeneration: 11,
    approvalDigest: `sha256:${'1'.repeat(64)}` as const,
    admissionDocumentDigest: `sha256:${'2'.repeat(64)}` as const,
    ownerArtifactDigest,
    wireCapabilityDigest: `sha256:${'3'.repeat(64)}` as const,
    signedManifest: {
      format: 'agent-teams.hosted-lifecycle-owner-admission/v4' as const,
      manifestDigest: `sha256:${'4'.repeat(64)}` as const,
      releasePinDigest: `sha256:${'5'.repeat(64)}` as const,
      launcherKeyId: '6'.repeat(64),
    },
  }
}
