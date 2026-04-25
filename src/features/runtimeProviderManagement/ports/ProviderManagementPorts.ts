import type {
  ConnectProviderApiKeyInput,
  ProviderConnection,
  ProviderManagementResult,
  ProviderManagementRuntimeId,
  ProviderManagementView,
  ProviderModelTestResult,
  ProviderSelectionInput,
  SetDefaultModelInput,
  TestProviderModelInput,
} from '../domain/types.js'

export interface ProviderManagementQueryPort {
  loadView(
    runtimeId: ProviderManagementRuntimeId,
  ): Promise<ProviderManagementResult<ProviderManagementView>>
}

export interface ProviderManagementCommandPort {
  connectWithApiKey(
    input: ConnectProviderApiKeyInput,
  ): Promise<ProviderManagementResult<ProviderConnection>>
  forgetManagedCredential(
    input: ProviderSelectionInput,
  ): Promise<ProviderManagementResult<ProviderConnection>>
  ignoreProvider(
    input: ProviderSelectionInput,
  ): Promise<ProviderManagementResult<ProviderConnection>>
  setDefaultModel(
    input: SetDefaultModelInput,
  ): Promise<ProviderManagementResult<ProviderManagementView>>
  testModel(
    input: TestProviderModelInput,
  ): Promise<ProviderManagementResult<ProviderModelTestResult>>
}
