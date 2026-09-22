import { createHash, createPublicKey } from 'node:crypto'

/**
 * Production activation-v2 authorship pins.
 *
 * Pin values are deployment inputs. P3.F still owns provisioning those values;
 * absence or any malformed/non-Ed25519 input leaves production unavailable.
 * No test-vector identity is compiled into this module.
 */

const PIN_SOURCE = Symbol('HostedApprovalActivationV2PinSource')
const SHA256 = /^sha256:[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

export const HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV =
  'CLAUDE_TEAM_HOSTED_APPROVAL_ACTIVATION_V2_ED25519_SPKI_DER_BASE64URL'
export const HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV =
  'CLAUDE_TEAM_HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST'

export type HostedApprovalActivationV2PinSource = Readonly<{
  publicKeySpkiDer: Uint8Array
  publicKeyDigest: `sha256:${string}`
  contractDigest: `sha256:${string}`
  [PIN_SOURCE]: true
}>

export function getHostedApprovalActivationV2ProductionPins(): HostedApprovalActivationV2PinSource {
  const encodedSpki = process.env[HOSTED_APPROVAL_ACTIVATION_V2_SPKI_ENV]
  const contractDigest = process.env[HOSTED_APPROVAL_ACTIVATION_V2_CONTRACT_DIGEST_ENV]
  if (!encodedSpki || !contractDigest) unavailable()
  if (!BASE64URL.test(encodedSpki) || !SHA256.test(contractDigest)) unavailable()

  const spki = Buffer.from(encodedSpki, 'base64url')
  if (spki.byteLength === 0 || spki.toString('base64url') !== encodedSpki) unavailable()
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' ||
      !Buffer.from(key.export({ format: 'der', type: 'spki' })).equals(spki)) unavailable()
  } catch {
    unavailable()
  }
  return Object.freeze({
    publicKeySpkiDer: new Uint8Array(spki),
    publicKeyDigest: `sha256:${createHash('sha256').update(spki).digest('hex')}`,
    contractDigest: contractDigest as `sha256:${string}`,
    [PIN_SOURCE]: true as const,
  })
}

/** Test-vector injection seam. Never used by the production verifier API. */
export function createHostedApprovalActivationV2PinsForTest(input: Readonly<{
  publicKeySpkiDer: Uint8Array
  publicKeyDigest: `sha256:${string}`
  contractDigest: `sha256:${string}`
}>): HostedApprovalActivationV2PinSource {
  return Object.freeze({
    publicKeySpkiDer: new Uint8Array(input.publicKeySpkiDer),
    publicKeyDigest: input.publicKeyDigest,
    contractDigest: input.contractDigest,
    [PIN_SOURCE]: true as const,
  })
}

function unavailable(): never {
  throw new Error('hosted_approval_activation_production_pins_unavailable')
}
