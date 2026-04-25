import type {
  ConnectProviderApiKeyInput,
  ProviderConnection,
  ProviderManagementResult,
} from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function connectProviderWithApiKey(
  port: ProviderManagementCommandPort,
  input: ConnectProviderApiKeyInput,
): Promise<ProviderManagementResult<ProviderConnection>> {
  return port.connectWithApiKey(input)
}
