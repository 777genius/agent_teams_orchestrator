import { describe, expect, test } from 'bun:test'

import { resolveLaunchToolApprovalMode } from './OpenCodeBridgeCommandHandler.js'

describe('OpenCode launch approval-mode wire', () => {
  test.each([
    [{ toolApprovalMode: 'manual', skipPermissions: false }, 'manual'],
    [{ toolApprovalMode: 'auto', skipPermissions: true }, 'auto'],
  ] as const)('preserves the exact explicit approval-mode pair %#', (body, expected) => {
    expect(resolveLaunchToolApprovalMode(body)).toBe(expected)
  })

  test.each([
    { toolApprovalMode: 'manual' },
    { toolApprovalMode: 'manual', skipPermissions: true },
    { toolApprovalMode: 'manual', skipPermissions: 'false' },
    { toolApprovalMode: 'manual', skipPermissions: null },
    { toolApprovalMode: 'auto' },
    { toolApprovalMode: 'auto', skipPermissions: false },
    { toolApprovalMode: 'auto', skipPermissions: 'true' },
    { toolApprovalMode: 'auto', skipPermissions: null },
    { toolApprovalMode: 'automatic', skipPermissions: true },
  ])('rejects an invalid or contradictory explicit wire %#', body => {
    expect(() => resolveLaunchToolApprovalMode(body)).toThrow()
  })

  test.each([
    [{ skipPermissions: false }, 'manual'],
    [{ skipPermissions: true }, 'auto'],
    [{}, 'auto'],
    [{ skipPermissions: 'false' }, 'auto'],
  ] as const)('keeps pre-explicit legacy semantics only when mode is absent %#', (body, expected) => {
    expect(resolveLaunchToolApprovalMode(body)).toBe(expected)
  })
})
