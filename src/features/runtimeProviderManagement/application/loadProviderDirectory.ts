import type {
  LoadProviderDirectoryInput,
  ProviderDirectoryView,
  ProviderManagementResult,
} from '../domain/types.js'
import type { ProviderManagementDirectoryQueryPort } from '../ports/ProviderManagementPorts.js'

export async function loadProviderDirectory(
  port: ProviderManagementDirectoryQueryPort,
  input: LoadProviderDirectoryInput,
): Promise<ProviderManagementResult<ProviderDirectoryView>> {
  return port.loadDirectory(input)
}
