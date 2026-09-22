import type {
  ConnectProviderInput,
  ProviderConnection,
  ProviderManagementResult,
  ProviderOAuthFlowObserver,
} from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function connectProvider(
  port: ProviderManagementCommandPort,
  input: ConnectProviderInput,
  observer?: ProviderOAuthFlowObserver,
): Promise<ProviderManagementResult<ProviderConnection>> {
  return port.connectProvider(input, observer)
}
