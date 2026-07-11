import React, { useEffect, useMemo, useReducer, useState } from 'react'
import figures from 'figures'

import { Box, Text, useInput } from '../../../ink.js'
import TextInput from '../../../components/TextInput.js'
import { Dialog } from '../../../components/design-system/Dialog.js'
import type {
  ConnectProviderApiKeyInput,
  ProviderActionDescriptor,
  ProviderActionId,
  ProviderConnection,
  ProviderConnectionState,
  ProviderManagementResult,
  ProviderManagementView,
  ProviderOwnership,
  ProviderRuntimeState,
} from '../domain/types.js'

type ProviderManagementDialogProps = {
  view: ProviderManagementView
  onCancel: () => void
  onConnectWithApiKey?: (
    input: ConnectProviderApiKeyInput,
  ) => Promise<ProviderManagementResult<ProviderConnection>>
  onForgetManagedCredential?: (input: {
    runtimeId: ProviderManagementView['runtimeId']
    providerId: string
  }) => Promise<ProviderManagementResult<ProviderConnection>>
  onProviderChanged?: (provider: ProviderConnection) => void
}

type DialogMode = 'list' | 'connect'
type DialogStatus = 'idle' | 'submitting' | 'success' | 'error'

export type ProviderManagementDialogState = {
  selectedProviderId: string | null
  mode: DialogMode
  apiKey: string
  apiKeyCursorOffset: number
  status: DialogStatus
  statusMessage: string | null
}

type ProviderManagementDialogEvent =
  | { type: 'sync-view'; providerIds: readonly string[] }
  | { type: 'select-provider'; providerId: string }
  | { type: 'start-connect'; providerId: string }
  | { type: 'update-api-key'; value: string }
  | { type: 'update-api-key-cursor'; offset: number }
  | { type: 'cancel-connect' }
  | { type: 'submit-started' }
  | { type: 'submit-succeeded'; message: string }
  | { type: 'submit-failed'; message: string }

const RUNTIME_STATE_LABELS: Record<ProviderRuntimeState, string> = {
  ready: 'Ready',
  'needs-auth': 'Needs auth',
  'needs-setup': 'Needs setup',
  degraded: 'Degraded',
}

const PROVIDER_STATE_LABELS: Record<ProviderConnectionState, string> = {
  connected: 'Connected',
  available: 'Available',
  'not-connected': 'Not connected',
  ignored: 'Ignored',
  error: 'Error',
}

const OWNERSHIP_LABELS: Record<ProviderOwnership, string> = {
  managed: 'Managed',
  local: 'Local',
  env: 'Env',
  project: 'Project',
}

const ACTION_PRIORITY: ProviderActionId[] = [
  'connect',
  'use',
  'forget',
  'test',
  'set-default',
  'configure',
  'unignore',
]

export function getInitialProviderManagementDialogState(
  view: ProviderManagementView,
): ProviderManagementDialogState {
  return {
    selectedProviderId: view.providers[0]?.providerId ?? null,
    mode: 'list',
    apiKey: '',
    apiKeyCursorOffset: 0,
    status: 'idle',
    statusMessage: null,
  }
}

export function reduceProviderManagementDialogState(
  state: ProviderManagementDialogState,
  event: ProviderManagementDialogEvent,
): ProviderManagementDialogState {
  switch (event.type) {
    case 'sync-view': {
      if (state.selectedProviderId && event.providerIds.includes(state.selectedProviderId)) {
        return state
      }
      return {
        ...state,
        selectedProviderId: event.providerIds[0] ?? null,
        mode: 'list',
        apiKey: '',
        apiKeyCursorOffset: 0,
      }
    }
    case 'select-provider':
      return {
        ...state,
        selectedProviderId: event.providerId,
        status: 'idle',
        statusMessage: null,
      }
    case 'start-connect':
      return {
        ...state,
        selectedProviderId: event.providerId,
        mode: 'connect',
        apiKey: '',
        apiKeyCursorOffset: 0,
        status: 'idle',
        statusMessage: null,
      }
    case 'update-api-key':
      return {
        ...state,
        apiKey: event.value,
        apiKeyCursorOffset: Math.min(event.value.length, state.apiKeyCursorOffset),
      }
    case 'update-api-key-cursor':
      return {
        ...state,
        apiKeyCursorOffset: event.offset,
      }
    case 'cancel-connect':
      return {
        ...state,
        mode: 'list',
        apiKey: '',
        apiKeyCursorOffset: 0,
        status: 'idle',
        statusMessage: null,
      }
    case 'submit-started':
      return {
        ...state,
        status: 'submitting',
        statusMessage: null,
      }
    case 'submit-succeeded':
      return {
        ...state,
        mode: 'list',
        apiKey: '',
        apiKeyCursorOffset: 0,
        status: 'success',
        statusMessage: event.message,
      }
    case 'submit-failed':
      return {
        ...state,
        apiKey: '',
        apiKeyCursorOffset: 0,
        status: 'error',
        statusMessage: event.message,
      }
  }
}

export function validateApiKeyInput(value: string): string | null {
  return value.trim().length === 0 ? 'API key is required' : null
}

export function getProviderAction(
  provider: ProviderConnection,
  actionId: ProviderActionId,
): ProviderActionDescriptor | null {
  return provider.actions.find(action => action.id === actionId) ?? null
}

export function getPreferredProviderAction(
  provider: ProviderConnection,
): ProviderActionDescriptor | null {
  for (const actionId of ACTION_PRIORITY) {
    const enabledAction = provider.actions.find(action => action.id === actionId && action.enabled)
    if (enabledAction) return enabledAction
  }
  return provider.actions[0] ?? null
}

export function getProviderManagementInputGuide(mode: DialogMode): string {
  return mode === 'connect'
    ? 'Enter save - Esc cancel'
    : 'Up/down select - Enter action - c connect - f forget - Esc close'
}

function getRuntimeColor(state: ProviderRuntimeState): 'success' | 'warning' | 'error' {
  if (state === 'ready') return 'success'
  if (state === 'needs-auth') return 'warning'
  return 'error'
}

function getProviderColor(
  state: ProviderConnectionState,
): 'success' | 'warning' | 'inactive' | 'error' {
  if (state === 'connected') return 'success'
  if (state === 'available') return 'inactive'
  if (state === 'not-connected' || state === 'ignored') return 'warning'
  return 'error'
}

function joinOwnership(ownership: readonly ProviderOwnership[]): string {
  return ownership.map(value => OWNERSHIP_LABELS[value]).join(' + ')
}

function formatProviderDetail(provider: ProviderConnection): string {
  const parts: string[] = []
  if (provider.recommended) parts.push('Recommended')
  if (provider.ownership.length > 0) parts.push(joinOwnership(provider.ownership))
  if (provider.modelCount > 0) {
    parts.push(`${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}`)
  }
  return parts.join('  ')
}

function RuntimeSection({ view }: { view: ProviderManagementView }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Runtime</Text>
      <Box>
        <Text>CLI </Text>
        <Text color={getRuntimeColor(view.runtime.state)}>
          {RUNTIME_STATE_LABELS[view.runtime.state]}
        </Text>
        <Text dimColor> {view.runtime.cliPath ?? 'not found'}</Text>
      </Box>
      <Box>
        <Text>Version </Text>
        <Text dimColor>{view.runtime.version ?? 'unknown'}</Text>
      </Box>
      <Box>
        <Text>Managed profile </Text>
        <Text>{view.runtime.managedProfile}</Text>
        <Text dimColor> local OpenCode config is not modified</Text>
      </Box>
      <Box>
        <Text>Local auth </Text>
        <Text>{view.runtime.localAuth}</Text>
      </Box>
    </Box>
  )
}

function ProviderRow({
  provider,
  selected,
}: {
  provider: ProviderConnection
  selected: boolean
}): React.ReactNode {
  const marker = selected ? figures.pointer : ' '
  const detail = formatProviderDetail(provider)
  const action = getPreferredProviderAction(provider)
  return (
    <Box>
      <Text color={selected ? 'permission' : undefined}>{marker} </Text>
      <Text bold={selected}>{provider.displayName.padEnd(16)}</Text>
      <Text color={getProviderColor(provider.state)}>
        {PROVIDER_STATE_LABELS[provider.state].padEnd(15)}
      </Text>
      <Text dimColor>{detail.padEnd(32)}</Text>
      <Text dimColor={Boolean(action && !action.enabled)}>{action?.label ?? ''}</Text>
    </Box>
  )
}

function ProvidersSection({
  providers,
  selectedProviderId,
}: {
  providers: readonly ProviderConnection[]
  selectedProviderId: string | null
}): React.ReactNode {
  if (providers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Providers</Text>
        <Text dimColor>No OpenCode providers were found.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Providers</Text>
      {providers.map(provider => (
        <ProviderRow
          key={provider.providerId}
          provider={provider}
          selected={provider.providerId === selectedProviderId}
        />
      ))}
    </Box>
  )
}

function ProviderActionSection({
  provider,
}: {
  provider: ProviderConnection | null
}): React.ReactNode {
  if (!provider) {
    return null
  }

  const disabledReason = provider.actions.find(action => !action.enabled)?.disabledReason
  return (
    <Box flexDirection="column">
      <Text bold>Selected</Text>
      <Text>
        {provider.displayName}{' '}
        <Text dimColor>
          {provider.actions.map(action => action.label).join(' / ') || 'No actions'}
        </Text>
      </Text>
      {disabledReason ? <Text dimColor>{disabledReason}</Text> : null}
    </Box>
  )
}

function ApiKeyConnectForm({
  provider,
  value,
  cursorOffset,
  status,
  statusMessage,
  onChange,
  onCursorOffsetChange,
  onSubmit,
}: {
  provider: ProviderConnection
  value: string
  cursorOffset: number
  status: DialogStatus
  statusMessage: string | null
  onChange: (value: string) => void
  onCursorOffsetChange: (offset: number) => void
  onSubmit: (value: string) => void
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Connect {provider.displayName}</Text>
      <Box>
        <Text>API key </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onCursorOffsetChange}
          columns={48}
          mask="*"
          focus={true}
          showCursor={true}
          multiline={false}
        />
      </Box>
      {status === 'submitting' ? <Text dimColor>Saving...</Text> : null}
      {statusMessage ? (
        <Text color={status === 'error' ? 'error' : 'success'}>{statusMessage}</Text>
      ) : null}
    </Box>
  )
}

function DefaultsSection({ view }: { view: ProviderManagementView }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Default for teams</Text>
      <Text dimColor>Auto: prefer verified connected provider</Text>
      <Text>
        Current: <Text dimColor>{view.defaultModel ?? view.fallbackModel ?? 'not selected'}</Text>
      </Text>
    </Box>
  )
}

function DiagnosticsSection({ diagnostics }: { diagnostics: readonly string[] }): React.ReactNode {
  if (diagnostics.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      <Text bold color="warning">
        Diagnostics
      </Text>
      {diagnostics.slice(0, 4).map((diagnostic, index) => (
        <Text key={`${index}:${diagnostic}`} dimColor>
          {figures.warning} {diagnostic}
        </Text>
      ))}
    </Box>
  )
}

export function ProviderManagementDialog({
  view,
  onCancel,
  onConnectWithApiKey,
  onForgetManagedCredential,
  onProviderChanged,
}: ProviderManagementDialogProps): React.ReactNode {
  const [state, dispatch] = useReducer(
    reduceProviderManagementDialogState,
    view,
    getInitialProviderManagementDialogState,
  )
  const [providerOverrides, setProviderOverrides] = useState<Record<string, ProviderConnection>>({})
  const providerSignature = view.providers.map(provider => provider.providerId).join('\0')

  useEffect(() => {
    setProviderOverrides({})
    dispatch({
      type: 'sync-view',
      providerIds: view.providers.map(provider => provider.providerId),
    })
  }, [providerSignature, view.providers])

  const providers = useMemo(
    () => view.providers.map(provider => providerOverrides[provider.providerId] ?? provider),
    [providerOverrides, view.providers],
  )
  const effectiveView = useMemo(() => ({ ...view, providers }), [providers, view])
  const selectedProvider =
    providers.find(provider => provider.providerId === state.selectedProviderId) ??
    providers[0] ??
    null
  const selectedIndex = selectedProvider
    ? providers.findIndex(provider => provider.providerId === selectedProvider.providerId)
    : -1

  const updateProvider = (provider: ProviderConnection) => {
    setProviderOverrides(previous => ({
      ...previous,
      [provider.providerId]: provider,
    }))
    onProviderChanged?.(provider)
  }

  const selectRelativeProvider = (delta: number) => {
    if (providers.length === 0) return
    const nextIndex =
      selectedIndex < 0 ? 0 : (selectedIndex + delta + providers.length) % providers.length
    const provider = providers[nextIndex]
    if (provider) {
      dispatch({ type: 'select-provider', providerId: provider.providerId })
    }
  }

  const startConnect = (provider: ProviderConnection) => {
    const action = getProviderAction(provider, 'connect')
    if (!action?.enabled) {
      dispatch({
        type: 'submit-failed',
        message: action?.disabledReason ?? 'Connect is not available for this provider',
      })
      return
    }
    dispatch({ type: 'start-connect', providerId: provider.providerId })
  }

  const submitApiKey = async (value: string) => {
    if (!selectedProvider) return
    const validationError = validateApiKeyInput(value)
    if (validationError) {
      dispatch({ type: 'submit-failed', message: validationError })
      return
    }
    if (!onConnectWithApiKey) {
      dispatch({
        type: 'submit-failed',
        message: 'Connect handler is not available',
      })
      return
    }

    dispatch({ type: 'submit-started' })
    const result = await onConnectWithApiKey({
      runtimeId: view.runtimeId,
      providerId: selectedProvider.providerId,
      apiKey: value.trim(),
    })
    if ('error' in result) {
      dispatch({ type: 'submit-failed', message: result.error.message })
      return
    }

    updateProvider(result.value)
    dispatch({
      type: 'submit-succeeded',
      message: `${result.value.displayName} connected`,
    })
  }

  const forgetSelectedProvider = async (provider: ProviderConnection) => {
    const action = getProviderAction(provider, 'forget')
    if (!action?.enabled) {
      dispatch({
        type: 'submit-failed',
        message: action?.disabledReason ?? 'Forget is not available for this provider',
      })
      return
    }
    if (!onForgetManagedCredential) {
      dispatch({
        type: 'submit-failed',
        message: 'Forget handler is not available',
      })
      return
    }

    dispatch({ type: 'submit-started' })
    const result = await onForgetManagedCredential({
      runtimeId: view.runtimeId,
      providerId: provider.providerId,
    })
    if ('error' in result) {
      dispatch({ type: 'submit-failed', message: result.error.message })
      return
    }

    updateProvider(result.value)
    dispatch({
      type: 'submit-succeeded',
      message: `${result.value.displayName} credential removed`,
    })
  }

  const runPreferredAction = () => {
    if (!selectedProvider || state.status === 'submitting') return
    const action = getPreferredProviderAction(selectedProvider)
    if (!action) return
    if (action.id === 'connect') {
      startConnect(selectedProvider)
      return
    }
    if (action.id === 'forget') {
      void forgetSelectedProvider(selectedProvider)
      return
    }
    if (!action.enabled) {
      dispatch({
        type: 'submit-failed',
        message: action.disabledReason ?? `${action.label} is not available`,
      })
    }
  }

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        selectRelativeProvider(-1)
        return
      }
      if (key.downArrow) {
        selectRelativeProvider(1)
        return
      }
      if (key.return) {
        runPreferredAction()
        return
      }
    },
    { isActive: state.mode === 'list' },
  )

  useInput(
    (input, key) => {
      if (key.escape || (input === 'c' && key.ctrl)) {
        dispatch({ type: 'cancel-connect' })
      }
    },
    { isActive: state.mode === 'connect' },
  )

  useInput(
    input => {
      if (!selectedProvider || state.status === 'submitting') return
      if (input === 'c') {
        startConnect(selectedProvider)
      } else if (input === 'f') {
        void forgetSelectedProvider(selectedProvider)
      }
    },
    { isActive: state.mode === 'list' },
  )

  const connectedCount = providers.filter(provider => provider.state === 'connected').length
  const modelCount = providers.reduce((count, provider) => count + provider.modelCount, 0)

  return (
    <Dialog
      title={view.title}
      subtitle={`${connectedCount} connected providers, ${modelCount} models`}
      onCancel={onCancel}
      color="permission"
      isCancelActive={state.mode === 'list'}
      inputGuide={() => <Text>{getProviderManagementInputGuide(state.mode)}</Text>}
    >
      <Box flexDirection="column" gap={1}>
        <RuntimeSection view={effectiveView} />
        <ProvidersSection
          providers={providers}
          selectedProviderId={selectedProvider?.providerId ?? null}
        />
        <ProviderActionSection provider={selectedProvider} />
        {state.mode === 'connect' && selectedProvider ? (
          <ApiKeyConnectForm
            provider={selectedProvider}
            value={state.apiKey}
            cursorOffset={state.apiKeyCursorOffset}
            status={state.status}
            statusMessage={state.statusMessage}
            onChange={value => dispatch({ type: 'update-api-key', value })}
            onCursorOffsetChange={offset =>
              dispatch({
                type: 'update-api-key-cursor',
                offset,
              })
            }
            onSubmit={value => {
              void submitApiKey(value)
            }}
          />
        ) : null}
        {state.mode !== 'connect' && state.statusMessage ? (
          <Text color={state.status === 'error' ? 'error' : 'success'}>{state.statusMessage}</Text>
        ) : null}
        <DefaultsSection view={effectiveView} />
        <DiagnosticsSection diagnostics={view.diagnostics} />
      </Box>
    </Dialog>
  )
}
