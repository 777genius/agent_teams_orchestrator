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

  it('reads the tool name from the OpenCode 1.18 permission field', () => {
    const normalized = normalizeOpenCodePermission({
      id: 'per_1',
      sessionID: 'session-1',
      permission: 'bash',
      patterns: ['git status'],
      always: ['git status *'],
      tool: { messageID: 'msg_1', callID: 'call_1' },
    })
    expect(normalized?.requestId).toBe('per_1')
    expect(normalized?.sessionId).toBe('session-1')
    expect(normalized?.tool).toBe('bash')
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
