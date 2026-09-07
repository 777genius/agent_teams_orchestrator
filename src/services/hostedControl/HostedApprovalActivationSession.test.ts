import { afterEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HostedApprovalActivatablePort } from './HostedApprovalActivatablePort.js'
import {
  HostedApprovalActivationSession,
  HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES,
  type HostedApprovalActivationConnection,
  type HostedApprovalActivationRecovery,
  type HostedApprovalActivationRuntimeAuthority,
} from './HostedApprovalActivationSession.js'
import {
  createHostedApprovalActivationV2Proof,
  type HostedApprovalActivationBinding,
  type HostedApprovalActivationExpectation,
} from './HostedApprovalRuntimeActivation.js'
import { createHostedApprovalActivationV2ProductionPins, HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV, HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV, createHostedApprovalActivationV2PinsForTest } from './HostedApprovalActivationV2Pins.js'
import { HostedApprovalDeferredManifestV2 } from './HostedApprovalDeferredManifestV2.js'
import { fixtureHeaderV2 } from './fixtures/bootstrapV2Producer.js'
import type { HostedApprovalWirePort } from './HostedApprovalWire.js'

type Golden = {
  proof: { testOnlySecretHex: string }
  signing: {
    publicKeySpkiDerBase64url: string
    publicKeyDigest: `sha256:${string}`
    contractDigest: `sha256:${string}`
  }
  binding: HostedApprovalActivationBinding
  admissionDocument: string
  prepare: { transportBytes: string; serializedUnsigned: string }
  ownerReady: { transportBytes: string }
  publication: { transportBytes: string }
  ready: { transportBytes: string }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('HostedApprovalActivationSession', () => {
  test('maps the exact C1 prepare and publication to exact owner_ready and activation-bound ready', async () => {
    const harness = await createHarness()
    const events: string[] = []
    harness.recover = async () => {
      events.push('recovered')
      return delegate
    }
    const session = harness.session(events)

    harness.connection.receivePublicationAfterOwnerReady =
      async (ownerReady, maximumBytes) => {
        events.push('owner_ready_published')
        expect(ownerReady).toBe(harness.golden.ownerReady.transportBytes)
        expect(maximumBytes).toBe(512 * 1024)
        expect(harness.port.lifecycle.status).toBe('inactive')
        return harness.golden.publication.transportBytes
      }
    const ready = await session.activate(harness.golden.prepare.transportBytes)

    expect(ready).toBe(harness.golden.ready.transportBytes)
    expect(session.phase).toBe('ready')
    expect(harness.port.lifecycle.status).toBe('active')
    expect(events).toEqual([
      'bootstrap', 'root', 'owner_ready_published', 'recovered',
      'socket_token', 'bootstrap', 'root', 'socket_consume', 'installed',
    ])
  })

  test('legacy production authentication fails before recovery while environment pins are unavailable', async () => {
    const harness = await createHarness()
    let recoveries = 0
    const session = HostedApprovalActivationSession.production({
      ...harness.options,
      recover: async () => { recoveries++; return delegate },
    })
    harness.connection.receivePublicationAfterOwnerReady = transition(harness)
      .receivePublicationAfterOwnerReady
    await expect(session.activate(harness.golden.prepare.transportBytes))
      .rejects.toThrow(/production_pins_unavailable/)
    expect(recoveries).toBe(0)
    expect(harness.port.lifecycle.status).toBe('inactive')
  })

  test('publication transition is one-shot, same-session, and unavailable until owner_ready', async () => {
    const harness = await createHarness()
    let release!: (source: string) => void
    const publication = new Promise<string>(resolve => { release = resolve })
    let entered!: () => void
    const ownerReadyEntered = new Promise<void>(resolve => { entered = resolve })
    let ownerReadyObserved = false
    const session = harness.session()
    harness.connection.receivePublicationAfterOwnerReady = async ownerReady => {
        ownerReadyObserved = ownerReady === harness.golden.ownerReady.transportBytes
        entered()
        return publication
    }
    const activation = session.activate(harness.golden.prepare.transportBytes)
    const second = session.activate(harness.golden.prepare.transportBytes)
    await expect(second).rejects.toThrow(/wrong_phase/)
    await ownerReadyEntered
    expect(ownerReadyObserved).toBe(true)
    release(harness.golden.publication.transportBytes)
    await expect(activation).resolves.toBe(harness.golden.ready.transportBytes)
  })

  test('revokes before activation and while prepare currency checks are pending', async () => {
    const before = await createHarness()
    const beforeCleanup: Array<HostedApprovalWirePort | null> = []
    before.cleanup = value => { beforeCleanup.push(value) }
    const beforeSession = before.session()

    await beforeSession.revoke()
    expect(beforeSession.phase).toBe('revoked')
    expect(before.port.lifecycle).toEqual({ status: 'revoked', epoch: 1, sealed: true })
    expect(beforeCleanup).toEqual([null])
    await expect(beforeSession.activate(before.golden.prepare.transportBytes))
      .rejects.toThrow(/wrong_phase/)

    const during = await createHarness()
    const bootstrap = deferred<boolean>()
    let bootstrapCalls = 0
    let transitioned = false
    during.authority.assertBootstrapCurrent = () => {
      bootstrapCalls++
      return bootstrapCalls === 1 ? bootstrap.promise : true
    }
    during.connection.receivePublicationAfterOwnerReady = async () => {
      transitioned = true
      return during.golden.publication.transportBytes
    }
    const duringSession = during.session()
    const activation = duringSession.activate(during.golden.prepare.transportBytes)
    await Promise.resolve()
    const revocation = duringSession.revoke()
    expect(during.port.lifecycle.status).toBe('revoked')
    bootstrap.resolve(true)

    await revocation
    await expect(activation).rejects.toThrow(/attempt_stale/)
    expect(duringSession.phase).toBe('revoked')
    expect(transitioned).toBe(false)
  })

  test('revocation linearizes during publication wait before awaited cleanup', async () => {
    const harness = await createHarness()
    const entered = deferred<void>()
    const publication = deferred<string>()
    const cleanupRelease = deferred<void>()
    harness.cleanup = async () => { await cleanupRelease.promise }
    harness.connection.receivePublicationAfterOwnerReady = async () => {
      entered.resolve()
      return publication.promise
    }
    const session = harness.session()
    const activation = session.activate(harness.golden.prepare.transportBytes)
    await entered.promise

    const revocation = session.revoke()
    expect(session.phase).toBe('revoked')
    expect(harness.port.lifecycle.status).toBe('revoked')
    publication.resolve(harness.golden.publication.transportBytes)
    cleanupRelease.resolve()

    await revocation
    await expect(activation).rejects.toThrow(/wrong_phase/)
    expect(harness.port.lifecycle.status).toBe('revoked')
  })

  test('revokes during recovery and cleans a delegate recovered after linearization', async () => {
    const harness = await createHarness()
    const entered = deferred<void>()
    const recovered = deferred<HostedApprovalWirePort>()
    const cleaned: Array<HostedApprovalWirePort | null> = []
    harness.cleanup = value => { cleaned.push(value) }
    harness.recover = async () => {
      entered.resolve()
      return recovered.promise
    }
    harness.connection.receivePublicationAfterOwnerReady = transition(harness)
      .receivePublicationAfterOwnerReady
    const session = harness.session()
    const activation = session.activate(harness.golden.prepare.transportBytes)
    await entered.promise

    const revocation = session.revoke()
    expect(harness.port.lifecycle.status).toBe('revoked')
    recovered.resolve(delegate)

    await revocation
    await expect(activation).rejects.toThrow(/attempt_stale/)
    expect(session.phase).toBe('revoked')
    expect(cleaned).toEqual([null, delegate])
  })

  test('fails activation closed when revoked at install and revokes after ready', async () => {
    const atInstall = await createHarness()
    const installCleanup: Array<HostedApprovalWirePort | null> = []
    atInstall.cleanup = value => { installCleanup.push(value) }
    atInstall.connection.receivePublicationAfterOwnerReady = transition(atInstall)
      .receivePublicationAfterOwnerReady
    const beginRecovery = atInstall.port.beginRecovery.bind(atInstall.port)
    let installRevocation: Promise<void> | undefined
    let installSession!: HostedApprovalActivationSession
    atInstall.port.beginRecovery = () => {
      const guard = beginRecovery()
      return Object.freeze({
        ...guard,
        install: (value: HostedApprovalWirePort) => {
          guard.install(value)
          installRevocation = installSession.revoke()
        },
      })
    }
    installSession = atInstall.session()

    await expect(installSession.activate(atInstall.golden.prepare.transportBytes))
      .rejects.toThrow(/attempt_stale/)
    await installRevocation
    expect(installSession.phase).toBe('revoked')
    expect(atInstall.port.lifecycle.status).toBe('revoked')
    expect(installCleanup).toEqual([delegate])

    const afterReady = await createHarness()
    const readyCleanup: Array<HostedApprovalWirePort | null> = []
    afterReady.cleanup = value => { readyCleanup.push(value) }
    afterReady.connection.receivePublicationAfterOwnerReady = transition(afterReady)
      .receivePublicationAfterOwnerReady
    const readySession = afterReady.session()
    await expect(readySession.activate(afterReady.golden.prepare.transportBytes))
      .resolves.toBe(afterReady.golden.ready.transportBytes)

    await readySession.revoke()
    expect(readySession.phase).toBe('revoked')
    expect(afterReady.port.lifecycle.status).toBe('revoked')
    expect(readyCleanup).toEqual([delegate])
  })

  test('coalesces repeated revoke and the revoke-versus-failure race', async () => {
    const repeated = await createHarness()
    let repeatedCleanups = 0
    repeated.cleanup = () => { repeatedCleanups++ }
    const repeatedSession = repeated.session()
    await Promise.all([
      repeatedSession.revoke(),
      repeatedSession.revoke(),
      repeatedSession.revoke(),
    ])
    expect(repeatedCleanups).toBe(1)
    expect(repeated.port.lifecycle).toEqual({ status: 'revoked', epoch: 1, sealed: true })

    const racing = await createHarness()
    const raceCleanup: Array<HostedApprovalWirePort | null> = []
    racing.cleanup = value => { raceCleanup.push(value) }
    racing.connection.receivePublicationAfterOwnerReady = transition(racing)
      .receivePublicationAfterOwnerReady
    let rootChecks = 0
    let raceRevocation: Promise<void> | undefined
    let racingSession!: HostedApprovalActivationSession
    racing.authority.assertRootCurrent = () => {
      rootChecks++
      if (rootChecks === 2) {
        raceRevocation = racingSession.revoke()
        return false
      }
      return true
    }
    racingSession = racing.session()

    await expect(racingSession.activate(racing.golden.prepare.transportBytes))
      .rejects.toThrow(/root_stale/)
    await raceRevocation
    expect(racingSession.phase).toBe('revoked')
    expect(racing.port.lifecycle.status).toBe('revoked')
    expect(raceCleanup).toEqual([delegate])
  })

  test('strictly rejects prepare proof direction, challenge, binding, order, LF, and size', async () => {
    const cases: Array<[string, (harness: Harness) => string]> = [
      ['wrong direction', harness => withProof(
        harness.golden.prepare.serializedUnsigned,
        createHostedApprovalActivationV2Proof(
          harness.golden.proof.testOnlySecretHex,
          'admission',
          harness.golden.prepare.serializedUnsigned,
        ),
      )],
      ['challenge', harness => harness.golden.prepare.transportBytes.replace(
        `"challenge":"${'3'.repeat(64)}"`,
        `"challenge":"${'4'.repeat(64)}"`,
      )],
      ['binding', harness => mutatePrepare(harness, value => {
        ;(value.binding as any).socketPath = '/run/wrong.sock'
      })],
      ['order', harness => {
        const value = JSON.parse(harness.golden.prepare.transportBytes)
        return `${JSON.stringify({ operation: value.operation, schemaVersion: 2,
          capability: value.capability, challenge: value.challenge,
          binding: value.binding, controllerProof: value.controllerProof })}\n`
      }],
      ['missing LF', harness => harness.golden.prepare.transportBytes.slice(0, -1)],
      ['CRLF', harness => `${harness.golden.prepare.transportBytes.slice(0, -1)}\r\n`],
      ['size', harness => `${' '.repeat(HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES)}\n`],
    ]

    for (const [name, source] of cases) {
      const harness = await createHarness()
      let transitioned = false
      harness.connection.receivePublicationAfterOwnerReady = async () => {
          transitioned = true
          return harness.golden.publication.transportBytes
        }
      await expect(harness.session().activate(source(harness)), name).rejects.toThrow()
      expect(transitioned, name).toBe(false)
      expect(harness.port.lifecycle.status, name).toBe('inactive')
    }
  })

  test('rejects publication signature, proof, ordering, LF, and byte limit before recovery', async () => {
    const mutations: Array<[string, (source: string) => string]> = [
      ['signature', source => source.replace(/"signature":"./, '"signature":"A')],
      ['proof', source => source.replace(/"controllerProof":"./, '"controllerProof":"0')],
      ['order', source => {
        const value = JSON.parse(source)
        return `${JSON.stringify({ envelope: value.envelope, schemaVersion: 2,
          authorship: value.authorship })}\n`
      }],
      ['LF', source => source.slice(0, -1)],
      ['size', () => `${' '.repeat(512 * 1024)}\n`],
    ]
    for (const [name, mutate] of mutations) {
      const harness = await createHarness()
      let recoveries = 0
      harness.recover = async () => { recoveries++; return delegate }
      harness.connection.receivePublicationAfterOwnerReady = async () =>
        mutate(harness.golden.publication.transportBytes)
      await expect(harness.session().activate(
        harness.golden.prepare.transportBytes,
      ), name).rejects.toThrow()
      expect(recoveries, name).toBe(0)
      expect(harness.port.lifecycle.status, name).toBe('inactive')
    }
  })

  test('recovers before install, rechecks every fence, and never constructs ready before install', async () => {
    const harness = await createHarness()
    let cleaned: HostedApprovalWirePort | null = null
    harness.cleanup = value => { cleaned = value }
    harness.recover = async admission => {
      expect(harness.port.lifecycle.status).toBe('recovering')
      expect(await admission.isCurrent()).toBe(true)
      await writeFile(harness.rawPath, '{}\n', { mode: 0o600 })
      await chmod(harness.rawPath, 0o600)
      return delegate
    }
    harness.connection.receivePublicationAfterOwnerReady = transition(harness)
      .receivePublicationAfterOwnerReady
    await expect(harness.session().activate(harness.golden.prepare.transportBytes))
      .rejects.toThrow(/raw_admission_stale/)
    expect(harness.port.lifecycle.status).toBe('revoked')
    expect(cleaned).toBe(delegate)
  })

  test('final bootstrap, root, socket, attempt, binding, and pins fences fail closed', async () => {
    const fences: Array<[string, (harness: Harness) => void]> = [
      ['bootstrap', harness => { harness.bootstrapCurrent = false }],
      ['root', harness => { harness.rootCurrent = false }],
      ['socket', harness => { harness.socketCurrent = false }],
      ['attempt', harness => { void harness.port.revoke() }],
      ['binding', harness => {
        harness.expectation = { ...harness.expectation, approvalGeneration: 4 }
      }],
      ['pins', harness => { harness.pins.publicKeySpkiDer[0] ^= 0xff }],
    ]
    for (const [name, invalidate] of fences) {
      const harness = await createHarness()
      harness.recover = async () => { invalidate(harness); return delegate }
      harness.connection.receivePublicationAfterOwnerReady = transition(harness)
        .receivePublicationAfterOwnerReady
      await expect(harness.session().activate(
        harness.golden.prepare.transportBytes,
      ), name).rejects.toThrow()
      expect(harness.port.lifecycle.status, name).toBe('revoked')
    }
  })

  test('requires the runtime owner/socket identity and path before publishing owner_ready', async () => {
    const harness = await createHarness()
    harness.connection.ownerBinding = {
      ...harness.connection.ownerBinding,
      ownerSessionId: 'owner-session_wrong-identity',
    }
    let transitioned = false
    harness.connection.receivePublicationAfterOwnerReady = async () => {
        transitioned = true
        return harness.golden.publication.transportBytes
      }
    await expect(harness.session().activate(harness.golden.prepare.transportBytes))
      .rejects.toThrow(/connection_binding_mismatch/)
    expect(transitioned).toBe(false)
  })
})

type Harness = Awaited<ReturnType<typeof createHarness>>

async function createHarness() {
  const golden = JSON.parse(await readFile(
    new URL('./fixtures/hosted-approval-activation-v2-golden.json', import.meta.url),
    'utf8',
  )) as Golden
  const directory = await mkdtemp(join(tmpdir(), 'hosted-activation-session-'))
  temporaryDirectories.push(directory)
  const rawPath = join(directory, 'admission.json')
  await writeFile(rawPath, golden.admissionDocument, { mode: 0o600 })

  const expectation = expectationFromBinding(golden.binding)
  const pins = createHostedApprovalActivationV2PinsForTest({
    publicKeySpkiDer: Buffer.from(golden.signing.publicKeySpkiDerBase64url, 'base64url'),
    publicKeyDigest: golden.signing.publicKeyDigest,
    contractDigest: golden.signing.contractDigest,
  })
  const port = new HostedApprovalActivatablePort()
  const harness = {
    golden,
    rawPath,
    pins,
    port,
    expectation,
    bootstrapCurrent: true,
    rootCurrent: true,
    socketCurrent: true,
    recover: (async () => delegate) as HostedApprovalActivationRecovery,
    cleanup: undefined as undefined | ((
      delegate: HostedApprovalWirePort | null,
    ) => void | Promise<void>),
    events: undefined as string[] | undefined,
    connection: null as unknown as MutableConnection,
    authority: null as unknown as HostedApprovalActivationRuntimeAuthority,
    options: null as unknown as Parameters<typeof HostedApprovalActivationSession.production>[0],
    session: null as unknown as
      (events?: string[]) => HostedApprovalActivationSession,
  }
  harness.connection = {
    ownerBinding: structuredClone(golden.binding.ownerBinding),
    socketPath: golden.binding.socketPath,
    isCurrent: () => harness.socketCurrent,
    prepareEffectToken: () => {
      harness.events?.push('socket_token')
      if (!harness.socketCurrent) return null
      let consumed = false
      return { consume: () => {
        harness.events?.push('socket_consume')
        if (consumed) return false
        consumed = true
        return harness.socketCurrent
      } }
    },
    receivePublicationAfterOwnerReady: async () => golden.publication.transportBytes,
  }
  harness.authority = {
    snapshot: () => harness.expectation,
    assertBootstrapCurrent: () => {
      harness.events?.push('bootstrap')
      return harness.bootstrapCurrent
    },
    assertRootCurrent: () => {
      harness.events?.push('root')
      return harness.rootCurrent
    },
  }
  Object.defineProperty(harness, 'options', { get: () => ({
    proofKey: golden.proof.testOnlySecretHex,
    authority: harness.authority,
    connection: harness.connection,
    rawAdmissionPath: rawPath,
    port,
    recover: (...args: Parameters<typeof harness.recover>) => harness.recover(...args),
    cleanup: harness.cleanup,
  }) })
  harness.session = (events?: string[]) => {
    harness.events = events
    const originalInstall = port.beginRecovery.bind(port)
    if (events) {
      port.beginRecovery = () => {
        const guard = originalInstall()
        const install = guard.install
        return Object.freeze({ ...guard, install: (value: HostedApprovalWirePort) => {
          install(value)
          events.push('installed')
        } })
      }
    }
    return HostedApprovalActivationSession.forTest(harness.options, pins)
  }
  return harness
}

type MutableConnection = HostedApprovalActivationConnection & {
  ownerBinding: HostedApprovalActivationConnection['ownerBinding']
  socketPath: string
}

function transition(harness: Harness) {
  return {
    receivePublicationAfterOwnerReady: async (ownerReady: string) => {
      expect(ownerReady).toBe(harness.golden.ownerReady.transportBytes)
      return harness.golden.publication.transportBytes
    },
  }
}

function expectationFromBinding(
  binding: HostedApprovalActivationBinding,
): HostedApprovalActivationExpectation {
  return {
    authority: {
      deploymentId: binding.deploymentId,
      bootId: binding.bootId,
      workspaceId: binding.workspaceId,
      teamId: binding.teamId,
      restoreGeneration: binding.restoreGeneration,
      mountBinding: structuredClone(binding.mountBinding),
    },
    ownerBinding: structuredClone(binding.ownerBinding),
    socketPath: binding.socketPath,
    approvalGeneration: binding.approvalGeneration,
    admissionOwnerGeneration: binding.admissionOwnerGeneration,
    approvalDigest: binding.approvalDigest,
    admissionDocumentDigest: binding.admissionDocumentDigest,
    ownerArtifactDigest: binding.ownerArtifactDigest,
    wireCapabilityDigest: binding.wireCapabilityDigest,
    signedManifest: structuredClone(binding.signedManifest),
  }
}

function mutatePrepare(harness: Harness, mutate: (value: any) => void): string {
  const value = JSON.parse(harness.golden.prepare.transportBytes)
  delete value.controllerProof
  mutate(value)
  const unsigned = JSON.stringify(value)
  return withProof(unsigned, createHostedApprovalActivationV2Proof(
    harness.golden.proof.testOnlySecretHex,
    'owner-ready-request',
    unsigned,
  ))
}

function withProof(unsigned: string, proof: string): string {
  return `${unsigned.slice(0, -1)},"controllerProof":"${proof}"}\n`
}

const delegate = Object.freeze({}) as HostedApprovalWirePort

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('production factories retain explicit validated pins before prepare and across recovery', async () => {
  const names = [HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV, HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV]
  const previous = names.map(name => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    for (const deferred of [false, true]) {
      for (const mismatch of ['none', 'key', 'contract']) {
        for (const name of names) delete process.env[name]
        const harness = await createHarness()
        const input = { publicKeySpkiDerBase64url: mismatch === 'key' ?
          generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') :
          harness.golden.signing.publicKeySpkiDerBase64url,
          contractDigest: mismatch === 'contract' ? `sha256:${'f'.repeat(64)}` : harness.golden.signing.contractDigest }
        const pins = createHostedApprovalActivationV2ProductionPins(input)
        let recovered = 0
        harness.recover = async () => {
          recovered++
          // Mutation between first signature verification and the final fence.
          pins.publicKeySpkiDer.fill(0)
          for (const name of names) process.env[name] = 'malformed'
          input.contractDigest = `sha256:${'e'.repeat(64)}`
          return delegate
        }
        const { manifestDigest: _, ...pending } = harness.expectation.signedManifest
        const options = { ...harness.options, expectedHost: fixtureHeaderV2().expectedHost,
          authority: { ...harness.authority, snapshot: () => ({ ...harness.expectation, signedManifest: pending }) } }
        const session = deferred ? HostedApprovalDeferredManifestV2.production(options, pins) :
          HostedApprovalActivationSession.production(harness.options, pins)
        input.publicKeySpkiDerBase64url = 'malformed'
        pins.publicKeySpkiDer.fill(0)
        if (mismatch !== 'none') {
          await expect(session.activate(harness.golden.prepare.transportBytes)).rejects.toThrow(/pin/)
          expect(recovered).toBe(0)
          expect(harness.port.lifecycle.status).toBe(deferred ? 'revoked' : 'inactive')
        } else {
          expect(await session.activate(harness.golden.prepare.transportBytes)).toBe(harness.golden.ready.transportBytes)
          expect(recovered).toBe(1)
          expect(harness.port.lifecycle.status).toBe('active')
        }
        expect(() => HostedApprovalActivationSession.production(harness.options, harness.pins as typeof pins)).toThrow(/pins_unavailable/)
        expect(() => HostedApprovalDeferredManifestV2.production(options, harness.pins as typeof pins)).toThrow(/pins_unavailable/)
      }
    }
  } finally {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i] })
  }
})
