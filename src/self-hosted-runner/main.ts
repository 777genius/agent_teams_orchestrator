import { unsupportedInternalFeature } from '../utils/unsupportedInternalFeature.js'

export async function selfHostedRunnerMain(_args: string[]): Promise<void> {
  unsupportedInternalFeature('Self-hosted runner support')
}
