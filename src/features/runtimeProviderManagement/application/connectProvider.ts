import type {
  ConnectProviderInput,
  ProviderConnection,
  ProviderManagementResult,
} from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function connectProvider(
  port: ProviderManagementCommandPort,
  input: ConnectProviderInput,
): Promise<ProviderManagementResult<ProviderConnection>> {
  return port.connectProvider(input)
}
