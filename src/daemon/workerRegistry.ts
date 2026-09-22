import { unsupportedInternalFeature } from '../utils/unsupportedInternalFeature.js'

export async function runDaemonWorker(_kind?: string): Promise<void> {
  unsupportedInternalFeature('Daemon worker support')
}
