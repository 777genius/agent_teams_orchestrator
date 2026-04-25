import React from 'react'
import figures from 'figures'

import { Box, Text } from '../../../ink.js'
import { Dialog } from '../../../components/design-system/Dialog.js'
import type {
  LocalAuthState,
  ManagedProfileState,
  ProviderConnection,
  ProviderConnectionState,
  ProviderManagementView,
  ProviderOwnership,
  ProviderPrimaryAction,
  ProviderRuntimeState,
} from '../domain/types.js'

type ProviderManagementDialogProps = {
  view: ProviderManagementView
  onCancel: () => void
}

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

const MANAGED_PROFILE_LABELS: Record<ManagedProfileState, string> = {
  active: 'Active',
  missing: 'Missing',
  stale: 'Stale',
}

const LOCAL_AUTH_LABELS: Record<LocalAuthState, string> = {
  synced: 'Synced',
  missing: 'Missing',
  stale: 'Stale',
  disabled: 'Disabled',
}

const OWNERSHIP_LABELS: Record<ProviderOwnership, string> = {
  managed: 'Managed',
  local: 'Local',
  env: 'Env',
  project: 'Project',
}

const ACTION_LABELS: Record<ProviderPrimaryAction, string> = {
  connect: 'Connect',
  use: 'Use',
  test: 'Test',
  forget: 'Forget',
  unignore: 'Unignore',
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

function actionLabel(action: ProviderPrimaryAction | null): string {
  return action ? ACTION_LABELS[action] : ''
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
        <Text>CLI              </Text>
        <Text color={getRuntimeColor(view.runtime.state)}>
          {RUNTIME_STATE_LABELS[view.runtime.state]}
        </Text>
        <Text dimColor>       {view.runtime.cliPath ?? 'not found'}</Text>
      </Box>
      <Box>
        <Text>Version          </Text>
        <Text dimColor>{view.runtime.version ?? 'unknown'}</Text>
      </Box>
      <Box>
        <Text>Managed profile  </Text>
        <Text>{MANAGED_PROFILE_LABELS[view.runtime.managedProfile]}</Text>
        <Text dimColor>      local OpenCode config is not modified</Text>
      </Box>
      <Box>
        <Text>Local auth       </Text>
        <Text>{LOCAL_AUTH_LABELS[view.runtime.localAuth]}</Text>
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
  return (
    <Box>
      <Text color={selected ? 'permission' : undefined}>{marker} </Text>
      <Text bold={selected}>{provider.displayName.padEnd(16)}</Text>
      <Text color={getProviderColor(provider.state)}>
        {PROVIDER_STATE_LABELS[provider.state].padEnd(15)}
      </Text>
      <Text dimColor>{detail.padEnd(32)}</Text>
      <Text>{actionLabel(provider.primaryAction)}</Text>
    </Box>
  )
}

function ProvidersSection({ providers }: { providers: readonly ProviderConnection[] }): React.ReactNode {
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
      {providers.map((provider, index) => (
        <ProviderRow
          key={provider.providerId}
          provider={provider}
          selected={index === 0}
        />
      ))}
    </Box>
  )
}

function DefaultsSection({ view }: { view: ProviderManagementView }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Default for teams</Text>
      <Text dimColor>Auto: prefer verified connected provider</Text>
      <Text>
        Current:{' '}
        <Text dimColor>{view.defaultModel ?? view.fallbackModel ?? 'not selected'}</Text>
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
      <Text bold color="warning">Diagnostics</Text>
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
}: ProviderManagementDialogProps): React.ReactNode {
  const connectedCount = view.providers.filter(provider => provider.state === 'connected').length
  const modelCount = view.providers.reduce((count, provider) => count + provider.modelCount, 0)

  return (
    <Dialog
      title={view.title}
      subtitle={`${connectedCount} connected providers, ${modelCount} models`}
      onCancel={onCancel}
      color="permission"
      inputGuide={() => (
        <Text>Enter connect/use - t test - r resync - i ignore - Esc close</Text>
      )}
    >
      <Box flexDirection="column" gap={1}>
        <RuntimeSection view={view} />
        <ProvidersSection providers={view.providers} />
        <DefaultsSection view={view} />
        <DiagnosticsSection diagnostics={view.diagnostics} />
      </Box>
    </Dialog>
  )
}
