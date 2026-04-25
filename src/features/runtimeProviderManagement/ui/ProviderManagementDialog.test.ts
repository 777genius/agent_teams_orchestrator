import { describe, expect, test } from 'bun:test'

import {
  getPreferredProviderAction,
  getProviderManagementInputGuide,
  reduceProviderManagementDialogState,
  validateApiKeyInput,
} from './ProviderManagementDialog.js'

import type { ProviderConnection } from '../domain/types.js'

function provider(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    state: 'not-connected',
    ownership: [],
    recommended: true,
    modelCount: 0,
    defaultModelId: null,
    authMethods: ['api'],
    actions: [{
      id: 'connect',
      label: 'Connect',
      enabled: true,
      disabledReason: null,
      requiresSecret: true,
      ownershipScope: 'managed',
    }],
    detail: null,
    ...overrides,
  }
}

describe('ProviderManagementDialog state', () => {
  test('validates empty API keys before submit', () => {
    expect(validateApiKeyInput('')).toBe('API key is required')
    expect(validateApiKeyInput('   ')).toBe('API key is required')
    expect(validateApiKeyInput('sk-test')).toBe(null)
  })

  test('prefers enabled connect actions over disabled configure actions', () => {
    const selected = provider({
      actions: [
        {
          id: 'configure',
          label: 'Configure manually',
          enabled: false,
          disabledReason: 'OpenCode did not advertise API-key auth for this provider',
          requiresSecret: false,
          ownershipScope: 'runtime',
        },
        {
          id: 'connect',
          label: 'Connect',
          enabled: true,
          disabledReason: null,
          requiresSecret: true,
          ownershipScope: 'managed',
        },
      ],
    })

    expect(getPreferredProviderAction(selected)?.id).toBe('connect')
  })

  test('clears secret state when connect is cancelled or finished', () => {
    const editing = reduceProviderManagementDialogState({
      selectedProviderId: 'openrouter',
      mode: 'connect',
      apiKey: '',
      apiKeyCursorOffset: 0,
      status: 'idle',
      statusMessage: null,
    }, {
      type: 'update-api-key',
      value: 'sk-test-secret',
    })

    expect(editing.apiKey).toBe('sk-test-secret')

    const cancelled = reduceProviderManagementDialogState(editing, {
      type: 'cancel-connect',
    })
    expect(cancelled.mode).toBe('list')
    expect(cancelled.apiKey).toBe('')

    const failed = reduceProviderManagementDialogState(editing, {
      type: 'submit-failed',
      message: 'failed',
    })
    expect(failed.mode).toBe('connect')
    expect(failed.apiKey).toBe('')

    const succeeded = reduceProviderManagementDialogState(editing, {
      type: 'submit-succeeded',
      message: 'connected',
    })
    expect(succeeded.mode).toBe('list')
    expect(succeeded.apiKey).toBe('')
  })

  test('uses a connect-specific input guide while editing secrets', () => {
    expect(getProviderManagementInputGuide('connect')).toContain('Enter save')
    expect(getProviderManagementInputGuide('list')).toContain('Enter action')
  })
})
