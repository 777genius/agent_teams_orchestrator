import { describe, expect, test } from 'bun:test'

import { buildHostedActualOwnerNativePublication } from '../services/hostedControl/HostedActualOwnerNativeWriter.js'
import { hostedActualOwnerTestInput } from '../services/hostedControl/HostedActualOwnerNativeWriter.test.js'
import {
  mapHostedActualOwnerPublicationToProduct,
  parseHostedActualOwnerNativePublication,
} from './hostedActualOwnerAcceptance.js'

const line = async () => Buffer.from(`${JSON.stringify(
  buildHostedActualOwnerNativePublication(await hostedActualOwnerTestInput('retained')),
)}\n`)

describe('hostedActualOwnerAcceptance', () => {
  test('accepts the complete canonical native receipt and maps Product without byte payloads', async () => {
    const parsed = parseHostedActualOwnerNativePublication(await line())
    const mapped = mapHostedActualOwnerPublicationToProduct(parsed)
    expect(mapped).toMatchObject({
      schemaVersion: 1, operationNonce: '1'.repeat(64), revision: 2,
      predecessor: { kind: 'retained', sha256: parsed.publication.predecessor.kind === 'retained'
        ? parsed.publication.predecessor.image.sha256 : null },
      final: { sha256: parsed.publication.final.sha256, byteSize: parsed.publication.final.byteSize },
      receipt: { status: 'published', emissionNonce: '2'.repeat(64), sequence: 7 },
      lifecycle: { durable: true, sealed: true, revoked: false, revocationReason: null },
    })
    expect(JSON.stringify(mapped)).not.toContain('base64')
    expect(Object.isFrozen(mapped)).toBe(true)
  })

  test('fails closed on noncanonical framing and unknown fields', async () => {
    const valid = await line()
    expect(() => parseHostedActualOwnerNativePublication(valid.subarray(0, -1))).toThrow()
    expect(() => parseHostedActualOwnerNativePublication(Buffer.concat([valid, Buffer.from('\n')]))).toThrow()
    const value = JSON.parse(valid.subarray(0, -1).toString())
    value.extra = true
    expect(() => parseHostedActualOwnerNativePublication(Buffer.from(`${JSON.stringify(value)}\n`))).toThrow()
  })

  test('fails closed when P, N, receipt, pins, clocks, fence, or lineage is changed', async () => {
    const mutations: Array<(value: any) => void> = [
      value => { value.publication.predecessor.image.base64 = Buffer.from('different').toString('base64') },
      value => { value.publication.final.sha256 = '0'.repeat(64) },
      value => { value.publication.receipt.operationNonce = '9'.repeat(64) },
      value => { value.operation.result.cleanup = 'failed' },
      value => { value.pins.producerExecutableSha256 = 'a'.repeat(64) },
      value => { value.lifecycle.sync.clock.monotonicNs = '0' },
      value => { value.publication.receipt.writerFence.dev = '01' },
      value => { value.owner.predecessorOwnerStartToken = value.owner.ownerStartToken },
      value => { value.lifecycle.seal.status = 'pending' },
    ]
    for (const mutate of mutations) {
      const value = JSON.parse((await line()).subarray(0, -1).toString())
      mutate(value)
      expect(() => parseHostedActualOwnerNativePublication(
        Buffer.from(`${JSON.stringify(value)}\n`),
      )).toThrow()
    }
  })

  test('requires an exact fenced absence proof', async () => {
    const value: any = structuredClone(buildHostedActualOwnerNativePublication(await hostedActualOwnerTestInput()))
    value.publication.predecessor.proof.writerFence = {
      ...value.publication.predecessor.proof.writerFence, ino: '99',
    }
    expect(() => mapHostedActualOwnerPublicationToProduct(value)).toThrow()
  })
})
