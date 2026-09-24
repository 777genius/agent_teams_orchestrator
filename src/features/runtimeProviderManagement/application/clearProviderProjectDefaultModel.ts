import type { ClearProjectDefaultModelInput } from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function clearProviderProjectDefaultModel(
  port: ProviderManagementCommandPort,
  input: ClearProjectDefaultModelInput,
) {
  return port.clearProjectDefaultModel(input)
}
