import type {
  LoadProviderManagementViewInput,
  ProviderManagementResult,
  ProviderManagementView,
} from '../domain/types.js'
import type { ProviderManagementQueryPort } from '../ports/ProviderManagementPorts.js'

export async function loadProviderManagementView(
  port: ProviderManagementQueryPort,
  input: LoadProviderManagementViewInput,
): Promise<ProviderManagementResult<ProviderManagementView>> {
  return port.loadView(input)
}
