import { expect, test } from 'bun:test'
import { createOpenCodePreflightHostLeaseInput, OpenCodePreflightLeaseRegistry } from './OpenCodePreflightLease.js'

test('exact generated preflight registration excludes invented scope and revokes pending scope', () => {
  const registry = new OpenCodePreflightLeaseRegistry()
  const lease = Object.freeze(createOpenCodePreflightHostLeaseInput('readiness'))
  expect(registry.has(lease)).toBe(false)
  expect(() => registry.register(Object.freeze({...lease}))).toThrow()
  registry.register(lease)
  expect(registry.has({...lease})).toBe(true) // host's immutable snapshot, same exact lease
  expect(registry.has({...lease,memberName:lease.memberName+'-forged'})).toBe(false)
  expect(registry.has({...lease,runId:'preflight_forged'})).toBe(false)
  expect(registry.has({...lease,teamId:'__opencode_preflight__suffix'})).toBe(false)
  expect(() => registry.register(lease)).toThrow()
  registry.release(lease)
  expect(registry.has(lease)).toBe(false)
  const next = Object.freeze(createOpenCodePreflightHostLeaseInput('execution'))
  registry.register(next); registry.clear(); expect(registry.has(next)).toBe(false)
})
