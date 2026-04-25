import type {
  LoadProviderSetupFormInput,
  ProviderManagementResult,
  ProviderSetupForm,
} from '../domain/types.js'
import type { ProviderManagementQueryPort } from '../ports/ProviderManagementPorts.js'

export async function loadProviderSetupForm(
  port: ProviderManagementQueryPort,
  input: LoadProviderSetupFormInput,
): Promise<ProviderManagementResult<ProviderSetupForm>> {
  return port.loadSetupForm(input)
}
