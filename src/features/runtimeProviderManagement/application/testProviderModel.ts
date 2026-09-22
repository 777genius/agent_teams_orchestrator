import type { TestProviderModelInput } from '../domain/types.js'
import type { ProviderManagementCommandPort } from '../ports/ProviderManagementPorts.js'

export async function testProviderModel(
  port: ProviderManagementCommandPort,
  input: TestProviderModelInput,
) {
  return port.testModel(input)
}
