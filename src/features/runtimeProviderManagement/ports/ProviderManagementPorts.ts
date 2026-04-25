import type {
  ConnectProviderApiKeyInput,
  LoadProviderModelsInput,
  ProviderConnection,
  ProviderManagementResult,
  ProviderManagementRuntimeId,
  ProviderManagementView,
  ProviderModelTestResult,
  ProviderSelectionInput,
  SetDefaultModelInput,
  TestProviderModelInput,
  RuntimeProviderModelsView,
} from '../domain/types.js'

export interface ProviderManagementQueryPort {
  loadView(
    runtimeId: ProviderManagementRuntimeId,
  ): Promise<ProviderManagementResult<ProviderManagementView>>
  loadModels(
    input: LoadProviderModelsInput,
  ): Promise<ProviderManagementResult<RuntimeProviderModelsView>>
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
