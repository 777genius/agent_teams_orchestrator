import { expect, test } from 'bun:test'
import { OpenCodeNativeRequestOwners } from './OpenCodeNativeRequestOwners.js'

type Physical = { epoch: string; credential: string; pid: number; birth: string; baseUrl: string }
const first = { epoch: 'TEST-A', credential: 'TEST-private-A', pid: 1, birth: 'TEST-birth', baseUrl: 'http://127.0.0.1:1' }
function fixture() {
  const admitted = new WeakSet<object>()
  const owners = new OpenCodeNativeRequestOwners<Physical>(custody => {
    if (!admitted.has(custody)) throw new Error('TEST-unadmitted')
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b))
  const admit = (value: Physical) => { admitted.add(value); return value }
  return { owners, admit }
}

test('owner JSON and DTO copies cannot transfer a private request capability', () => {
  const { owners, admit } = fixture()
  const owner = owners.bind({ baseUrl: first.baseUrl }, admit(first))
  expect(JSON.stringify(owner)).toBe(JSON.stringify({ baseUrl: first.baseUrl }))
  expect(() => owners.capture(JSON.parse(JSON.stringify(owner)))).toThrow('native_custody_unavailable')
  expect(() => owners.capture({ ...owner })).toThrow('native_custody_unavailable')
  expect(() => owners.capture(undefined)).toThrow('native_custody_unavailable')
  expect(owners.capture(owner)).toBe(first)
})

test('explicit local context copies preserve their captured epoch after the URL is reused', () => {
  const { owners, admit } = fixture()
  const oldOwner = owners.bind({}, admit(first))
  const context = owners.inherit({}, oldOwner)
  const next = admit({ ...first, epoch: 'TEST-B', credential: 'TEST-private-B', pid: 2, birth: 'TEST-new-birth' })
  const newOwner = owners.bind({}, next)
  expect(owners.capture(context)).toBe(first)
  expect(owners.capture(newOwner)).toBe(next)
  expect(() => owners.bind(oldOwner, next)).toThrow('native_custody_unavailable')
  expect(() => owners.inherit(context, newOwner)).toThrow('native_custody_unavailable')
})

test('same physical epoch recovered as another admitted object remains usable', () => {
  const { owners, admit } = fixture()
  const owner = owners.bind({}, admit(first))
  const previous = owners.capture(owner)
  const recovered = admit({ ...first })
  owners.bind(owner, recovered)
  expect(owners.capture(owner)).toBe(recovered)
  expect(previous).toBe(first)
  expect(() => owners.bind({}, { ...first })).toThrow('TEST-unadmitted')
})
