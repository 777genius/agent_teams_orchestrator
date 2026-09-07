import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { allocationFixture } from './native-allocation.fixture.js'
import { decodeNativeAllocation, matchesProductObservation } from './native-operation-allocation.js'

test('full fixed allocation enforces generations, sessions, A continuity, B isolation, starts and obligations', () => {
  const a = allocationFixture()
  assert.equal(a.starts.length, 7); assert.equal(a.generations.length, 4)
  assert(Object.isFrozen(a.generations.find(g => g.generation === 4)!.slots))
  for (const patch of [{ scenario: {} }, { starts: a.starts.slice(1) }, { generations: a.generations.slice(1) },
    { entries: a.entries.slice(0, 1) }, { obligations: a.obligations.slice(1) },
    { entries: Array(129).fill(a.entries.find(e => e.id === 'pending')) }])
    assert.throws(() => decodeNativeAllocation({ ...a, ...patch }))
  for (const field of ['teamId', 'teamRoot', 'walLineage', 'routeId', 'routeDigest', 'activationEndpoint', 'lifecycleEndpoint'] as const) {
    const g4 = a.generations.find(g => g.generation === 4)!, slotA = g4.slots.find(s => s.slot === 'A')!
    assert.throws(() => decodeNativeAllocation({ ...a, generations: a.generations.map(g => g === g4 ? { ...g,
      slots: g.slots.map(s => s.slot === 'B' ? { ...s, [field]: slotA[field] } : s) } : g) }))
  }
  const g1 = a.generations.find(g => g.generation === 1)!
  for (const patch of [{ ownerSessionId: g1.ownerSessionId }, { slots: [] }, { supplemental: { ...g1.supplemental, operationChannelFd: 11 } }])
    assert.throws(() => decodeNativeAllocation({ ...a, generations: a.generations.map(g => g.generation === 2 ? { ...g, ...patch } : g) }))
})
test('closed operations, exact methods/bodies, DAG, uses and wire aliases reject', () => {
  const a = allocationFixture(), pending = a.entries.find(e => e.id === 'pending')!, page = a.entries.find(e => e.id === 'Apage')!
  const reject = (replacement: unknown) => assert.throws(() => decodeNativeAllocation({ ...a,
    entries: a.entries.map(e => e === pending ? replacement : e) }))
  for (const patch of [{ origin: 'environment' }, { generation: 5 }, { slot: 'B' }, { routeDigest: '0'.repeat(64) },
    { maximumUses: 0 }, { maximumUses: 256 }, { dependencies: ['Rretry'] }, { dependencies: Array(9).fill('pending') },
    { operation: { ...pending.operation, path: '/arbitrary' } }, { operation: { ...pending.operation, method: 'GET' } },
    { operation: { ...pending.operation, callback: 'arbitrary' } }, { operation: { ...pending.operation, kind: 'constructor' } },
    { operation: { ...pending.operation, body: {} } }, { operation: { ...pending.operation, decision: 'allow_once' } }]) reject({ ...pending, ...patch })
  assert.throws(() => decodeNativeAllocation({ ...a, entries: [...a.entries, { ...page, id: 'alias',
    operation: { ...page.operation, kind: 'product-list', binding: { kind: 'exact', sessionId: 'different', requestId: 'different' } } }] }))
  for (const id of ['Apage', 'Aterminal', 'Bpage']) {
    const entry = a.entries.find(e => e.id === id)!
    assert(matchesProductObservation(entry, 'POST', entry.operation.path, entry.operation.body))
    assert(!matchesProductObservation(entry, 'GET', entry.operation.path, entry.operation.body))
    assert(!matchesProductObservation(entry, 'POST', entry.operation.path, { ...entry.operation.body, limit: 51 }))
    assert(!matchesProductObservation(entry, 'POST', entry.operation.path, { ...entry.operation.body, extra: true }))
  }
  const csrf = a.entries.find(e => e.operation.negativeCase === 'product-http:csrf_rejected')!
  assert.throws(() => decodeNativeAllocation({ ...a, entries: a.entries.filter(e => e !== csrf),
    obligations: a.obligations.map(o => ({ ...o, operationIds: o.operationIds.filter(id => id !== csrf.id) })) }))
})
