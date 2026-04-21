import { describe, expect, it } from 'bun:test'

import { normalizeOpenCodePermission, normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'

describe('OpenCodePermissionNormalizer', () => {
  it('normalizes OpenCode 1.14 style requestID/sessionID permissions', () => {
    expect(normalizeOpenCodePermission({
      requestID: 'req-1',
      sessionID: 'session-1',
      tool: 'bash',
      title: 'Run command',
      kind: 'tool',
    })).toEqual({
      requestId: 'req-1',
      sessionId: 'session-1',
      tool: 'bash',
      title: 'Run command',
      kind: 'tool',
      raw: {
        requestID: 'req-1',
        sessionID: 'session-1',
        tool: 'bash',
        title: 'Run command',
        kind: 'tool',
      },
    })
  })

  it('normalizes id/sessionId drift and drops malformed permissions', () => {
    expect(normalizeOpenCodePermissions([
      {
        id: 'perm-1',
        sessionId: 'session-2',
        toolName: 'edit',
        description: 'Edit file',
        type: 'tool',
      },
      {
        title: 'missing id',
      },
    ])).toEqual([
      {
        requestId: 'perm-1',
        sessionId: 'session-2',
        tool: 'edit',
        title: 'Edit file',
        kind: 'tool',
        raw: {
          id: 'perm-1',
          sessionId: 'session-2',
          toolName: 'edit',
          description: 'Edit file',
          type: 'tool',
        },
      },
    ])
  })
})
