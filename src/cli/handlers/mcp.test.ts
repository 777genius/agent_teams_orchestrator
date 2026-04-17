import { describe, expect, it } from 'bun:test'

import {
  buildMcpDiagnoseJsonPayload,
  buildMcpListJsonPayload,
  describeMcpServerTarget,
  filterExtensionsManagedMcpServers,
} from '../../services/mcp/cliJson.js'

import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

describe('MCP JSON helpers', () => {
  it('builds stable config-only JSON payloads for stdio and http servers', () => {
    const payload = buildMcpListJsonPayload({
      zebra: {
        type: 'stdio',
        command: 'uvx',
        args: ['zebra-mcp'],
        scope: 'global',
      },
      alpha: {
        type: 'http',
        url: 'https://mcp.example.com',
        scope: 'project',
      },
      'plugin:context7:context7': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        scope: 'dynamic',
      },
    } satisfies Record<string, ScopedMcpServerConfig>)

    expect(payload).toEqual({
      schemaVersion: 1,
      servers: [
        {
          name: 'alpha',
          scope: 'project',
          transport: 'http',
          target: 'https://mcp.example.com',
        },
        {
          name: 'zebra',
          scope: 'global',
          transport: 'stdio',
          target: 'uvx zebra-mcp',
        },
      ],
    })
  })

  it('filters dynamic MCP servers out of the Extensions JSON contract', () => {
    expect(
      filterExtensionsManagedMcpServers({
        context7: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
          scope: 'global',
        },
        'plugin:context7:context7': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          scope: 'dynamic',
        },
      } satisfies Record<string, ScopedMcpServerConfig>),
    ).toEqual({
      context7: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@latest'],
        scope: 'global',
      },
    })
  })

  it('describes claudeai proxy targets using their URL', () => {
    expect(
      describeMcpServerTarget({
        type: 'claudeai-proxy',
        id: 'proxy-1',
        url: 'https://claude.ai/mcp/proxy',
        scope: 'managed',
      }),
    ).toBe('https://claude.ai/mcp/proxy')
  })

  it('redacts sensitive URL query params and CLI flag values from targets', () => {
    expect(
      describeMcpServerTarget({
        type: 'stdio',
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          'https://mcp.tavily.com/mcp/?tavilyApiKey=secret-value&agent=claude',
          '--api-key',
          'super-secret-token',
        ],
        scope: 'global',
      }),
    ).toBe(
      'npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=REDACTED&agent=REDACTED --api-key REDACTED',
    )
  })

  it('redacts credentials and fragments in remote MCP URLs', () => {
    expect(
      describeMcpServerTarget({
        type: 'http',
        url: 'https://user:pass@example.com/mcp?token=abc#fragment-token',
        scope: 'global',
      }),
    ).toBe('https://***:***@example.com/mcp?token=REDACTED#REDACTED')
  })

  it('wraps diagnostics in a versioned JSON payload', () => {
    expect(
      buildMcpDiagnoseJsonPayload(
        [
          {
            name: 'context7',
            scope: 'global',
            transport: 'stdio',
            target: 'npx -y @upstash/context7-mcp',
            status: 'connected',
            statusLabel: 'Connected',
          },
          {
            name: 'plugin:context7:context7',
            scope: 'dynamic',
            transport: 'stdio',
            target: 'npx -y @upstash/context7-mcp',
            status: 'connected',
            statusLabel: 'Connected',
          },
        ],
        '2026-04-17T12:00:00.000Z',
      ),
    ).toEqual({
      schemaVersion: 1,
      checkedAt: '2026-04-17T12:00:00.000Z',
      diagnostics: [
        {
          name: 'context7',
          scope: 'global',
          transport: 'stdio',
          target: 'npx -y @upstash/context7-mcp',
          status: 'connected',
          statusLabel: 'Connected',
        },
      ],
    })
  })
})
