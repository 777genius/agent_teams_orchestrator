import { describe, expect, test } from 'bun:test'

import {
  buildOpenCodeCapabilityInfo,
  buildOpenCodeDetailMessage,
  buildOpenCodeStatusMessage,
} from './OpenCodeDiagnostics.js'

import type { OpenCodeInventorySnapshot, OpenCodePreparedProfile } from './types.js'

const profile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  canonicalProjectPath: '/tmp/project',
  workingDirectoryPath: '/tmp/project',
  scopeToken: null,
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-fingerprint-123456',
  behaviorSources: [
    'AGENTS.md',
    '.opencode/package.json',
    '.opencode/plugins/team-hooks.ts',
  ],
  managedConfig: {
    default_agent: 'teammate',
  },
  managedConfigFingerprint: 'managed-fingerprint-123456',
  homePath: '/tmp/profile-root/home',
  tmpPath: '/tmp/profile-root/tmp',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: {},
}

const snapshot: OpenCodeInventorySnapshot = {
  detected: true,
  binaryPath: '/opt/homebrew/bin/opencode',
  version: '1.4.0',
  projectPath: '/tmp/project',
  profile,
  connectedProviders: [{ id: 'openai', authHint: 'oauth', source: 'credentials' }],
  availableProviders: ['openai'],
  models: ['openai/gpt-5.4-mini'],
  agents: [{ id: 'teammate', mode: 'primary' }],
  authStorePath: profile.managedAuthPath,
  probeError: null,
  diagnostics: [],
}

describe('OpenCodeDiagnostics', () => {
  test('surfaces project plugin behavior sources in runtime status metadata', () => {
    const capabilities = buildOpenCodeCapabilityInfo(snapshot)

    expect(capabilities).toContainEqual({
      id: 'project-plugins',
      label: '1 project plugin files',
      enabled: true,
    })
    expect(buildOpenCodeDetailMessage(snapshot)).toContain('project plugins 1')
  })

  test('treats built-in free OpenCode models as launch-ready without credentials', () => {
    const freeSnapshot: OpenCodeInventorySnapshot = {
      ...snapshot,
      connectedProviders: [],
      availableProviders: ['opencode'],
      models: ['opencode/big-pickle'],
      modelMetadata: [
        {
          id: 'opencode/big-pickle',
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          context: 200000,
          limits: { context: 200000, output: 128000 },
          free: true,
          raw: {
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 200000, output: 128000 },
          },
        },
      ],
    }

    expect(buildOpenCodeStatusMessage(freeSnapshot)).toBeNull()
    expect(buildOpenCodeCapabilityInfo(freeSnapshot)).toContainEqual({
      id: 'builtin-free-models',
      label: '1 built-in free model',
      enabled: true,
    })
    expect(buildOpenCodeDetailMessage(freeSnapshot)).toContain('1 built-in free model')
  })
})
