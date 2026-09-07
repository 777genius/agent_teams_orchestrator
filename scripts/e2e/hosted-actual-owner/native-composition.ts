import { admitNativeOwnerLaunch, type NativeAdmittedLaunch } from './native-launch-admission.js'
import type { SelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'

/** Concrete selected entry composition. It accepts no authority callbacks,
 * prepared results, keys or arbitrary custody acquisition function. */
export class NativeOwnerComposition {
  #admitted: NativeAdmittedLaunch | undefined
  #closed = false
  admitLaunch(phase: SelectedLaunchPhase): NativeAdmittedLaunch {
    if (this.#closed || this.#admitted) throw new Error('hosted_owner_v2_composition_consumed')
    return this.#admitted = admitNativeOwnerLaunch(phase)
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true; this.#admitted?.close(); this.#admitted = undefined
  }
}
export function createNativeOwnerComposition(): NativeOwnerComposition { return new NativeOwnerComposition() }
