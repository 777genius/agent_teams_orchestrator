import { StructuredIO } from '../../cli/structuredIO.js'
import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as lockfile from 'src/utils/lockfile.js'
import {
  startHostedNativeLeadMailboxPump,
  dispatchAfterHostedNativeBarrier,
  publishHostedNativeReady,
  createHostedNativeDispatchSettlementTracker,
  settleHostedNativeConsumerShutdown,
  shouldContinueHostedNativeDrain,
  computeHostedNativeEnvelopeDigest,
  readHostedNativeLaunchEnvelope,
  type HostedNativeLaunchEnvelope,
  type HostedNativeReadyAcknowledgement,
} from './hostedNativeLaunch.js'
import { createHostedMailboxShutdownHandler } from './hostedMailboxShutdown.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function envelopeFixture(): Promise<{ path: string; envelope: HostedNativeLaunchEnvelope }> {
  const data = await mkdtemp(join(tmpdir(), 'hosted-native-envelope-'))
  cleanup.push(data)
  await chmod(data, 0o700)
  const legacyKey = 'exact-team'
  const team = join(data, 'teams', legacyKey)
  const tasks = join(data, 'tasks', legacyKey)
  const cwd = join(data, 'cwd')
  const privateDir = join(data, '.hosted-native')
  await Promise.all([team, tasks, cwd, privateDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const [dataStat, teamStat, tasksStat] = await Promise.all([stat(data), stat(team), stat(tasks)])
  const path = join(privateDir, 'envelope.json')
  const settingsPath = join(privateDir, 'settings.json')
  const mcpConfigPath = join(privateDir, 'mcp.json')
  await Promise.all([
    writeFile(settingsPath, '{}', { mode: 0o600 }),
    writeFile(mcpConfigPath, '{}', { mode: 0o600 }),
  ])
  const bootstrapSpecPath = join(privateDir, 'spec.json')
  const userPromptFilePath = join(privateDir, 'prompt.txt')
  await Promise.all([
    writeFile(bootstrapSpecPath, '{}', { mode: 0o600 }),
    writeFile(userPromptFilePath, 'hello', { mode: 0o600 }),
  ])
  const unsigned: Omit<HostedNativeLaunchEnvelope, 'envelopeDigest'> = {
    version: 1, role: 'native-lead', publicTeamId: 'public-id', legacyKey,
    canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks,
    canonicalCwd: cwd, dataRootIdentity: `${dataStat.dev}:${dataStat.ino}`,
    teamRootIdentity: `${teamStat.dev}:${teamStat.ino}`, tasksRootIdentity: `${tasksStat.dev}:${tasksStat.ino}`,
    runId: 'run-1', primary: { displayName: 'captain', agentId: 'captain@exact-team', provider: 'codex', model: 'gpt-5' },
    primaryAlias: 'team-lead', launchIdentityToken: 'unguessable-token',
    materialDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    settingsDigest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    mcpDigest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    settingsPath, mcpConfigPath, bootstrapSpecPath,
    bootstrapSpecDigest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    userPromptFilePath,
    userPromptDigest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    permissionMode: 'bypassPermissions',
    readyAckPath: join(privateDir, 'ready.json'),
    canonicalAuthority: {
      version: 1,
      registrationId: 'registration-1',
      storageGeneration: 'storage-generation-1',
      admittedWriterImage: 'sha256:' + 'd'.repeat(64),
      registryRoot: privateDir,
      anchorName: 'registration-1.lock',
      bindingRecordName: 'registration-1.json',
    },
  }
  const envelope = { ...unsigned, envelopeDigest: computeHostedNativeEnvelopeDigest(unsigned) }
  await writeFile(path, JSON.stringify(envelope), { mode: 0o600 })
  return { path, envelope }
}

describe('hosted native launch envelope', () => {
  test('accepts exact private root/identity material and rejects digest substitution', async () => {
    const fixture = await envelopeFixture()
    expect((await readHostedNativeLaunchEnvelope(fixture.path)).primary.displayName).toBe('captain')
    await chmod(fixture.envelope.canonicalTeamRoot, 0o777)
    await expect(readHostedNativeLaunchEnvelope(fixture.path)).rejects.toThrow('not private and stable')
    await chmod(fixture.envelope.canonicalTeamRoot, 0o700)
    await writeFile(fixture.path, JSON.stringify({ ...fixture.envelope, runId: 'substituted' }), { mode: 0o600 })
    await expect(readHostedNativeLaunchEnvelope(fixture.path)).rejects.toThrow('digest mismatch')
  })
})


test('real mailbox pump wakes retained StructuredIO after stdin EOF', async () => {
  const fixture = await envelopeFixture()
  const inbox = join(fixture.envelope.canonicalTeamRoot, 'inboxes', 'team-lead.json')
  await mkdir(join(fixture.envelope.canonicalTeamRoot, 'inboxes'), { mode: 0o700 })
  await writeFile(inbox, '[]', { mode: 0o600 })
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const errors: Error[] = []
  const pump = await startHostedNativeLeadMailboxPump({
    envelope: { ...fixture.envelope, mailboxPollMs: 50 },
    hostedInput: lease,
    onFatalError: error => errors.push(error),
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const next = io.structuredInput.next()
    await writeFile(inbox, JSON.stringify([{
      from: 'worker', text: 'after parent EOF', timestamp: new Date().toISOString(),
      read: false,
    }]), { mode: 0o600 })
    const delivered = await Promise.race([
      next,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('mailbox delivery timed out')), 2000)
      }),
    ])
    expect(delivered.value?.type).toBe('user')
    expect(JSON.stringify(delivered.value)).toContain('after parent EOF')
    // Enqueue precedes durable acknowledgement; allow the same pump pass to finish.
    for (let i = 0; i < 50; i++) {
      const rows = JSON.parse(await readFile(inbox, 'utf8'))
      if (rows[0]?.read) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(JSON.parse(await readFile(inbox, 'utf8'))[0].read).toBe(true)
    expect(errors).toEqual([])
  } finally {
    if (deadline) clearTimeout(deadline)
    await pump.stop()
    lease.close()
    await io.structuredInput.return()
  }
})

test('same launch token is reserved before the initial poll awaits', async () => {
  const fixture = await envelopeFixture()
  const entered = deferred()
  const release = deferred()
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const first = startHostedNativeLeadMailboxPump({
    envelope: fixture.envelope,
    hostedInput: lease,
    onFatalError: () => {},
    effects: {
      lstat: (async (...args: Parameters<typeof lstat>) => {
        entered.resolve()
        await release.promise
        return await lstat(...args)
      }) as typeof lstat,
    },
  })
  await entered.promise
  await expect(startHostedNativeLeadMailboxPump({
    envelope: fixture.envelope,
    hostedInput: lease,
    onFatalError: () => {},
  })).rejects.toThrow('already active')
  release.resolve()
  const pump = await first
  await pump.stop()
  lease.close()
  await io.structuredInput.return(undefined)
})

test('stop during a read joins read and lock release without later effects', async () => {
  const fixture = await envelopeFixture()
  const inboxDir = join(fixture.envelope.canonicalTeamRoot, 'inboxes')
  const inbox = join(inboxDir, 'team-lead.json')
  await mkdir(inboxDir, { mode: 0o700 })
  await writeFile(inbox, '[]', { mode: 0o600 })
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const readEntered = deferred()
  const releaseRead = deferred()
  let reads = 0
  let acknowledgements = 0
  let releases = 0
  const pump = await startHostedNativeLeadMailboxPump({
    envelope: { ...fixture.envelope, mailboxPollMs: 50 },
    hostedInput: lease,
    onFatalError: () => {},
    effects: {
      readFile: (async (path: Parameters<typeof readFile>[0], encoding: BufferEncoding) => {
        reads++
        if (reads === 2) {
          readEntered.resolve()
          await releaseRead.promise
        }
        return await readFile(path, encoding)
      }) as never,
      lock: (async (path: string, options: Parameters<typeof lockfile.lock>[1]) => {
        const unlock = await lockfile.lock(path, options)
        return async () => {
          releases++
          await unlock()
        }
      }) as never,
      writeFileAtomic: (async () => { acknowledgements++ }) as never,
    },
  })
  await readEntered.promise
  await new Promise(resolve => setTimeout(resolve, 125))
  expect(reads).toBe(2)
  let stopped = false
  const stopping = pump.stop().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  releaseRead.resolve()
  await stopping
  expect(releases).toBe(2)
  expect(acknowledgements).toBe(0)
  lease.close()
  await io.structuredInput.return(undefined)
})

test('stop during acknowledgement waits for write and prevents another poll', async () => {
  const fixture = await envelopeFixture()
  const inboxDir = join(fixture.envelope.canonicalTeamRoot, 'inboxes')
  const inbox = join(inboxDir, 'team-lead.json')
  await mkdir(inboxDir, { mode: 0o700 })
  await writeFile(inbox, '[]', { mode: 0o600 })
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const writeEntered = deferred()
  const releaseWrite = deferred()
  let writes = 0
  const pump = await startHostedNativeLeadMailboxPump({
    envelope: { ...fixture.envelope, mailboxPollMs: 50 },
    hostedInput: lease,
    onFatalError: () => {},
    effects: {
      writeFileAtomic: (async (path: string, data: string | Buffer, options?: { mode?: number }) => {
        writes++
        writeEntered.resolve()
        await releaseWrite.promise
        await writeFile(path, data, options)
      }) as never,
    },
  })
  await writeFile(inbox, JSON.stringify([{
    from: 'worker', text: 'accepted before stop', timestamp: new Date().toISOString(), read: false,
  }]), { mode: 0o600 })
  await writeEntered.promise
  let stopped = false
  const stopping = pump.stop().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  releaseWrite.resolve()
  await stopping
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(writes).toBe(1)
  expect(JSON.parse(await readFile(inbox, 'utf8'))[0].read).toBe(true)
  lease.close()
  await io.structuredInput.return(undefined)
})

test('a closed lease cancels startup and releases the token reservation', async () => {
  const fixture = await envelopeFixture()
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  lease.close()
  await expect(startHostedNativeLeadMailboxPump({
    envelope: fixture.envelope,
    hostedInput: lease,
    onFatalError: () => {},
  })).rejects.toThrow('closed before mailbox pump startup')
  await io.structuredInput.return(undefined)
})

test('stop during ready publication removes the ack and rejects readiness', async () => {
  const fixture = await envelopeFixture()
  const writeEntered = deferred()
  const releaseWrite = deferred()
  let stopping = false
  let stops = 0
  const publication = publishHostedNativeReady({
    envelope: fixture.envelope,
    pump: { stop: async () => { stops++ } },
    isStopping: () => stopping,
    write: async envelope => {
      writeEntered.resolve()
      await releaseWrite.promise
      await writeFile(envelope.readyAckPath, 'transient-ready', { mode: 0o600 })
      return {} as HostedNativeReadyAcknowledgement
    },
  })
  await writeEntered.promise
  stopping = true
  releaseWrite.resolve()
  await expect(publication).rejects.toThrow('stopped during readiness publication')
  await expect(lstat(fixture.envelope.readyAckPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(stops).toBe(1)
})

test('ready publication preserves its failure together with pump stop failure', async () => {
  const fixture = await envelopeFixture()
  const readyFailure = new Error('ready writer failed')
  const stopFailure = new Error('accepted acknowledgement settlement failed')
  const publication = publishHostedNativeReady({
    envelope: fixture.envelope,
    pump: { stop: async () => { throw stopFailure } },
    isStopping: () => false,
    write: async () => { throw readyFailure },
  })
  try {
    await publication
    throw new Error('publication unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([readyFailure, stopFailure])
  }
})

test('real pump stop preserves accepted acknowledgement failure with readiness failure', async () => {
  const fixture = await envelopeFixture()
  const inboxDir = join(fixture.envelope.canonicalTeamRoot, 'inboxes')
  const inbox = join(inboxDir, 'team-lead.json')
  await mkdir(inboxDir, { mode: 0o700 })
  await writeFile(inbox, '[]', { mode: 0o600 })
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const acknowledgementEntered = deferred()
  const releaseAcknowledgement = deferred()
  const acknowledgementFailure = new Error('acknowledgement failed after acceptance')
  const readinessFailure = new Error('readiness publication failed')
  const pump = await startHostedNativeLeadMailboxPump({
    envelope: { ...fixture.envelope, mailboxPollMs: 50 },
    hostedInput: lease,
    onFatalError: () => {},
    effects: {
      writeFileAtomic: (async () => {
        acknowledgementEntered.resolve()
        await releaseAcknowledgement.promise
        throw acknowledgementFailure
      }) as never,
    },
  })
  try {
    await writeFile(inbox, JSON.stringify([{
      from: 'worker', text: 'accepted before readiness failed',
      timestamp: new Date().toISOString(), read: false,
    }]), { mode: 0o600 })
    await acknowledgementEntered.promise
    const publication = publishHostedNativeReady({
      envelope: fixture.envelope,
      pump,
      isStopping: () => false,
      write: async () => { throw readinessFailure },
    })
    releaseAcknowledgement.resolve()
    try {
      await publication
      throw new Error('publication unexpectedly succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      const failures = (error as AggregateError).errors
      expect(failures[0]).toBe(readinessFailure)
      expect((failures[1] as Error).message).toContain(
        'accepted but its acknowledgement is uncertain',
      )
      expect((failures[1] as Error).cause).toBe(acknowledgementFailure)
    }
  } finally {
    await pump.stop().catch(() => {})
    lease.close()
    await io.structuredInput.return(undefined)
  }
})

test('mailbox pump preserves acknowledgement uncertainty and release failure', async () => {
  const fixture = await envelopeFixture()
  const inboxDir = join(fixture.envelope.canonicalTeamRoot, 'inboxes')
  const inbox = join(inboxDir, 'team-lead.json')
  await mkdir(inboxDir, { mode: 0o700 })
  await writeFile(inbox, JSON.stringify([{
    from: 'worker', text: 'accepted turn', timestamp: new Date().toISOString(), read: false,
  }]), { mode: 0o600 })
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const releaseFailure = new Error('release failed')
  try {
    await startHostedNativeLeadMailboxPump({
      envelope: fixture.envelope,
      hostedInput: lease,
      onFatalError: () => {},
      effects: {
        writeFileAtomic: (async () => { throw new Error('ack failed') }) as never,
        lock: (async () => async () => { throw releaseFailure }) as never,
      },
    })
    throw new Error('pump unexpectedly started')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    const failures = (error as AggregateError).errors
    expect((failures[0] as Error).message).toContain('accepted but its acknowledgement is uncertain')
    expect(failures[1]).toBe(releaseFailure)
  } finally {
    lease.close()
    await io.structuredInput.return(undefined)
  }
})

test('production print dispatch tracker joins recursive handoff settlement', async () => {
  const tracker = createHostedNativeDispatchSettlementTracker()
  const first = deferred()
  const second = deferred()
  tracker.dispatch(async () => { await first.promise })
  const settled = tracker.settle()
  tracker.dispatch(async () => { await second.promise })
  let finished = false
  void settled.then(() => { finished = true })
  first.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  second.resolve()
  await settled
  expect(finished).toBe(true)
})

test('dispatch tracker retains rejection completed before settlement and reports it immediately', async () => {
  const failure = new Error('dispatch failed before teardown')
  const reported: unknown[] = []
  const tracker = createHostedNativeDispatchSettlementTracker()
  tracker.onFailure(error => reported.push(error))
  tracker.dispatch(async () => { throw failure })
  await Promise.resolve()
  await Promise.resolve()
  expect(reported).toEqual([failure])
  await expect(tracker.settle()).rejects.toBe(failure)
})

test('consumer failure cannot bypass an active dispatch join', async () => {
  const dispatch = deferred()
  const disposalFailure = new Error('reader disposal failed')
  const consumerFailure = new Error('input consumer failed')
  const settlement = settleHostedNativeConsumerShutdown({
    disposal: Promise.reject(disposalFailure),
    consumer: Promise.reject(consumerFailure),
    settleDispatches: async () => { await dispatch.promise },
  })
  let finished = false
  void settlement.catch(() => { finished = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  dispatch.resolve()
  try {
    await settlement
    throw new Error('shutdown unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      disposalFailure,
      consumerFailure,
    ])
  }
})

test('hosted drain suppresses a queued command once stop is visible', () => {
  expect(shouldContinueHostedNativeDrain({
    isStopping: true,
    hasRunningBackground: true,
    hasQueuedCommand: true,
  })).toBe(false)
})

test('closed periodic lease terminates scheduling without a fatal error', async () => {
  const fixture = await envelopeFixture()
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  let polls = 0
  const fatals: Error[] = []
  const pump = await startHostedNativeLeadMailboxPump({
    envelope: { ...fixture.envelope, mailboxPollMs: 50 },
    hostedInput: lease,
    onFatalError: error => fatals.push(error),
    effects: {
      lstat: (async () => {
        polls++
        const error = new Error('missing') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }) as never,
    },
  })
  lease.close()
  await new Promise(resolve => setTimeout(resolve, 130))
  await pump.stop()
  expect(polls).toBe(1)
  expect(fatals).toEqual([])
  await io.structuredInput.return(undefined)
})

test('hosted protocol handler completes before mailbox acknowledgement', async () => {
  const fixture = await envelopeFixture()
  const inboxDir = join(fixture.envelope.canonicalTeamRoot, 'inboxes')
  const inbox = join(inboxDir, 'team-lead.json')
  await mkdir(inboxDir, { mode: 0o700 })
  await writeFile(inbox, JSON.stringify([{
    from: 'worker', text: JSON.stringify({
      type: 'shutdown_approved', requestId: 'request-1', from: 'substituted',
      timestamp: new Date().toISOString(),
    }),
    timestamp: new Date().toISOString(), read: false,
  }]), { mode: 0o600 })
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const order: string[] = []
  const actualHandler = createHostedMailboxShutdownHandler({
    teamName: fixture.envelope.legacyKey,
    getAppState: () => ({}) as never,
    setAppState: () => {},
  })
  const pump = await startHostedNativeLeadMailboxPump({
    envelope: fixture.envelope,
    hostedInput: lease,
    onFatalError: () => {},
    processProtocolMessage: async message => {
      order.push('protocol')
      return actualHandler(message)
    },
    effects: {
      writeFileAtomic: (async (
        path: string,
        data: string | Buffer,
        options?: { mode?: number },
      ) => {
        order.push('acknowledge')
        await writeFile(path, data, options)
      }) as never,
    },
  })
  expect(order).toEqual(['protocol', 'acknowledge'])
  expect(JSON.parse(await readFile(inbox, 'utf8'))[0].read).toBe(true)
  await pump.stop()
  lease.close()
  await io.structuredInput.return(undefined)
})

test('stop joins a protocol handler and prevents its later acknowledgement', async () => {
  const fixture = await envelopeFixture()
  const inboxDir = join(fixture.envelope.canonicalTeamRoot, 'inboxes')
  const inbox = join(inboxDir, 'team-lead.json')
  await mkdir(inboxDir, { mode: 0o700 })
  await writeFile(inbox, '[]', { mode: 0o600 })
  const io = new StructuredIO((async function* () {})())
  const lease = io.retainHostedInput()
  const entered = deferred()
  const release = deferred()
  let acknowledgements = 0
  const pump = await startHostedNativeLeadMailboxPump({
    envelope: { ...fixture.envelope, mailboxPollMs: 50 },
    hostedInput: lease,
    onFatalError: () => {},
    processProtocolMessage: async () => {
      entered.resolve()
      await release.promise
      return true
    },
    effects: {
      writeFileAtomic: (async () => { acknowledgements++ }) as never,
    },
  })
  await writeFile(inbox, JSON.stringify([{
    from: 'worker', text: '{"type":"shutdown_approved"}',
    timestamp: new Date().toISOString(), read: false,
  }]), { mode: 0o600 })
  await entered.promise
  let stopped = false
  const stopping = pump.stop().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release.resolve()
  await stopping
  expect(acknowledgements).toBe(0)
  lease.close()
  await io.structuredInput.return(undefined)
})

test('ready cancellation aggregates primary removal and stop failures', async () => {
  const fixture = await envelopeFixture()
  const readyFailure = new Error('ready publication failed')
  const removalFailure = new Error('compensating removal failed')
  const stopFailure = new Error('pump stop failed')
  let stopping = false
  try {
    await publishHostedNativeReady({
      envelope: fixture.envelope,
      pump: { stop: async () => { throw stopFailure } },
      isStopping: () => stopping,
      write: async () => {
        stopping = true
        throw readyFailure
      },
      remove: (async () => { throw removalFailure }) as never,
    })
    throw new Error('publication unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    const failures = (error as AggregateError).errors
    expect(failures[0]).toBe(readyFailure)
    expect((failures[1] as Error).message).toContain('stopped during readiness')
    expect(failures.slice(2)).toEqual([removalFailure, stopFailure])
  }
})

test('pending consumer preparation cannot dispatch after teardown starts', async () => {
  const prepareEntered = deferred()
  const releasePrepare = deferred<string>()
  let stopping = false
  const dispatched: string[] = []
  const pending = dispatchAfterHostedNativeBarrier({
    isStopping: () => stopping,
    prepare: async () => {
      prepareEntered.resolve()
      return await releasePrepare.promise
    },
    dispatch: value => dispatched.push(value),
  })
  await prepareEntered.promise
  stopping = true
  releasePrepare.resolve('must not run')
  expect(await pending).toBe(false)
  expect(dispatched).toEqual([])
})
