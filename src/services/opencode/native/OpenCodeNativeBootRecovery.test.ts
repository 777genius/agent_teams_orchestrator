import { expect, test } from 'bun:test'
import { nativePreviousBootConfirmed, type NativeCustodyReference } from './OpenCodeNativeCustody.js'
import type { NativeAuthority } from './OpenCodeNativeAuthority.js'

const oldBoot = '11111111-1111-1111-1111-111111111111'
const newBoot = '22222222-2222-2222-2222-222222222222'
const authority = () => {
  const epoch = 'a'.repeat(64), scopeDigest = 'b'.repeat(64), profileRoot = '/TEST/profile'
  return {
    reference: { schemaVersion: 1, bootId: oldBoot, epoch, scopeDigest, profileRoot } as NativeCustodyReference,
    images: { epoch }, scopeDigest, profileRoot,
  } as NativeAuthority
}

test('previous Linux boot conclusively retires native epoch without numeric PID reuse', () => {
  const previous = authority()
  expect(nativePreviousBootConfirmed(previous, newBoot)).toBe(true)
  expect(nativePreviousBootConfirmed(previous, oldBoot)).toBe(false)
  expect(nativePreviousBootConfirmed(previous, 'not-a-boot-id')).toBe(false)
  expect(nativePreviousBootConfirmed({ ...previous, reference: null }, newBoot)).toBe(false)
  expect(nativePreviousBootConfirmed({ ...previous, reference: { ...previous.reference!, epoch: 'c'.repeat(64) } }, newBoot)).toBe(false)
  expect(nativePreviousBootConfirmed({ ...previous, reference: { ...previous.reference!, profileRoot: '/TEST/foreign' } }, newBoot)).toBe(false)
  expect(nativePreviousBootConfirmed({ ...previous, reference: { ...previous.reference!, scopeDigest: 'd'.repeat(64) } }, newBoot)).toBe(false)
})
