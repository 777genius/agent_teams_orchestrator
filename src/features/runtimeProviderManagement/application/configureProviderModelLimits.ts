import type { ConfigureProviderModelLimitsInput } from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function configureProviderModelLimits(
  port: ProviderManagementCommandPort,
  input: ConfigureProviderModelLimitsInput,
) {
  return port.configureModelLimits(input)
}
