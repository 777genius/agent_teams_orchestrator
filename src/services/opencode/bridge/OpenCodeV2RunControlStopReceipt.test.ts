import { describe, expect, test } from 'bun:test'
import { sameStopReceipt } from './OpenCodeV2RunControl.js'
import type { RunControlResult, RunStopMember } from './OpenCodeV2RunTypes.js'

type StopResult = Extract<RunControlResult, { kind: 'stop' }>
const clean = (pid: number): RunStopMember['cleanup'] => ({
  scopeClosed: true, processRetired: true, descendantsRetired: true, pid,
  birth: { format: 'darwin-pidversion', value: `${pid}:1`, bootId: null },
})
const stopped: StopResult = { kind: 'stop', state: 'stopped', members: [{ memberId: 'worker', cleanup: clean(4242), errors: [] }], ownerRetired: true }
const unknownUnretired: StopResult = { kind: 'stop', state: 'cleanup_unknown', members: stopped.members, ownerRetired: false }
const unknownRetired: StopResult = { kind: 'stop', state: 'cleanup_unknown', members: stopped.members, ownerRetired: true }
const drifted: StopResult = { kind: 'stop', state: 'stopped', members: [{ memberId: 'worker', cleanup: clean(4343), errors: [] }], ownerRetired: true }

describe('sameStopReceipt late-downgrade tolerance', () => {
  test('identical stopped receipts match', () => {
    expect(sameStopReceipt(stopped, { ...stopped })).toBe(true)
  })
  test('a stopped proof matches the public downgrade of an unretired owner', () => {
    expect(sameStopReceipt(stopped, unknownUnretired)).toBe(true)
    expect(sameStopReceipt(unknownUnretired, stopped)).toBe(true)
  })
  test('an unretired downgrade on either side never hides a retired non-stopped receipt', () => {
    expect(sameStopReceipt(unknownRetired, stopped)).toBe(true)
    expect(sameStopReceipt(stopped, unknownRetired)).toBe(false)
  })
  test('member drift breaks equality in both states', () => {
    expect(sameStopReceipt(stopped, drifted)).toBe(false)
  })
})
