import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'

import {
  HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV,
  getHostedApprovalActivationV2ProductionPins,
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
