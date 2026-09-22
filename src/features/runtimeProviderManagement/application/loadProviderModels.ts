import type { LoadProviderModelsInput } from '../domain/types.js'
import type { ProviderManagementQueryPort } from '../ports/ProviderManagementPorts.js'

export async function loadProviderModels(
  port: ProviderManagementQueryPort,
  input: LoadProviderModelsInput,
) {
  return port.loadModels(input)
}
