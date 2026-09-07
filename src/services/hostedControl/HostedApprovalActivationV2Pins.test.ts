import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'

import {
  HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV,
  getHostedApprovalActivationV2ProductionPins,
  createHostedApprovalActivationV2ProductionPins,
  createHostedApprovalActivationV2PinsForTest,
  requireHostedApprovalActivationV2ProductionPins,
} from './HostedApprovalActivationV2Pins.js'

const previousSpki = process.env[HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV]
const previousContract = process.env[HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV]

afterEach(() => {
  restore(HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV, previousSpki)
  restore(HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV, previousContract)
})

describe('HostedApprovalActivationV2 production pins', () => {
  test('fails closed when deployment provisioning is absent or malformed', () => {
    delete process.env[HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV]
    delete process.env[HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV]
    expect(() => getHostedApprovalActivationV2ProductionPins()).toThrow(/pins_unavailable/)

    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    process.env[HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV] = publicKey
      .export({ format: 'der', type: 'spki' }).toString('base64url')
    process.env[HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV] =
      `sha256:${'a'.repeat(64)}`
    expect(() => getHostedApprovalActivationV2ProductionPins()).toThrow(/pins_unavailable/)

    process.env[HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV] = 'not+padded=='
    expect(() => getHostedApprovalActivationV2ProductionPins()).toThrow(/pins_unavailable/)
  })

  test('accepts only the exact deployment-provided Ed25519 SPKI and contract pin', () => {
    // Fresh identity: production tests never provision the repository golden key.
    const { publicKey } = generateKeyPairSync('ed25519')
    const spki = publicKey.export({ format: 'der', type: 'spki' })
    const contractDigest = `sha256:${'b'.repeat(64)}` as const
    process.env[HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV] = spki.toString('base64url')
    process.env[HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV] = contractDigest

    const pins = getHostedApprovalActivationV2ProductionPins()
    expect(Buffer.from(pins.publicKeySpkiDer)).toEqual(spki)
    expect(pins.publicKeyDigest).toBe(
      `sha256:${createHash('sha256').update(spki).digest('hex')}`,
    )
    expect(pins.contractDigest).toBe(contractDigest)
    expect(Object.isFrozen(pins)).toBe(true)
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

test('explicit production validation rejects malformed, noncanonical and non-Ed25519 deployment inputs', () => {
  const spki = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' })
  const contractDigest = `sha256:${'b'.repeat(64)}` as const
  const encoded = spki.toString('base64url')
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' })
  for (const publicKeySpkiDerBase64url of ['', 'AA', encoded + '=',
    Buffer.concat([spki, Buffer.from([0])]).toString('base64url'), rsa.toString('base64url'),
    // BER long-form length encodes the same key but is not canonical DER.
    Buffer.concat([Buffer.from([0x30, 0x81, spki[1]!]), spki.subarray(2)]).toString('base64url')]) {
    expect(() => createHostedApprovalActivationV2ProductionPins({ publicKeySpkiDerBase64url, contractDigest })).toThrow(/pins_unavailable/)
  }
  for (const digest of ['', 'b'.repeat(64), `sha256:${'B'.repeat(64)}`, contractDigest + '\n']) {
    expect(() => createHostedApprovalActivationV2ProductionPins({ publicKeySpkiDerBase64url: encoded, contractDigest: digest })).toThrow(/pins_unavailable/)
  }
  const pins = createHostedApprovalActivationV2ProductionPins({ publicKeySpkiDerBase64url: encoded, contractDigest })
  const testPins = createHostedApprovalActivationV2PinsForTest(pins)
  for (const forged of [testPins, { ...pins }, Object.create(pins), undefined, null]) {
    expect(() => requireHostedApprovalActivationV2ProductionPins(forged as typeof pins)).toThrow(/pins_unavailable/)
  }
  pins.publicKeySpkiDer.fill(0)
  expect(Buffer.from(pins.publicKeySpkiDer)).toEqual(spki)
})
