import { unsupportedInternalFeature } from '../utils/unsupportedInternalFeature.js'

export async function environmentRunnerMain(_args: string[]): Promise<void> {
  unsupportedInternalFeature('BYOC environment runner support')
}
