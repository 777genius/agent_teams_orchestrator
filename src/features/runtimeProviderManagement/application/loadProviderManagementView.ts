import type {
  ProviderManagementResult,
  ProviderManagementRuntimeId,
  ProviderManagementView,
} from '../domain/types.js'
import type { ProviderManagementQueryPort } from '../ports/ProviderManagementPorts.js'

export async function loadProviderManagementView(
  port: ProviderManagementQueryPort,
  runtimeId: ProviderManagementRuntimeId,
): Promise<ProviderManagementResult<ProviderManagementView>> {
  return port.loadView(runtimeId)
}
