import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { createHostedControlProof, createHostedDomainProof } from './ownerProof.js'
import { fingerprintHostedTaskCommand, type HostedTaskMutationCommand } from './protocol.js'
import { HostedControlRuntime, type HostedControlRuntimePortFactoryContext } from './HostedControlRuntime.js'
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
      },
    }
    const lifecycleUnsigned = {
      schemaVersion: 2,
      exchangeId: `lifecycle-request_${'d'.repeat(32)}`,
      operation: 'control_state',
      ownerBinding,
      payload: lifecyclePayload,
    }
    const lifecycleLine = await exchange(socketPath, signedDomainLine(
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
    expect(JSON.parse(taskLine).payload.kind).toBe('stale_generation')
    expect(lifecycleCalls).toBe(1)
    expect(messageCalls).toBe(1)

    lease.socket.destroy()
    for (let attempt = 0; attempt < 100 && await server.hasActiveLease(); attempt += 1) {
      await Bun.sleep(2)
    }
    expect(await server.hasActiveLease()).toBe(false)
    expect(await portContext.isCurrentAuthority({ actorId: 'actor-context', ...portContext.authority })).toBe(false)
    expect(await exchange(socketPath, signedDomainLine(
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
    expect(messageCalls).toBe(1)

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
