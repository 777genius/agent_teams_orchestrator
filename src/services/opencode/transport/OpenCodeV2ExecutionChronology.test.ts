import { expect, test } from 'bun:test'
import { executionCurrentOperations } from './OpenCodeV2ExecutionCurrentClient.js'
import { executionFloorOperations } from './OpenCodeV2ExecutionFloorClient.js'
import { OpenCodeV2ExecutionFetch } from './OpenCodeV2ExecutionFetch.js'

const endpoint = 'http://127.0.0.1:32123'
const sessionID = 'ses_TESTchronology'
const cursor = Buffer.from(JSON.stringify({ id: 'msg_TESTcomment', order: 'asc', direction: 'next' })).toString('base64url')
for (const pin of ['2.0.0', '2.0.21'] as const) {
  test(`${pin} official generated client requests ascending first page and follows cursor without order`, async () => {
    const requests: URL[] = []
    const wire = new OpenCodeV2ExecutionFetch(endpoint, pin, '/TEST/project', 'TEST-only-password',
      { deadline: Date.now() + 5000 }, async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url)
        requests.push(url)
        expect(request.method).toBe('GET')
        expect(url.pathname).toBe(`/api/session/${sessionID}/message`)
        expect(url.searchParams.get('limit')).toBe('200')
        if (requests.length === 1) {
          // Both official handlers default to DESC when order is absent.
          expect(url.searchParams.get('order')).toBe('asc')
          expect(url.searchParams.has('cursor')).toBe(false)
        } else {
          expect(requests).toHaveLength(2)
          expect(url.searchParams.get('cursor')).toBe(cursor)
          expect(url.searchParams.has('order')).toBe(false)
        }
        return Response.json({ data: [], cursor: requests.length === 1 ? { next: cursor } : {} })
      })
    try {
      const operations = (pin === '2.0.0' ? executionFloorOperations : executionCurrentOperations)(endpoint, '/TEST/project', wire, wire.fetch)
      await operations.messages(sessionID)
      await operations.messages(sessionID, cursor)
      expect(requests).toHaveLength(2)
    } finally { await wire.dispose() }
  })
  test(`${pin} wire refuses alternative order, cursor-plus-order, duplicate order and unrelated route order before fetch`, async () => {
    let invocations = 0
    const wire = new OpenCodeV2ExecutionFetch(endpoint, pin, '/TEST/project', 'TEST-only-password',
      { deadline: Date.now() + 5000 }, async () => { invocations++; return Response.json({}) })
    try {
      for (const route of [
        `/api/session/${sessionID}/message?order=desc`,
        `/api/session/${sessionID}/message?cursor=${cursor}&order=asc`,
        `/api/session/${sessionID}/message?order=asc&order=asc`,
        `/api/session/${sessionID}?order=asc`,
      ]) await expect(wire.fetch(endpoint + route)).rejects.toThrow('authority_mismatch')
      expect(invocations).toBe(0)
    } finally { await wire.dispose() }
  })
}
