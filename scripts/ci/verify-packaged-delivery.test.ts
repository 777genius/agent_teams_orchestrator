import { expect, test } from 'bun:test'

import { parsePackagedSecurityCapabilities } from './verify-packaged-delivery.js'

test('accepts only the packaged authorization capability contract', () => {
  expect(parsePackagedSecurityCapabilities('{"schemaVersion":1,"mcpHttpAuthorizationHeaders":true}\n'))
    .toEqual({ schemaVersion: 1, mcpHttpAuthorizationHeaders: true })
  for (const output of [
    '2.777.777 (Claude Code)',
    '{}',
    '{"schemaVersion":1,"mcpHttpAuthorizationHeaders":false}',
    '{"schemaVersion":"1","mcpHttpAuthorizationHeaders":true}',
    '{"schemaVersion":2,"mcpHttpAuthorizationHeaders":true}',
    '[{"schemaVersion":1,"mcpHttpAuthorizationHeaders":true}]',
    '{"schemaVersion":1,"mcpHttpAuthorizationHeaders":true,"providerAuth":"unexpected"}',
    '{"schemaVersion":1,"mcpHttpAuthorizationHeaders":true}\nstartup output',
  ]) expect(() => parsePackagedSecurityCapabilities(output)).toThrow('Invalid packaged security capabilities')
})
