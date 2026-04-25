import type {
  ConnectProviderApiKeyInput,
  ConnectProviderInput,
  LoadProviderDirectoryInput,
  LoadProviderManagementViewInput,
  LoadProviderModelsInput,
  LoadProviderSetupFormInput,
  ProviderConnection,
  ProviderDirectoryView,
  ProviderManagementResult,
  ProviderManagementView,
  ProviderModelTestResult,
  ProviderSetupForm,
  ProviderSelectionInput,
  SetDefaultModelInput,
  TestProviderModelInput,
  RuntimeProviderModelsView,
} from '../domain/types.js'

export interface ProviderManagementQueryPort {
  loadView(
    input: LoadProviderManagementViewInput,
  ): Promise<ProviderManagementResult<ProviderManagementView>>
  loadSetupForm(
    input: LoadProviderSetupFormInput,
  ): Promise<ProviderManagementResult<ProviderSetupForm>>
  loadModels(
    input: LoadProviderModelsInput,
  ): Promise<ProviderManagementResult<RuntimeProviderModelsView>>
}

export interface ProviderManagementDirectoryQueryPort {
  loadDirectory(
    input: LoadProviderDirectoryInput,
  ): Promise<ProviderManagementResult<ProviderDirectoryView>>
}

export interface ProviderManagementCommandPort {
  connectProvider(
    input: ConnectProviderInput,
  ): Promise<ProviderManagementResult<ProviderConnection>>
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
