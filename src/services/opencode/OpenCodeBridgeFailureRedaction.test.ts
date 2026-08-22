import { describe, expect, test } from 'bun:test'

import { sanitizeOpenCodeBridgeFailureMessage } from './OpenCodeBridgeFailureRedaction.js'

describe('OpenCode bridge failure redaction', () => {
  test.each([
    "EACCES: permission denied, open '/home/alice/.local/share/claude-multimodel-nodejs/opencode/auth.json'",
    "mkdir 'C:\\Users\\Alice\\AppData\\Local\\claude-multimodel\\token.json' failed",
    "open '\\\\server\\share\\secret\\auth.json' failed",
    "open '\\\\?\\C:\\sensitive\\device-path\\config.json' failed",
    'request https://api.example.test/v1/models?api_key=sk-secret&token=more failed',
    'Authorization: Bearer sk-live-secret token=ghp_private password=hunter2',
  ])('removes adversarial endpoint, credential and path material from %s', message => {
    const result = sanitizeOpenCodeBridgeFailureMessage(message)
    expect(result.includes('failed') || result.includes('EACCES') || result.includes('Authorization')).toBe(true)
    for (const secret of ['alice', 'Alice', 'claude-multimodel', 'auth.json', 'api.example.test',
      'sk-secret', 'more', 'sk-live-secret', 'ghp_private', 'hunter2', 'server', 'sensitive']) {
      expect(result).not.toContain(secret)
    }
  })
})
