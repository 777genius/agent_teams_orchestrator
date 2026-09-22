import type {
  ProviderConnection,
  ProviderManagementResult,
  ProviderSelectionInput,
} from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function forgetManagedProvider(
  port: ProviderManagementCommandPort,
  input: ProviderSelectionInput,
): Promise<ProviderManagementResult<ProviderConnection>> {
  return port.forgetManagedCredential(input)
}
