import { describe, expect, it } from 'bun:test'

import {
  buildMcpDiagnoseJsonPayload,
  buildMcpListJsonPayload,
  describeMcpServerTarget,
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
