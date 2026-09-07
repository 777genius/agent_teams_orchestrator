import { describe, expect, test } from 'bun:test'
import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN,
  HOSTED_APPROVAL_ACTIVATION_WIRE_CAPABILITY_DIGEST,
  createHostedApprovalActivationV2Proof,
  unwrapHostedApprovalActivation,
  unwrapHostedApprovalActivationForTest,
  type HostedApprovalActivationBinding,
  type HostedApprovalActivationExpectation,
} from './HostedApprovalRuntimeActivation.js'
import {
  createHostedApprovalActivationV2PinsForTest,
  createHostedApprovalActivationV2ProductionPins,
  HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV,
  HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV,
  type HostedApprovalActivationV2PinSource,
} from './HostedApprovalActivationV2Pins.js'

type Golden = {
  proofKeyHex: string
  privateKeyPkcs8Pem: string
  publicKeySpkiDer: string
  publicKeyDigest: `sha256:${string}`
  contractDigest: `sha256:${string}`
  binding: HostedApprovalActivationBinding
  admissionDocument: string
  controllerProof: string
  signature: string
  c1: C1Golden
}

type C1Golden = {
  schemaVersion: 2
  contract: string
  proof: { testOnlySecretHex: string }
  signing: {
    testOnlyPrivateKeyPkcs8Pem: string
    publicKeySpkiDerBase64url: string
    publicKeyDigest: `sha256:${string}`
    contractDigest: `sha256:${string}`
  }
  binding: HostedApprovalActivationBinding
  admissionDocument: string
  expectedDerivedTeamView: {
    teamId: string
    routes: any[]
    actorMembers: Record<string, string>
  }
  prepare: C1ProofVector
  ownerReady: C1ProofVector
  publication: C1ProofVector & {
    serializedUnsignedEnvelope: string
    signature: string
    transportBytes: string
    activationDigest: string
  }
  ready: C1ProofVector
}

type C1ProofVector = {
  direction: 'owner-ready-request' | 'owner-ready' | 'admission' | 'ready'
  serializedUnsigned?: string
  controllerProof: string
}

describe('hosted approval product activation-v2 verifier', () => {
  test('accepts the product cross-repo golden and returns only frozen authenticated views', async () => {
    const fixture = await golden()
    const admission = JSON.parse(fixture.admissionDocument)
    const publication = publish(fixture, fixture.binding, admission)
    expect(publication.controllerProof).toBe(fixture.controllerProof)
    expect(publication.signature).toBe(fixture.signature)

    const verified = verify(fixture, publication.source, fixture.binding)
    expect(publication.source).toBe(fixture.c1.publication.transportBytes)
    expect(verified.canonicalAdmissionDocument).toBe(fixture.admissionDocument)
    expect(verified.admissionDocumentDigest).toBe(fixture.binding.admissionDocumentDigest)
    expect(verified.activationDigest).toBe(fixture.c1.publication.activationDigest)
    expect(verified.binding.ownerArtifactDigest)
      .not.toBe(verified.globalAdmission.routes[0].openCodeBinding.openCodeArtifactDigest)
    expect(verified.globalAdmission.routes).toHaveLength(2)
    expect(verified.requestedTeam.routes).toHaveLength(1)
    expect(verified.requestedTeam.teamId).toBe(fixture.binding.teamId)
    expect(verified.requestedTeam.admissionGeneration)
      .toBe(verified.globalAdmission.admissionGeneration)
    expect(verified.requestedTeam.approvalDigest).toBe(fixture.binding.approvalDigest)
    expect(verified.requestedTeam.globalAdmissionDigest)
      .toBe(verified.admissionDocumentDigest)
    expect(fixture.binding.wireCapabilityDigest)
      .toBe(HOSTED_APPROVAL_ACTIVATION_WIRE_CAPABILITY_DIGEST)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.binding.ownerBinding.socketIdentity)).toBe(true)
    expect(Object.isFrozen(verified.globalAdmission.routes[0].openCodeBinding)).toBe(true)
    expect(Object.isFrozen(verified.requestedTeam.actorMembers)).toBe(true)
    expect(verified.requestedTeam.routes).toEqual(fixture.c1.expectedDerivedTeamView.routes)
    expect(verified.requestedTeam.actorMembers)
      .toEqual(fixture.c1.expectedDerivedTeamView.actorMembers)
  })

  test('consumes all four exact C1 HMAC vectors and pins the C1 contract bytes', async () => {
    const fixture = await golden()
    for (const vector of [
      fixture.c1.prepare,
      fixture.c1.ownerReady,
      fixture.c1.publication,
      fixture.c1.ready,
    ]) {
      const unsigned = vector.direction === 'admission'
        ? fixture.c1.publication.serializedUnsignedEnvelope
        : vector.serializedUnsigned!
      expect(createHostedApprovalActivationV2Proof(
        fixture.proofKeyHex,
        vector.direction,
        unsigned,
      )).toBe(vector.controllerProof)
    }

    const contract = await readFile(new URL(
      './fixtures/hosted-approval-activation-v2-contract.json',
      import.meta.url,
    ), 'utf8')
    expect(sha256(contract)).toBe(fixture.contractDigest)
    expect(sha256(contract.replace('"schemaVersion":2', '"schemaVersion":3')))
      .not.toBe(fixture.contractDigest)
  })

  test('authenticates the full global catalog before deriving a requested-team view', async () => {
    const fixture = await golden()
    const admission = JSON.parse(fixture.admissionDocument)
    const second = structuredClone(admission.routes[0])
    second.routeId = 'route_z_second-team'
    second.authority.teamId = 'team_33333333333333333333333333333333'
    second.authority.runId = 'run_88888888888888888888888888888888'
    // Reusing a session ID is legal because uniqueness is the full route tuple.
    second.authority.deliveryOwnerId = 'member_cccccccccccccccccccccccccccccccc'
    second.scope.principalId = 'actor_z_second-team'
    second.scope.teamId = second.authority.teamId
    second.openCodeBinding.deliveryOwnerId = second.authority.deliveryOwnerId
    const third = structuredClone(second)
    third.routeId = 'route_zz_second-team'
    third.authority.runId = 'run_77777777777777777777777777777777'
    third.authority.deliveryOwnerId = 'member_dddddddddddddddddddddddddddddddd'
    third.scope.principalId = 'actor_zz_second-team'
    third.openCodeBinding.deliveryOwnerId = third.authority.deliveryOwnerId
    admission.routes.push(second)
    admission.routes.push(third)
    admission.actorMembers['actor_z_second-team'] = second.authority.deliveryOwnerId
    admission.actorMembers['actor_zz_second-team'] = third.authority.deliveryOwnerId
    const binding = bindAdmission({
      ...fixture.binding,
      teamId: second.authority.teamId,
    }, admission)
    const verified = verify(fixture, publish(fixture, binding, admission).source, binding)

    expect(verified.globalAdmission.routes).toHaveLength(4)
    expect(verified.requestedTeam.routes.map(route => route.routeId)).toEqual([
      second.routeId,
      third.routeId,
    ])
    expect(verified.requestedTeam.actorMembers).toEqual({
      'actor_z_second-team': second.authority.deliveryOwnerId,
      'actor_zz_second-team': third.authority.deliveryOwnerId,
    })
    expect(verified.admissionDocumentDigest).toBe(binding.admissionDocumentDigest)
  })

  test('rejects wrapper/envelope reordering, unknown fields, and the legacy raw path', async () => {
    const fixture = await golden()
    const admission = JSON.parse(fixture.admissionDocument)
    const good = publish(fixture, fixture.binding, admission)
    const wrapper = JSON.parse(good.source)
    const reorderedWrapper = `${JSON.stringify({
      envelope: wrapper.envelope,
      schemaVersion: 2,
      authorship: wrapper.authorship,
    })}\n`
    expect(() => verify(fixture, reorderedWrapper, fixture.binding)).toThrow(/order/)
    expect(() => verify(fixture, `${JSON.stringify({ ...wrapper, unknown: true })}\n`, fixture.binding))
      .toThrow(/order/)
    expect(() => verify(fixture, good.envelope, fixture.binding)).toThrow(/order|publication/)
    expect(() => verify(
      fixture,
      good.source.replace('{"schemaVersion":2', '{"schemaVersion":1'),
      fixture.binding,
    )).toThrow(/publication/)

    const reorderedBinding = {
      ...fixture.binding,
      ownerBinding: {
        ...fixture.binding.ownerBinding,
        socketIdentity: {
          inode: '12', device: '11', uid: 1000, gid: 1000, mode: 384,
        },
      },
    }
    expect(() => verify(
      fixture,
      publish(fixture, reorderedBinding as HostedApprovalActivationBinding, admission).source,
      reorderedBinding as HostedApprovalActivationBinding,
    )).toThrow(/order/)

    const unknownAdmission = structuredClone(admission)
    unknownAdmission.routes[0].openCodeBinding.ambientAuthority = 'forbidden'
    const unknownBinding = bindAdmission(fixture.binding, unknownAdmission)
    expect(() => verify(
      fixture, publish(fixture, unknownBinding, unknownAdmission).source, unknownBinding,
    )).toThrow(/order/)
  })

  test('rejects signature, HMAC direction/domain/exact-byte, and verifier pin tampering', async () => {
    const fixture = await golden()
    const admission = JSON.parse(fixture.admissionDocument)
    const good = publish(fixture, fixture.binding, admission)
    const parsed = JSON.parse(good.source)
    parsed.authorship.signature = Buffer.alloc(64).toString('base64url')
    expect(() => verify(fixture, `${JSON.stringify(parsed)}\n`, fixture.binding)).toThrow(/authorship/)

    for (const proof of [
      '0'.repeat(64),
      proofFor(fixture.proofKeyHex, good.unsignedEnvelope, 'owner-ready'),
      createHmac('sha256', Buffer.from(fixture.proofKeyHex, 'hex'))
        .update(`wrong-domain\0admission\0${good.unsignedEnvelope}`).digest('hex'),
    ]) {
      const publication = publish(fixture, fixture.binding, admission, proof)
      expect(() => verify(fixture, publication.source, fixture.binding)).toThrow(/proof/)
    }

    const exactByteEnvelope = JSON.parse(good.envelope)
    exactByteEnvelope.binding.socketPath += '-tampered'
    const resigned = publishEnvelope(fixture, JSON.stringify(exactByteEnvelope))
    expect(() => verify(fixture, resigned, {
      ...fixture.binding,
      socketPath: exactByteEnvelope.binding.socketPath,
    })).toThrow(/proof/)

    const wrongContract = createHostedApprovalActivationV2PinsForTest({
      ...productVerifierInput(fixture),
      contractDigest: `sha256:${'9'.repeat(64)}` as const,
    })
    expect(() => unwrapHostedApprovalActivationForTest(
      good.source, fixture.proofKeyHex, wrongContract, expectation(fixture.binding),
    )).toThrow(/pin/)
    const { publicKey } = generateKeyPairSync('ed25519')
    const wrongSpki = publicKey.export({ format: 'der', type: 'spki' })
    const wrongKeyVerifier = createHostedApprovalActivationV2PinsForTest({
      ...productVerifierInput(fixture),
      publicKeySpkiDer: wrongSpki,
      publicKeyDigest: sha256(wrongSpki),
    })
    expect(() => unwrapHostedApprovalActivationForTest(
      good.source, fixture.proofKeyHex, wrongKeyVerifier, expectation(fixture.binding),
    )).toThrow(/pin/)
  })

  test('rejects digest and exact admission generation tampering', async () => {
    const fixture = await golden()
    const admission = JSON.parse(fixture.admissionDocument)
    for (const drift of [
      { approvalDigest: `sha256:${'a'.repeat(64)}` as const },
      { admissionDocumentDigest: `sha256:${'b'.repeat(64)}` as const },
    ]) {
      const binding = { ...fixture.binding, ...drift }
      expect(() => verify(
        fixture, publish(fixture, binding, admission).source, binding,
      )).toThrow(/digest/)
    }
    for (const generation of [
      'approval-admission-generation_03_owner_7',
      'approval-admission-generation_3_owner_07',
      'approval-admission-generation_3_owner_8',
      'approval-admission-generation_3',
    ]) {
      const changed = structuredClone(admission)
      changed.admissionGeneration = generation
      const binding = bindAdmission(fixture.binding, changed)
      expect(() => verify(
        fixture, publish(fixture, binding, changed).source, binding,
      )).toThrow(/generation/)
    }

    const changedOwner = {
      ...fixture.binding,
      ownerArtifactDigest: `sha256:${'c'.repeat(64)}` as const,
    }
    const publication = publish(fixture, changedOwner, admission)
    expect(() => unwrapHostedApprovalActivationForTest(
      publication.source,
      fixture.proofKeyHex,
      productVerifier(fixture),
      expectation(fixture.binding),
    )).toThrow(/binding/)

    const changedWire = {
      ...fixture.binding,
      wireCapabilityDigest: `sha256:${'d'.repeat(64)}` as const,
    }
    expect(() => verify(
      fixture, publish(fixture, changedWire, admission).source, changedWire,
    )).toThrow(/binding/)
  })

  test('rejects team, scope, and effect tampering after valid signing and HMAC', async () => {
    const fixture = await golden()
    const base = JSON.parse(fixture.admissionDocument)
    const cases: Array<(admission: any) => void> = [
      admission => { admission.routes[0].authority.teamId = 'team_22222222222222222222222222222222' },
      admission => { admission.routes[0].scope.teamId = 'team_22222222222222222222222222222222' },
      admission => { admission.routes[0].scope.workspaceId = 'workspace_tampered' },
      admission => { admission.routes[0].openCodeBinding.toolApprovalMode = 'auto' },
      admission => { admission.routes[0].openCodeBinding.liveEffectFingerprint = 'c'.repeat(63) },
    ]
    for (const tamper of cases) {
      const admission = structuredClone(base)
      tamper(admission)
      const binding = bindAdmission(fixture.binding, admission)
      expect(() => verify(
        fixture, publish(fixture, binding, admission).source, binding,
      )).toThrow(/team|route|binding|open_code/)
    }
  })

  test('rejects duplicate composite routes while allowing a session ID in a distinct tuple', async () => {
    const fixture = await golden()
    const admission = JSON.parse(fixture.admissionDocument)
    const duplicate = structuredClone(admission.routes[0])
    duplicate.routeId = 'route_z_duplicate'
    admission.routes.push(duplicate)
    const binding = bindAdmission(fixture.binding, admission)
    expect(() => verify(
      fixture, publish(fixture, binding, admission).source, binding,
    )).toThrow(/duplicate/)
  })

  test('rejects actor mappings that are not cross-bound by any authenticated route', async () => {
    const fixture = await golden()
    const admission = JSON.parse(fixture.admissionDocument)
    admission.actorMembers.actor_unbound = `member_${'e'.repeat(32)}`
    const binding = bindAdmission(fixture.binding, admission)
    expect(() => verify(
      fixture, publish(fixture, binding, admission).source, binding,
    )).toThrow(/actor_mapping_unbound/)
  })

  test('keeps legacy production authorship unavailable without deployment pins', async () => {
    const fixture = await golden()
    const publication = publish(
      fixture,
      fixture.binding,
      JSON.parse(fixture.admissionDocument),
    )
    expect(() => unwrapHostedApprovalActivation(
      publication.source,
      fixture.proofKeyHex,
      expectation(fixture.binding),
    )).toThrow(/production_pins_unavailable/)

    const alternate = generateKeyPairSync('ed25519')
    const alternateSpki = alternate.publicKey.export({ format: 'der', type: 'spki' })
    const alternateFixture: Golden = {
      ...fixture,
      privateKeyPkcs8Pem: alternate.privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }).toString(),
      publicKeySpkiDer: alternateSpki.toString('base64url'),
      publicKeyDigest: sha256(alternateSpki),
    }
    const arbitrarilyResigned = publish(
      alternateFixture,
      fixture.binding,
      JSON.parse(fixture.admissionDocument),
    )
    expect(() => verify(
      fixture,
      arbitrarilyResigned.source,
      fixture.binding,
    )).toThrow(/pin/)
  })

  test('enforces exact LF-inclusive admission and publication byte boundaries', async () => {
    const fixture = await golden()

    const admissionAtLimit = admissionWithExactBytes(fixture, 256 * 1024)
    const admissionBinding = bindAdmission(fixture.binding, admissionAtLimit)
    expect(Buffer.byteLength(`${JSON.stringify(admissionAtLimit)}\n`)).toBe(256 * 1024)
    expect(() => verify(
      fixture,
      publish(fixture, admissionBinding, admissionAtLimit).source,
      admissionBinding,
    )).not.toThrow()

    const admissionOverLimit = admissionWithExactBytes(fixture, 256 * 1024 + 1)
    const overAdmissionBinding = bindAdmission(fixture.binding, admissionOverLimit)
    expect(() => verify(
      fixture,
      publish(fixture, overAdmissionBinding, admissionOverLimit).source,
      overAdmissionBinding,
    )).toThrow(/admission_too_large/)

    const publicationAtLimit = publicationWithExactBytes(fixture, 512 * 1024)
    expect(Buffer.byteLength(publicationAtLimit.source)).toBe(512 * 1024)
    expect(() => verify(
      fixture,
      publicationAtLimit.source,
      publicationAtLimit.binding,
    )).not.toThrow()

    const publicationOverLimit = publicationWithExactBytes(fixture, 512 * 1024 + 1)
    expect(Buffer.byteLength(publicationOverLimit.source)).toBe(512 * 1024 + 1)
    expect(() => verify(
      fixture,
      publicationOverLimit.source,
      publicationOverLimit.binding,
    )).toThrow(/publication_too_large/)
  })
})

async function golden(): Promise<Golden> {
  const c1 = JSON.parse(await readFile(new URL(
    './fixtures/hosted-approval-activation-v2-golden.json',
    import.meta.url,
  ), 'utf8')) as C1Golden
  return {
    proofKeyHex: c1.proof.testOnlySecretHex,
    privateKeyPkcs8Pem: c1.signing.testOnlyPrivateKeyPkcs8Pem,
    publicKeySpkiDer: c1.signing.publicKeySpkiDerBase64url,
    publicKeyDigest: c1.signing.publicKeyDigest,
    contractDigest: c1.signing.contractDigest,
    binding: c1.binding,
    admissionDocument: c1.admissionDocument,
    controllerProof: c1.publication.controllerProof,
    signature: c1.publication.signature,
    c1,
  }
}

function verify(
  fixture: Golden,
  source: string,
  binding: HostedApprovalActivationBinding,
) {
  return unwrapHostedApprovalActivationForTest(
    source,
    fixture.proofKeyHex,
    productVerifier(fixture),
    expectation(binding),
  )
}

function productVerifier(fixture: Golden): HostedApprovalActivationV2PinSource {
  return createHostedApprovalActivationV2PinsForTest(productVerifierInput(fixture))
}

function productVerifierInput(fixture: Golden) {
  return {
    publicKeySpkiDer: Buffer.from(fixture.publicKeySpkiDer, 'base64url'),
    publicKeyDigest: fixture.publicKeyDigest,
    contractDigest: fixture.contractDigest,
  }
}

function expectation(binding: HostedApprovalActivationBinding): HostedApprovalActivationExpectation {
  return {
    authority: {
      deploymentId: binding.deploymentId,
      bootId: binding.bootId,
      workspaceId: binding.workspaceId,
      teamId: binding.teamId,
      restoreGeneration: binding.restoreGeneration,
      mountBinding: binding.mountBinding,
    },
    ownerBinding: binding.ownerBinding,
    socketPath: binding.socketPath,
    approvalGeneration: binding.approvalGeneration,
    admissionOwnerGeneration: binding.admissionOwnerGeneration,
    approvalDigest: binding.approvalDigest,
    admissionDocumentDigest: binding.admissionDocumentDigest,
    ownerArtifactDigest: binding.ownerArtifactDigest,
    wireCapabilityDigest: binding.wireCapabilityDigest,
    signedManifest: binding.signedManifest,
  }
}

function bindAdmission(
  binding: HostedApprovalActivationBinding,
  admission: any,
): HostedApprovalActivationBinding {
  const document = `${JSON.stringify(admission)}\n`
  return {
    ...binding,
    approvalDigest: sha256(JSON.stringify({
      schemaVersion: 1,
      approvalGeneration: binding.approvalGeneration,
      authorities: admission.routes.map((route: any) => route.authority),
    })),
    admissionDocumentDigest: sha256(document),
  }
}

function publish(
  fixture: Golden,
  binding: HostedApprovalActivationBinding,
  admission: unknown,
  suppliedProof?: string,
) {
  const unsignedEnvelope = JSON.stringify({
    schemaVersion: 2,
    purpose: 'agent-teams.hosted-approval-activation/v2',
    binding,
    admission,
  })
  const controllerProof = suppliedProof ?? proofFor(
    fixture.proofKeyHex,
    unsignedEnvelope,
    'admission',
  )
  const envelope = `${unsignedEnvelope.slice(0, -1)},"controllerProof":"${controllerProof}"}`
  return {
    source: publishEnvelope(fixture, envelope),
    envelope,
    unsignedEnvelope,
    controllerProof,
    signature: signatureFor(fixture, envelope),
  }
}

function publishEnvelope(fixture: Golden, envelope: string): string {
  return `{"schemaVersion":2,"envelope":${envelope},"authorship":${JSON.stringify({
    algorithm: 'Ed25519',
    publicKeyDigest: fixture.publicKeyDigest,
    contractDigest: fixture.contractDigest,
    signature: signatureFor(fixture, envelope),
  })}}\n`
}

function signatureFor(fixture: Golden, envelope: string): string {
  const statement =
    `{"schemaVersion":2,"algorithm":"Ed25519",` +
    `"publicKeyDigest":"${fixture.publicKeyDigest}",` +
    `"contractDigest":"${fixture.contractDigest}","envelope":${envelope}}`
  return sign(
    null,
    Buffer.from(statement, 'utf8'),
    createPrivateKey(fixture.privateKeyPkcs8Pem),
  ).toString('base64url')
}

function proofFor(keyHex: string, unsigned: string, direction: string): string {
  return createHostedApprovalActivationV2Proof(
    keyHex,
    direction as 'owner-ready-request' | 'owner-ready' | 'admission' | 'ready',
    unsigned,
  )
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function admissionWithExactBytes(fixture: Golden, target: number): any {
  const original = JSON.parse(fixture.admissionDocument)
  const admission = structuredClone(original)
  const template = original.routes[0]
  admission.routes = []
  admission.actorMembers = {}

  for (let index = 0; index < 256; index += 1) {
    const suffix = index.toString(16).padStart(32, '0')
    const order = index.toString().padStart(3, '0')
    const route = structuredClone(template)
    route.routeId = `route_${order}`
    route.authority.runId = `run_${suffix}`
    route.authority.deliveryOwnerId = `member_${suffix}`
    route.scope.principalId = `actor_${order}`
    route.openCodeBinding.deliveryOwnerId = route.authority.deliveryOwnerId
    admission.routes.push(route)
    admission.actorMembers[route.scope.principalId] = route.authority.deliveryOwnerId
    if (Buffer.byteLength(`${JSON.stringify(admission)}\n`) >= target) {
      admission.routes.pop()
      delete admission.actorMembers[route.scope.principalId]
      break
    }
  }

  let remaining = target - Buffer.byteLength(`${JSON.stringify(admission)}\n`)
  const fields = [
    'laneId', 'credentialId', 'sessionId', 'runtimeInstanceId',
  ] as const
  for (const route of admission.routes) {
    for (const field of fields) {
      const available = 192 - route.authority[field].length
      const occurrences = field === 'credentialId' || field === 'runtimeInstanceId' ? 2 : 1
      const count = Math.min(available, Math.floor(remaining / occurrences))
      route.authority[field] += 'x'.repeat(count)
      if (field !== 'laneId' && field !== 'sessionId') {
        route.openCodeBinding[field] = route.authority[field]
      }
      remaining -= count * occurrences
      if (remaining === 0) return admission
    }
    const memberAvailable = 192 - route.memberName.length
    const memberCount = Math.min(memberAvailable, remaining)
    route.memberName += 'x'.repeat(memberCount)
    remaining -= memberCount
    if (remaining === 0) return admission
  }
  throw new Error(`unable to construct ${target}-byte admission; ${remaining} bytes remain`)
}

function publicationWithExactBytes(fixture: Golden, target: number): {
  source: string
  binding: HostedApprovalActivationBinding
} {
  const admission = JSON.parse(fixture.admissionDocument)
  const baseBinding = { ...fixture.binding, socketPath: '/' }
  const base = publish(fixture, baseBinding, admission).source
  const padding = target - Buffer.byteLength(base)
  if (padding < 0) throw new Error('publication target is below base size')
  const binding = { ...baseBinding, socketPath: `/${'x'.repeat(padding)}` }
  const source = publish(fixture, binding, admission).source
  if (Buffer.byteLength(source) !== target) throw new Error('publication sizing drift')
  return { source, binding }
}

test('production unwrap verifies a fresh Ed25519 signer with explicit pins and preserves legacy env lookup', async () => {
  const base = await golden()
  const pair = generateKeyPairSync('ed25519')
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' })
  const fixture: Golden = { ...base, publicKeySpkiDer: spki.toString('base64url'),
    publicKeyDigest: sha256(spki), privateKeyPkcs8Pem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
  const source = publish(fixture, fixture.binding, JSON.parse(fixture.admissionDocument)).source
  const input = { publicKeySpkiDerBase64url: fixture.publicKeySpkiDer, contractDigest: fixture.contractDigest }
  const pins = createHostedApprovalActivationV2ProductionPins(input)
  const names = [HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV, HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV]
  const previous = names.map(name => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    input.publicKeySpkiDerBase64url = 'invalid'
    input.contractDigest = `sha256:${'f'.repeat(64)}`
    pins.publicKeySpkiDer.fill(0)
    const verifyProduction = (selected = pins) => unwrapHostedApprovalActivation(source, fixture.proofKeyHex, expectation(fixture.binding), selected)
    expect(verifyProduction().binding).toEqual(fixture.binding)
    const foreign = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    for (const selected of [
      createHostedApprovalActivationV2ProductionPins({ publicKeySpkiDerBase64url: foreign, contractDigest: fixture.contractDigest }),
      createHostedApprovalActivationV2ProductionPins({ publicKeySpkiDerBase64url: fixture.publicKeySpkiDer, contractDigest: input.contractDigest }),
    ]) expect(() => verifyProduction(selected)).toThrow(/pin/)
    expect(() => verifyProduction(createHostedApprovalActivationV2PinsForTest(pins) as typeof pins)).toThrow(/pins_unavailable/)
    const tampered = JSON.parse(source)
    tampered.authorship.signature = Buffer.alloc(64).toString('base64url')
    expect(() => unwrapHostedApprovalActivation(JSON.stringify(tampered), fixture.proofKeyHex, expectation(fixture.binding), pins)).toThrow(/authorship_invalid/)
    expect(() => unwrapHostedApprovalActivation(source, fixture.proofKeyHex, expectation(fixture.binding))).toThrow(/pins_unavailable/)
    process.env[names[0]!] = fixture.publicKeySpkiDer
    process.env[names[1]!] = fixture.contractDigest
    expect(unwrapHostedApprovalActivation(source, fixture.proofKeyHex, expectation(fixture.binding)).binding).toEqual(fixture.binding)
    process.env[names[0]!] = foreign
    expect(() => unwrapHostedApprovalActivation(source, fixture.proofKeyHex, expectation(fixture.binding))).toThrow(/pin/)
    expect(verifyProduction().binding).toEqual(fixture.binding)
  } finally {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i] })
  }
})
