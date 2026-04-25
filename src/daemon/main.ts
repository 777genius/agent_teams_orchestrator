import { unsupportedInternalFeature } from '../utils/unsupportedInternalFeature.js'

export async function daemonMain(_args: string[]): Promise<void> {
  unsupportedInternalFeature('Daemon support')
}
