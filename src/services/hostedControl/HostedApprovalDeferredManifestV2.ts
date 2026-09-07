import { HostedApprovalActivationSession, HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES,
  type HostedApprovalActivationSessionOptions, type HostedApprovalActivationTransportSession } from './HostedApprovalActivationSession.js'
import type { HostedApprovalActivationExpectation } from './HostedApprovalRuntimeActivation.js'
import { requireHostedApprovalActivationV2ProductionPins, type HostedApprovalActivationV2ProductionPinSource, type HostedApprovalActivationV2PinSource } from './HostedApprovalActivationV2Pins.js'
import { immutableV2, requireV2, SHA_V2, type BootstrapHeaderV2 } from './HostedControlBootstrapV2Wire.js'

export type DeferredManifestExpectationV2 = Omit<HostedApprovalActivationExpectation, 'signedManifest'> & {
  signedManifest: Omit<HostedApprovalActivationExpectation['signedManifest'], 'manifestDigest'>
}
export type DeferredManifestSessionOptionsV2 = Omit<HostedApprovalActivationSessionOptions, 'authority'> & {
  expectedHost: BootstrapHeaderV2['expectedHost']
  authority: Omit<HostedApprovalActivationSessionOptions['authority'], 'snapshot'> & {
    snapshot(): DeferredManifestExpectationV2
  }
}
type ManifestState = { kind: 'pending' } | { kind: 'candidate'; manifestDigest: `sha256:${string}` } |
  { kind: 'admitted'; manifestDigest: `sha256:${string}`; activationPublicationSha256: string } | { kind: 'revoked' }

/** Only this v2 adapter borrows the candidate's manifestDigest. The original
 * complete v1 expectation and Ed25519 verifier remain mandatory and unchanged. */
export class HostedApprovalDeferredManifestV2 implements HostedApprovalActivationTransportSession {
  #state: ManifestState = Object.freeze({ kind: 'pending' })
  #session: HostedApprovalActivationTransportSession | null = null
  private constructor(private readonly options: DeferredManifestSessionOptionsV2,
    private readonly create: (o: HostedApprovalActivationSessionOptions) => HostedApprovalActivationTransportSession) {}
  static production(options: DeferredManifestSessionOptionsV2, pins?: HostedApprovalActivationV2ProductionPinSource): HostedApprovalDeferredManifestV2 {
    const retained = pins === undefined ? undefined : requireHostedApprovalActivationV2ProductionPins(pins)
    return new HostedApprovalDeferredManifestV2(options, o => HostedApprovalActivationSession.production(o, retained))
  }
  /** Same existing test-vector pins seam; never selectable by the real entry. */
  static forTest(options: DeferredManifestSessionOptionsV2, pins: HostedApprovalActivationV2PinSource): HostedApprovalDeferredManifestV2 {
    return new HostedApprovalDeferredManifestV2(options, o => HostedApprovalActivationSession.forTest(o, pins))
  }
  get state(): Readonly<ManifestState> { return this.#state }
  async activate(frame: string): Promise<string> {
    requireV2(this.#state.kind === 'pending', 'activation_consumed')
    this.#state = Object.freeze({ kind: 'revoked' }) // malformed first attempt also consumes this endpoint
    try {
      requireV2(Buffer.byteLength(frame) <= HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES && frame.endsWith('\n'), 'prepare_size')
      const parsed = JSON.parse(frame)
      requireV2(`${JSON.stringify(parsed)}\n` === frame, 'prepare_canonical')
      const digest: unknown = parsed?.binding?.signedManifest?.manifestDigest
      requireV2(typeof digest === 'string' && SHA_V2.test(digest), 'manifest_candidate')
      const manifestDigest = digest as `sha256:${string}`
      this.#state = Object.freeze({ kind: 'candidate', manifestDigest })
      const snapshot = (): HostedApprovalActivationExpectation => {
        const known = this.options.authority.snapshot()
        requireV2(!('manifestDigest' in known.signedManifest) &&
          Object.keys(known.signedManifest).sort().join(',') === 'format,launcherKeyId,releasePinDigest', 'pending_manifest_fields')
        // Restore the established activation wire's field order explicitly.
        return immutableV2({ ...known, signedManifest: { format: known.signedManifest.format, manifestDigest,
          releasePinDigest: known.signedManifest.releasePinDigest, launcherKeyId: known.signedManifest.launcherKeyId } })
      }
      this.#session = this.create({ ...this.options,
        authority: { ...this.options.authority, snapshot },
        recover: async (admission, activation) => {
          // Existing production() has verified the Ed25519 publication and ALL
          // bootstrap + actual published socket bindings before this callback.
          requireV2(this.#state.kind === 'candidate' && activation.binding.signedManifest.manifestDigest === manifestDigest, 'manifest_state')
          const host = this.options.expectedHost
          requireV2(activation.binding.ownerBinding.ownerGeneration === host.activation.ownerGeneration &&
            activation.binding.ownerBinding.ownerSessionId === host.activation.ownerSessionId &&
            activation.admissionDocumentDigest === host.activation.admissionDocumentDigest &&
            activation.binding.ownerArtifactDigest === host.activation.ownerArtifactDigest &&
            activation.requestedTeam.routes.every(route => route.authority.runtimeInstanceId === host.hosted.runtimeInstanceId &&
              route.openCodeBinding.openCodeArtifactDigest === `sha256:${host.executable.sha256}`), 'activation_expected_host')
          this.#state = Object.freeze({ kind: 'admitted', manifestDigest,
            activationPublicationSha256: activation.activationDigest })
          return this.options.recover(admission, activation)
        },
      })
      return await this.#session.activate(frame)
    } catch (error) { await this.revoke().catch(() => undefined); throw error }
  }
  async revoke(): Promise<void> {
    this.#state = Object.freeze({ kind: 'revoked' })
    await this.#session?.revoke()
  }
}
