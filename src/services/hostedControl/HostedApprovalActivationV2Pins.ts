/**
 * Compiled activation-v2 authorship pins.
 *
 * The production pin is deliberately unavailable while activation-v2 remains
 * behind its false gate.  Freezing a test-vector key here would turn fixture
 * material into production trust configuration.
 */

const PIN_SOURCE = Symbol('HostedApprovalActivationV2PinSource')

export type HostedApprovalActivationV2PinSource = Readonly<{
  publicKeySpkiDer: Uint8Array
  publicKeyDigest: `sha256:${string}`
  contractDigest: `sha256:${string}`
  [PIN_SOURCE]: true
}>

export function getHostedApprovalActivationV2ProductionPins(): HostedApprovalActivationV2PinSource {
  throw new Error('hosted_approval_activation_production_pins_unavailable')
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
