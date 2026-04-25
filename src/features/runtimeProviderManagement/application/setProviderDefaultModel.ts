import type { SetDefaultModelInput } from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function setProviderDefaultModel(
  port: ProviderManagementCommandPort,
  input: SetDefaultModelInput,
) {
  return port.setDefaultModel(input)
}
